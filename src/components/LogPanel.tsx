/**
 * The log, three ways: the job's own log, the whole run's failed steps, and Claude's
 * rewrite of it.
 *
 * They are genuinely different things rather than three qualities of the same thing, which
 * is why all three are offered rather than one being picked for you:
 *
 * - **Job** — one job's log, through the GitHub API. No `gh` needed, and usually already
 *   in hand, so it is the default.
 * - **Run** — every failed step of the run, via `gh`. The only view that shows an upstream
 *   job's output, which is what you need when the failure you clicked is an aggregator
 *   reacting to `needs:`.
 * - **Claude** — the log rewritten: decisive lines first, noise cut, short notes where a
 *   line needs one. Costs a model call, so it is never fetched implicitly.
 *
 * Colour on the first two is local and instant (`src/lib/logHighlight.ts`); no model call
 * is spent on something a regex settles.
 */

import { useEffect, useState } from 'react';
import { Button, Flash, SegmentedControl, Spinner, Text } from '@primer/react';
import { SparkleFillIcon, SyncIcon } from '@primer/octicons-react';
import { fetchJobLog, logTtlMs } from '../api/logCache';
import { fetchRunLogViaGh } from '../storage/desktopClaude';
import { runLogCache, runLogKey } from '../storage/failureCaches';
import { devLog, devWarn } from '../lib/devLog';
import { LogLines } from './LogLines';
import { MarkdownView } from './MarkdownView';
import styles from './LogPanel.module.css';

export type LogTab = 'job' | 'run' | 'claude';

export function LogPanel({
  jobId,
  runId,
  runAttempt,
  owner,
  repo,
  /** Claude's rewrite, if one has been produced or restored from the cache. */
  rewrittenLog,
  rewriteRunning,
  ghAvailable,
  aiAvailable,
  onRewrite,
  maxHeight,
}: {
  jobId: number | null;
  runId: number | null;
  runAttempt: number | null;
  owner: string;
  repo: string;
  rewrittenLog: string | null;
  rewriteRunning: boolean;
  /** `gh` is installed and signed in — nothing to do with AI. */
  ghAvailable: boolean;
  /** AI integration is switched on and `claude` is there. */
  aiAvailable: boolean;
  onRewrite: () => void;
  maxHeight?: number | string;
}) {
  const [tab, setTab] = useState<LogTab>('job');
  const [showTimestamps, setShowTimestamps] = useState(false);

  // The whole job log, not the tail the report shows. Almost always free: opening a
  // failure's report already put it in logCache, and concurrent callers share the request.
  const [jobLog, setJobLog] = useState<{ text: string; error: string | null; loading: boolean }>({
    text: '',
    error: null,
    loading: false,
  });
  useEffect(() => {
    if (jobId == null) {
      setJobLog({ text: '', error: 'This check run has no Actions job log.', loading: false });
      return;
    }
    let live = true;
    setJobLog({ text: '', error: null, loading: true });
    fetchJobLog(owner, repo, jobId, logTtlMs(true)).then(
      (text) => live && setJobLog({ text, error: null, loading: false }),
      (err: unknown) =>
        live &&
        setJobLog({
          text: '',
          error: err instanceof Error ? err.message : 'The log could not be read.',
          loading: false,
        }),
    );
    return () => {
      live = false;
    };
  }, [owner, repo, jobId]);

  const cacheKey = runId != null ? runLogKey(runId, runAttempt) : null;
  const [runLog, setRunLog] = useState<{ text: string; truncated: boolean } | null>(() =>
    cacheKey ? runLogCache.get(cacheKey) ?? null : null,
  );
  const [runLogState, setRunLogState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });

  // Never sit on a tab that has just been hidden — switching AI off while looking at the
  // Claude view would otherwise leave an empty pane with no way back to it.
  useEffect(() => {
    if (tab === 'claude' && !aiAvailable) setTab('job');
    if (tab === 'run' && !ghAvailable) setTab('job');
  }, [tab, aiAvailable, ghAvailable]);

  // Re-read the cache when the focused failure changes, so switching rows doesn't show the
  // previous run's log.
  useEffect(() => {
    setRunLog(cacheKey ? runLogCache.get(cacheKey) ?? null : null);
    setRunLogState({ loading: false, error: null });
  }, [cacheKey]);

  const loadRunLog = async () => {
    if (runId == null || cacheKey === null) return;
    setRunLogState({ loading: true, error: null });
    const result = await fetchRunLogViaGh(owner, repo, runId);
    if (!result.ok) {
      devWarn('claude', `gh could not produce the run log: ${result.error}`, { runId });
      setRunLogState({ loading: false, error: result.error });
      return;
    }
    devLog('claude', `run log via gh: ${result.text.length} chars`, { runId });
    const entry = { text: result.text, truncated: result.truncated };
    runLogCache.set(cacheKey, entry);
    setRunLog(entry);
    setRunLogState({ loading: false, error: null });
  };

  // Fetching is on demand, not on tab change: `gh` downloads this from blob storage and it
  // can take a while, so it happens when asked for and never as a side effect of a click
  // that was only meant to look.
  const runTabReady = runLog !== null;

  return (
    <div className={styles.flexCol}>
      <div className={styles.flexCenter}>
        <SegmentedControl aria-label="Which log to show" size="small">
          <SegmentedControl.Button selected={tab === 'job'} onClick={() => setTab('job')}>
            Job log
          </SegmentedControl.Button>
          <SegmentedControl.Button
            selected={tab === 'run'}
            onClick={() => setTab('run')}
            // Hidden rather than shown-and-broken: without the desktop bridge there is no
            // gh to ask, so the tab could never have content.
            className={ghAvailable ? undefined : styles.hidden}
          >
            Whole run
          </SegmentedControl.Button>
          <SegmentedControl.Button
            selected={tab === 'claude'}
            onClick={() => setTab('claude')}
            // Gone entirely when AI is switched off, like every other AI control.
            className={aiAvailable ? undefined : styles.hidden}
          >
            {rewrittenLog ? 'Claude ✓' : 'Claude'}
          </SegmentedControl.Button>
        </SegmentedControl>

        <div className={styles.grow} />

        {tab !== 'claude' && (
          <Button
            size="small"
            variant="invisible"
            onClick={() => setShowTimestamps((v) => !v)}
            aria-pressed={showTimestamps}
          >
            {showTimestamps ? 'Hide times' : 'Show times'}
          </Button>
        )}
        {tab === 'run' && (
          <Button
            size="small"
            leadingVisual={runLogState.loading ? undefined : SyncIcon}
            disabled={runLogState.loading || runId == null}
            onClick={() => void loadRunLog()}
          >
            {runLogState.loading ? (
              <>
                <Spinner size="small" className={styles.mr1} />
                Fetching…
              </>
            ) : runTabReady ? (
              'Refetch'
            ) : (
              'Fetch with gh'
            )}
          </Button>
        )}
        {tab === 'claude' && (
          <Button
            size="small"
            leadingVisual={rewriteRunning ? undefined : SparkleFillIcon}
            disabled={rewriteRunning}
            onClick={onRewrite}
          >
            {rewriteRunning ? (
              <>
                <Spinner size="small" className={styles.mr1} />
                Rewriting…
              </>
            ) : rewrittenLog ? (
              'Rewrite again'
            ) : (
              'Rewrite with Claude'
            )}
          </Button>
        )}
      </div>

      <div className={styles.grow2}>
        {tab === 'job' &&
          (jobLog.text ? (
            <LogLines text={jobLog.text} showTimestamps={showTimestamps} maxHeight={maxHeight} />
          ) : (
            <Placeholder>
              {jobLog.loading
                ? 'Loading the job’s log…'
                : (jobLog.error ?? 'No log was available for this job.')}
            </Placeholder>
          ))}

        {tab === 'run' && (
          <>
            {runLogState.error && (
              <Flash variant="warning" className={styles.mb2Small}>
                {runLogState.error}
              </Flash>
            )}
            {runLog?.truncated && (
              <Flash variant="warning" className={styles.mb2Small}>
                The log was very large, so only its start was kept.
              </Flash>
            )}
            {runLog ? (
              <LogLines text={runLog.text} showTimestamps={showTimestamps} maxHeight={maxHeight} />
            ) : (
              <Placeholder>
                {runLogState.loading
                  ? 'Asking gh for every failed step of this run…'
                  : 'Every failed step of the run, fetched with your local gh. This is the view that shows an upstream job’s output.'}
              </Placeholder>
            )}
          </>
        )}

        {tab === 'claude' &&
          (rewrittenLog ? (
            <div className={styles.scrollPane} style={{ maxHeight }}>
              <MarkdownView markdown={rewrittenLog} />
            </div>
          ) : (
            <Placeholder>
              {rewriteRunning
                ? 'Claude is rewriting the log…'
                : 'The same log with the decisive lines first, the noise cut, and a short note where a line needs one. Costs one model call.'}
            </Placeholder>
          ))}
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={styles.roundedP3}
    >
      <Text>{children}</Text>
    </div>
  );
}

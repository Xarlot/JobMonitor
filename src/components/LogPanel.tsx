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
 *
 * What a model *is* worth a call for is the **map**: which of a failed run's forty red lines are
 * the ones to read, in order, with a sentence each. Those findings become a marker stripe beside
 * the log and two buttons that walk it, the way an IDE walks compiler errors — and, unless the
 * setting is turned off, the scan starts as soon as this view is opened. A map you have to ask
 * for is a map you consult after you have already scrolled the log by hand, which is the work it
 * exists to remove.
 */

import { useEffect, useRef, useMemo, useState } from 'react';
import { Button, Flash, IconButton, SegmentedControl, Spinner, Text } from '@primer/react';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SparkleFillIcon,
  SyncIcon,
  TelescopeIcon,
} from '@primer/octicons-react';
import { fetchJobLog, logTtlMs } from '../api/logCache';
import { fetchRunLogViaGh } from '../storage/desktopClaude';
import { runLogCache, runLogKey } from '../storage/failureCaches';
import { devLog, devWarn } from '../lib/devLog';
import { anchorLogMarks, parseLogMarks } from '../lib/logMarks';
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
  marksDocument = null,
  marksRunning = false,
  marksError = null,
  scanOnOpen = false,
  onFindMarks,
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
  /**
   * Claude's findings from the `marks` task, verbatim.
   *
   * Passed as the reply rather than as parsed marks because anchoring depends on which log is on
   * screen: the same findings are re-located against the job's log and the whole-run log, and a
   * week-old cached reply is re-anchored the same way when the failure is reopened.
   */
  marksDocument?: string | null;
  marksRunning?: boolean;
  marksError?: string | null;
  /** Start the scan on opening rather than waiting to be asked (Settings → AI integration). */
  scanOnOpen?: boolean;
  onFindMarks?: () => void;
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

  /*
   * The findings, and where they land in the text currently on screen.
   *
   * Two steps, memoized apart, because they change for different reasons: the reply is parsed once
   * per analysis, while the anchoring is redone whenever the reader switches between the job's log
   * and the whole run's — the same finding is a different line number in each, and some findings
   * are simply not present in the other log.
   */
  const shownText = tab === 'job' ? jobLog.text : tab === 'run' ? (runLog?.text ?? '') : '';
  const records = useMemo(
    () => (marksDocument ? parseLogMarks(marksDocument) : []),
    [marksDocument],
  );
  const { marks, unanchored } = useMemo(
    () => anchorLogMarks(records, shownText),
    [records, shownText],
  );

  /**
   * Scan the log as soon as this view is open, unless there is already an answer.
   *
   * This is the one model call the app makes without a click on the thing it does — which is
   * defensible only because of what bounds it: the AI master switch, a setting of its own, a view
   * the reader deliberately opened, and **once per job**. `started` is a ref rather than state
   * because it must not re-render, and it is keyed by job id so switching rows scans the new row
   * and returning to an old one does not scan it twice.
   *
   * An existing reply, a run in flight, or a previous failure all suppress it: retrying a failed
   * scan on every visit would spend a call per visit to fail the same way.
   */
  const scanned = useRef<number | null>(null);
  const canScan = aiAvailable && scanOnOpen && Boolean(onFindMarks);
  useEffect(() => {
    if (!canScan || jobId == null) return;
    if (scanned.current === jobId) return;
    if (marksDocument || marksRunning || marksError) return;
    scanned.current = jobId;
    onFindMarks?.();
    // Deliberately not depending on the state it reads: those change *because* of this call, and
    // re-running on them is how an automatic call turns into a loop. The guard above is the whole
    // contract, and `jobId` is the only input that should start a new scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canScan, jobId]);

  /**
   * Which finding is being visited, or null for "not walking the list yet".
   *
   * Null rather than 0 on purpose: a log that scrolls itself somewhere the moment its analysis
   * lands is disorienting, and with the scan now starting on its own that would happen while the
   * reader was mid-line. The stripe says where the trouble is; the jump waits to be asked for.
   */
  const [current, setCurrent] = useState<number | null>(null);
  // A new scan, or a different log to anchor against, invalidates the position — "3 of 8" on a
  // list that has just been replaced points at nothing the reader chose.
  useEffect(() => {
    setCurrent(null);
  }, [marks]);

  const step = (delta: number) => {
    if (marks.length === 0) return;
    setCurrent((prev) => {
      if (prev === null) return delta > 0 ? 0 : marks.length - 1;
      // Wraps, like every other find-next: the alternative is a disabled button at each end,
      // which reads as broken when the reason is that you have seen them all.
      return (prev + delta + marks.length) % marks.length;
    });
  };

  const active = current === null ? null : (marks[current] ?? null);
  /** The map's controls belong to the two real logs; Claude's rewrite is already ordered. */
  const mapOffered = aiAvailable && tab !== 'claude' && Boolean(onFindMarks);

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

        {mapOffered && (
          <>
            {marks.length > 0 && (
              <div className={styles.navGroup}>
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={ChevronUpIcon}
                  aria-label="Previous failure in the log"
                  onClick={() => step(-1)}
                />
                <Text className={styles.navCount}>
                  {current === null ? marks.length : `${current + 1}/${marks.length}`}
                </Text>
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={ChevronDownIcon}
                  aria-label="Next failure in the log"
                  onClick={() => step(1)}
                />
              </div>
            )}
            <Button
              size="small"
              leadingVisual={marksRunning ? undefined : TelescopeIcon}
              disabled={marksRunning}
              onClick={onFindMarks}
            >
              {marksRunning ? (
                <>
                  <Spinner size="small" className={styles.mr1} />
                  Scanning…
                </>
              ) : records.length > 0 ? (
                'Scan again'
              ) : (
                'Find failures'
              )}
            </Button>
          </>
        )}
      </div>

      {marksError && tab !== 'claude' && (
        <Flash variant="warning" className={styles.mb2Small}>
          {marksError}
        </Flash>
      )}

      {/*
        What you have just jumped to, in words. The stripe says where and the line itself says
        what, but the reason a line matters — "this is a consequence of the failure above" — is the
        part only the analysis knows, and it would be lost in a tooltip.
      */}
      {active && (
        <div className={styles.markBar}>
          <Text className={styles.markLine}>line {active.line}</Text>
          <Text className={styles.markLabel}>{active.label}</Text>
          {active.note && <Text className={styles.markNote}>{active.note}</Text>}
        </div>
      )}

      {/*
        Said rather than silently dropped. A finding from the job's own log often has no line in
        the whole-run log (and the other way round), so a map with holes in it has to declare
        them — otherwise the reader trusts eight ticks when there were ten findings.
      */}
      {unanchored > 0 && tab !== 'claude' && (
        <Text className={styles.unanchored}>
          {unanchored} {unanchored === 1 ? 'finding' : 'findings'} could not be located in this log
          {tab === 'run' ? ' — they came from the job’s own log' : ''}.
        </Text>
      )}

      <div className={styles.grow2}>
        {tab === 'job' &&
          (jobLog.text ? (
            <LogLines
              text={jobLog.text}
              showTimestamps={showTimestamps}
              maxHeight={maxHeight}
              marks={marks}
              focusLine={active?.line ?? null}
              onPickMark={setCurrent}
            />
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
              <LogLines
                text={runLog.text}
                showTimestamps={showTimestamps}
                maxHeight={maxHeight}
                marks={marks}
                focusLine={active?.line ?? null}
                onPickMark={setCurrent}
              />
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

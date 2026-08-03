/**
 * Progress and result UI for "Explain with Claude".
 *
 * A dialog rather than an inline button state because the operation is long (fetching
 * a whole failed log, then a model call that can take a minute or two) and has real
 * phases worth showing. The phases and the streaming reply come from the main process,
 * so nothing here is a decorative spinner: what you see is where the time is actually
 * going, and Stop really kills the local processes.
 */

import { useEffect, useState } from 'react';
import { Box, Button, Flash, Octicon, Spinner, Text } from '@primer/react';
import {
  CheckCircleFillIcon,
  CheckIcon,
  DotFillIcon,
  PlayIcon,
  PlusIcon,
} from '@primer/octicons-react';
import { subtleScrollbarSx } from '../lib/scrollbar';
import { useStickToBottom } from '../hooks/useStickToBottom';
import type { ClaudePhase } from '../storage/desktopClaude';
import { splitIntoSentenceLines, type ClaudeDepth } from '../lib/claudePrompt';
import { MarkdownView } from './MarkdownView';
import type { TriageState } from '../hooks/useClaudeTriage';
import { Modal } from './Modal';

/**
 * The first phase's label has to match what is actually happening. "Reading the log
 * already fetched" is true only when the app really had it — saying it during a
 * multi-megabyte download makes a slow but working fetch look like a hang.
 */
export function phasesFor(depth: ClaudeDepth, logCached: boolean): { id: ClaudePhase; label: string }[] {
  return [
    {
      id: 'fetching-log',
      label:
        depth === 'quick'
          ? logCached
            ? 'Reading the log already fetched'
            : 'Downloading the job’s log'
          : 'Fetching the failed step’s log',
    },
    {
      id: 'analysing',
      label:
        depth === 'quick'
          ? 'Asking claude'
          : depth === 'blame'
            ? 'Reading the run history and diffs'
            : 'Investigating with claude',
    },
    { id: 'done', label: 'Done' },
  ];
}

/**
 * Where the analysed log came from. `app` means something different per depth: for the
 * deep read it's a fallback worth flagging, but the quick read never calls gh in the
 * first place, so reporting a gh failure there would invent a problem that didn't happen.
 */
function sourceNote(source: string, depth: ClaudeDepth): string | null {
  if (source === 'gh') return 'read the whole run’s failed steps via gh';
  // No log at all — worth saying loudly, since it bounds how much the answer can know.
  if (source === 'none') return 'no log was available, so this works from the annotations alone';
  if (source !== 'app') return null;
  return depth === 'quick'
    ? 'analysed the log Job Monitor had already fetched'
    : 'gh couldn’t supply a log, so the job’s own log was used instead';
}

function phaseIndex(phases: { id: ClaudePhase }[], phase: ClaudePhase | null): number {
  return phase ? phases.findIndex((p) => p.id === phase) : -1;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Ticking elapsed time, so a long call visibly progresses even between phases. */
function useElapsed(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running, startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1000));
}

/** Prose, not a terminal: the model's answer is Markdown and reads as text. */
const proseBoxSx = {
  p: 2,
  bg: 'canvas.inset',
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'border.default',
  ...subtleScrollbarSx,
} as const;

const logBoxSx = {
  m: 0,
  p: 2,
  fontFamily: 'mono',
  fontSize: 0,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  bg: 'canvas.inset',
  color: 'fg.default',
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'border.default',
  maxHeight: 260,
  overflowY: 'auto',
  ...subtleScrollbarSx,
} as const;

/** What each depth is for, said plainly in the dialog. */
const DEPTH_BLURB: Record<ClaudeDepth, string> = {
  quick: 'A one-minute read of the failed job’s log — no digging, no fetching beyond the log itself. Runs Sonnet.',
  deep: 'Fetches the run’s artifacts, the workflow file and the PR diff before answering. Runs Opus, and can take a few minutes.',
  log: 'Rewrites the log itself — decisive lines first, noise cut, short notes where a line needs one. Real log text, with the searching already done.',
  blame: 'Names the commit that broke this flow and its author. When several commits landed between runs, it weighs them by what each one changed. Runs Opus.',
};

const DEPTH_TITLE: Record<ClaudeDepth, string> = {
  quick: 'Quick read',
  deep: 'Deep analysis',
  log: 'Readable log',
  blame: 'Who broke it',
};

/**
 * One line of the commands feed, with its verb picked out.
 *
 * Kept here rather than in the log highlighter: `$`, `read`, `grep` and `glob` are labels
 * this app writes (see describeToolUse), not CI log vocabulary, and teaching the log
 * classifier about them would make it fire on ordinary log text that happens to start
 * with "read".
 */
function ActivityLine({ line }: { line: string }) {
  const m = /^(\$|read|grep|glob)\s+(.*)$/s.exec(line);
  if (!m) {
    return <Box as="span" sx={{ display: 'block' }}>{line}</Box>;
  }
  return (
    <Box as="span" sx={{ display: 'block' }}>
      <Text as="span" sx={{ color: 'accent.fg' }}>{m[1]}</Text> {m[2]}
    </Box>
  );
}

export function ClaudeTriageDialog({
  jobName,
  depth,
  state,
  onCancel,
  onRetry,
  onContinue,
  onToggleInReport,
  onClose,
}: {
  jobName: string;
  depth: ClaudeDepth;
  state: TriageState;
  onCancel: () => void;
  onRetry: () => void;
  /** Pick the unfinished run up where it stopped. */
  onContinue: () => void;
  /** Carry this result into the bug report, or take it back out. */
  onToggleInReport: () => void;
  onClose: () => void;
}) {
  const phases = phasesFor(depth, state.logCached);
  const elapsed = useElapsed(state.startedAt, state.running);
  const active = phaseIndex(phases, state.phase);
  const finished = Boolean(state.analysis || state.document) && !state.running;

  // Both feeds follow their newest line as it arrives, and stop following if the
  // reader scrolls up.
  const activityRef = useStickToBottom<HTMLPreElement>(state.activity.length);
  // A div now, not a <pre>: the narration is rendered Markdown.
  const writingRef = useStickToBottom<HTMLDivElement>(state.partial);

  return (
    <Modal
      title={DEPTH_TITLE[depth]}
      subtitle={jobName}
      onClose={onClose}
      footer={
        <>
          {state.running ? (
            <Button variant="danger" onClick={onCancel}>
              Stop
            </Button>
          ) : (
            <>
              {/*
                Continuing is offered first and as the primary action: a run that stopped
                after twenty minutes of investigation has established a great deal, and
                starting again pays for all of it a second time.
              */}
              {state.sessionId && state.incompleteReason && (
                <Button variant="primary" leadingVisual={PlayIcon} onClick={onContinue}>
                  Continue
                </Button>
              )}
              <Button onClick={onRetry}>
                {state.analysis || state.document ? 'Re-analyse' : 'Try again'}
              </Button>
            </>
          )}
          {/*
            A document task has no "problem / suggested fix" to fold into the report
            automatically, so including its verdict is an explicit choice — and one worth
            remembering, since the report is usually built later than the analysis.
          */}
          {finished && state.document && (
            <Button
              variant={state.inReport ? 'default' : 'primary'}
              leadingVisual={state.inReport ? CheckIcon : PlusIcon}
              onClick={onToggleInReport}
            >
              {state.inReport ? 'In the report' : 'Add verdict to report'}
            </Button>
          )}
          <Button
            variant={finished && !state.document ? 'primary' : 'default'}
            onClick={onClose}
          >
            {finished && state.analysis ? 'Use in report' : 'Close'}
          </Button>
        </>
      }
    >
      <Text as="p" sx={{ color: 'fg.muted', fontSize: 0, mt: 0, mb: 3 }}>
        {DEPTH_BLURB[depth]} Runs your local <code>claude</code>
        {depth === 'deep' ? (
          <>
            {' '}and <code>gh</code>
          </>
        ) : null}
        ; the log is sent to Claude for analysis — the only thing Job Monitor sends outside GitHub.
      </Text>

      {/* Phases, so a long wait is legible rather than a blank spinner. */}
      <Box sx={{ mb: 3 }}>
        {phases.map((phase, index) => {
          const done = active > index || finished;
          const isActive = state.running && active === index;
          return (
            <Box
              key={phase.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1, fontSize: 1 }}
            >
              {isActive ? (
                <Spinner size="small" />
              ) : (
                <Octicon
                  icon={done ? CheckCircleFillIcon : DotFillIcon}
                  size={16}
                  sx={{ color: done ? 'success.fg' : 'fg.subtle' }}
                />
              )}
              <Text sx={{ color: done || isActive ? 'fg.default' : 'fg.muted' }}>{phase.label}</Text>
              {phase.id === 'fetching-log' && state.logBytes > 0 && (
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  {formatBytes(state.logBytes)}
                </Text>
              )}
              {phase.id === 'fetching-log' && state.retrying && (
                <Text sx={{ fontSize: 0, color: 'attention.fg' }}>retrying…</Text>
              )}
            </Box>
          );
        })}
      </Box>

      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, color: 'fg.muted', flexWrap: 'wrap' }}
      >
        <Text sx={{ fontSize: 0 }}>{elapsed}s elapsed</Text>
        {state.logSource && sourceNote(state.logSource, depth) && (
          <Text sx={{ fontSize: 0 }}>· {sourceNote(state.logSource, depth)}</Text>
        )}
        {state.logTruncated && (
          <Text sx={{ fontSize: 0 }}>· log was large, only its start and end were analysed</Text>
        )}
      </Box>

      {state.toolsUnavailable && (
        <Flash variant="warning" sx={{ mb: 3, fontSize: 0 }}>
          Your <code>claude</code> couldn’t be given tools, so this run only reads the log that was
          already fetched — it can’t pull artifacts or the diff.
        </Flash>
      )}

      {/*
        Two panes, and they answer different questions. This one is the commands it ran —
        the literal tool calls. The one below is the same story in words. Both stay after
        the run finishes and are restored from the cache when a stored analysis is
        reopened: the trail is what the conclusion rests on.
      */}
      {state.activity.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted', display: 'block', mb: 1 }}>
            What Claude is doing
          </Text>
          <Box as="pre" ref={activityRef} sx={{ ...logBoxSx, maxHeight: 160 }}>
            {state.activity.map((line, i) => (
              <ActivityLine key={i} line={line} />
            ))}
          </Box>
        </Box>
      )}

      {/*
        A cut-short answer is still an answer, but it must not read as a finished one — the
        commit list may be missing the candidate it never got to.
      */}
      {state.incompleteReason && !state.running && (
        <Flash variant="warning" sx={{ mb: 3, fontSize: 0 }}>
          Claude stopped before finishing — {state.incompleteReason}. What it wrote is below, but treat
          it as partial.{' '}
          {state.sessionId ? (
            <>
              <strong>Continue</strong> picks up where it stopped, keeping everything it has already
              worked out; <strong>Re-analyse</strong> starts over.
            </>
          ) : (
            <>
              <strong>Re-analyse</strong> starts again.
            </>
          )}
        </Flash>
      )}

      {state.error && (
        <Flash variant="danger" sx={{ mb: 3, fontSize: 1 }}>
          {state.error}
        </Flash>
      )}

      {/*
        The narration — what it is doing, in plain English, rather than as argv. Kept
        after the run rather than swapped out for the conclusion: the reasoning is how the
        conclusion is judged, and it was the half that vanished the moment it finished.
      */}
      {state.partial && (
        <>
          <Text sx={{ fontSize: 0, fontWeight: 'bold', color: 'fg.muted', display: 'block', mb: 1 }}>
            What Claude is writing
          </Text>
          {/*
            Sentence-split for display, the same way the finished analysis is. Without it
            the live pane shows one long paragraph per turn while the final text shows one
            sentence per line — the same content reading two different ways.
          */}
          <Box ref={writingRef} sx={{ ...proseBoxSx, maxHeight: 260, overflowY: 'auto' }}>
            <MarkdownView markdown={splitIntoSentenceLines(state.partial)} />
          </Box>
        </>
      )}

      {/*
        The document tasks answer with their own structure — a blame report has a verdict, a
        boundary, suspects and a flaky-test table — so it is rendered whole rather than
        squeezed into "problem / suggested fix", which would lose exactly that structure.
      */}
      {state.document && state.document !== state.partial.trim() && (
        <Box sx={proseBoxSx}>
          <MarkdownView markdown={state.document} />
        </Box>
      )}

      {state.analysis && (
        <>
          <Text as="h3" sx={{ fontSize: 1, fontWeight: 'bold', mb: 1 }}>
            The problem
          </Text>
          {/*
            Rendered, not shown raw. The model is asked for Markdown and it uses it — the
            decisive log line comes back in backticks, and as monospace text that quoting
            was invisible. A quoted log line inside it is coloured like the log itself.
          */}
          <Box sx={{ ...proseBoxSx, mb: 3 }}>
            {state.analysis.problem ? (
              <MarkdownView markdown={state.analysis.problem} />
            ) : (
              <Text sx={{ color: 'fg.muted' }}>(nothing returned)</Text>
            )}
          </Box>
          <Text as="h3" sx={{ fontSize: 1, fontWeight: 'bold', mb: 1 }}>
            Suggested fix
          </Text>
          <Box sx={proseBoxSx}>
            {state.analysis.solution ? (
              <MarkdownView markdown={state.analysis.solution} />
            ) : (
              <Text sx={{ color: 'fg.muted' }}>(nothing returned)</Text>
            )}
          </Box>
          <Text as="p" sx={{ color: 'fg.muted', fontSize: 0, mb: 0 }}>
            Both are now part of the report — the problem at the top, the suggested fix collapsed at
            the end.
          </Text>
        </>
      )}
    </Modal>
  );
}

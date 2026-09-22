/**
 * What Claude is doing right now, as a strip at the top rather than a window in the way.
 *
 * The two data tasks start **on their own** — the cause when you focus a failure, the log map
 * when you open its log — and work that starts by itself must not open a modal. A dialog that
 * appears without being asked for is an interruption, and it hides the very thing it is
 * reporting on: the pane behind it is where the answer is going to land.
 *
 * So progress goes here: one line per running task, at the top of the working area, saying which
 * task, which phase, what it last did, how long it has been going, and offering **Stop**. That is
 * everything the dialog's progress half carried; what it does not carry is the result, because
 * the result now has a place of its own.
 *
 * The dialog still exists for the tasks you *ask* for — the quick read, the deep analysis, who
 * broke it — where it is the window you opened deliberately and where the answer is displayed.
 */

import { Button, Spinner, Text } from '@primer/react';
import { BeakerIcon, TelescopeIcon } from '@primer/octicons-react';
import type { ClaudeDepth } from '../lib/claudePrompt';
import { useElapsed } from '../hooks/useElapsed';
import type { TriageState } from '../hooks/useClaudeTriage';
import styles from './AiProgressNotice.module.css';
import { Icon } from './Icon';

/** What the strip calls each automatic task, in the present tense. */
const TITLE: Partial<Record<ClaudeDepth, string>> = {
  cause: 'Working out what failed',
  marks: 'Mapping the log',
};

const ICON: Partial<Record<ClaudeDepth, typeof BeakerIcon>> = {
  cause: BeakerIcon,
  marks: TelescopeIcon,
};

/** Where the time is going, in the strip's shorter words. */
function phaseLabel(state: TriageState): string | null {
  switch (state.phase) {
    case 'fetching-log':
      return state.logCached ? 'reading the log' : 'downloading the log';
    case 'analysing':
      return 'asking claude';
    default:
      return null;
  }
}

function Row({
  depth,
  state,
  onStop,
}: {
  depth: ClaudeDepth;
  state: TriageState;
  onStop: () => void;
}) {
  const elapsed = useElapsed(state.startedAt, state.running);
  // The newest tool call. One line, not the feed: this is a strip, and the whole trail is in the
  // analysis it belongs to.
  const activity = state.activity.length > 0 ? state.activity[state.activity.length - 1] : null;

  return (
    <div className={styles.row}>
      <Spinner size="small" />
      <Icon icon={ICON[depth] ?? BeakerIcon} size={14} className={styles.icon} />
      <Text className={styles.title}>{TITLE[depth] ?? 'Working'}</Text>
      {phaseLabel(state) && <Text className={styles.phase}>· {phaseLabel(state)}</Text>}
      {activity && (
        <Text className={styles.activity} title={activity}>
          {activity}
        </Text>
      )}
      <div className={styles.grow} />
      <Text className={styles.elapsed}>{elapsed}s</Text>
      <Button size="small" variant="invisible" onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}

export function AiProgressNotice({
  running,
  onStop,
}: {
  /** The automatic tasks in flight, in the order they should be listed. */
  running: { depth: ClaudeDepth; state: TriageState }[];
  onStop: (depth: ClaudeDepth) => void;
}) {
  if (running.length === 0) return null;
  return (
    <div className={styles.strip}>
      {running.map(({ depth, state }) => (
        <Row key={depth} depth={depth} state={state} onStop={() => onStop(depth)} />
      ))}
    </div>
  );
}

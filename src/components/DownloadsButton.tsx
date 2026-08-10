import { AnchoredOverlay, Button, Heading, IconButton, ProgressBar, Spinner, Text } from '@primer/react';
import { CheckCircleFillIcon, DownloadIcon, FileZipIcon, XCircleFillIcon } from '@primer/octicons-react';
import { isDesktop } from '../storage/desktopSecret';
import { useDownloads, type DownloadTask } from '../context/DownloadsContext';
import { subtleScrollbar } from '../lib/scrollbar';
import styles from './DownloadsButton.module.css';

/**
 * Header control (desktop only) that opens a downloads panel showing each
 * download's progress and status, with a "show in folder" action when done.
 * In a plain browser this renders nothing — the browser owns the download UI.
 */
export function DownloadsButton() {
  const { tasks, activeCount, panelOpen, setPanelOpen, saveTask, clearFinished, reveal } = useDownloads();
  if (!isDesktop()) return null;

  const finishedCount = tasks.filter((t) => t.status !== 'running').length;

  return (
    <AnchoredOverlay
      open={panelOpen}
      onOpen={() => setPanelOpen(true)}
      onClose={() => setPanelOpen(false)}
      side="outside-bottom"
      align="end"
      width="auto"
      renderAnchor={(anchorProps) => {
        // Primer 38 already omits `aria-labelledby` from the anchor props, so there is nothing left
        // to strip: IconButton's aria typing is exclusive (label XOR labelledby), and our
        // `aria-label` below is now the only one either way.
        return (
        <div className={styles.relative}>
          <IconButton
            {...anchorProps}
            icon={DownloadIcon}
            aria-label={`Downloads${activeCount > 0 ? ` (${activeCount} active)` : ''}`}
            variant="invisible"
          />
          {activeCount > 0 && (
            <div
              className={styles.badge}
            >
              {activeCount}
            </div>
          )}
        </div>
        );
      }}
    >
      <div className={styles.width}>
        <div
          className={styles.flexCenter}
        >
          <Heading as="h3" className={styles.body}>Downloads</Heading>
          <div className={styles.grow} />
          {finishedCount > 0 && (
            <Button variant="invisible" size="small" onClick={clearFinished}>Clear</Button>
          )}
        </div>
        <div className={`${styles.list} ${subtleScrollbar}`}>
          {tasks.length === 0 ? (
            <Text className={styles.blockP3}>No downloads yet.</Text>
          ) : (
            tasks.map((t) => <DownloadRow key={t.id} task={t} onSave={saveTask} onReveal={reveal} />)
          )}
        </div>
      </div>
    </AnchoredOverlay>
  );
}

function DownloadRow({
  task,
  onSave,
  onReveal,
}: {
  task: DownloadTask;
  onSave: (task: DownloadTask) => void;
  onReveal: (path: string) => void;
}) {
  const percent =
    task.total && task.total > 0 ? Math.round(((task.done ?? 0) / task.total) * 100) : null;
  const inFlight = task.status === 'running' || task.status === 'saving';
  return (
    <div className={styles.px3Py2}>
      <div className={styles.flexCenter2}>
        {inFlight ? (
          <Spinner size="small" />
        ) : task.status === 'done' ? (
          <CheckCircleFillIcon className={styles.successFg} />
        ) : task.status === 'error' ? (
          <XCircleFillIcon className={styles.dangerFg} />
        ) : (
          <FileZipIcon className={styles.fgMuted} />
        )}
        <Text className={styles.growBody}>
          {task.name}
        </Text>
        {task.status === 'ready' && (
          <Button variant="primary" size="small" leadingVisual={DownloadIcon} onClick={() => onSave(task)}>
            Save
          </Button>
        )}
      </div>
      {task.status === 'running' && (
        <div className={styles.mt1Ml4}>
          {percent != null ? (
            <ProgressBar progress={percent} className={styles.mb1} aria-label="Download progress" />
          ) : null}
          <Text className={styles.smallFgMuted}>
            {task.phase
              ? `${task.phase}${task.total ? ` · ${task.done ?? 0}/${task.total}` : ''}`
              : 'Downloading…'}
          </Text>
        </div>
      )}
      {task.status === 'saving' && (
        <Text className={styles.blockMt1}>Saving…</Text>
      )}
      {task.status === 'error' && (
        <Text className={styles.blockMt1_2}>{task.error}</Text>
      )}
      {task.status === 'done' && task.savedPath && (
        <Button variant="invisible" size="small" className={styles.mt1Ml3} onClick={() => onReveal(task.savedPath!)}>
          Show in folder
        </Button>
      )}
    </div>
  );
}

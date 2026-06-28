import { AnchoredOverlay, Box, Button, Heading, IconButton, Octicon, ProgressBar, Spinner, Text } from '@primer/react';
import { CheckCircleFillIcon, DownloadIcon, FileZipIcon, XCircleFillIcon } from '@primer/octicons-react';
import { isDesktop } from '../storage/desktopSecret';
import { useDownloads, type DownloadTask } from '../context/DownloadsContext';
import { subtleScrollbarSx } from '../lib/scrollbar';

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
      renderAnchor={(props) => {
        // IconButton's aria typing is exclusive (label XOR labelledby); drop the
        // overlay's aria-labelledby so our aria-label is the single source.
        const { 'aria-labelledby': labelledBy, ...anchorProps } = props;
        void labelledBy;
        return (
        <Box sx={{ position: 'relative', display: 'inline-flex' }}>
          <IconButton
            {...anchorProps}
            icon={DownloadIcon}
            aria-label={`Downloads${activeCount > 0 ? ` (${activeCount} active)` : ''}`}
            variant="invisible"
          />
          {activeCount > 0 && (
            <Box
              sx={{
                position: 'absolute',
                top: -2,
                right: -2,
                minWidth: 16,
                height: 16,
                px: 1,
                bg: 'accent.emphasis',
                color: 'fg.onEmphasis',
                borderRadius: 10,
                fontSize: '10px',
                lineHeight: '16px',
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              {activeCount}
            </Box>
          )}
        </Box>
        );
      }}
    >
      <Box sx={{ width: 360, maxWidth: '90vw' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            px: 3,
            py: 2,
            borderBottom: '1px solid',
            borderColor: 'border.default',
          }}
        >
          <Heading as="h3" sx={{ fontSize: 1 }}>Downloads</Heading>
          <Box sx={{ flex: 1 }} />
          {finishedCount > 0 && (
            <Button variant="invisible" size="small" onClick={clearFinished}>Clear</Button>
          )}
        </Box>
        <Box sx={{ maxHeight: 360, overflowY: 'auto', ...subtleScrollbarSx }}>
          {tasks.length === 0 ? (
            <Text sx={{ display: 'block', p: 3, color: 'fg.muted', fontSize: 1 }}>No downloads yet.</Text>
          ) : (
            tasks.map((t) => <DownloadRow key={t.id} task={t} onSave={saveTask} onReveal={reveal} />)
          )}
        </Box>
      </Box>
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
    <Box sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'border.muted' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {inFlight ? (
          <Spinner size="small" />
        ) : task.status === 'done' ? (
          <Octicon icon={CheckCircleFillIcon} sx={{ color: 'success.fg' }} />
        ) : task.status === 'error' ? (
          <Octicon icon={XCircleFillIcon} sx={{ color: 'danger.fg' }} />
        ) : (
          <Octicon icon={FileZipIcon} sx={{ color: 'fg.muted' }} />
        )}
        <Text sx={{ flex: 1, minWidth: 0, fontSize: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.name}
        </Text>
        {task.status === 'ready' && (
          <Button variant="primary" size="small" leadingVisual={DownloadIcon} onClick={() => onSave(task)}>
            Save
          </Button>
        )}
      </Box>
      {task.status === 'running' && (
        <Box sx={{ mt: 1, ml: 4 }}>
          {percent != null ? (
            <ProgressBar progress={percent} sx={{ mb: 1 }} aria-label="Download progress" />
          ) : null}
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
            {task.phase
              ? `${task.phase}${task.total ? ` · ${task.done ?? 0}/${task.total}` : ''}`
              : 'Downloading…'}
          </Text>
        </Box>
      )}
      {task.status === 'saving' && (
        <Text sx={{ display: 'block', mt: 1, ml: 4, fontSize: 0, color: 'fg.muted' }}>Saving…</Text>
      )}
      {task.status === 'error' && (
        <Text sx={{ display: 'block', mt: 1, ml: 4, fontSize: 0, color: 'danger.fg' }}>{task.error}</Text>
      )}
      {task.status === 'done' && task.savedPath && (
        <Button variant="invisible" size="small" sx={{ mt: 1, ml: 3 }} onClick={() => onReveal(task.savedPath!)}>
          Show in folder
        </Button>
      )}
    </Box>
  );
}

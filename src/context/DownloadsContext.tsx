import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Box, Button, IconButton, Octicon, Text } from '@primer/react';
import { CheckCircleFillIcon, XCircleFillIcon, XIcon } from '@primer/octicons-react';
import { isDesktop } from '../storage/desktopSecret';
import { canSaveToDisk, saveToDisk, showInFolder } from '../storage/desktopDownloads';
import { saveBlob } from '../lib/downloadArtifact';

export type DownloadStatus = 'running' | 'ready' | 'saving' | 'done' | 'error';

export interface DownloadTask {
  id: string;
  name: string;
  status: DownloadStatus;
  /** Determinate progress (e.g. artifacts processed in a bundle). */
  done?: number;
  total?: number;
  /** What's happening right now (e.g. the current artifact name). */
  phase?: string;
  /** Fetched/built bytes held until the user saves (desktop only). */
  blob?: Blob;
  savedPath?: string;
  error?: string;
}

export interface DownloadReport {
  done?: number;
  total?: number;
  phase?: string;
}

/** Produces the bytes to save; calls `report` to surface progress. */
export type DownloadProducer = (
  report: (p: DownloadReport) => void,
) => Promise<{ data: Blob; filename: string }>;

interface DownloadsContextValue {
  tasks: DownloadTask[];
  activeCount: number;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /**
   * Fetch/build the data. On the desktop it's then held in the panel as "ready"
   * and saved only when the user clicks Save; in the browser it downloads at once.
   */
  run: (name: string, producer: DownloadProducer) => Promise<void>;
  /** Write a ready task's bytes to disk (desktop). */
  saveTask: (task: DownloadTask) => void;
  clearFinished: () => void;
  reveal: (path: string) => void;
}

const DownloadsContext = createContext<DownloadsContextValue>({
  tasks: [],
  activeCount: 0,
  panelOpen: false,
  setPanelOpen: () => {},
  run: async () => {},
  saveTask: () => {},
  clearFinished: () => {},
  reveal: () => {},
});

export function useDownloads(): DownloadsContextValue {
  return useContext(DownloadsContext);
}

let seq = 0;

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [alert, setAlert] = useState<DownloadTask | null>(null);

  const patch = useCallback((id: string, p: Partial<DownloadTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  const reveal = useCallback((path: string) => void showInFolder(path), []);

  const run = useCallback(
    async (name: string, producer: DownloadProducer) => {
      const id = `dl-${++seq}`;
      setTasks((prev) => [{ id, name, status: 'running' }, ...prev]);
      if (isDesktop()) setPanelOpen(true); // surface the panel as work begins
      try {
        const { data, filename } = await producer((rep) => patch(id, rep));
        if (canSaveToDisk()) {
          // Desktop: stage the bytes; the user saves from the panel.
          patch(id, { status: 'ready', name: filename, blob: data, phase: undefined });
        } else {
          // Browser: let the browser handle the download.
          saveBlob(data, filename);
          patch(id, { status: 'done', name: filename });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Download failed.';
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'error', error: message } : t)));
        if (isDesktop()) setAlert({ id, name, status: 'error', error: message });
        throw err; // let the caller (dialog) show inline feedback too
      }
    },
    [patch],
  );

  const saveTask = useCallback(
    async (task: DownloadTask) => {
      if (!task.blob) return;
      patch(task.id, { status: 'saving' });
      try {
        const bytes = new Uint8Array(await task.blob.arrayBuffer());
        const savedPath = await saveToDisk(task.name, bytes);
        if (!savedPath) saveBlob(task.blob, task.name); // IPC failed → browser fallback
        const done: DownloadTask = { ...task, status: 'done', savedPath: savedPath ?? undefined, blob: undefined };
        setTasks((prev) => prev.map((t) => (t.id === task.id ? done : t)));
        setAlert(done);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Save failed.';
        patch(task.id, { status: 'error', error: message });
        setAlert({ ...task, status: 'error', error: message, blob: undefined });
      }
    },
    [patch],
  );

  const clearFinished = useCallback(
    () => setTasks((prev) => prev.filter((t) => t.status === 'running' || t.status === 'ready' || t.status === 'saving')),
    [],
  );

  // "Active" = anything not finished (in-flight or waiting for the user to save).
  const activeCount = useMemo(
    () => tasks.filter((t) => t.status !== 'done' && t.status !== 'error').length,
    [tasks],
  );

  const value = useMemo(
    () => ({ tasks, activeCount, panelOpen, setPanelOpen, run, saveTask: (t: DownloadTask) => void saveTask(t), clearFinished, reveal }),
    [tasks, activeCount, panelOpen, run, saveTask, clearFinished, reveal],
  );

  return (
    <DownloadsContext.Provider value={value}>
      {children}
      {isDesktop() && alert && (
        <DownloadAlert task={alert} onClose={() => setAlert(null)} onReveal={reveal} />
      )}
    </DownloadsContext.Provider>
  );
}

/** Transient toast shown when a download is saved (or fails). Desktop only. */
function DownloadAlert({
  task,
  onClose,
  onReveal,
}: {
  task: DownloadTask;
  onClose: () => void;
  onReveal: (path: string) => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 7000);
    return () => clearTimeout(t);
  }, [task, onClose]);

  const ok = task.status === 'done';
  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 1100,
        maxWidth: 380,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 2,
        p: 2,
        bg: 'canvas.overlay',
        border: '1px solid',
        borderColor: 'border.default',
        borderRadius: 2,
        boxShadow: 'shadow.large',
      }}
    >
      <Octicon
        icon={ok ? CheckCircleFillIcon : XCircleFillIcon}
        sx={{ color: ok ? 'success.fg' : 'danger.fg', mt: '2px' }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Text sx={{ fontWeight: 'bold', display: 'block' }}>
          {ok ? 'Saved to Downloads' : 'Download failed'}
        </Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted', wordBreak: 'break-word' }}>
          {ok ? task.name : `${task.name} — ${task.error ?? 'error'}`}
        </Text>
        {ok && task.savedPath && (
          <Button variant="invisible" size="small" sx={{ mt: 1 }} onClick={() => onReveal(task.savedPath!)}>
            Show in folder
          </Button>
        )}
      </Box>
      <IconButton icon={XIcon} aria-label="Dismiss" variant="invisible" size="small" onClick={onClose} />
    </Box>
  );
}

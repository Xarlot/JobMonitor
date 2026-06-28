import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Checkbox, Flash, IconButton, Label, Spinner, Text } from '@primer/react';
import { DownloadIcon, FileZipIcon } from '@primer/octicons-react';
import type { Artifact, ArtifactsResponse } from '../api/types';
import { ghGet, ghGetBlob, GitHubApiError } from '../api/githubClient';
import { artifactZipPath, runArtifactsPath } from '../api/endpoints';
import { artifactFileName } from '../lib/downloadArtifact';
import { bundleArtifacts, type BundleProgress } from '../lib/artifactBundle';
import { formatBytes } from '../lib/format';
import { useDownloads } from '../context/DownloadsContext';
import { isDesktop } from '../storage/desktopSecret';
import { Modal } from './Modal';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; artifacts: Artifact[] }
  | { phase: 'error'; message: string };

const cellSx = {
  px: 2,
  py: '8px',
  borderColor: 'border.muted',
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
  fontSize: 1,
  verticalAlign: 'middle',
} as const;

/**
 * Lists a run's artifacts in a scrollable grid (sorted by name) and downloads
 * them: a single artifact as its own zip, or several as one combined zip with a
 * folder per artifact. Used for both flow runs and PR runs.
 */
export function ArtifactsDialog({
  owner,
  repo,
  runId,
  title,
  subtitle,
  bundleName,
  onClose,
}: {
  owner: string;
  repo: string;
  runId: number;
  title: string;
  subtitle?: string;
  bundleName: string;
  onClose: () => void;
}) {
  const { run } = useDownloads();
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [bundling, setBundling] = useState<BundleProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    ghGet<ArtifactsResponse>(runArtifactsPath(owner, repo, runId))
      .then(({ data }) => {
        if (!active) return;
        const sorted = [...(data.artifacts ?? [])].sort((a, b) => a.name.localeCompare(b.name));
        setState({ phase: 'loaded', artifacts: sorted });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState({
          phase: 'error',
          message: err instanceof GitHubApiError ? err.message : 'Failed to load artifacts.',
        });
      });
    return () => {
      active = false;
    };
  }, [owner, repo, runId]);

  const artifacts = state.phase === 'loaded' ? state.artifacts : [];
  const usable = useMemo(() => artifacts.filter((a) => !a.expired), [artifacts]);
  const busy = downloadingId != null || bundling != null;

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allSelected = usable.length > 0 && usable.every((a) => selected.has(a.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(usable.map((a) => a.id)));

  const downloadOne = (a: Artifact) => {
    const filename = artifactFileName(a.name);
    const producer = async () => ({
      data: await ghGetBlob(artifactZipPath(owner, repo, a.id)),
      filename,
    });
    // Desktop: hand off to the downloads panel and close this dialog so the panel
    // (and its Save button) isn't hidden behind the modal.
    if (isDesktop()) {
      void run(filename, producer).catch(() => {});
      onClose();
      return;
    }
    setError(null);
    setDownloadingId(a.id);
    run(filename, producer)
      .catch((err) => setError(err instanceof GitHubApiError ? err.message : 'Download failed.'))
      .finally(() => setDownloadingId(null));
  };

  const downloadBundle = (items: Artifact[]) => {
    if (items.length === 0) return;
    const filename = bundleName.toLowerCase().endsWith('.zip') ? bundleName : `${bundleName}.zip`;
    const producer = (report: (p: { done?: number; total?: number; phase?: string }) => void) =>
      bundleArtifacts(owner, repo, items, (p) => {
        report({ done: p.done, total: p.total, phase: p.current });
        setBundling(p);
      }).then((data) => ({ data, filename }));
    if (isDesktop()) {
      void run(filename, producer).catch(() => {});
      onClose();
      return;
    }
    setError(null);
    setBundling({ done: 0, total: items.length, current: '' });
    run(filename, producer)
      .catch((err) =>
        setError(err instanceof GitHubApiError ? err.message : err instanceof Error ? err.message : 'Bundle failed.'),
      )
      .finally(() => setBundling(null));
  };

  const selectedUsable = usable.filter((a) => selected.has(a.id));

  const footer = state.phase === 'loaded' && usable.length > 0 && (
    <>
      <Text sx={{ fontSize: 0, color: 'fg.muted', alignSelf: 'center', mr: 'auto' }}>
        {bundling
          ? `Bundling ${bundling.done}/${bundling.total}…`
          : `${selectedUsable.length} selected`}
      </Text>
      <Button
        disabled={busy || selectedUsable.length === 0}
        leadingVisual={DownloadIcon}
        onClick={() => void downloadBundle(selectedUsable)}
      >
        Download selected (.zip)
      </Button>
      <Button
        variant="primary"
        disabled={busy}
        leadingVisual={DownloadIcon}
        onClick={() => void downloadBundle(usable)}
      >
        Download all (.zip)
      </Button>
    </>
  );

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} footer={footer || undefined}>
      {state.phase === 'loading' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, color: 'fg.muted' }}>
          <Spinner size="small" /> <Text>Loading artifacts…</Text>
        </Box>
      )}
      {state.phase === 'error' && (
        <Flash variant="danger" sx={{ fontSize: 1 }}>{state.message}</Flash>
      )}
      {state.phase === 'loaded' && artifacts.length === 0 && (
        <Text sx={{ color: 'fg.muted' }}>No artifacts for this run.</Text>
      )}
      {state.phase === 'loaded' && artifacts.length > 0 && (
        <>
          {error && <Flash variant="danger" sx={{ mb: 2, fontSize: 1 }}>{error}</Flash>}
          <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <Box as="thead">
              <Box as="tr">
                <Box as="th" sx={{ ...cellSx, width: 36, fontWeight: 'bold' }}>
                  <Checkbox
                    checked={allSelected}
                    indeterminate={!allSelected && selectedUsable.length > 0}
                    onChange={toggleAll}
                    aria-label="Select all artifacts"
                  />
                </Box>
                <Box as="th" sx={{ ...cellSx, textAlign: 'left', color: 'fg.muted' }}>Name</Box>
                <Box as="th" sx={{ ...cellSx, textAlign: 'right', color: 'fg.muted', width: 110 }}>Size</Box>
                <Box as="th" sx={{ ...cellSx, width: 56 }} />
              </Box>
            </Box>
            <Box as="tbody">
              {artifacts.map((a) => (
                <Box as="tr" key={a.id}>
                  <Box as="td" sx={cellSx}>
                    <Checkbox
                      checked={selected.has(a.id)}
                      disabled={a.expired || busy}
                      onChange={() => toggle(a.id)}
                      aria-label={`Select ${a.name}`}
                    />
                  </Box>
                  <Box as="td" sx={cellSx}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <FileZipIcon />
                      <Text sx={{ fontWeight: 'bold' }}>{a.name}</Text>
                      {a.expired && <Label variant="secondary">expired</Label>}
                    </Box>
                  </Box>
                  <Box as="td" sx={{ ...cellSx, textAlign: 'right', color: 'fg.muted', whiteSpace: 'nowrap' }}>
                    {formatBytes(a.size_in_bytes)}
                  </Box>
                  <Box as="td" sx={{ ...cellSx, textAlign: 'right' }}>
                    <Box
                      sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 28,
                        height: 28,
                      }}
                    >
                      {downloadingId === a.id ? (
                        <Spinner size="small" />
                      ) : (
                        <IconButton
                          size="small"
                          variant="invisible"
                          icon={DownloadIcon}
                          aria-label={`Download ${a.name}`}
                          disabled={a.expired || busy}
                          onClick={() => void downloadOne(a)}
                        />
                      )}
                    </Box>
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        </>
      )}
    </Modal>
  );
}

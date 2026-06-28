import { useState } from 'react';
import { Box, IconButton } from '@primer/react';
import { FileZipIcon } from '@primer/octicons-react';
import { ArtifactsDialog } from './ArtifactsDialog';

/**
 * Icon button that opens the artifacts dialog for a run. Artifacts are a per-run
 * concept in the GitHub API, so the same control serves flow runs and PR runs.
 */
export function ArtifactsButton({
  owner,
  repo,
  runId,
  title,
  subtitle,
  bundleName,
  size = 'small',
}: {
  owner: string;
  repo: string;
  runId: number;
  title: string;
  subtitle?: string;
  bundleName: string;
  size?: 'small' | 'medium';
}) {
  const [open, setOpen] = useState(false);
  return (
    // Stop clicks from reaching an enclosing row (which would toggle expansion).
    <Box as="span" sx={{ display: 'inline-flex' }} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <IconButton
        size={size}
        variant="invisible"
        icon={FileZipIcon}
        aria-label="Artifacts"
        onClick={() => setOpen(true)}
      />
      {open && (
        <ArtifactsDialog
          owner={owner}
          repo={repo}
          runId={runId}
          title={title}
          subtitle={subtitle}
          bundleName={bundleName}
          onClose={() => setOpen(false)}
        />
      )}
    </Box>
  );
}

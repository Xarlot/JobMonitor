import { useEffect, useState } from 'react';
import { Box, Button, Flash, Spinner, Text } from '@primer/react';
import type { Job } from '../api/types';
import { ghGet } from '../api/githubClient';
import { singleJobPath } from '../api/endpoints';
import { Modal } from './Modal';
import { JobSummaryDialog } from './JobSummaryDialog';
import { JobLogsDialog } from './JobLogsDialog';

/**
 * For a PR check-run that maps to an Actions job, fetch the single job (to get
 * steps + check-run link) and reuse the same Summary / Logs dialogs as flows.
 */
export function CheckRunDialog({
  owner,
  repo,
  jobId,
  kind,
  onClose,
}: {
  owner: string;
  repo: string;
  jobId: number;
  kind: 'summary' | 'logs';
  onClose: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    ghGet<Job>(singleJobPath(owner, repo, jobId))
      .then(({ data }) => active && setJob(data))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [owner, repo, jobId]);

  if (error) {
    return (
      <Modal title="Check" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <Flash variant="danger" sx={{ fontSize: 0 }}>{error}</Flash>
      </Modal>
    );
  }
  if (!job) {
    return (
      <Modal title="Loading…" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
          <Spinner size="small" /> <Text sx={{ fontSize: 0 }}>Loading job…</Text>
        </Box>
      </Modal>
    );
  }
  return kind === 'summary' ? (
    <JobSummaryDialog owner={owner} repo={repo} job={job} onClose={onClose} />
  ) : (
    <JobLogsDialog owner={owner} repo={repo} job={job} onClose={onClose} />
  );
}

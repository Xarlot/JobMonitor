import { useState } from 'react';
import { Box, Button, Flash, Link, Octicon, Spinner, Text } from '@primer/react';
import { ChevronDownIcon, ChevronRightIcon, LinkExternalIcon } from '@primer/octicons-react';
import type { Job } from '../api/types';
import { fetchJobLog, logTtlMs } from '../api/logCache';
import { statusToOverall } from '../lib/status';
import { splitLogBySteps } from '../lib/logs';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';
import { formatDuration, formatTime } from '../lib/format';

const logBoxSx = {
  m: 0,
  p: 2,
  fontFamily: 'mono',
  fontSize: 0,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 360,
  overflowY: 'auto',
  bg: 'canvas.inset',
  color: 'fg.default',
} as const;

export function JobLogsDialog({
  owner,
  repo,
  job,
  onClose,
}: {
  owner: string;
  repo: string;
  job: Job;
  onClose: () => void;
}) {
  const [logsByStep, setLogsByStep] = useState<Record<number, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Fetch the whole job log exactly once (even on failure) so expanding more
  // steps — or a step with no logs — never re-triggers a fetch.
  const loadLogs = () => {
    if (attempted || loading) return;
    setAttempted(true);
    setLoading(true);
    setError(null);
    fetchJobLog(owner, repo, job.id, logTtlMs(job.status === 'completed'))
      .then((text) => setLogsByStep(splitLogBySteps(text, job.steps)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  const toggle = (n: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
    loadLogs();
  };

  const steps = [...job.steps].sort((a, b) => a.number - b.number);

  return (
    <Modal
      title={job.name}
      subtitle={`${owner}/${repo} · logs`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', mb: 2 }}>
        <StatusBadge status={statusToOverall(job.status, job.conclusion)} />
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          duration {formatDuration(job.started_at, job.completed_at)}
        </Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>started {formatTime(job.started_at)}</Text>
        <Box sx={{ flex: 1 }} />
        {job.html_url && (
          <Link href={job.html_url} target="_blank" rel="noreferrer">
            <Octicon icon={LinkExternalIcon} size={14} sx={{ mr: 1 }} />
            Open on GitHub
          </Link>
        )}
      </Box>
      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 3 }}>
        Expand a step to load its logs. Logs are fetched once for the whole job and split by step.
      </Text>

      {error && (
        <Flash variant="warning" sx={{ mb: 3, fontSize: 0 }}>
          Couldn’t load logs: {error}. A read-only fine-grained token can’t download Actions logs
          (GitHub returns 404); a classic token with <strong>repo + workflow</strong> scopes can.{' '}
          {job.html_url && (
            <Link href={job.html_url} target="_blank" rel="noreferrer">
              Open on GitHub
            </Link>
          )}
        </Flash>
      )}

      {steps.length === 0 ? (
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>No steps (job was skipped or not started).</Text>
      ) : (
        <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, overflow: 'hidden' }}>
          {steps.map((step, idx) => {
            const open = expanded.has(step.number);
            const stepLog = logsByStep?.[step.number];
            return (
              <Box key={`${step.number}-${step.name}`} sx={{ borderTop: idx > 0 ? '1px solid' : 'none', borderColor: 'border.muted' }}>
                <Box
                  onClick={() => toggle(step.number)}
                  sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: '6px', cursor: 'pointer', ':hover': { bg: 'canvas.subtle' } }}
                >
                  <Octicon icon={open ? ChevronDownIcon : ChevronRightIcon} size={14} sx={{ color: 'fg.muted' }} />
                  <StatusBadge status={statusToOverall(step.status, step.conclusion)} withText={false} size={14} />
                  <Text sx={{ fontSize: 0, flex: 1, minWidth: 0 }}>
                    <Text as="span" sx={{ color: 'fg.muted', mr: 1 }}>{step.number}.</Text>
                    {step.name}
                  </Text>
                  <Text sx={{ fontSize: 0, color: 'fg.muted', whiteSpace: 'nowrap' }}>
                    {formatDuration(step.started_at, step.completed_at)}
                  </Text>
                </Box>
                {open && (
                  <Box>
                    {loading && !stepLog ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted', px: 2, py: 2 }}>
                        <Spinner size="small" /> <Text sx={{ fontSize: 0 }}>Loading logs…</Text>
                      </Box>
                    ) : stepLog ? (
                      <Box as="pre" sx={logBoxSx}>{stepLog}</Box>
                    ) : (
                      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', px: 2, py: 2 }}>
                        {error ? '(logs unavailable — see note above)' : '(no log output for this step)'}
                      </Text>
                    )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Modal>
  );
}

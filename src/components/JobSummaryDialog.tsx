import { useEffect, useState } from 'react';
import { Box, Button, Flash, Label, Link, Octicon, Spinner, Text } from '@primer/react';
import { AlertIcon, InfoIcon, LinkExternalIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { Annotation, Job } from '../api/types';
import { ghGet } from '../api/githubClient';
import { checkRunAnnotationsPath, checkRunIdFromUrl } from '../api/endpoints';
import { statusToOverall } from '../lib/status';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';
import { formatDuration, formatTime } from '../lib/format';

const LEVEL_STYLE = {
  failure: { icon: XCircleFillIcon, color: 'danger.fg' },
  warning: { icon: AlertIcon, color: 'attention.fg' },
  notice: { icon: InfoIcon, color: 'accent.fg' },
} as const;

const cellSx = {
  px: 2,
  py: '6px',
  fontSize: 0,
  verticalAlign: 'middle',
  borderColor: 'border.muted',
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
} as const;

export function JobSummaryDialog({
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
  const checkRunId = checkRunIdFromUrl(job.check_run_url);
  const [annotations, setAnnotations] = useState<Annotation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (checkRunId == null) return;
    let active = true;
    setLoading(true);
    setError(null);
    ghGet<Annotation[]>(checkRunAnnotationsPath(owner, repo, checkRunId))
      .then(({ data }) => active && setAnnotations(data))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [owner, repo, checkRunId]);

  const steps = [...job.steps].sort((a, b) => a.number - b.number);

  return (
    <Modal
      title={job.name}
      subtitle={`${owner}/${repo} · summary`}
      onClose={onClose}
      footer={
        <>
          {job.html_url && (
            <Button
              leadingVisual={LinkExternalIcon}
              onClick={() => window.open(job.html_url as string, '_blank', 'noopener')}
            >
              Open job summary on GitHub
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', mb: 3 }}>
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

      <Text as="h3" sx={{ fontSize: 1, fontWeight: 'bold', color: 'fg.muted', mb: 2 }}>
        Annotations{annotations ? ` (${annotations.length})` : ''}
      </Text>
      {checkRunId == null ? (
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>No check-run linked to this job.</Text>
      ) : loading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
          <Spinner size="small" /> <Text sx={{ fontSize: 0 }}>Loading annotations…</Text>
        </Box>
      ) : error ? (
        <Flash variant="danger" sx={{ fontSize: 0 }}>{error}</Flash>
      ) : annotations && annotations.length > 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {annotations.map((a, i) => {
            const style = LEVEL_STYLE[a.annotation_level ?? 'notice'] ?? LEVEL_STYLE.notice;
            return (
              <Box key={i} sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, p: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                  <Octicon icon={style.icon} size={14} sx={{ color: style.color }} />
                  {a.title && <Text sx={{ fontWeight: 'bold', fontSize: 0 }}>{a.title}</Text>}
                  {a.path && a.path !== '.github' && (
                    <Label variant="secondary">
                      {a.path}
                      {a.start_line ? `:${a.start_line}` : ''}
                    </Label>
                  )}
                </Box>
                <Box as="pre" sx={{ m: 0, fontFamily: 'mono', fontSize: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {a.message ?? ''}
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>No annotations reported.</Text>
      )}

      <Text as="h3" sx={{ fontSize: 1, fontWeight: 'bold', color: 'fg.muted', mt: 3, mb: 2 }}>
        Steps ({steps.length})
      </Text>
      {steps.length === 0 ? (
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>No steps (job was skipped or not started).</Text>
      ) : (
        <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
          <Box as="tbody">
            {steps.map((step) => (
              <Box as="tr" key={`${step.number}-${step.name}`}>
                <Box as="td" sx={{ ...cellSx, width: 150 }}>
                  <StatusBadge status={statusToOverall(step.status, step.conclusion)} />
                </Box>
                <Box as="td" sx={cellSx}>
                  <Text as="span" sx={{ color: 'fg.muted', mr: 2 }}>{step.number}.</Text>
                  {step.name}
                </Box>
                <Box as="td" sx={{ ...cellSx, color: 'fg.muted', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {formatDuration(step.started_at, step.completed_at)}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Modal>
  );
}

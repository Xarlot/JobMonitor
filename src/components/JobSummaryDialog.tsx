import { useEffect, useState } from 'react';
import { Button, Flash, Label, Link, Spinner, Text } from '@primer/react';
import { AlertIcon, InfoIcon, LinkExternalIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { Annotation, Job } from '../api/types';
import { checkRunIdFromUrl } from '../api/endpoints';
import { fetchAnnotations } from '../api/annotations';
import { statusToOverall } from '../lib/status';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';
import { formatDuration, formatTime } from '../lib/format';
import styles from './JobSummaryDialog.module.css';
import { Icon } from './Icon';

const LEVEL_STYLE = {
  failure: { icon: XCircleFillIcon, color: 'var(--fgColor-danger)' },
  warning: { icon: AlertIcon, color: 'var(--fgColor-attention)' },
  notice: { icon: InfoIcon, color: 'var(--fgColor-accent)' },
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
    fetchAnnotations(owner, repo, checkRunId)
      .then((data) => active && setAnnotations(data))
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
      <div className={styles.flexCenter}>
        <StatusBadge status={statusToOverall(job.status, job.conclusion)} />
        <Text className={styles.smallFgMuted}>
          duration {formatDuration(job.started_at, job.completed_at)}
        </Text>
        <Text className={styles.smallFgMuted}>started {formatTime(job.started_at)}</Text>
        <div className={styles.grow} />
        {job.html_url && (
          <Link href={job.html_url} target="_blank" rel="noreferrer">
            <LinkExternalIcon size={14} className={styles.mr1} />
            Open on GitHub
          </Link>
        )}
      </div>

      <Text as="h3" className={styles.bodyBold}>
        Annotations{annotations ? ` (${annotations.length})` : ''}
      </Text>
      {checkRunId == null ? (
        <Text className={styles.smallFgMuted}>No check-run linked to this job.</Text>
      ) : loading ? (
        <div className={styles.flexCenter2}>
          <Spinner size="small" /> <Text className={styles.small}>Loading annotations…</Text>
        </div>
      ) : error ? (
        <Flash variant="danger" className={styles.small}>{error}</Flash>
      ) : annotations && annotations.length > 0 ? (
        <div className={styles.flexCol}>
          {annotations.map((a, i) => {
            const style = LEVEL_STYLE[a.annotation_level ?? 'notice'] ?? LEVEL_STYLE.notice;
            return (
              <div key={i} className={styles.roundedP2}>
                <div className={styles.flexCenter3}>
                  <Icon icon={style.icon} size={14} style={{ color: style.color }} />
                  {a.title && <Text className={styles.boldSmall}>{a.title}</Text>}
                  {a.path && a.path !== '.github' && (
                    <Label variant="secondary">
                      {a.path}
                      {a.start_line ? `:${a.start_line}` : ''}
                    </Label>
                  )}
                </div>
                <pre className={styles.m0Mono}>
                  {a.message ?? ''}
                </pre>
              </div>
            );
          })}
        </div>
      ) : (
        <Text className={styles.smallFgMuted}>No annotations reported.</Text>
      )}

      <Text as="h3" className={styles.bodyBold2}>
        Steps ({steps.length})
      </Text>
      {steps.length === 0 ? (
        <Text className={styles.smallFgMuted}>No steps (job was skipped or not started).</Text>
      ) : (
        <table className={styles.width}>
          <tbody>
            {steps.map((step) => (
              <tr key={`${step.number}-${step.name}`}>
                <td className={styles.px2Small}>
                  <StatusBadge status={statusToOverall(step.status, step.conclusion)} />
                </td>
                <td className={styles.px2Small2}>
                  <Text as="span" className={styles.fgMutedMr2}>{step.number}.</Text>
                  {step.name}
                </td>
                <td className={styles.px2Small3}>
                  {formatDuration(step.started_at, step.completed_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

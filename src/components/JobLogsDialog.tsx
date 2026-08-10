import { useState } from 'react';
import { Button, Flash, Link, Spinner, Text } from '@primer/react';
import { ChevronDownIcon, ChevronRightIcon, LinkExternalIcon } from '@primer/octicons-react';
import type { Job } from '../api/types';
import { fetchJobLog, logTtlMs } from '../api/logCache';
import { statusToOverall } from '../lib/status';
import { splitLogBySteps } from '../lib/logs';
import { LogLines } from './LogLines';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';
import { formatDuration, formatTime } from '../lib/format';
import styles from './JobLogsDialog.module.css';
import { Icon } from './Icon';

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
      <Text className={styles.smallFgMuted2}>
        Expand a step to load its logs. Logs are fetched once for the whole job and split by step.
      </Text>

      {error && (
        <Flash variant="warning" className={styles.mb3Small}>
          Couldn’t load logs: {error}. A read-only fine-grained token can’t download Actions logs
          (GitHub returns 404); a classic token with the <strong>repo</strong> scope can.{' '}
          {job.html_url && (
            <Link href={job.html_url} target="_blank" rel="noreferrer">
              Open on GitHub
            </Link>
          )}
        </Flash>
      )}

      {steps.length === 0 ? (
        <Text className={styles.smallFgMuted}>No steps (job was skipped or not started).</Text>
      ) : (
        <div className={styles.rounded}>
          {steps.map((step, idx) => {
            const open = expanded.has(step.number);
            const stepLog = logsByStep?.[step.number];
            return (
              <div key={`${step.number}-${step.name}`} className={idx > 0 ? styles.jobRowDivided : styles.jobRow}>
                <div
                  onClick={() => toggle(step.number)}
                  className={styles.jobHeader}
                >
                  <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size={14} className={styles.fgMuted} />
                  <StatusBadge status={statusToOverall(step.status, step.conclusion)} withText={false} size={14} />
                  <Text className={styles.smallGrow}>
                    <Text as="span" className={styles.fgMutedMr1}>{step.number}.</Text>
                    {step.name}
                  </Text>
                  <Text className={styles.smallFgMuted3}>
                    {formatDuration(step.started_at, step.completed_at)}
                  </Text>
                </div>
                {open && (
                  <div>
                    {loading && !stepLog ? (
                      <div className={styles.flexCenter2}>
                        <Spinner size="small" /> <Text className={styles.small}>Loading logs…</Text>
                      </div>
                    ) : stepLog ? (
                      <LogLines text={stepLog} maxHeight={360} />
                    ) : (
                      <Text className={styles.smallFgMuted4}>
                        {error ? '(logs unavailable — see note above)' : '(no log output for this step)'}
                      </Text>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

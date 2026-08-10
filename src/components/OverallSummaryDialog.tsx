import { useEffect, useState } from 'react';
import { Button, Flash, Label, Spinner, Text } from '@primer/react';
import { AlertIcon, InfoIcon, LinkExternalIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { Annotation, OverallStatus, WorkflowRun } from '../api/types';
import { checkRunIdFromUrl } from '../api/endpoints';
import { fetchAnnotationsOrEmpty } from '../api/annotations';
import { fetchAllRunJobs } from '../api/jobs';
import { statusToOverall } from '../lib/status';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';
import styles from './OverallSummaryDialog.module.css';
import { Icon } from './Icon';

export interface SummaryItem {
  id: string | number;
  label: string;
  status: OverallStatus;
  checkRunId: number | null;
}

type LabelVariant = 'danger' | 'attention' | 'success' | 'secondary';
const COUNT_META: { status: OverallStatus; label: string; variant: LabelVariant }[] = [
  { status: 'failure', label: 'failed', variant: 'danger' },
  { status: 'in_progress', label: 'in progress', variant: 'attention' },
  { status: 'pending', label: 'pending', variant: 'attention' },
  { status: 'success', label: 'passed', variant: 'success' },
  { status: 'neutral', label: 'skipped', variant: 'secondary' },
  { status: 'unknown', label: 'unknown', variant: 'secondary' },
];

const LEVEL_STYLE = {
  failure: { icon: XCircleFillIcon, color: 'var(--fgColor-danger)' },
  warning: { icon: AlertIcon, color: 'var(--fgColor-attention)' },
  notice: { icon: InfoIcon, color: 'var(--fgColor-accent)' },
} as const;

const MAX_ANNOTATION_FETCH = 40;

function isAttention(s: OverallStatus): boolean {
  return s === 'failure' || s === 'in_progress' || s === 'pending';
}

/** Fetches annotations for attention items and renders the actual content per item. */
function SummaryBody({ owner, repo, items }: { owner: string; repo: string; items: SummaryItem[] }) {
  const [annByItem, setAnnByItem] = useState<Record<string, Annotation[]>>({});
  const [annLoading, setAnnLoading] = useState(true);

  const attention = items.filter((i) => isAttention(i.status));
  const attentionKey = attention.map((i) => `${i.id}:${i.checkRunId ?? ''}`).join(',');

  useEffect(() => {
    let active = true;
    setAnnLoading(true);
    const targets = attention.filter((i) => i.checkRunId != null).slice(0, MAX_ANNOTATION_FETCH);
    Promise.all(
      targets.map(
        async (t) =>
          [
            String(t.id),
            await fetchAnnotationsOrEmpty(owner, repo, t.checkRunId as number),
          ] as const,
      ),
    ).then((pairs) => {
      if (!active) return;
      const map: Record<string, Annotation[]> = {};
      for (const [id, a] of pairs) map[id] = a;
      setAnnByItem(map);
      setAnnLoading(false);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, attentionKey]);

  const counts: Record<OverallStatus, number> = {
    success: 0,
    failure: 0,
    pending: 0,
    in_progress: 0,
    neutral: 0,
    unknown: 0,
  };
  for (const i of items) counts[i.status]++;

  return (
    <div>
      {/* status roll-up */}
      <div className={styles.flexGap2}>
        <Text className={styles.smallFgMuted}>{items.length} items:</Text>
        {COUNT_META.filter((m) => counts[m.status] > 0).map((m) => (
          <Label key={m.status} variant={m.variant}>
            {counts[m.status]} {m.label}
          </Label>
        ))}
      </div>

      <Text as="h3" className={styles.bodyBold}>
        Needs attention ({attention.length})
      </Text>
      {attention.length === 0 ? (
        <Text className={styles.smallFgMuted2}>Everything passed — nothing needs attention.</Text>
      ) : (
        <div className={styles.flexCol}>
          {attention.map((it) => {
            const anns = annByItem[String(it.id)] ?? [];
            return (
              <div
                key={it.id}
                className={styles.roundedP2}
              >
                <div className={anns.length ? styles.annHeaderSpaced : styles.annHeader}>
                  <StatusBadge status={it.status} />
                  <Text className={styles.boldBody}>{it.label}</Text>
                </div>
                {anns.length > 0 ? (
                  <div className={styles.flexCol2}>
                    {anns.map((a, i) => {
                      const style = LEVEL_STYLE[a.annotation_level ?? 'notice'] ?? LEVEL_STYLE.notice;
                      return (
                        <div key={i} className={styles.annotation} style={{ borderColor: style.color }}>
                          <div className={styles.flexCenter}>
                            <Icon icon={style.icon} size={12} style={{ color: style.color }} />
                            {a.title && <Text className={styles.boldSmall}>{a.title}</Text>}
                            {a.path && a.path !== '.github' && (
                              <Text className={styles.smallFgMuted2}>
                                {a.path}
                                {a.start_line ? `:${a.start_line}` : ''}
                              </Text>
                            )}
                          </div>
                          <pre className={styles.m0Mono}>
                            {a.message ?? ''}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                ) : annLoading && it.checkRunId != null ? (
                  <Text className={styles.smallFgMuted2}>loading annotations…</Text>
                ) : (
                  <Text className={styles.smallFgMuted2}>No annotations.</Text>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function OverallSummaryDialog({
  title,
  subtitle,
  owner,
  repo,
  items,
  loading,
  error,
  htmlUrl,
  onClose,
}: {
  title: string;
  subtitle?: string;
  owner: string;
  repo: string;
  items: SummaryItem[];
  loading?: boolean;
  error?: string | null;
  htmlUrl?: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          {htmlUrl && (
            <Button
              leadingVisual={LinkExternalIcon}
              onClick={() => window.open(htmlUrl, '_blank', 'noopener')}
            >
              Open summary on GitHub
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {loading ? (
        <div className={styles.flexCenter2}>
          <Spinner size="small" /> <Text className={styles.small}>Loading…</Text>
        </div>
      ) : error ? (
        <Flash variant="danger" className={styles.small}>{error}</Flash>
      ) : (
        <SummaryBody owner={owner} repo={repo} items={items} />
      )}
    </Modal>
  );
}

/** Flow-run overall summary: all jobs + the annotation content of attention jobs. */
export function RunOverallSummaryDialog({
  owner,
  repo,
  run,
  onClose,
}: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  onClose: () => void;
}) {
  const [items, setItems] = useState<SummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchAllRunJobs(owner, repo, run.id)
      .then((jobs) => {
        if (!active) return;
        setItems(
          jobs.map((j) => ({
            id: j.id,
            label: j.name,
            status: statusToOverall(j.status, j.conclusion),
            checkRunId: checkRunIdFromUrl(j.check_run_url),
          })),
        );
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [owner, repo, run.id]);

  return (
    <OverallSummaryDialog
      title={run.display_title || run.name || 'Workflow run'}
      subtitle={`${owner}/${repo} · run #${run.run_number} · summary`}
      owner={owner}
      repo={repo}
      items={items}
      loading={loading}
      error={error}
      htmlUrl={run.html_url}
      onClose={onClose}
    />
  );
}

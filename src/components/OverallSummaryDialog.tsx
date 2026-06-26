import { useEffect, useState } from 'react';
import { Box, Button, Flash, Label, Octicon, Spinner, Text } from '@primer/react';
import { AlertIcon, InfoIcon, LinkExternalIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { Annotation, OverallStatus, WorkflowRun } from '../api/types';
import { ghGet } from '../api/githubClient';
import { checkRunAnnotationsPath, checkRunIdFromUrl } from '../api/endpoints';
import { fetchAllRunJobs } from '../api/jobs';
import { statusToOverall } from '../lib/status';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';

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
  failure: { icon: XCircleFillIcon, color: 'danger.fg' },
  warning: { icon: AlertIcon, color: 'attention.fg' },
  notice: { icon: InfoIcon, color: 'accent.fg' },
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
      targets.map(async (t) => {
        try {
          const { data } = await ghGet<Annotation[]>(
            checkRunAnnotationsPath(owner, repo, t.checkRunId as number),
          );
          return [String(t.id), data] as const;
        } catch {
          return [String(t.id), [] as Annotation[]] as const;
        }
      }),
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
    <Box>
      {/* status roll-up */}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 3 }}>
        <Text sx={{ fontSize: 0, color: 'fg.muted', mr: 1 }}>{items.length} items:</Text>
        {COUNT_META.filter((m) => counts[m.status] > 0).map((m) => (
          <Label key={m.status} variant={m.variant}>
            {counts[m.status]} {m.label}
          </Label>
        ))}
      </Box>

      <Text as="h3" sx={{ fontSize: 1, fontWeight: 'bold', color: 'fg.muted', mb: 2 }}>
        Needs attention ({attention.length})
      </Text>
      {attention.length === 0 ? (
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Everything passed — nothing needs attention.</Text>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {attention.map((it) => {
            const anns = annByItem[String(it.id)] ?? [];
            return (
              <Box
                key={it.id}
                sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, p: 2 }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: anns.length ? 2 : 0 }}>
                  <StatusBadge status={it.status} />
                  <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{it.label}</Text>
                </Box>
                {anns.length > 0 ? (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {anns.map((a, i) => {
                      const style = LEVEL_STYLE[a.annotation_level ?? 'notice'] ?? LEVEL_STYLE.notice;
                      return (
                        <Box key={i} sx={{ pl: 2, borderLeft: '2px solid', borderColor: style.color }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Octicon icon={style.icon} size={12} sx={{ color: style.color }} />
                            {a.title && <Text sx={{ fontWeight: 'bold', fontSize: 0 }}>{a.title}</Text>}
                            {a.path && a.path !== '.github' && (
                              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                                {a.path}
                                {a.start_line ? `:${a.start_line}` : ''}
                              </Text>
                            )}
                          </Box>
                          <Box as="pre" sx={{ m: 0, fontFamily: 'mono', fontSize: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {a.message ?? ''}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                ) : annLoading && it.checkRunId != null ? (
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>loading annotations…</Text>
                ) : (
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>No annotations.</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
          <Spinner size="small" /> <Text sx={{ fontSize: 0 }}>Loading…</Text>
        </Box>
      ) : error ? (
        <Flash variant="danger" sx={{ fontSize: 0 }}>{error}</Flash>
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

/**
 * Manual "re-run the failed jobs" action for a pull request.
 *
 * Self-contained in the style of ArtifactsButton: it swallows the row click, owns
 * its own dialog, and renders nothing at all unless the token is known to permit
 * writes — a control that 403s is worse than no control.
 *
 * It resolves runs the same way the auto-rerun engine does (all workflow runs for
 * the PR head), rather than reusing the single run id scraped from the first
 * check-run: a PR usually triggers several workflows, and picking whichever GitHub
 * happened to list first would be arbitrary for an action that costs CI minutes.
 * Unlike the engine it ignores auto-merge and the configured workflow list — an
 * explicit click is its own authority.
 */

import { useEffect, useState } from 'react';
import { Box, Button, Flash, IconButton, Label, Link, Spinner, Text } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { fetchRunsForHead, rerunFailedJobs } from '../api/workflows';
import type { WorkflowRun } from '../api/types';
import { MANUALLY_RERUNNABLE_CONCLUSIONS } from '../lib/autoRerun';
import { workflowBasename } from '../lib/workflow';
import { formatRelative } from '../lib/format';
import { useTokenCapability } from '../hooks/useTokenCapability';
import { Modal } from './Modal';

type Outcome = { runId: number; ok: boolean; message: string };

function RerunDialog({
  owner,
  repo,
  headSha,
  subtitle,
  onClose,
  onRerun,
}: {
  owner: string;
  repo: string;
  headSha: string;
  subtitle: string;
  onClose: () => void;
  onRerun: () => void;
}) {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);

  useEffect(() => {
    let active = true;
    fetchRunsForHead(owner, repo, headSha)
      .then((all) => {
        if (!active) return;
        setRuns(
          all.filter(
            (r) => r.status === 'completed' && MANUALLY_RERUNNABLE_CONCLUSIONS.has(r.conclusion),
          ),
        );
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [owner, repo, headSha]);

  const rerun = async (run: WorkflowRun) => {
    setBusy(run.id);
    try {
      await rerunFailedJobs(owner, repo, run.id);
      setOutcomes((prev) => [
        ...prev.filter((o) => o.runId !== run.id),
        { runId: run.id, ok: true, message: `Re-run requested (attempt ${run.run_attempt + 1}).` },
      ]);
      onRerun();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setOutcomes((prev) => [
        ...prev.filter((o) => o.runId !== run.id),
        { runId: run.id, ok: false, message },
      ]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Re-run failed jobs"
      subtitle={subtitle}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && <Flash variant="danger" sx={{ fontSize: 0 }}>{error}</Flash>}

      {!error && runs === null && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
          <Spinner size="small" />
          <Text sx={{ fontSize: 0 }}>Looking for failed runs…</Text>
        </Box>
      )}

      {runs !== null && runs.length === 0 && (
        <Text sx={{ color: 'fg.muted', fontSize: 1 }}>
          No failed workflow runs for this commit.
        </Text>
      )}

      {runs?.map((run) => {
        const outcome = outcomes.find((o) => o.runId === run.id);
        return (
          <Box
            key={run.id}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              py: 2,
              borderTop: '1px solid',
              borderColor: 'border.muted',
              flexWrap: 'wrap',
            }}
          >
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Link
                href={run.html_url}
                target="_blank"
                rel="noreferrer"
                sx={{ fontSize: 1, fontWeight: 'bold', color: 'fg.default' }}
              >
                {run.name ?? run.display_title}
              </Link>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
                {run.path && (
                  <Text sx={{ fontSize: 0, fontFamily: 'mono' }}>
                    {workflowBasename(run.path)}
                  </Text>
                )}
                <Text sx={{ fontSize: 0 }}>run #{run.run_number}</Text>
                {run.run_attempt > 1 && (
                  <Text sx={{ fontSize: 0 }}>attempt {run.run_attempt}</Text>
                )}
                <Text sx={{ fontSize: 0 }}>{formatRelative(run.updated_at)}</Text>
              </Box>
            </Box>
            <Label variant={run.conclusion === 'cancelled' ? 'secondary' : 'danger'}>
              {run.conclusion}
            </Label>
            <Button
              size="small"
              variant="primary"
              disabled={busy === run.id || outcome?.ok === true}
              onClick={() => void rerun(run)}
            >
              {busy === run.id ? 'Requesting…' : outcome?.ok ? 'Requested' : 'Re-run failed jobs'}
            </Button>
            {outcome && (
              <Box sx={{ flexBasis: '100%' }}>
                <Flash variant={outcome.ok ? 'success' : 'danger'} sx={{ fontSize: 0 }}>
                  {outcome.message}
                </Flash>
              </Box>
            )}
          </Box>
        );
      })}
    </Modal>
  );
}

export function RerunFailedJobsButton({
  owner,
  repo,
  headSha,
  subtitle,
  onRerun,
  size = 'small',
}: {
  owner: string;
  repo: string;
  headSha: string;
  subtitle: string;
  /** Called after a successful request, to re-poll the PR's checks. */
  onRerun: () => void;
  size?: 'small' | 'medium';
}) {
  const [open, setOpen] = useState(false);
  const { canRerun } = useTokenCapability();

  // Hidden, not disabled: the token can't do this, so there is nothing to explain
  // here. Settings → Token carries the explanation.
  if (!canRerun) return null;

  return (
    <Box as="span" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <IconButton
        size={size}
        variant="invisible"
        icon={SyncIcon}
        aria-label="Re-run failed jobs"
        onClick={() => setOpen(true)}
      />
      {open && (
        <RerunDialog
          owner={owner}
          repo={repo}
          headSha={headSha}
          subtitle={subtitle}
          onClose={() => setOpen(false)}
          onRerun={onRerun}
        />
      )}
    </Box>
  );
}

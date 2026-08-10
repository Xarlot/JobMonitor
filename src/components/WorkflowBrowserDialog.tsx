import { useEffect, useMemo, useState } from 'react';
import { BranchName, Flash, Label, Select, Spinner, Text, TextInput } from '@primer/react';
import { SearchIcon } from '@primer/octicons-react';
import type { WorkflowRun, WorkflowRunsResponse } from '../api/types';
import { ghGet, GitHubApiError } from '../api/githubClient';
import { repoRunsPath } from '../api/endpoints';
import { statusToOverall } from '../lib/status';
import { recentFlowsFromRuns, sinceCreated, type FlowPick, type RecentFlow } from '../lib/recentFlows';
import { formatRelative } from '../lib/format';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';
import styles from './WorkflowBrowserDialog.module.css';

export type { FlowPick };

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; combos: RecentFlow[] }
  | { phase: 'error'; message: string };

const WINDOW_HOURS = 24;
const PER_PAGE = 100;
/** Safety cap so a pathologically busy repo can't trigger unbounded paging. */
const MAX_PAGES = 10;

/**
 * Browse the repo's workflow runs from the last day, grouped into distinct
 * workflow × branch × event combinations. Picking a row fills the matching flow
 * fields in the editor.
 */
export function WorkflowBrowserDialog({
  owner,
  repo,
  onSelect,
  onClose,
}: {
  owner: string;
  repo: string;
  onSelect: (pick: FlowPick) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [eventFilter, setEventFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');

  useEffect(() => {
    let active = true;
    setState({ phase: 'loading' });
    // The `created` window is bounded server-side, but a single page only returns
    // the newest 100 runs — page through it so a busy repo still shows the full day.
    (async () => {
      try {
        const created = sinceCreated(WINDOW_HOURS);
        const all: WorkflowRun[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const { data } = await ghGet<WorkflowRunsResponse>(
            repoRunsPath(owner, repo, { created, perPage: PER_PAGE, page }),
          );
          const runs = data.workflow_runs ?? [];
          all.push(...runs);
          if (runs.length < PER_PAGE) break; // last page within the window
        }
        if (!active) return;
        setState({ phase: 'loaded', combos: recentFlowsFromRuns(all) });
      } catch (err) {
        if (!active) return;
        setState({
          phase: 'error',
          message: err instanceof GitHubApiError ? err.message : 'Failed to load workflow runs.',
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [owner, repo]);

  const subtitle = useMemo(
    () => `${owner}/${repo} · runs from the last ${WINDOW_HOURS}h`,
    [owner, repo],
  );

  const pick = (c: RecentFlow) => {
    onSelect({ name: c.name, workflowFile: c.workflowFile, branch: c.branch, event: c.event });
    onClose();
  };

  const combos = state.phase === 'loaded' ? state.combos : [];
  // Distinct trigger/branch values drive the filter dropdowns.
  const events = useMemo(() => [...new Set(combos.map((c) => c.event))].sort(), [combos]);
  const branches = useMemo(
    () => [...new Set(combos.map((c) => c.branch).filter(Boolean))].sort(),
    [combos],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return combos.filter(
      (c) =>
        (!q || c.name.toLowerCase().includes(q) || c.workflowFile.toLowerCase().includes(q)) &&
        (!eventFilter || c.event === eventFilter) &&
        (!branchFilter || c.branch === branchFilter),
    );
  }, [combos, query, eventFilter, branchFilter]);

  return (
    <Modal title="Browse recent workflows" subtitle={subtitle} onClose={onClose}>
      {state.phase === 'loading' && (
        <div className={styles.flexCenter}>
          <Spinner size="small" /> <Text>Loading recent runs…</Text>
        </div>
      )}
      {state.phase === 'error' && (
        <Flash variant="danger" className={styles.body}>{state.message}</Flash>
      )}
      {state.phase === 'loaded' && state.combos.length === 0 && (
        <Text className={styles.fgMuted}>No workflow runs in the last {WINDOW_HOURS} hours.</Text>
      )}
      {state.phase === 'loaded' && state.combos.length > 0 && (
        <>
          <Text as="p" className={styles.smallFgMuted}>
            Pick a workflow to fill the flow’s name, file, branch and event.
          </Text>
          <div className={styles.flexGap2}>
            <TextInput
              leadingVisual={SearchIcon}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or file…"
              aria-label="Search workflows"
              className={styles.grow}
            />
            <Select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              aria-label="Filter by trigger"
            >
              <Select.Option value="">All triggers</Select.Option>
              {events.map((ev) => (
                <Select.Option key={ev} value={ev}>{ev}</Select.Option>
              ))}
            </Select>
            <Select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              aria-label="Filter by branch"
            >
              <Select.Option value="">All branches</Select.Option>
              {branches.map((b) => (
                <Select.Option key={b} value={b}>{b}</Select.Option>
              ))}
            </Select>
          </div>
          {filtered.length === 0 ? (
            <Text className={styles.fgMuted}>No workflows match your search.</Text>
          ) : (
          <table className={styles.width}>
            <thead>
              <tr>
                <th className={styles.px2Body}>Status</th>
                <th className={styles.px2Body2}>Workflow</th>
                <th className={styles.px2Body2}>Trigger</th>
                <th className={styles.px2Body2}>Branch</th>
                <th className={styles.px2Body3}>
                  Last run
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => pick(c)}
                  onKeyDown={(e: React.KeyboardEvent) =>
                    (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(c))
                  }
                  className={styles.clickableRow}
                >
                  <td className={styles.px2Body4}>
                    <StatusBadge status={statusToOverall(c.latest.status, c.latest.conclusion)} />
                  </td>
                  <td className={styles.px2Body4}>
                    <Text className={styles.boldBlock}>{c.name}</Text>
                    {c.workflowFile && (
                      <Text className={styles.fgMutedSmall}>{c.workflowFile}</Text>
                    )}
                  </td>
                  <td className={styles.px2Body4}>
                    <Label variant="secondary">{c.event}</Label>
                  </td>
                  <td className={styles.px2Body4}>
                    {c.branch ? (
                      <BranchName as="span" className={styles.small}>{c.branch}</BranchName>
                    ) : (
                      <Text className={styles.fgMuted}>—</Text>
                    )}
                  </td>
                  <td className={styles.px2Body3}>
                    {formatRelative(c.latest.run_started_at ?? c.latest.created_at)}
                    {c.count > 1 && (
                      <Text className={styles.blockSmall}>{c.count} runs</Text>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </>
      )}
    </Modal>
  );
}

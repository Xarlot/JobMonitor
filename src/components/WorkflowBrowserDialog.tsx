import { useEffect, useMemo, useState } from 'react';
import { Box, BranchName, Flash, Label, Select, Spinner, Text, TextInput } from '@primer/react';
import { SearchIcon } from '@primer/octicons-react';
import type { WorkflowRun, WorkflowRunsResponse } from '../api/types';
import { ghGet, GitHubApiError } from '../api/githubClient';
import { repoRunsPath } from '../api/endpoints';
import { statusToOverall } from '../lib/status';
import { recentFlowsFromRuns, sinceCreated, type FlowPick, type RecentFlow } from '../lib/recentFlows';
import { formatRelative } from '../lib/format';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';

export type { FlowPick };

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; combos: RecentFlow[] }
  | { phase: 'error'; message: string };

const cellSx = {
  px: 2,
  py: '8px',
  borderColor: 'border.muted',
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
  fontSize: 1,
  verticalAlign: 'middle',
} as const;

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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, color: 'fg.muted' }}>
          <Spinner size="small" /> <Text>Loading recent runs…</Text>
        </Box>
      )}
      {state.phase === 'error' && (
        <Flash variant="danger" sx={{ fontSize: 1 }}>{state.message}</Flash>
      )}
      {state.phase === 'loaded' && state.combos.length === 0 && (
        <Text sx={{ color: 'fg.muted' }}>No workflow runs in the last {WINDOW_HOURS} hours.</Text>
      )}
      {state.phase === 'loaded' && state.combos.length > 0 && (
        <>
          <Text as="p" sx={{ fontSize: 0, color: 'fg.muted', mb: 2 }}>
            Pick a workflow to fill the flow’s name, file, branch and event.
          </Text>
          <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
            <TextInput
              leadingVisual={SearchIcon}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or file…"
              aria-label="Search workflows"
              sx={{ flex: 1, minWidth: 200 }}
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
          </Box>
          {filtered.length === 0 ? (
            <Text sx={{ color: 'fg.muted' }}>No workflows match your search.</Text>
          ) : (
          <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
            <Box as="thead">
              <Box as="tr">
                <Box as="th" sx={{ ...cellSx, width: 140, textAlign: 'left', color: 'fg.muted' }}>Status</Box>
                <Box as="th" sx={{ ...cellSx, textAlign: 'left', color: 'fg.muted' }}>Workflow</Box>
                <Box as="th" sx={{ ...cellSx, textAlign: 'left', color: 'fg.muted' }}>Trigger</Box>
                <Box as="th" sx={{ ...cellSx, textAlign: 'left', color: 'fg.muted' }}>Branch</Box>
                <Box as="th" sx={{ ...cellSx, textAlign: 'right', color: 'fg.muted', whiteSpace: 'nowrap' }}>
                  Last run
                </Box>
              </Box>
            </Box>
            <Box as="tbody">
              {filtered.map((c) => (
                <Box
                  as="tr"
                  key={c.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => pick(c)}
                  onKeyDown={(e: React.KeyboardEvent) =>
                    (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(c))
                  }
                  sx={{ cursor: 'pointer', ':hover': { bg: 'canvas.subtle' } }}
                >
                  <Box as="td" sx={cellSx}>
                    <StatusBadge status={statusToOverall(c.latest.status, c.latest.conclusion)} />
                  </Box>
                  <Box as="td" sx={cellSx}>
                    <Text sx={{ fontWeight: 'bold', display: 'block' }}>{c.name}</Text>
                    {c.workflowFile && (
                      <Text sx={{ color: 'fg.muted', fontSize: 0 }}>{c.workflowFile}</Text>
                    )}
                  </Box>
                  <Box as="td" sx={cellSx}>
                    <Label variant="secondary">{c.event}</Label>
                  </Box>
                  <Box as="td" sx={cellSx}>
                    {c.branch ? (
                      <BranchName as="span" sx={{ fontSize: 0 }}>{c.branch}</BranchName>
                    ) : (
                      <Text sx={{ color: 'fg.muted' }}>—</Text>
                    )}
                  </Box>
                  <Box as="td" sx={{ ...cellSx, textAlign: 'right', color: 'fg.muted', whiteSpace: 'nowrap' }}>
                    {formatRelative(c.latest.run_started_at ?? c.latest.created_at)}
                    {c.count > 1 && (
                      <Text sx={{ display: 'block', fontSize: 0 }}>{c.count} runs</Text>
                    )}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
          )}
        </>
      )}
    </Modal>
  );
}

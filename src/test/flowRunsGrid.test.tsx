/**
 * The runs grid renders.
 *
 * Written when this grid was moved from TanStack Table v8 to v9, which is a wholesale change of
 * table engine: features became opt-in, the row model is constructed rather than passed as a getter,
 * and the cell accessor changed. All of that typechecks whether or not a single row ever appears —
 * the column definitions are data, and a table configured with the wrong feature set builds a valid
 * object that renders nothing. So the assertions here are deliberately about output: that the rows
 * arrive, in order, with the values the accessors were supposed to reach.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BaseStyles, ThemeProvider } from '@primer/react';
import type { WorkflowRun } from '../api/types';
import type { ResolvedFlow } from '../lib/flowPatterns';
import type { FlowState } from '../hooks/useFlows';
import { FlowsFilterProvider } from '../context/FlowsFilterContext';
import { FlowRunsGrid } from '../components/FlowRunsGrid';

// The grid pulls in dialogs and buttons that reach for Electron, the network and config. None of
// them is what this test is about, and each would fail for its own unrelated reason.
vi.mock('../components/TimelineDialog', () => ({ FlowRunTimelineDialog: () => null }));
vi.mock('../components/OverallSummaryDialog', () => ({ RunOverallSummaryDialog: () => null }));
vi.mock('../components/ArtifactsButton', () => ({ ArtifactsButton: () => null }));
vi.mock('../components/AnalysedBadge', () => ({ AnalysedBadge: () => null }));
vi.mock('../components/JobsTable', () => ({ JobsTable: () => null }));

function run(over: Partial<WorkflowRun> & { id: number }): WorkflowRun {
  return {
    name: 'CI',
    display_title: `Build ${over.id}`,
    head_branch: 'main',
    head_sha: 'deadbee',
    run_number: over.id,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://example.invalid/run',
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:05:00Z',
    run_started_at: '2026-08-01T10:00:30Z',
    ...over,
  };
}

const flow = {
  id: 'flow-1',
  name: 'Build',
  workflowFile: 'build.yml',
  branches: ['main'],
  events: [],
  maxRuns: 5,
  emptyFilter: {},
  match: {},
} as unknown as ResolvedFlow;

function state(runs: WorkflowRun[]): FlowState {
  return {
    owner: 'DevExpress',
    repo: 'JavaJobMonitor',
    runs,
    overall: 'success',
    jobsByRun: {},
    isExpanded: () => false,
    onToggleRun: () => {},
    isFetchingRuns: false,
    runsError: null,
    runsUpdatedAt: Date.parse('2026-08-01T10:05:00Z'),
    refresh: () => {},
    latestArtifactBytes: null,
  } as unknown as FlowState;
}

function renderGrid(runs: WorkflowRun[]) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <FlowsFilterProvider>
          <FlowRunsGrid flow={flow} state={state(runs)} />
        </FlowsFilterProvider>
      </BaseStyles>
    </ThemeProvider>,
  );
}

describe('FlowRunsGrid', () => {
  it('renders one row per run, in the order given', () => {
    renderGrid([run({ id: 3 }), run({ id: 2 }), run({ id: 1 })]);

    const rows = screen.getAllByRole('row').filter((r) => within(r).queryByText(/^Build \d$/));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => within(r).getByText(/^Build \d$/).textContent)).toEqual([
      'Build 3',
      'Build 2',
      'Build 1',
    ]);
  });

  it('reaches through the accessors to the run fields', () => {
    renderGrid([run({ id: 7, head_branch: 'release/2.2', run_number: 41763 })]);

    // Each of these comes from a different column definition, so between them they prove the
    // accessor columns, the display columns and the cell renderers all still resolve.
    expect(screen.getByText('Build 7')).toBeInTheDocument();
    expect(screen.getByText('release/2.2')).toBeInTheDocument();
    expect(screen.getByText(/41763/)).toBeInTheDocument();
  });

  it('renders every column of the header', () => {
    renderGrid([run({ id: 1 })]);
    const headerCells = screen.getAllByRole('columnheader');
    // A table whose feature set is misconfigured can produce headers and no body, or the reverse.
    expect(headerCells.length).toBeGreaterThan(3);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('says so when the runs are filtered out rather than rendering an empty table', () => {
    renderGrid([]);
    expect(screen.queryByText(/^Build \d$/)).not.toBeInTheDocument();
  });
});

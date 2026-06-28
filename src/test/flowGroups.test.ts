import { describe, expect, it } from 'vitest';
import {
  addGroup,
  applyBoard,
  deleteGroup,
  deriveSections,
  exportBoard,
  moveFlow,
} from '../lib/flowGroups';
import {
  DEFAULT_CONFIG,
  safeParseBoard,
  type Flow,
  type FlowGroup,
  type MonitorConfig,
} from '../storage/configStore';

function flow(id: string): Flow {
  return {
    id,
    name: id.toUpperCase(),
    workflowFile: 'ci.yml',
    branches: ['main'],
    events: [],
    maxRuns: 5,
    emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
  };
}

function cfg(flows: Flow[], groups: FlowGroup[]): MonitorConfig {
  return { ...DEFAULT_CONFIG, upstream: { owner: 'o', repo: 'r' }, fork: { owner: 'f', branch: null }, flows, groups };
}

const ids = (flows: Flow[]) => flows.map((f) => f.id);

describe('deriveSections', () => {
  it('splits into groups (flowIds order) + ungrouped (config order)', () => {
    const c = cfg(
      [flow('a'), flow('b'), flow('c')],
      [{ id: 'g1', name: 'G1', flowIds: ['b'], collapsed: false }],
    );
    const s = deriveSections(c.flows, c.groups);
    expect(s).toHaveLength(2);
    expect(s[0].group?.id).toBe('g1');
    expect(ids(s[0].flows)).toEqual(['b']);
    expect(s[1].group).toBeNull();
    expect(ids(s[1].flows)).toEqual(['a', 'c']); // config.flows order, b claimed
  });

  it('ignores dangling ids and claims a flow for only the first group', () => {
    const c = cfg(
      [flow('a'), flow('b')],
      [
        { id: 'g1', name: 'G1', flowIds: ['a', 'missing'], collapsed: false },
        { id: 'g2', name: 'G2', flowIds: ['a', 'b'], collapsed: false }, // 'a' already claimed
      ],
    );
    const s = deriveSections(c.flows, c.groups);
    expect(ids(s[0].flows)).toEqual(['a']);
    expect(ids(s[1].flows)).toEqual(['b']);
    expect(ids(s[2].flows)).toEqual([]); // ungrouped empty
  });
});

describe('moveFlow', () => {
  it('moves a flow into a group at a position', () => {
    const c = cfg([flow('a'), flow('b'), flow('c')], [{ id: 'g1', name: 'G1', flowIds: ['b'], collapsed: false }]);
    const next = moveFlow(c, 'a', 'g1', 'b'); // a before b in g1
    expect(next.groups[0].flowIds).toEqual(['a', 'b']);
  });

  it('moves a flow out to ungrouped, reflecting order via config.flows', () => {
    const c = cfg([flow('a'), flow('b'), flow('c')], [{ id: 'g1', name: 'G1', flowIds: ['b'], collapsed: false }]);
    const next = moveFlow(c, 'b', null, 'a'); // b to ungrouped, before a
    expect(next.groups[0].flowIds).toEqual([]);
    const sections = deriveSections(next.flows, next.groups);
    const ungrouped = sections[sections.length - 1];
    expect(ids(ungrouped.flows)).toEqual(['b', 'a', 'c']);
  });

  it('moves a flow between groups', () => {
    const c = cfg(
      [flow('a'), flow('b')],
      [
        { id: 'g1', name: 'G1', flowIds: ['a'], collapsed: false },
        { id: 'g2', name: 'G2', flowIds: ['b'], collapsed: false },
      ],
    );
    const next = moveFlow(c, 'a', 'g2', null); // a -> end of g2
    expect(next.groups[0].flowIds).toEqual([]);
    expect(next.groups[1].flowIds).toEqual(['b', 'a']);
  });
});

describe('group CRUD', () => {
  it('addGroup appends an empty group', () => {
    const c = cfg([flow('a')], []);
    const next = addGroup(c, 'Pipelines');
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0].name).toBe('Pipelines');
    expect(next.groups[0].flowIds).toEqual([]);
  });

  it('deleteGroup drops the group; its flows fall back to ungrouped', () => {
    const c = cfg([flow('a'), flow('b')], [{ id: 'g1', name: 'G1', flowIds: ['a'], collapsed: false }]);
    const next = deleteGroup(c, 'g1');
    expect(next.groups).toEqual([]);
    expect(next.flows.map((f) => f.id)).toEqual(['a', 'b']); // flow defs kept
  });
});

describe('export / import board (cross-machine transfer)', () => {
  it('round-trips flows + groups unambiguously by id through JSON', () => {
    const a = cfg(
      [flow('uuid-1'), flow('uuid-2'), flow('uuid-3')],
      [
        { id: 'gA', name: 'A', flowIds: ['uuid-2', 'uuid-1'], collapsed: true },
        { id: 'gB', name: 'B', flowIds: ['uuid-3'], collapsed: false },
      ],
    );
    // Serialize on machine 1, deserialize on machine 2.
    const json = JSON.stringify(exportBoard(a));
    const parsed = safeParseBoard(JSON.parse(json));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const b = applyBoard(DEFAULT_CONFIG, parsed.board);
    expect(b.flows).toEqual(a.flows); // full flow definitions preserved
    expect(b.groups).toEqual(a.groups); // grouping + order + collapsed preserved
    // Same ids → grouping resolves identically on the other machine.
    expect(deriveSections(b.flows, b.groups).map((s) => s.flows.map((f) => f.id))).toEqual(
      deriveSections(a.flows, a.groups).map((s) => s.flows.map((f) => f.id)),
    );
  });

  it('rejects malformed board JSON', () => {
    expect(safeParseBoard({ flows: [{ id: '' }], groups: [] }).ok).toBe(false);
  });
});

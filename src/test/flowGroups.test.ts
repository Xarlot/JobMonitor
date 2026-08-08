import { describe, expect, it } from 'vitest';
import {
  addGroup,
  applyBoard,
  deleteGroup,
  deriveSections,
  exportBoard,
  forgetPlacements,
  moveFlow,
} from '../lib/flowGroups';
import {
  DEFAULT_CONFIG,
  safeParseBoard,
  type Flow,
  type FlowGroup,
  type MonitorConfig,
} from '../storage/configStore';
import type { ResolvedFlow } from '../lib/flowPatterns';

function flow(id: string): Flow {
  return {
    id,
    name: id.toUpperCase(),
    workflowFile: 'ci.yml',
    branches: ['main'],
    events: [],
    maxRuns: 5,
    emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
    match: { pattern: '', by: 'name', caseSensitive: false, maxMatches: 12 },
  };
}

/** A flow as produced by expanding the pattern flow `patternId`. */
function derived(patternId: string, file: string): ResolvedFlow {
  return {
    ...flow(`${patternId}::${file}`),
    name: file,
    workflowFile: '42',
    source: {
      patternFlowId: patternId,
      patternName: patternId.toUpperCase(),
      pattern: '^x',
      workflow: { id: 42, name: file, file },
    },
  };
}

function cfg(flows: Flow[], groups: FlowGroup[]): MonitorConfig {
  return {
    ...DEFAULT_CONFIG,
    upstream: { owner: 'o', repo: 'r' },
    fork: { owner: 'f', repo: '', branch: null },
    flows,
    groups,
  };
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

describe('regex (pattern) flows on the board', () => {
  // The config holds the pattern flow 'p'; the board sees its two matches.
  const matches = [derived('p', 'a.yml'), derived('p', 'b.yml')];
  const cfgP = (groups: FlowGroup[], ungroupedOrder: string[] = []) => ({
    ...cfg([flow('single'), flow('p')], groups),
    ungroupedOrder,
  });

  it('puts every match in the group that lists the pattern flow', () => {
    const c = cfgP([{ id: 'g1', name: 'G1', flowIds: ['p'], collapsed: false }]);
    const s = deriveSections([flow('single'), ...matches], c.groups, c.ungroupedOrder);
    expect(ids(s[0].flows)).toEqual(['p::a.yml', 'p::b.yml']);
    expect(ids(s[1].flows)).toEqual(['single']);
  });

  it('leaves a match that was placed by hand out of its pattern’s group', () => {
    const c = cfgP([
      { id: 'g1', name: 'G1', flowIds: ['p'], collapsed: false },
      { id: 'g2', name: 'G2', flowIds: ['p::b.yml'], collapsed: false },
    ]);
    const s = deriveSections(matches, c.groups, c.ungroupedOrder);
    expect(ids(s[0].flows)).toEqual(['p::a.yml']);
    expect(ids(s[1].flows)).toEqual(['p::b.yml']);
  });

  it('drags a match out to ungrouped and back, without the pattern claiming it back', () => {
    const c = cfgP([{ id: 'g1', name: 'G1', flowIds: ['p'], collapsed: false }]);

    const out = moveFlow(c, 'p::b.yml', null, null, []);
    expect(out.ungroupedOrder).toContain('p::b.yml');
    let s = deriveSections(matches, out.groups, out.ungroupedOrder);
    expect(ids(s[0].flows)).toEqual(['p::a.yml']);
    expect(ids(s[1].flows)).toEqual(['p::b.yml']);

    // Back into the group, before the match that sits there implicitly: the
    // placeholder's members are materialized so the order is exact.
    const back = moveFlow(out, 'p::b.yml', 'g1', 'p::a.yml', ['p::a.yml']);
    expect(back.ungroupedOrder).not.toContain('p::b.yml');
    s = deriveSections(matches, back.groups, back.ungroupedOrder);
    expect(ids(s[0].flows)).toEqual(['p::b.yml', 'p::a.yml']);
    expect(ids(s[1].flows)).toEqual([]);
    // The pattern placeholder survives, so future matches still join this group.
    expect(back.groups[0].flowIds).toContain('p');
    const withNew = deriveSections([...matches, derived('p', 'c.yml')], back.groups, back.ungroupedOrder);
    expect(ids(withNew[0].flows)).toContain('p::c.yml');
  });

  it('reorders matches inside the ungrouped section', () => {
    const c = cfgP([]);
    const next = moveFlow(c, 'p::b.yml', null, 'p::a.yml', ['p::a.yml', 'p::b.yml']);
    const s = deriveSections(matches, next.groups, next.ungroupedOrder);
    expect(ids(s[s.length - 1].flows)).toEqual(['p::b.yml', 'p::a.yml']);
  });

  it('keeps the pattern intact when a card is dropped around its matches', () => {
    const c = cfgP([{ id: 'g1', name: 'G1', flowIds: ['p'], collapsed: false }]);
    const shown = ['p::a.yml', 'p::b.yml'];

    // Below the pattern's block, then above it: the matches stay implicit, so a
    // later regex change can't leave stale placements behind.
    expect(moveFlow(c, 'single', 'g1', null, shown).groups[0].flowIds).toEqual(['p', 'single']);
    expect(moveFlow(c, 'single', 'g1', 'p::a.yml', shown).groups[0].flowIds).toEqual(['single', 'p']);
  });

  it('pins only the matches a drop actually splits', () => {
    const c = cfgP([{ id: 'g1', name: 'G1', flowIds: ['p'], collapsed: false }]);
    const next = moveFlow(c, 'single', 'g1', 'p::b.yml', ['p::a.yml', 'p::b.yml']);
    expect(next.groups[0].flowIds).toEqual(['p', 'p::a.yml', 'single', 'p::b.yml']);
    // …and the requested order is what the board shows.
    const s = deriveSections([flow('single'), ...matches], next.groups, next.ungroupedOrder);
    expect(ids(s[0].flows)).toEqual(['p::a.yml', 'single', 'p::b.yml']);
  });

  it('forgets stale placements without touching the flows', () => {
    const c = {
      ...cfgP([{ id: 'g1', name: 'G1', flowIds: ['p', 'p::gone.yml', 'p::a.yml'], collapsed: false }]),
      ungroupedOrder: ['p::vanished.yml', 'p::b.yml'],
    };
    const s = deriveSections(matches, c.groups, c.ungroupedOrder);
    const stale = s.flatMap((sec) => sec.pinnedMissing);
    expect(stale).toEqual(['p::gone.yml', 'p::vanished.yml']);

    const next = forgetPlacements(c, stale);
    expect(next.groups[0].flowIds).toEqual(['p', 'p::a.yml']);
    expect(next.ungroupedOrder).toEqual(['p::b.yml']);
    expect(next.flows).toEqual(c.flows); // definitions untouched
    expect(deriveSections(matches, next.groups, next.ungroupedOrder).flatMap((sec) => sec.pinnedMissing))
      .toEqual([]);
  });

  it('reports placements that currently resolve to nothing', () => {
    const c = cfgP([{ id: 'g1', name: 'G1', flowIds: ['p::gone.yml', 'p::a.yml'], collapsed: false }]);
    const s = deriveSections(matches, c.groups, c.ungroupedOrder);
    expect(ids(s[0].flows)).toEqual(['p::a.yml']);
    expect(s[0].pinnedMissing).toEqual(['p::gone.yml']); // kept, so it returns later
  });
});

describe('moveFlow into a collapsed group', () => {
  it('expands the group so the dropped card is visible', () => {
    const c = cfg([flow('a'), flow('b')], [{ id: 'g1', name: 'G1', flowIds: ['b'], collapsed: true }]);
    expect(moveFlow(c, 'a', 'g1', null).groups[0].collapsed).toBe(false);
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

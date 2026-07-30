import { describe, expect, it } from 'vitest';
import {
  compileFlowPattern,
  derivedFileOf,
  derivedFlowId,
  expandFlow,
  expandFlows,
  isDerivedFlowId,
  isPatternFlow,
  matchWorkflows,
  patternFlowIdOf,
} from '../lib/flowPatterns';
import type { Workflow } from '../api/types';
import type { Flow, FlowMatch } from '../storage/configStore';

function wf(id: number, name: string, file: string, state = 'active'): Workflow {
  return { id, name, path: `.github/workflows/${file}`, state };
}

const WORKFLOWS: Workflow[] = [
  wf(1, 'Nightly Linux', 'nightly-linux.yml'),
  wf(2, 'Nightly Windows', 'nightly-windows.yml'),
  wf(3, 'CI', 'check-pull-request-java.yml'),
  wf(4, 'Docs', 'docs.yml'),
  wf(5, 'Old nightly', 'nightly-old.yml', 'deleted'),
];

function match(over: Partial<FlowMatch> = {}): FlowMatch {
  return { pattern: '', by: 'name', caseSensitive: false, maxMatches: 12, ...over };
}

function flow(over: Partial<Flow> = {}): Flow {
  return {
    id: 'f1',
    name: 'Flow',
    workflowFile: 'ci.yml',
    branches: ['main', 'release'],
    events: ['push'],
    maxRuns: 7,
    emptyFilter: { enabled: true, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
    match: match(),
    ...over,
  };
}

describe('compileFlowPattern', () => {
  it('treats an empty pattern as "no pattern", not an error', () => {
    expect(compileFlowPattern(match())).toEqual({ re: null, error: null });
  });

  it('reports a syntax error instead of throwing', () => {
    const { re, error } = compileFlowPattern(match({ pattern: '(' }));
    expect(re).toBeNull();
    expect(error).toBeTruthy();
  });

  it('is case-insensitive unless asked otherwise', () => {
    expect(compileFlowPattern(match({ pattern: 'nightly' })).re?.test('NIGHTLY')).toBe(true);
    expect(
      compileFlowPattern(match({ pattern: 'nightly', caseSensitive: true })).re?.test('NIGHTLY'),
    ).toBe(false);
  });
});

describe('matchWorkflows', () => {
  it('matches the display name by default, sorted by name', () => {
    const hits = matchWorkflows(WORKFLOWS, match({ pattern: '^nightly' }));
    expect(hits.map((w) => w.name)).toEqual(['Nightly Linux', 'Nightly Windows']);
  });

  it('matches the file name when asked', () => {
    const hits = matchWorkflows(WORKFLOWS, match({ pattern: 'pull-request', by: 'file' }));
    expect(hits.map((w) => w.id)).toEqual([3]);
  });

  it('matches either side with by: any', () => {
    const hits = matchWorkflows(WORKFLOWS, match({ pattern: '^(CI|docs)', by: 'any' }));
    expect(hits.map((w) => w.name)).toEqual(['CI', 'Docs']); // CI by name, docs.yml by file
  });

  it('skips deleted workflows', () => {
    const hits = matchWorkflows(WORKFLOWS, match({ pattern: 'nightly', by: 'file' }));
    expect(hits.map((w) => w.id)).toEqual([1, 2]);
  });

  it('caps at maxMatches', () => {
    expect(matchWorkflows(WORKFLOWS, match({ pattern: 'nightly', maxMatches: 1 }))).toHaveLength(1);
  });

  it('matches nothing when the regex is broken', () => {
    expect(matchWorkflows(WORKFLOWS, match({ pattern: '[' }))).toEqual([]);
  });
});

describe('expandFlow', () => {
  it('leaves a single-workflow flow untouched (same object identity)', () => {
    const f = flow();
    expect(expandFlow(f, WORKFLOWS)).toEqual([f]);
    expect(expandFlow(f, undefined)[0]).toBe(f);
  });

  it('yields one flow per match, keyed by a stable derived id', () => {
    const f = flow({ id: 'p1', workflowFile: '', match: match({ pattern: '^nightly', by: 'file' }) });
    const derived = expandFlow(f, WORKFLOWS);
    expect(derived.map((d) => d.id)).toEqual([
      'p1::nightly-linux.yml',
      'p1::nightly-windows.yml',
    ]);
    // Named after the workflow, queried by its numeric id (no extra resolve request).
    expect(derived.map((d) => d.name)).toEqual(['Nightly Linux', 'Nightly Windows']);
    expect(derived.map((d) => d.workflowFile)).toEqual(['1', '2']);
    expect(derived[0].source).toEqual({
      patternFlowId: 'p1',
      patternName: 'Flow',
      pattern: '^nightly',
      workflow: { id: 1, name: 'Nightly Linux', file: 'nightly-linux.yml' },
    });
  });

  it('inherits branches, events, maxRuns and the visibility filter', () => {
    const f = flow({ match: match({ pattern: 'nightly' }) });
    const [derived] = expandFlow(f, WORKFLOWS);
    expect(derived.branches).toEqual(f.branches);
    expect(derived.events).toEqual(f.events);
    expect(derived.maxRuns).toBe(f.maxRuns);
    expect(derived.emptyFilter).toEqual(f.emptyFilter);
  });

  it('clears the pattern on derived flows so they never expand again', () => {
    const [derived] = expandFlow(flow({ match: match({ pattern: 'nightly' }) }), WORKFLOWS);
    expect(isPatternFlow(derived)).toBe(false);
    expect(expandFlow(derived, WORKFLOWS)).toEqual([derived]);
  });

  it('contributes nothing while the repo workflow list is unknown', () => {
    expect(expandFlow(flow({ match: match({ pattern: 'nightly' }) }), undefined)).toEqual([]);
  });
});

describe('expandFlows', () => {
  it('keeps config order, expanding patterns in place', () => {
    const flows = [
      flow({ id: 'a' }),
      flow({ id: 'p', match: match({ pattern: '^nightly', by: 'file' }) }),
      flow({ id: 'b' }),
    ];
    expect(expandFlows(flows, () => WORKFLOWS).map((f) => f.id)).toEqual([
      'a',
      'p::nightly-linux.yml',
      'p::nightly-windows.yml',
      'b',
    ]);
  });
});

describe('derived id helpers', () => {
  it('round-trips the parent id and the file', () => {
    const id = derivedFlowId('parent-uuid', 'nightly-linux.yml');
    expect(isDerivedFlowId(id)).toBe(true);
    expect(patternFlowIdOf(id)).toBe('parent-uuid');
    expect(derivedFileOf(id)).toBe('nightly-linux.yml');
  });

  it('leaves plain ids alone', () => {
    expect(isDerivedFlowId('plain')).toBe(false);
    expect(patternFlowIdOf('plain')).toBe('plain');
    expect(derivedFileOf('plain')).toBe('');
  });
});

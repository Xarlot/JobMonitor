/**
 * Pattern flows: a configured flow whose `match.pattern` regex is expanded into
 * one *derived* flow per matching workflow of the repo. Derived flows are virtual
 * (they never reach the persisted config) but their ids are stable —
 * `<patternFlowId>::<workflow file>` — so group membership, expand state and the
 * run cache stick to them across reloads and re-expansions.
 *
 * A flow watching several branches is split the same way: one derived flow per
 * branch (`<flowId>::<file>@@<branch>`, the file empty for a single-workflow flow),
 * so `main, 2026.1` gives a card per branch instead of one card mixing both.
 */

import type { Workflow } from '../api/types';
import type { Flow, FlowMatch } from '../storage/configStore';
import { workflowBasename } from './workflow';

/** Separator between a pattern flow's id and the matched workflow's file name. */
export const DERIVED_ID_SEP = '::';
/** Separator before the branch of a flow split per branch (never in a workflow file name). */
export const BRANCH_ID_SEP = '@@';

export interface ResolvedFlow extends Flow {
  /** Set only on flows derived from a pattern flow's match. */
  source?: {
    /** Id of the configured flow this was expanded from (a regex and/or multi-branch flow). */
    patternFlowId: string;
    /** That flow's name and regex ('' when not a regex flow), for "where does this card come from?" UI. */
    patternName: string;
    pattern: string;
    /** The matched workflow — only on a regex match. */
    workflow?: { id: number; name: string; file: string };
    /** The one branch this card watches — only when the configured flow lists several. */
    branch?: string;
  };
}

export function isPatternFlow(flow: Flow): boolean {
  return flow.match.pattern.trim().length > 0;
}

export function derivedFlowId(patternFlowId: string, file: string, branch?: string): string {
  const suffix = branch === undefined ? '' : `${BRANCH_ID_SEP}${branch}`;
  return `${patternFlowId}${DERIVED_ID_SEP}${file}${suffix}`;
}

export function isDerivedFlowId(id: string): boolean {
  return id.includes(DERIVED_ID_SEP);
}

/** The configured flow an id came from (the id itself when not derived). */
export function patternFlowIdOf(id: string): string {
  const i = id.indexOf(DERIVED_ID_SEP);
  return i < 0 ? id : id.slice(0, i);
}

/** What follows the parent id in a derived id ('' when not derived). */
function derivedTail(id: string): string {
  const i = id.indexOf(DERIVED_ID_SEP);
  return i < 0 ? '' : id.slice(i + DERIVED_ID_SEP.length);
}

/** The matched workflow file encoded in a derived id ('' when not derived or not a regex match). */
export function derivedFileOf(id: string): string {
  const tail = derivedTail(id);
  const j = tail.indexOf(BRANCH_ID_SEP);
  return j < 0 ? tail : tail.slice(0, j);
}

/** The branch encoded in a derived id ('' when the flow wasn't split per branch). */
export function derivedBranchOf(id: string): string {
  const tail = derivedTail(id);
  const j = tail.indexOf(BRANCH_ID_SEP);
  return j < 0 ? '' : tail.slice(j + BRANCH_ID_SEP.length);
}

/**
 * Readable label for a placement whose flow isn't on the board right now (a
 * deleted flow, or a regex match the pattern no longer produces). `nameOf` looks
 * up a *configured* flow's name.
 */
export function describeFlowId(id: string, nameOf: (flowId: string) => string | undefined): string {
  if (!isDerivedFlowId(id)) return nameOf(id) ?? id;
  const parent = nameOf(patternFlowIdOf(id));
  const file = derivedFileOf(id);
  const branch = derivedBranchOf(id);
  const what = [file, branch].filter(Boolean).join(' @ ') || id;
  if (!parent) return what;
  return file ? `${what} (regex flow “${parent}”)` : `${what} (flow “${parent}”)`;
}

export interface CompiledPattern {
  /** null when the pattern is empty or does not compile. */
  re: RegExp | null;
  /** Syntax error message, if any (empty patterns are not an error). */
  error: string | null;
}

export function compileFlowPattern(match: FlowMatch): CompiledPattern {
  const pattern = match.pattern.trim();
  if (!pattern) return { re: null, error: null };
  try {
    return { re: new RegExp(pattern, match.caseSensitive ? '' : 'i'), error: null };
  } catch (e) {
    return { re: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Deleted workflows keep showing up in the list; nothing can run there again. */
function watchable(w: Workflow): boolean {
  return w.state !== 'deleted';
}

/**
 * Every workflow the pattern matches, sorted by display name and *not* capped —
 * for telling the user how many workflows their regex really hits, which a capped
 * count cannot do (it tops out at the cap and looks like the true total).
 */
export function matchWorkflowsUncapped(workflows: Workflow[], match: FlowMatch): Workflow[] {
  const { re } = compileFlowPattern(match);
  if (!re) return [];
  const hits = workflows.filter((w) => {
    if (!watchable(w)) return false;
    const file = workflowBasename(w.path);
    if (match.by === 'name') return re.test(w.name);
    if (match.by === 'file') return re.test(file);
    return re.test(w.name) || re.test(file);
  });
  hits.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      workflowBasename(a.path).localeCompare(workflowBasename(b.path)),
  );
  return hits;
}

/**
 * The matches a pattern flow actually expands into: as above, capped at
 * `maxMatches` (each match polls on its own, so the cap is a rate-limit guard).
 */
export function matchWorkflows(workflows: Workflow[], match: FlowMatch): Workflow[] {
  return matchWorkflowsUncapped(workflows, match).slice(0, match.maxMatches);
}

function derivedFlow(flow: Flow, w: Workflow): ResolvedFlow {
  const file = workflowBasename(w.path);
  return {
    ...flow,
    id: derivedFlowId(flow.id, file),
    name: w.name || file,
    // The numeric id needs no name→id resolution request on every poll.
    workflowFile: String(w.id),
    // A derived flow is concrete — it must never expand again.
    match: { ...flow.match, pattern: '' },
    source: {
      patternFlowId: flow.id,
      patternName: flow.name,
      pattern: flow.match.pattern,
      workflow: { id: w.id, name: w.name, file },
    },
  };
}

/**
 * One flow per branch of a flow that lists several, so their runs never share a
 * card. A single-branch flow is returned as is (same object).
 */
function splitByBranch(flow: ResolvedFlow, configured: Flow): ResolvedFlow[] {
  const branches = [...new Set(flow.branches)];
  if (branches.length <= 1) return [flow];
  const file = flow.source?.workflow?.file ?? '';
  return branches.map((branch) => ({
    ...flow,
    id: derivedFlowId(configured.id, file, branch),
    name: `${flow.name} · ${branch}`,
    branches: [branch],
    source: {
      patternFlowId: configured.id,
      patternName: configured.name,
      pattern: flow.source?.pattern ?? '',
      ...(flow.source?.workflow ? { workflow: flow.source.workflow } : {}),
      branch,
    },
  }));
}

/**
 * A plain flow stays itself; a pattern flow becomes one derived flow per match;
 * either is further split into one flow per branch when it lists several.
 * `workflows === undefined` means the repo's list isn't loaded yet — the pattern
 * contributes nothing rather than a misleading empty card.
 */
export function expandFlow(flow: Flow, workflows: Workflow[] | undefined): ResolvedFlow[] {
  if (!isPatternFlow(flow)) return splitByBranch(flow, flow);
  if (!workflows) return [];
  return matchWorkflows(workflows, flow.match).flatMap((w) =>
    splitByBranch(derivedFlow(flow, w), flow),
  );
}

/** Expand a whole config's flows, in order. */
export function expandFlows(
  flows: Flow[],
  workflowsFor: (flow: Flow) => Workflow[] | undefined,
): ResolvedFlow[] {
  return flows.flatMap((flow) => expandFlow(flow, workflowsFor(flow)));
}

/** Effective coordinates of a flow (its own override, else upstream). */
export function flowRepoRef(
  flow: Flow,
  upstream: { owner: string; repo: string },
): { owner: string; repo: string } {
  return { owner: flow.owner || upstream.owner, repo: flow.repo || upstream.repo };
}

export function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/**
 * Pattern flows: a configured flow whose `match.pattern` regex is expanded into
 * one *derived* flow per matching workflow of the repo. Derived flows are virtual
 * (they never reach the persisted config) but their ids are stable —
 * `<patternFlowId>::<workflow file>` — so group membership, expand state and the
 * run cache stick to them across reloads and re-expansions.
 */

import type { Workflow } from '../api/types';
import type { Flow, FlowMatch } from '../storage/configStore';
import { workflowBasename } from './workflow';

/** Separator between a pattern flow's id and the matched workflow's file name. */
export const DERIVED_ID_SEP = '::';

export interface ResolvedFlow extends Flow {
  /** Set only on flows derived from a pattern flow's match. */
  source?: {
    /** Id of the configured pattern flow this was expanded from. */
    patternFlowId: string;
    /** That flow's name and regex, for "where does this card come from?" UI. */
    patternName: string;
    pattern: string;
    workflow: { id: number; name: string; file: string };
  };
}

export function isPatternFlow(flow: Flow): boolean {
  return flow.match.pattern.trim().length > 0;
}

export function derivedFlowId(patternFlowId: string, file: string): string {
  return `${patternFlowId}${DERIVED_ID_SEP}${file}`;
}

export function isDerivedFlowId(id: string): boolean {
  return id.includes(DERIVED_ID_SEP);
}

/** The configured flow an id came from (the id itself when not derived). */
export function patternFlowIdOf(id: string): string {
  const i = id.indexOf(DERIVED_ID_SEP);
  return i < 0 ? id : id.slice(0, i);
}

/** The matched workflow file encoded in a derived id ('' when not derived). */
export function derivedFileOf(id: string): string {
  const i = id.indexOf(DERIVED_ID_SEP);
  return i < 0 ? '' : id.slice(i + DERIVED_ID_SEP.length);
}

/**
 * Readable label for a placement whose flow isn't on the board right now (a
 * deleted flow, or a regex match the pattern no longer produces). `nameOf` looks
 * up a *configured* flow's name.
 */
export function describeFlowId(id: string, nameOf: (flowId: string) => string | undefined): string {
  if (!isDerivedFlowId(id)) return nameOf(id) ?? id;
  const pattern = nameOf(patternFlowIdOf(id));
  const file = derivedFileOf(id);
  return pattern ? `${file} (regex flow “${pattern}”)` : file;
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
 * Workflows matching the pattern, sorted by display name and capped at
 * `maxMatches` (each match polls on its own, so the cap is a rate-limit guard).
 */
export function matchWorkflows(workflows: Workflow[], match: FlowMatch): Workflow[] {
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
  return hits.slice(0, match.maxMatches);
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
 * A plain flow stays itself; a pattern flow becomes one derived flow per match.
 * `workflows === undefined` means the repo's list isn't loaded yet — the pattern
 * contributes nothing rather than a misleading empty card.
 */
export function expandFlow(flow: Flow, workflows: Workflow[] | undefined): ResolvedFlow[] {
  if (!isPatternFlow(flow)) return [flow];
  if (!workflows) return [];
  return matchWorkflows(workflows, flow.match).map((w) => derivedFlow(flow, w));
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

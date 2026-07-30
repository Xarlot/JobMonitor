/**
 * Pure helpers for organizing flows into user-defined groups (shared by the
 * Flows board and the Overview). Membership lives in `config.groups[].flowIds`
 * by stable flow id; flows referenced by no group are "ungrouped".
 *
 * Sections are derived from *resolved* flows, so a regex (pattern) flow's matches
 * are grouped and dragged individually. A group may also list the pattern flow's
 * own id — that entry stands for "all of its matches that aren't placed
 * elsewhere", which is how a pattern's matches land in a group by default.
 *
 * All mutators return a new MonitorConfig (callers persist it via setConfig).
 */

import { patternFlowIdOf, type ResolvedFlow } from './flowPatterns';
import {
  newGroupId,
  type FlowBoard,
  type FlowGroup,
  type MonitorConfig,
} from '../storage/configStore';

export interface FlowSection {
  /** null = the implicit "Ungrouped" section. */
  group: FlowGroup | null;
  flows: ResolvedFlow[];
  /**
   * Ids this group holds that currently resolve to nothing — a deleted flow, or a
   * pattern match that the regex no longer produces. Kept (not pruned) so the
   * placement returns when the workflow does; surfaced so the UI can say why a
   * card is missing instead of silently dropping it.
   */
  pinnedMissing: string[];
}

/** Move `id` so it sits just before `beforeId` (or to the end when null). */
function insertId(ids: string[], id: string, beforeId: string | null): string[] {
  const out = ids.filter((x) => x !== id);
  const idx = beforeId ? out.indexOf(beforeId) : -1;
  if (idx >= 0) out.splice(idx, 0, id);
  else out.push(id);
  return out;
}

function reorder<T extends { id: string }>(arr: T[], id: string, beforeId: string | null): T[] {
  const item = arr.find((x) => x.id === id);
  if (!item) return arr;
  const rest = arr.filter((x) => x.id !== id);
  const idx = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
  if (idx >= 0) rest.splice(idx, 0, item);
  else rest.push(item);
  return rest;
}

/**
 * New `flowIds` for a group after dropping `flowId` before `beforeFlowId`, given
 * the ids the group currently *shows* (`visible`).
 *
 * The point is to name as few flows explicitly as possible: a run of consecutive
 * cards that covers *all* of a pattern placeholder's implicit matches collapses
 * back into the placeholder, so dropping a card above or below a pattern's block
 * leaves the pattern intact (and future matches keep joining the group). Only a
 * drop *between* a pattern's own matches has to pin them individually.
 */
function rewriteFlowIds(
  current: string[],
  visible: string[],
  flowId: string,
  beforeFlowId: string | null,
): string[] {
  const explicit = new Set(current);
  // Cards shown here only because a placeholder expanded, grouped by placeholder.
  const implicitOf = new Map<string, Set<string>>();
  for (const id of visible) {
    if (id === flowId || explicit.has(id)) continue;
    const parent = patternFlowIdOf(id);
    if (parent === id) continue; // not a pattern match: nothing to collapse into
    const set = implicitOf.get(parent) ?? new Set<string>();
    set.add(id);
    implicitOf.set(parent, set);
  }

  const target = insertId(visible, flowId, beforeFlowId);
  const out: string[] = [];
  const collapsed = new Set<string>();
  for (let i = 0; i < target.length; ) {
    const members = implicitOf.get(patternFlowIdOf(target[i]));
    if (!members?.has(target[i])) {
      out.push(target[i]);
      i += 1;
      continue;
    }
    const run: string[] = [];
    while (i < target.length && members.has(target[i])) run.push(target[i++]);
    if (run.length === members.size) {
      const parent = patternFlowIdOf(run[0]);
      out.push(parent);
      collapsed.add(parent);
    } else {
      out.push(...run); // split by the drop → these matches become explicit
    }
  }

  // Entries the group holds but doesn't show: placeholders we didn't re-emit, and
  // placements waiting for their flow. Kept, ahead of the visible order.
  const kept = current.filter(
    (id) => id !== flowId && !collapsed.has(id) && !target.includes(id),
  );
  return [...kept, ...out];
}

/** Listed ids first (in `order`), then everything else in its natural order. */
function orderUngrouped(flows: ResolvedFlow[], order: string[]): ResolvedFlow[] {
  if (order.length === 0) return flows;
  const rank = new Map(order.map((id, i) => [id, i]));
  const listed = flows
    .filter((f) => rank.has(f.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const rest = flows.filter((f) => !rank.has(f.id));
  return [...listed, ...rest];
}

/**
 * Ordered sections: each group (in config order) with its flows (in `flowIds`
 * order), then an Ungrouped section with the rest (`ungroupedOrder` first, then
 * resolved order). Robust to dangling ids and to a flow listed in several groups
 * (first wins).
 */
export function deriveSections(
  flows: ResolvedFlow[],
  groups: FlowGroup[],
  ungroupedOrder: string[] = [],
): FlowSection[] {
  const byId = new Map(flows.map((f) => [f.id, f]));
  // Matches per pattern flow, so a group listing the pattern's id shows them all.
  const byPattern = new Map<string, ResolvedFlow[]>();
  for (const flow of flows) {
    const parent = flow.source?.patternFlowId;
    if (!parent) continue;
    const list = byPattern.get(parent);
    if (list) list.push(flow);
    else byPattern.set(parent, [flow]);
  }
  // Ids the user placed by hand — a placed match is never pulled in by its pattern.
  const placed = new Set<string>([...groups.flatMap((g) => g.flowIds), ...ungroupedOrder]);

  const claimed = new Set<string>();
  const sections: FlowSection[] = groups.map((group) => {
    const groupFlows: ResolvedFlow[] = [];
    const pinnedMissing: string[] = [];
    for (const id of group.flowIds) {
      if (claimed.has(id)) continue; // a flow belongs to at most one group
      const flow = byId.get(id);
      if (flow) {
        groupFlows.push(flow);
        claimed.add(id);
        continue;
      }
      const derived = byPattern.get(id);
      if (derived) {
        claimed.add(id);
        for (const match of derived) {
          if (claimed.has(match.id) || placed.has(match.id)) continue;
          groupFlows.push(match);
          claimed.add(match.id);
        }
        continue;
      }
      pinnedMissing.push(id);
    }
    return { group, flows: groupFlows, pinnedMissing };
  });

  const rest = flows.filter((f) => !claimed.has(f.id));
  sections.push({
    group: null,
    flows: orderUngrouped(rest, ungroupedOrder),
    // Same for the ungrouped placements: an id that resolves to nothing and isn't
    // a pattern placeholder (those stand for the matches shown right here).
    pinnedMissing: ungroupedOrder.filter(
      (id) => !byId.has(id) && !byPattern.has(id) && !claimed.has(id),
    ),
  });
  return sections;
}

/**
 * Forget placements by id — the "unmatched" leftovers a group (or the ungrouped
 * order) keeps for flows that are gone: a deleted flow, or a workflow the regex
 * no longer matches. Flow definitions are untouched; this only drops the layout
 * entries, so a match placed by hand goes back to following its pattern.
 */
export function forgetPlacements(config: MonitorConfig, ids: string[]): MonitorConfig {
  const drop = new Set(ids);
  if (drop.size === 0) return config;
  return {
    ...config,
    groups: config.groups.map((g) => ({
      ...g,
      flowIds: g.flowIds.filter((id) => !drop.has(id)),
    })),
    ungroupedOrder: config.ungroupedOrder.filter((id) => !drop.has(id)),
  };
}

export function addGroup(config: MonitorConfig, name: string): MonitorConfig {
  const group: FlowGroup = { id: newGroupId(), name: name.trim() || 'New group', flowIds: [], collapsed: false };
  return { ...config, groups: [...config.groups, group] };
}

export function renameGroup(config: MonitorConfig, groupId: string, name: string): MonitorConfig {
  return {
    ...config,
    groups: config.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
  };
}

/** Remove a group; its flows fall back to ungrouped (flow definitions are kept). */
export function deleteGroup(config: MonitorConfig, groupId: string): MonitorConfig {
  return { ...config, groups: config.groups.filter((g) => g.id !== groupId) };
}

export function setGroupCollapsed(
  config: MonitorConfig,
  groupId: string,
  collapsed: boolean,
): MonitorConfig {
  return {
    ...config,
    groups: config.groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)),
  };
}

/** Reorder groups: move `groupId` before `beforeGroupId` (or to the end). */
export function moveGroup(
  config: MonitorConfig,
  groupId: string,
  beforeGroupId: string | null,
): MonitorConfig {
  return { ...config, groups: reorder(config.groups, groupId, beforeGroupId) };
}

/**
 * Move a flow into `targetGroupId` (null = ungrouped), positioned before
 * `beforeFlowId` (or last). Removes it from any group first, and expands the
 * target group so the card can't land out of sight.
 *
 * Works for pattern-derived flows too. `sectionIds` is the id order the target
 * section currently *shows* (views pass it), which is what makes a drop land
 * exactly where it was aimed — see `rewriteFlowIds` for how little of it gets
 * pinned. Ungrouped has no `flowIds`, so its order (and the fact that a match was
 * deliberately taken out of its pattern's group) lives in `ungroupedOrder`.
 */
export function moveFlow(
  config: MonitorConfig,
  flowId: string,
  targetGroupId: string | null,
  beforeFlowId: string | null,
  sectionIds?: string[],
): MonitorConfig {
  const groups = config.groups.map((g) => ({
    ...g,
    flowIds: g.flowIds.filter((id) => id !== flowId),
  }));
  const visible = sectionIds?.filter((id) => id !== flowId);

  if (targetGroupId) {
    const current = groups.find((g) => g.id === targetGroupId)?.flowIds ?? [];
    const flowIds = visible
      ? rewriteFlowIds(current, visible, flowId, beforeFlowId)
      : insertId(current, flowId, beforeFlowId);
    return {
      ...config,
      // No longer ungrouped: drop any explicit ungrouped placement.
      ungroupedOrder: config.ungroupedOrder.filter((id) => id !== flowId),
      groups: groups.map((g) => (g.id === targetGroupId ? { ...g, collapsed: false, flowIds } : g)),
    };
  }

  // Ungrouped: configured flows also reorder `config.flows` (that's the Settings
  // order, and the fallback order for boards that never used drag & drop).
  const configured = config.flows.some((f) => f.id === flowId);
  const kept = config.ungroupedOrder.filter((id) => id !== flowId && !visible?.includes(id));
  const base = visible ? [...kept, ...visible] : config.ungroupedOrder;
  const record = !configured || base.length > 0;
  return {
    ...config,
    groups,
    flows: configured ? reorder(config.flows, flowId, beforeFlowId) : config.flows,
    ungroupedOrder: record ? insertId(base, flowId, beforeFlowId) : config.ungroupedOrder,
  };
}

/** Snapshot of flows + grouping for cross-machine transfer. */
export function exportBoard(config: MonitorConfig): FlowBoard {
  return {
    version: 1,
    flows: config.flows,
    groups: config.groups,
    ungroupedOrder: config.ungroupedOrder,
  };
}

/** Replace flows + grouping from an imported board (id-keyed, unambiguous). */
export function applyBoard(config: MonitorConfig, board: FlowBoard): MonitorConfig {
  return {
    ...config,
    flows: board.flows,
    groups: board.groups,
    ungroupedOrder: board.ungroupedOrder,
  };
}

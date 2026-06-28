/**
 * Pure helpers for organizing flows into user-defined groups (shared by the
 * Flows board and the Overview). Membership lives in `config.groups[].flowIds`
 * by stable flow id; flows referenced by no group are "ungrouped".
 *
 * All mutators return a new MonitorConfig (callers persist it via setConfig).
 */

import {
  newGroupId,
  type Flow,
  type FlowBoard,
  type FlowGroup,
  type MonitorConfig,
} from '../storage/configStore';

export interface FlowSection {
  /** null = the implicit "Ungrouped" section. */
  group: FlowGroup | null;
  flows: Flow[];
}

/**
 * Ordered sections: each group (in config order) with its flows (in `flowIds`
 * order), then an Ungrouped section with the rest (in `config.flows` order).
 * Robust to dangling ids and to a flow listed in several groups (first wins).
 */
export function deriveSections(flows: Flow[], groups: FlowGroup[]): FlowSection[] {
  const byId = new Map(flows.map((f) => [f.id, f]));
  const claimed = new Set<string>();
  const sections: FlowSection[] = groups.map((group) => {
    const groupFlows: Flow[] = [];
    for (const id of group.flowIds) {
      if (claimed.has(id)) continue; // a flow belongs to at most one group
      const flow = byId.get(id);
      if (flow) {
        groupFlows.push(flow);
        claimed.add(id);
      }
    }
    return { group, flows: groupFlows };
  });
  sections.push({ group: null, flows: flows.filter((f) => !claimed.has(f.id)) });
  return sections;
}

/** Move `id` so it sits just before `beforeId` (or to the end when null). */
function reorder<T extends { id: string }>(arr: T[], id: string, beforeId: string | null): T[] {
  const item = arr.find((x) => x.id === id);
  if (!item) return arr;
  const rest = arr.filter((x) => x.id !== id);
  const idx = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
  if (idx >= 0) rest.splice(idx, 0, item);
  else rest.push(item);
  return rest;
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
 * `beforeFlowId` (or last). Removes it from any group first. For the ungrouped
 * target the position is encoded by reordering `config.flows` (that's the
 * ungrouped render order); within a group the position is `flowIds` order.
 */
export function moveFlow(
  config: MonitorConfig,
  flowId: string,
  targetGroupId: string | null,
  beforeFlowId: string | null,
): MonitorConfig {
  const groups = config.groups.map((g) => ({
    ...g,
    flowIds: g.flowIds.filter((id) => id !== flowId),
  }));

  if (targetGroupId) {
    return {
      ...config,
      groups: groups.map((g) => {
        if (g.id !== targetGroupId) return g;
        const flowIds = [...g.flowIds];
        const idx = beforeFlowId ? flowIds.indexOf(beforeFlowId) : -1;
        if (idx >= 0) flowIds.splice(idx, 0, flowId);
        else flowIds.push(flowId);
        return { ...g, flowIds };
      }),
    };
  }

  // Ungrouped: reflect order via config.flows.
  return { ...config, groups, flows: reorder(config.flows, flowId, beforeFlowId) };
}

/** Snapshot of flows + grouping for cross-machine transfer. */
export function exportBoard(config: MonitorConfig): FlowBoard {
  return { version: 1, flows: config.flows, groups: config.groups };
}

/** Replace flows + grouping from an imported board (id-keyed, unambiguous). */
export function applyBoard(config: MonitorConfig, board: FlowBoard): MonitorConfig {
  return { ...config, flows: board.flows, groups: board.groups };
}

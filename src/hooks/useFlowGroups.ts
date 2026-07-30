/**
 * Binds the pure flow-group helpers to the live config, so the Overview and the
 * Flows board share one grouping model (persisted via ConfigContext).
 *
 * Sections are built from *resolved* flows (regex flows expanded into one flow per
 * matched workflow), so every card on the board — pattern match or not — is
 * grouped and dragged the same way.
 */

import { useMemo } from 'react';
import { useConfig } from '../context/ConfigContext';
import { useResolvedFlows, type PatternStatus } from '../context/ResolvedFlowsContext';
import type { FlowBoard } from '../storage/configStore';
import { describeFlowId, type ResolvedFlow } from '../lib/flowPatterns';
import * as G from '../lib/flowGroups';

export function useFlowGroups() {
  const { config, setConfig } = useConfig();
  const { flows, patterns, resolving } = useResolvedFlows();

  return useMemo(() => {
    const sections = G.deriveSections(flows, config.groups, config.ungroupedOrder).map((s) => ({
      ...s,
      // A regex flow with no matches right now isn't a stale placement — the board
      // already warns about the pattern itself.
      pinnedMissing: s.pinnedMissing.filter((id) => !patterns.has(id)),
    }));
    // What the target section shows right now, so a drop lands exactly where aimed
    // (and a pattern's implicit matches become explicit members).
    const sectionIds = (groupId: string | null) =>
      sections.find((s) => (s.group?.id ?? null) === groupId)?.flows.map((f) => f.id);
    return {
      config,
      /** Every flow on the board, patterns already expanded. */
      flows: flows as ResolvedFlow[],
      sections,
      /** Resolution status per pattern flow id (empty for configs without patterns). */
      patterns: patterns as ReadonlyMap<string, PatternStatus>,
      /** A pattern's workflow list is still loading — don't cry "missing" yet. */
      resolving,
      /** Readable label for an id in `section.pinnedMissing`. */
      describeId: (id: string) => describeFlowId(id, (fid) => config.flows.find((f) => f.id === fid)?.name),
      /** Drop stale layout entries (the "unmatched" ones); flows are untouched. */
      forgetPlacements: (ids: string[]) => setConfig(G.forgetPlacements(config, ids)),
      addGroup: (name: string) => setConfig(G.addGroup(config, name)),
      renameGroup: (id: string, name: string) => setConfig(G.renameGroup(config, id, name)),
      deleteGroup: (id: string) => setConfig(G.deleteGroup(config, id)),
      setCollapsed: (id: string, collapsed: boolean) =>
        setConfig(G.setGroupCollapsed(config, id, collapsed)),
      moveGroup: (id: string, beforeId: string | null) =>
        setConfig(G.moveGroup(config, id, beforeId)),
      moveFlow: (flowId: string, targetGroupId: string | null, beforeFlowId: string | null) =>
        setConfig(
          G.moveFlow(config, flowId, targetGroupId, beforeFlowId, sectionIds(targetGroupId)),
        ),
      exportBoard: (): FlowBoard => G.exportBoard(config),
      applyBoard: (board: FlowBoard) => setConfig(G.applyBoard(config, board)),
    };
  }, [config, setConfig, flows, patterns, resolving]);
}

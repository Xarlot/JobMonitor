/**
 * Binds the pure flow-group helpers to the live config, so the Overview and the
 * Flows board share one grouping model (persisted via ConfigContext).
 */

import { useMemo } from 'react';
import { useConfig } from '../context/ConfigContext';
import type { FlowBoard } from '../storage/configStore';
import * as G from '../lib/flowGroups';

export function useFlowGroups() {
  const { config, setConfig } = useConfig();

  return useMemo(
    () => ({
      config,
      sections: G.deriveSections(config.flows, config.groups),
      addGroup: (name: string) => setConfig(G.addGroup(config, name)),
      renameGroup: (id: string, name: string) => setConfig(G.renameGroup(config, id, name)),
      deleteGroup: (id: string) => setConfig(G.deleteGroup(config, id)),
      setCollapsed: (id: string, collapsed: boolean) =>
        setConfig(G.setGroupCollapsed(config, id, collapsed)),
      moveGroup: (id: string, beforeId: string | null) =>
        setConfig(G.moveGroup(config, id, beforeId)),
      moveFlow: (flowId: string, targetGroupId: string | null, beforeFlowId: string | null) =>
        setConfig(G.moveFlow(config, flowId, targetGroupId, beforeFlowId)),
      exportBoard: (): FlowBoard => G.exportBoard(config),
      applyBoard: (board: FlowBoard) => setConfig(G.applyBoard(config, board)),
    }),
    [config, setConfig],
  );
}

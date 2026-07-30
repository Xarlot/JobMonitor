/**
 * Mounts each resolved flow's runtime (useFlow) once, regardless of the active
 * tab, and publishes their live state into a tiny external store. Both the Flows
 * grid and the Overview read from this store via useSyncExternalStore — so flows
 * keep polling in the background and feed the Overview without double-polling.
 *
 * "Resolved" = a regex flow's matches each get their own runner, keyed by the
 * derived flow id, so they poll, cache and expand independently.
 *
 * The provider itself does not subscribe to the store, so store updates never
 * re-render the FlowRunners (which would loop).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useResolvedFlows } from './ResolvedFlowsContext';
import { useFlow, type FlowState } from '../hooks/useFlows';
import type { Flow } from '../storage/configStore';

type FlowStatesMap = ReadonlyMap<string, FlowState>;

interface RuntimeApi {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => FlowStatesMap;
}

const FlowsRuntimeContext = createContext<RuntimeApi | null>(null);

function FlowRunner({
  flow,
  publish,
}: {
  flow: Flow;
  publish: (id: string, state: FlowState) => void;
}) {
  const state = useFlow(flow);
  useEffect(() => {
    publish(flow.id, state);
  });
  return null;
}

export function FlowsRuntimeProvider({ children }: { children: ReactNode }) {
  const { flows } = useResolvedFlows();
  const mapRef = useRef<Map<string, FlowState>>(new Map());
  const listenersRef = useRef<Set<() => void>>(new Set());

  const notify = useCallback(() => {
    for (const l of listenersRef.current) l();
  }, []);

  const publish = useCallback(
    (id: string, state: FlowState) => {
      const next = new Map(mapRef.current);
      next.set(id, state);
      mapRef.current = next;
      notify();
    },
    [notify],
  );

  // Drop runtime state for flows that are gone (removed, or no longer matched).
  useEffect(() => {
    const ids = new Set(flows.map((f) => f.id));
    let changed = false;
    const next = new Map(mapRef.current);
    for (const key of next.keys()) {
      if (!ids.has(key)) {
        next.delete(key);
        changed = true;
      }
    }
    if (changed) {
      mapRef.current = next;
      notify();
    }
  }, [flows, notify]);

  const api = useMemo<RuntimeApi>(
    () => ({
      subscribe: (cb) => {
        listenersRef.current.add(cb);
        return () => listenersRef.current.delete(cb);
      },
      getSnapshot: () => mapRef.current,
    }),
    [],
  );

  return (
    <FlowsRuntimeContext.Provider value={api}>
      {flows.map((flow) => (
        <FlowRunner key={flow.id} flow={flow} publish={publish} />
      ))}
      {children}
    </FlowsRuntimeContext.Provider>
  );
}

export function useFlowStates(): FlowStatesMap {
  const api = useContext(FlowsRuntimeContext);
  if (!api) throw new Error('useFlowStates must be used within FlowsRuntimeProvider');
  return useSyncExternalStore(api.subscribe, api.getSnapshot, api.getSnapshot);
}

export function useFlowState(flowId: string): FlowState | undefined {
  return useFlowStates().get(flowId);
}

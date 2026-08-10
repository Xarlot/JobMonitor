/** Holds the MonitorConfig, persisting changes to localStorage. */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  isConfigComplete,
  loadConfig,
  saveConfig,
  type MonitorConfig,
} from '../storage/configStore';
import { isMockMode } from '../mocks/mockMode';
import { MOCK_CONFIG } from '../mocks/fixtures';
import { Operation, Telemetry } from '../lib/telemetry';

interface ConfigContextValue {
  config: MonitorConfig;
  setConfig: (next: MonitorConfig) => void;
  complete: boolean;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

function initialConfig(): MonitorConfig {
  if (isMockMode()) return MOCK_CONFIG;
  // Synchronous — localStorage plus a Zod parse — so it is timed by hand rather than with
  // `measure`, which is promise-shaped. It runs before the first paint, and a slow parse here is
  // felt as the app being slow to appear rather than as anything being slow later.
  const startedAtMs = performance.now();
  const config = loadConfig();
  Telemetry.operationCompleted(Operation.CONFIG_LOAD, performance.now() - startedAtMs);
  return config;
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<MonitorConfig>(initialConfig);

  const setConfig = useCallback((next: MonitorConfig) => {
    setConfigState(next);
    if (!isMockMode()) saveConfig(next);
  }, []);

  const value = useMemo<ConfigContextValue>(
    () => ({ config, setConfig, complete: isConfigComplete(config) }),
    [config, setConfig],
  );

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider');
  return ctx;
}

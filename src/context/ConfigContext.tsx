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

interface ConfigContextValue {
  config: MonitorConfig;
  setConfig: (next: MonitorConfig) => void;
  complete: boolean;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

function initialConfig(): MonitorConfig {
  return isMockMode() ? MOCK_CONFIG : loadConfig();
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

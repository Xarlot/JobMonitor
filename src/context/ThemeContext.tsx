import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { BaseStyles, ThemeProvider } from '@primer/react';

export type ThemeMode = 'auto' | 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Cycle auto → light → dark → auto. */
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'auto',
  setMode: () => {},
  cycle: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'job-monitor.theme';
const NIGHT_SCHEME = 'dark_dimmed';
const NEXT: Record<ThemeMode, ThemeMode> = { auto: 'light', light: 'dark', dark: 'auto' };

function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(loadMode);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);

  const cycle = useCallback(() => setMode(NEXT[mode]), [mode, setMode]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-color-mode', mode);
    // Use GitHub's softer "dark dimmed" palette for the dark scheme.
    root.setAttribute('data-dark-theme', NIGHT_SCHEME);
  }, [mode]);

  const colorMode = mode === 'light' ? 'day' : mode === 'dark' ? 'night' : 'auto';

  return (
    <ThemeContext.Provider value={{ mode, setMode, cycle }}>
      <ThemeProvider colorMode={colorMode} nightScheme={NIGHT_SCHEME}>
        <BaseStyles>{children}</BaseStyles>
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}

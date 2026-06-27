/**
 * Auth state machine over the secure token store.
 *
 *   loading -> needs-setup (no envelope)   --saveToken-->  unlocked
 *           -> locked (envelope present)   --unlock---->   unlocked
 *   unlocked --lock--> locked,  --forget--> needs-setup
 *
 * Consumers only read `status`; the plaintext token stays in secureTokenStore's
 * memory and is read directly by the GitHub client.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  forgetToken,
  hasStoredToken,
  lockToken,
  saveToken as persistToken,
  setTokenInMemory,
  unlockToken,
} from '../storage/secureTokenStore';
import { clearEtagCache } from '../api/githubClient';
import { clearLogCache } from '../api/logCache';
import { forgetSecret, recallSecret, rememberSecret } from '../storage/desktopSecret';
import { isMockMode } from '../mocks/mockMode';

export type AuthStatus = 'loading' | 'needs-setup' | 'locked' | 'unlocked';

interface AuthContextValue {
  status: AuthStatus;
  error: string | null;
  /** `remember` persists the passphrase in the OS keychain (desktop app only). */
  saveToken: (token: string, passphrase: string, remember?: boolean) => Promise<void>;
  unlock: (passphrase: string, remember?: boolean) => Promise<void>;
  forget: () => Promise<void>;
  lock: () => void;
}

/** Persist or drop the remembered passphrase based on the `remember` choice. */
async function syncRemembered(passphrase: string, remember: boolean): Promise<void> {
  if (remember) await rememberSecret(passphrase);
  else await forgetSecret();
}

const AuthContext = createContext<AuthContextValue | null>(null);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Unexpected error.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isMockMode()) {
      setTokenInMemory('mock-token');
      setStatus('unlocked');
      return;
    }
    let active = true;
    (async () => {
      const exists = await hasStoredToken().catch(() => false);
      if (!active) return;
      if (!exists) {
        setStatus('needs-setup');
        return;
      }
      // Desktop only: auto-unlock with a passphrase remembered in the OS keychain.
      const remembered = await recallSecret().catch(() => null);
      if (active && remembered) {
        try {
          await unlockToken(remembered);
          if (active) setStatus('unlocked');
          return;
        } catch {
          await forgetSecret().catch(() => {}); // stale/invalid -> drop it
        }
      }
      if (active) setStatus('locked');
    })();
    return () => {
      active = false;
    };
  }, []);

  const saveToken = useCallback(async (token: string, passphrase: string, remember = false) => {
    setError(null);
    try {
      await persistToken(token, passphrase);
      await syncRemembered(passphrase, remember);
      clearEtagCache();
      setStatus('unlocked');
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }, []);

  const unlock = useCallback(async (passphrase: string, remember = false) => {
    setError(null);
    try {
      await unlockToken(passphrase);
      await syncRemembered(passphrase, remember);
      setStatus('unlocked');
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }, []);

  const forget = useCallback(async () => {
    setError(null);
    await forgetToken();
    await forgetSecret();
    clearEtagCache();
    clearLogCache();
    setStatus('needs-setup');
  }, []);

  const lock = useCallback(() => {
    lockToken();
    clearEtagCache();
    clearLogCache();
    setStatus('locked');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, error, saveToken, unlock, forget, lock }),
    [status, error, saveToken, unlock, forget, lock],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

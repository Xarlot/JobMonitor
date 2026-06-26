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
import { isMockMode } from '../mocks/mockMode';

export type AuthStatus = 'loading' | 'needs-setup' | 'locked' | 'unlocked';

interface AuthContextValue {
  status: AuthStatus;
  error: string | null;
  saveToken: (token: string, passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  forget: () => Promise<void>;
  lock: () => void;
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
    hasStoredToken()
      .then((exists) => active && setStatus(exists ? 'locked' : 'needs-setup'))
      .catch(() => active && setStatus('needs-setup'));
    return () => {
      active = false;
    };
  }, []);

  const saveToken = useCallback(async (token: string, passphrase: string) => {
    setError(null);
    try {
      await persistToken(token, passphrase);
      clearEtagCache();
      setStatus('unlocked');
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }, []);

  const unlock = useCallback(async (passphrase: string) => {
    setError(null);
    try {
      await unlockToken(passphrase);
      setStatus('unlocked');
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }, []);

  const forget = useCallback(async () => {
    setError(null);
    await forgetToken();
    clearEtagCache();
    setStatus('needs-setup');
  }, []);

  const lock = useCallback(() => {
    lockToken();
    clearEtagCache();
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

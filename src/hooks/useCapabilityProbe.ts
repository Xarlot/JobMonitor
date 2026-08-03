/**
 * Completes the token-capability picture for the watched repository.
 *
 * Token scopes arrive for free on response headers, but re-running workflows also
 * needs the **Write** repository role, which costs one read of the repo. That
 * request is only worth making when it can actually change the answer — i.e. when
 * we already know the token is a classic PAT carrying `repo`. A fine-grained token
 * can never be verified, so it never spends the request.
 */

import { useEffect } from 'react';
import { probePushAccess } from '../api/workflows';
import { needsPushProbe, recordPushAccess } from '../api/tokenCapability';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import { useTokenCapability } from './useTokenCapability';

export function useCapabilityProbe(): void {
  const { config, complete } = useConfig();
  const { status } = useAuth();
  const capability = useTokenCapability();
  const { owner, repo } = config.upstream;

  const shouldProbe = status === 'unlocked' && complete && needsPushProbe(capability);

  useEffect(() => {
    if (!shouldProbe) return;
    // Drop any answer carried over from another repo before asking about this one.
    recordPushAccess(null);
    void probePushAccess(owner, repo);
  }, [shouldProbe, owner, repo]);
}

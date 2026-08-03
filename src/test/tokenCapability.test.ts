import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTokenCapability,
  parseScopes,
  recordPushAccess,
  recordTokenKind,
  recordTokenScopes,
  recordWriteRefused,
  resetTokenCapability,
  scopesAllowRerun,
  subscribeTokenCapability,
  tokenKindFromValue,
} from '../api/tokenCapability';

/** Only the scope header matters to the store; other headers are noise. */
function headers(scopes?: string): Headers {
  const h = new Headers({ 'x-ratelimit-remaining': '4999' });
  if (scopes !== undefined) h.set('x-oauth-scopes', scopes);
  return h;
}

/** The verified-writable path: classic token with `repo`, and Write role. */
function grantClassicRepoWithPush(): void {
  recordTokenScopes(headers('repo, workflow'));
  recordPushAccess(true);
}

describe('parseScopes', () => {
  it('splits, trims and lowercases', () => {
    expect(parseScopes('repo, user')).toEqual(['repo', 'user']);
    expect(parseScopes('  Repo ,WORKFLOW  ')).toEqual(['repo', 'workflow']);
  });

  it('yields an empty list for an empty header value', () => {
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes('   ')).toEqual([]);
  });
});

describe('scopesAllowRerun', () => {
  it('requires `repo`', () => {
    expect(scopesAllowRerun(['repo'])).toBe(true);
    expect(scopesAllowRerun(['repo', 'user'])).toBe(true);
  });

  // `public_repo` alone is not documented as sufficient for the re-run endpoints,
  // and `workflow` governs workflow *file contents*, not run control.
  it('rejects public_repo and workflow on their own', () => {
    expect(scopesAllowRerun(['public_repo'])).toBe(false);
    expect(scopesAllowRerun(['workflow'])).toBe(false);
    expect(scopesAllowRerun(['public_repo', 'workflow'])).toBe(false);
    expect(scopesAllowRerun([])).toBe(false);
  });
});

describe('tokenKindFromValue', () => {
  it('recognises the documented prefixes', () => {
    expect(tokenKindFromValue('ghp_abc')).toBe('classic');
    expect(tokenKindFromValue('github_pat_abc')).toBe('fine-grained');
    expect(tokenKindFromValue('ghs_abc')).toBe('other');
    expect(tokenKindFromValue('ghu_abc')).toBe('other');
  });

  it('treats a pre-2021 40-char hex token as classic', () => {
    expect(tokenKindFromValue('a'.repeat(40))).toBe('classic');
  });

  it('is unknown for anything else', () => {
    expect(tokenKindFromValue(null)).toBe('unknown');
    expect(tokenKindFromValue('mock-token')).toBe('unknown');
  });
});

describe('token capability ladder', () => {
  beforeEach(() => {
    resetTokenCapability();
  });

  it('starts unable to write, so no control can render before we know', () => {
    const cap = getTokenCapability();
    expect(cap.canRerun).toBe(false);
    expect(cap.reason).toBe('pending');
    expect(cap.scopes).toBeNull();
  });

  it('grants re-run for a classic `repo` token whose account can push', () => {
    grantClassicRepoWithPush();
    const cap = getTokenCapability();
    expect(cap.canRerun).toBe(true);
    expect(cap.reason).toBe('ok');
    expect(cap.kind).toBe('classic');
  });

  it('withholds re-run while push access is still unknown', () => {
    recordTokenScopes(headers('repo'));
    expect(getTokenCapability()).toMatchObject({ canRerun: false, reason: 'pending' });
  });

  // Scope is a ceiling, not a grant: re-running needs the Write role too.
  it('withholds re-run when the account has no push access', () => {
    recordTokenScopes(headers('repo'));
    recordPushAccess(false);
    expect(getTokenCapability()).toMatchObject({ canRerun: false, reason: 'no-push-access' });
  });

  it('withholds re-run for a classic token without `repo`', () => {
    recordTokenScopes(headers('public_repo, read:org'));
    recordPushAccess(true);
    expect(getTokenCapability()).toMatchObject({ canRerun: false, reason: 'no-repo-scope' });
  });

  it('reads a scope header present but empty as classic-and-not-permitted', () => {
    recordTokenScopes(headers(''));
    recordPushAccess(true);
    const cap = getTokenCapability();
    expect(cap.kind).toBe('classic');
    expect(cap.scopes).toEqual([]);
    expect(cap.canRerun).toBe(false);
    expect(cap.reason).toBe('no-repo-scope');
  });

  /**
   * The load-bearing case. A fine-grained PAT sends no scope header and its
   * `actions: write` grant is undiscoverable, so it must never be granted — and
   * `permissions.push` must not be able to talk us into it, because that field
   * reports the *user's* role, not the token's grants.
   */
  it('never grants re-run without a scope header, even when push access is true', () => {
    recordTokenScopes(headers()); // header absent
    recordPushAccess(true);
    const cap = getTokenCapability();
    expect(cap.canRerun).toBe(false);
    expect(cap.reason).toBe('not-classic');
  });

  it('keeps a fine-grained token labelled as such for the settings readout', () => {
    recordTokenKind('fine-grained');
    recordTokenScopes(headers());
    recordPushAccess(true);
    expect(getTokenCapability()).toMatchObject({ kind: 'fine-grained', canRerun: false });
  });

  it("lets GitHub's scope header override a wrong prefix guess", () => {
    recordTokenKind('unknown'); // e.g. the mock token, which has no prefix
    recordTokenScopes(headers('repo'));
    recordPushAccess(true);
    expect(getTokenCapability()).toMatchObject({ kind: 'classic', canRerun: true });
  });

  it('does not let a later header-less response erase known scopes', () => {
    grantClassicRepoWithPush();
    // e.g. a response that didn't carry the header for whatever reason
    recordTokenScopes(headers());
    expect(getTokenCapability().canRerun).toBe(true);
  });

  it('latches off when GitHub refuses a write for lack of permission', () => {
    grantClassicRepoWithPush();
    recordWriteRefused();
    expect(getTokenCapability()).toMatchObject({ canRerun: false, reason: 'refused' });
  });

  it('drops a stale push answer when the watched repo changes', () => {
    grantClassicRepoWithPush();
    recordPushAccess(null); // what useCapabilityProbe does before re-probing
    expect(getTokenCapability()).toMatchObject({ canRerun: false, reason: 'pending' });
  });

  it('resets on lock / forget', () => {
    grantClassicRepoWithPush();
    resetTokenCapability();
    expect(getTokenCapability()).toMatchObject({
      canRerun: false,
      reason: 'pending',
      scopes: null,
      userCanPush: null,
      kind: 'unknown',
    });
  });

  it('notifies subscribers when capability changes, but not on no-op updates', () => {
    let calls = 0;
    const unsubscribe = subscribeTokenCapability(() => {
      calls += 1;
    });
    recordTokenScopes(headers('repo'));
    recordPushAccess(true);
    const afterGrant = calls;
    expect(afterGrant).toBeGreaterThan(0);

    // Same headers again — nothing changed, so no re-render should be triggered.
    recordTokenScopes(headers('repo'));
    expect(calls).toBe(afterGrant);
    unsubscribe();
  });
});

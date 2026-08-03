/**
 * What the current token is allowed to DO — the gate in front of every write.
 *
 * Exposed as a tiny external store (consumed via useSyncExternalStore), like
 * rateLimit.ts. `canRerun` starts false and only ever becomes true on positive
 * proof, so a write control can never render before capability is known.
 *
 * The ladder, and why it is shaped this way:
 *
 *  - Classic PATs (and OAuth tokens) report their scopes in the `X-OAuth-Scopes`
 *    response header, which GitHub lists in `Access-Control-Expose-Headers` — so
 *    it is readable from the browser and costs no extra request. Re-running jobs
 *    needs the `repo` scope (`public_repo` alone is NOT documented as sufficient;
 *    the `workflow` scope governs workflow *file contents*, not run control).
 *  - Scope is only a ceiling. Re-running also needs the **Write** repository role,
 *    so `permissions.push` from GET /repos/{owner}/{repo} must agree — otherwise a
 *    `repo`-scoped token held by a read-only collaborator would show the feature
 *    and then 403.
 *  - Fine-grained PATs send no scope header, and their `actions: write` grant is
 *    undiscoverable: there is no token-introspection endpoint, the
 *    `X-Accepted-GitHub-Permissions` header is not CORS-exposed, and every
 *    repo-level Actions GET needs only `actions: read`, so no side-effect-free
 *    probe can tell read from write. `permissions.push` cannot stand in either —
 *    it reflects the *user's* role, not the token's grants (GET /repos needs only
 *    `metadata: read`). Such tokens are therefore treated as read-only.
 */

export type TokenKind = 'classic' | 'fine-grained' | 'other' | 'unknown';

export type CapabilityReason =
  /** Verified: classic token with `repo`, and the user can push. */
  | 'ok'
  /** Nothing observed yet (no response seen since the last reset). */
  | 'pending'
  /** Classic token, but `repo` is missing. */
  | 'no-repo-scope'
  /** No scope header — fine-grained PAT or an app token; undeterminable. */
  | 'not-classic'
  /** Token is fine, but the account's role on this repo is read-only. */
  | 'no-push-access'
  /** GitHub refused a write with "Resource not accessible by …". */
  | 'refused';

export interface TokenCapability {
  kind: TokenKind;
  /** Parsed `X-OAuth-Scopes`; null when the header was absent. */
  scopes: string[] | null;
  /** `permissions.push` from the repo probe; null until probed. */
  userCanPush: boolean | null;
  /** True only when a write is known to be permitted. */
  canRerun: boolean;
  reason: CapabilityReason;
  checkedAt: number | null;
}

const initial: TokenCapability = {
  kind: 'unknown',
  scopes: null,
  userCanPush: null,
  canRerun: false,
  reason: 'pending',
  checkedAt: null,
};

let current: TokenCapability = initial;
const listeners = new Set<() => void>();

export function getTokenCapability(): TokenCapability {
  return current;
}

export function subscribeTokenCapability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(next: TokenCapability): void {
  // Skip no-op updates so useSyncExternalStore doesn't re-render on every poll.
  if (
    next.kind === current.kind &&
    next.canRerun === current.canRerun &&
    next.reason === current.reason &&
    next.userCanPush === current.userCanPush &&
    sameScopes(next.scopes, current.scopes)
  ) {
    return;
  }
  current = next;
  for (const l of listeners) l();
}

function sameScopes(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((s, i) => s === b[i]);
}

/** `"repo, user"` -> `['repo', 'user']`. Tolerant of odd spacing/casing. */
export function parseScopes(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when the scope list permits Actions writes. GitHub omits `public_repo`
 * from the header when `repo` is present (it is implied), and `public_repo`
 * alone is not documented as sufficient for the re-run endpoints — so only
 * `repo` counts.
 */
export function scopesAllowRerun(scopes: readonly string[]): boolean {
  return scopes.includes('repo');
}

/**
 * Guess the token flavour from its prefix. Used ONLY to word the Settings
 * readout — never to decide capability, because these prefixes are changelog
 * convention rather than an API contract. Tokens issued before 2021 have no
 * prefix and were always classic.
 */
export function tokenKindFromValue(token: string | null): TokenKind {
  if (!token) return 'unknown';
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  if (/^[a-f0-9]{40}$/.test(token)) return 'classic';
  if (/^gh[ousr]_/.test(token)) return 'other';
  return 'unknown';
}

/**
 * Whether reading the repo's `permissions.push` could still change the verdict.
 *
 * Lives beside {@link recompute} so the two can't disagree: for anything but a
 * classic token carrying `repo` the answer is already settled, and the probe would
 * be a wasted request.
 */
export function needsPushProbe(cap: TokenCapability): boolean {
  return cap.scopes !== null && scopesAllowRerun(cap.scopes);
}

function recompute(next: TokenCapability): TokenCapability {
  // No scope header => fine-grained PAT or an app token => undeterminable.
  if (next.scopes === null) {
    return { ...next, canRerun: false, reason: 'not-classic' };
  }
  if (!scopesAllowRerun(next.scopes)) {
    return { ...next, canRerun: false, reason: 'no-repo-scope' };
  }
  if (next.userCanPush === null) {
    return { ...next, canRerun: false, reason: 'pending' };
  }
  if (!next.userCanPush) {
    return { ...next, canRerun: false, reason: 'no-push-access' };
  }
  return { ...next, canRerun: true, reason: 'ok' };
}

/**
 * Feed a response's headers in. Called for every response — including 304s and
 * errors — because the scope header is present regardless of status.
 *
 * `headers.get` returns null for an absent header; a classic token with no
 * scopes selected sends the header with an empty value, which parses to `[]`
 * and correctly reads as "classic, but not permitted".
 */
export function recordTokenScopes(headers: Headers): void {
  const raw = headers.get('x-oauth-scopes');
  if (raw === null) {
    // Absent header. Don't clobber a previously-seen scope list: a redirected or
    // proxied response could omit it. Only record the absence the first time.
    if (current.scopes !== null) return;
    emit(recompute({ ...current, scopes: null, checkedAt: Date.now() }));
    return;
  }
  const scopes = parseScopes(raw);
  emit(recompute({ ...current, kind: 'classic', scopes, checkedAt: Date.now() }));
}

/**
 * Record the outcome of the repo probe (`permissions.push`). Pass `null` to mark
 * it unknown again — done when the watched repo changes, so a stale "yes" from the
 * previous repo can't keep a write control alive while the new probe is in flight.
 */
export function recordPushAccess(canPush: boolean | null): void {
  emit(recompute({ ...current, userCanPush: canPush, checkedAt: Date.now() }));
}

/** Record the token flavour guessed from its value (readout copy only). */
export function recordTokenKind(kind: TokenKind): void {
  // A scope header is authoritative about being classic; don't let a prefix
  // guess override what GitHub actually told us.
  if (current.scopes !== null && kind !== 'classic') return;
  emit({ ...current, kind });
}

/**
 * GitHub refused a write for lack of permission. Latches capability off so the
 * feature hides itself rather than retrying against a wall.
 */
export function recordWriteRefused(): void {
  emit({ ...current, canRerun: false, reason: 'refused', checkedAt: Date.now() });
}

/** Wipe on token change / lock / forget, and when the watched repo changes. */
export function resetTokenCapability(): void {
  current = initial;
  for (const l of listeners) l();
}

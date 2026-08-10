/**
 * Error categories — why an operation failed.
 *
 * Small, closed, and never free text. The point of a category rather than a message is that a
 * message is where a repository name, a URL or a token realistically ends up; a number cannot carry
 * any of those.
 *
 * Kept deliberately coarse. The question these answer is "is this failing because of us, because of
 * GitHub, or because of the network" — not "what exactly went wrong", which is what the local
 * diagnostics log is for.
 */

import { buildRegistry, idEnum, type Def, type IdOf } from './registry';

const defs = {
  /** Unclassified. A rising UNKNOWN share means the mapping needs a new case, and is itself a
   *  signal worth watching on the dashboard. */
  UNKNOWN: { id: 0, key: 'unknown' },

  NETWORK: { id: 1, key: 'network' },
  /** Includes AbortError from the client's own request timeouts. */
  TIMEOUT: { id: 2, key: 'timeout' },

  // The GitHub-shaped failures. These map from GitHubApiError.status and the WriteRefusal union in
  // src/api/githubClient.ts rather than being classified afresh.
  AUTH: { id: 3, key: 'auth' },
  PERMISSION: { id: 4, key: 'permission' },
  RATE_LIMIT: { id: 5, key: 'rate_limit' },
  NOT_FOUND: { id: 6, key: 'not_found' },
  CONFLICT: { id: 7, key: 'conflict' },
  SERVER: { id: 8, key: 'server' },

  /** Malformed response, or a zod schema rejection on stored config. */
  PARSE: { id: 9, key: 'parse' },
  /** Deliberate — a user cancelled, or a newer request superseded this one. Not a fault. */
  CANCELLED: { id: 10, key: 'cancelled' },
  /** A run too old to act on; the `too-old` WriteRefusal. */
  TOO_OLD: { id: 11, key: 'too_old' },
  /** A local dependency is missing — `gh` or `claude` not installed. */
  UNAVAILABLE: { id: 12, key: 'unavailable' },
  /** Local persistence failed: quota exceeded, disk full, permission denied. */
  STORAGE: { id: 13, key: 'storage' },
} as const satisfies Record<string, Def>;

const TOMBSTONES: readonly number[] = [];

export const ERROR_CATEGORY_DEFS = defs;
export const ErrorCategories = buildRegistry('ErrorCategory', defs, TOMBSTONES);

export const ErrorCategory = idEnum(defs);
export type ErrorCategory = IdOf<typeof defs>;

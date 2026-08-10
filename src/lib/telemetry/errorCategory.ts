/**
 * Map an error to a telemetry category.
 *
 * Deliberately a *translation* rather than a fresh classification. `src/api/githubClient.ts`
 * already does the hard part — it distinguishes a primary rate limit from a secondary one, a
 * missing token grant from a missing repo role, and a run outside the 30-day window from one that
 * simply is not re-runnable yet, all from status codes plus observed message text. Re-deriving any
 * of that here would mean two classifiers that disagree, and the one the dashboards showed would
 * be the one nobody was maintaining.
 *
 * The output is a small closed set of numbers. Nothing here reads a message, and nothing here can
 * emit one.
 */

import { ErrorCategory } from '@jobmonitor/telemetry-schema/registry';
import type { ErrorCategory as ErrorCategoryId } from '@jobmonitor/telemetry-schema/registry';
import { GitHubApiError, type WriteRefusal } from '../../api/githubClient';

/** GitHub's own refusal taxonomy, already computed by the API layer. */
const REFUSAL_TO_CATEGORY: Record<WriteRefusal, ErrorCategoryId> = {
  'rate-limit': ErrorCategory.RATE_LIMIT,
  permission: ErrorCategory.PERMISSION,
  forbidden: ErrorCategory.PERMISSION,
  'too-old': ErrorCategory.TOO_OLD,
  conflict: ErrorCategory.CONFLICT,
  other: ErrorCategory.UNKNOWN,
};

function fromStatus(status: number): ErrorCategoryId {
  if (status === 401) return ErrorCategory.AUTH;
  if (status === 403) return ErrorCategory.PERMISSION;
  if (status === 404) return ErrorCategory.NOT_FOUND;
  if (status === 409) return ErrorCategory.CONFLICT;
  if (status === 429) return ErrorCategory.RATE_LIMIT;
  if (status >= 500) return ErrorCategory.SERVER;
  // A 4xx we have no specific meaning for. Deliberately UNKNOWN rather than a nearby guess — a
  // rising UNKNOWN share is a signal that this mapping needs a new case, and burying it under
  // CONFLICT or NOT_FOUND would hide exactly that.
  return ErrorCategory.UNKNOWN;
}

export function categorizeError(error: unknown): ErrorCategoryId {
  if (error instanceof GitHubApiError) {
    if (error.refusal) return REFUSAL_TO_CATEGORY[error.refusal] ?? ErrorCategory.UNKNOWN;
    if (error.isRateLimit) return ErrorCategory.RATE_LIMIT;
    return fromStatus(error.status);
  }

  if (error instanceof DOMException || (error instanceof Error && error.name)) {
    switch (error.name) {
      // Every timeout in the app is an AbortController firing — see REQUEST_TIMEOUT_MS and friends
      // in githubClient.ts. An abort from a superseded request is indistinguishable here, which is
      // why CANCELLED is reserved for explicit user cancellation reported by the caller.
      case 'AbortError':
      case 'TimeoutError':
        return ErrorCategory.TIMEOUT;
      case 'QuotaExceededError':
      case 'NotFoundError':
        return ErrorCategory.STORAGE;
      // SyntaxError from JSON.parse; ZodError from stored-config validation.
      case 'SyntaxError':
      case 'ZodError':
        return ErrorCategory.PARSE;
      default:
        break;
    }
  }

  // `fetch` rejects with a bare TypeError for DNS failure, refused connection, offline, and CORS.
  // It is the single most common error in the app and has no distinguishing property to test.
  if (error instanceof TypeError) return ErrorCategory.NETWORK;

  return ErrorCategory.UNKNOWN;
}

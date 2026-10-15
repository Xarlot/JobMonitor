/**
 * What an auto-rerun badge's bad news means, in words a person can act on.
 *
 * The badge says "2 unchecked" and the tooltip says what the engine logged, which is accurate and
 * terse: "could not check the failure: the run’s jobs could not be listed — HTTP 502". This turns
 * each event into the three things the Diagnostics tab explains — what happened, why it matters,
 * and what to do — keyed on the problem texts `usePrAutoRerun` writes. A problem it does not
 * recognise still gets the general explanation and its own text verbatim, never nothing.
 */

import type { RerunEvent } from '../hooks/usePrAutoRerun';

export interface RerunExplanation {
  /** One line: what went wrong with this run. */
  cause: string;
  /** What to do about it. */
  fix: string;
  /** Usually clears itself on the next poll — said so the user does not chase a ghost. */
  transient: boolean;
}

/** What "unchecked" means at all, before any one case. */
export const HELD_SUMMARY =
  'Auto-rerun wanted to re-run the failed jobs but held off, because it could not compare this failure with the previous attempt. ' +
  'That comparison is the brake that stops it re-running the same failure over and over; re-running without it would let the limit lapse. ' +
  'So nothing was re-run, and the run stays failed until it can check — or until you re-run it yourself.';

export const FAILED_SUMMARY =
  'Auto-rerun asked GitHub to re-run the failed jobs and GitHub refused.';

export function explainRerunEvent(event: Pick<RerunEvent, 'outcome' | 'detail'>): RerunExplanation {
  const detail = event.detail?.trim() ?? '';

  if (event.outcome === 'failed') {
    if (/403|forbidden|permission|scope/i.test(detail)) {
      return {
        cause: `GitHub refused the re-run: ${detail}`,
        fix: 'The token can no longer re-run jobs here. Check its scopes in Settings → GitHub token (it needs Actions: write), or re-run from GitHub.',
        transient: false,
      };
    }
    if (/rate limit|429/i.test(detail)) {
      return {
        cause: `GitHub refused the re-run: ${detail}`,
        fix: 'The rate limit was hit. Auto-rerun pauses until it resets and tries again on the next failure; re-run by hand if it cannot wait.',
        transient: true,
      };
    }
    if (/30 days|too old/i.test(detail)) {
      return {
        cause: `GitHub refused the re-run: ${detail}`,
        fix: 'GitHub does not re-run workflows more than 30 days after their first run. Push a commit to start a fresh run.',
        transient: false,
      };
    }
    return {
      cause: `GitHub refused the re-run: ${detail || 'no reason given'}`,
      fix: 'Open the run on GitHub and re-run it there; if GitHub refuses too, its message says why.',
      transient: false,
    };
  }

  if (/jobs could not be listed/i.test(detail)) {
    const rateLimited = /rate limit|429/i.test(detail);
    return {
      cause: `The run’s job list could not be read from GitHub (${detail.replace(/^.*?—\s*/, '')}).`,
      fix: rateLimited
        ? 'The rate limit was hit. It clears when the limit resets; the next poll after that checks the run and re-runs it if it should.'
        : 'Usually a passing GitHub or network error, which the next poll retries. If it keeps happening, the log below has every attempt; a token without Actions: read access fails here every time.',
      transient: !/403|forbidden/i.test(detail),
    };
  }
  if (/marked failed but none of its/i.test(detail)) {
    return {
      cause: 'GitHub reported the run as failed, but none of its jobs as failed yet.',
      fix: 'GitHub’s job list lags a run that has only just finished. The next poll normally sees the failed jobs and carries on — nothing to do unless this repeats for the same run.',
      transient: true,
    };
  }
  if (/nothing identifying/i.test(detail)) {
    return {
      cause: 'The failed jobs had no names, steps or annotations to tell this failure from the last one.',
      fix: 'Auto-rerun cannot tell whether it is the same failure, so it will not re-run this run on its own. Look at the run and re-run it yourself if it is worth another try.',
      transient: false,
    };
  }
  return {
    cause: detail ? `The failure could not be checked: ${detail}` : 'The failure could not be checked against the previous one.',
    fix: 'Open the run, decide whether it is worth another try, and re-run it yourself. The log below has the engine’s full reasoning.',
    transient: false,
  };
}

import { describe, expect, it } from 'vitest';
import {
  decideRerun,
  MANUALLY_RERUNNABLE_CONCLUSIONS,
  matchesWorkflowFile,
  RETRYABLE_CONCLUSIONS,
  type RerunSkipReason,
} from '../lib/autoRerun';
import type { AutoMerge, PullRequest, RunConclusion, WorkflowRun } from '../api/types';
import type { PrAutoRerunConfig } from '../storage/configStore';
import type { RerunRecord } from '../storage/rerunStore';

const NOW = Date.parse('2026-07-31T12:00:00Z');

const AUTO_MERGE: AutoMerge = {
  enabled_by: null,
  merge_method: 'squash',
  commit_title: null,
  commit_message: null,
};

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    node_id: 'PR_kwDOtest1',
    number: 42,
    title: 'a change',
    html_url: 'https://github.com/o/r/pull/42',
    state: 'open',
    draft: false,
    user: null,
    created_at: '2026-07-30T12:00:00Z',
    updated_at: '2026-07-31T11:00:00Z',
    auto_merge: AUTO_MERGE,
    merged_at: null,
    head: { sha: 'abc1234', ref: 'feature', label: 'o:feature', user: null },
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    ...over,
  };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1001,
    name: 'CI',
    display_title: 'a change',
    head_branch: 'feature',
    head_sha: 'abc1234',
    run_number: 7,
    run_attempt: 1,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/o/r/actions/runs/1001',
    created_at: '2026-07-31T11:00:00Z',
    updated_at: '2026-07-31T11:30:00Z',
    run_started_at: '2026-07-31T11:00:00Z',
    path: '.github/workflows/ci.yml',
    workflow_id: 9,
    ...over,
  };
}

function settings(over: Partial<PrAutoRerunConfig> = {}): PrAutoRerunConfig {
  return {
    enabled: true,
    workflowFiles: ['ci.yml'],
    maxAttempts: 10,
    maxIdenticalFailures: 5,
    maxRunAgeHours: 72,
    ...over,
  };
}

function record(
  attempts: RerunRecord['attempts'],
  declined?: RerunRecord['declined'],
): RerunRecord {
  return { runId: 1001, attempts, declined, updatedAt: NOW };
}

/** Decide with sensible defaults; `over` replaces individual arguments. */
function decide(over: Partial<Parameters<typeof decideRerun>[0]> = {}) {
  return decideRerun({
    run: run(),
    pr: pr(),
    settings: settings(),
    record: undefined,
    fingerprint: 'aaaa1111',
    now: NOW,
    ...over,
  });
}

function skipReason(over: Partial<Parameters<typeof decideRerun>[0]> = {}): RerunSkipReason | 'rerun' {
  const d = decide(over);
  return d.rerun ? 'rerun' : d.reason;
}

describe('RETRYABLE_CONCLUSIONS', () => {
  it('covers the two conclusions that mean "ran and broke"', () => {
    expect([...RETRYABLE_CONCLUSIONS].sort()).toEqual(['failure', 'timed_out']);
  });

  /** The relationship the two sets are defined by, asserted rather than commented. */
  it('is a strict subset of what a person may re-run by hand', () => {
    for (const c of RETRYABLE_CONCLUSIONS) {
      expect(MANUALLY_RERUNNABLE_CONCLUSIONS.has(c)).toBe(true);
    }
    expect(MANUALLY_RERUNNABLE_CONCLUSIONS.size).toBeGreaterThan(RETRYABLE_CONCLUSIONS.size);
  });

  /** A cancel is deliberate, so only an explicit click may undo it. */
  it('lets a human re-run a cancelled run but never does so automatically', () => {
    expect(RETRYABLE_CONCLUSIONS.has('cancelled')).toBe(false);
    expect(MANUALLY_RERUNNABLE_CONCLUSIONS.has('cancelled')).toBe(true);
  });

  it('never re-runs action_required either way — it needs a person, not a retry', () => {
    expect(RETRYABLE_CONCLUSIONS.has('action_required')).toBe(false);
    expect(MANUALLY_RERUNNABLE_CONCLUSIONS.has('action_required')).toBe(false);
  });
});

describe('matchesWorkflowFile', () => {
  it('matches the basename of the run path exactly', () => {
    expect(matchesWorkflowFile(run(), ['ci.yml'])).toBe(true);
    expect(matchesWorkflowFile(run(), ['other.yml', 'ci.yml'])).toBe(true);
  });

  it('is case-insensitive and tolerates padding in the configured name', () => {
    expect(matchesWorkflowFile(run(), ['CI.YML'])).toBe(true);
    expect(matchesWorkflowFile(run(), ['  ci.yml  '])).toBe(true);
  });

  // Exact file names only — a substring must never widen the allow-list.
  it('does not match a partial name or a display name', () => {
    expect(matchesWorkflowFile(run(), ['ci'])).toBe(false);
    expect(matchesWorkflowFile(run(), ['my-ci.yml'])).toBe(false);
    expect(matchesWorkflowFile(run(), ['CI'])).toBe(false);
  });

  it('never matches a run with no path', () => {
    expect(matchesWorkflowFile(run({ path: undefined }), ['ci.yml'])).toBe(false);
  });
});

describe('decideRerun', () => {
  it('re-runs a failed run of a watched workflow on an auto-merge PR', () => {
    expect(decide()).toEqual({ rerun: true });
  });

  it('re-runs a timed-out run too', () => {
    expect(skipReason({ run: run({ conclusion: 'timed_out' }) })).toBe('rerun');
  });

  it('does nothing when the feature is off', () => {
    expect(skipReason({ settings: settings({ enabled: false }) })).toBe('disabled');
  });

  it('does nothing when no workflows are listed', () => {
    expect(skipReason({ settings: settings({ workflowFiles: [] }) })).toBe('no_workflows');
  });

  it('ignores a workflow that is not on the list', () => {
    expect(skipReason({ settings: settings({ workflowFiles: ['other.yml'] }) })).toBe('not_matched');
  });

  // Auto-merge is the human signal that unattended re-running is wanted.
  it('ignores a PR without auto-merge', () => {
    expect(skipReason({ pr: pr({ auto_merge: null }) })).toBe('no_auto_merge');
  });

  it('waits for the run to finish', () => {
    expect(skipReason({ run: run({ status: 'in_progress', conclusion: null }) })).toBe('not_final');
    expect(skipReason({ run: run({ status: 'queued', conclusion: null }) })).toBe('not_final');
  });

  it('leaves a successful or skipped run alone', () => {
    expect(skipReason({ run: run({ conclusion: 'success' }) })).toBe('not_failed');
    expect(skipReason({ run: run({ conclusion: 'skipped' }) })).toBe('not_failed');
    expect(skipReason({ run: run({ conclusion: 'neutral' }) })).toBe('not_failed');
  });

  /**
   * `action_required` is bucketed as a failure by lib/status.ts, but it means a
   * human must approve something — re-running only re-queues the same wait.
   */
  it('never re-runs action_required', () => {
    expect(skipReason({ run: run({ conclusion: 'action_required' }) })).toBe('not_failed');
  });

  /** A cancel is normally deliberate; undoing it unattended would be wrong. */
  it('never re-runs a cancelled or stale run', () => {
    expect(skipReason({ run: run({ conclusion: 'cancelled' }) })).toBe('not_failed');
    expect(skipReason({ run: run({ conclusion: 'stale' }) })).toBe('not_failed');
  });

  it('ignores a run whose last attempt is older than the configured window', () => {
    const stamp = '2026-07-25T00:00:00Z'; // 156 h before NOW
    const old = run({ created_at: stamp, run_started_at: stamp });
    expect(skipReason({ run: old })).toBe('too_old'); // default window is 72 h
    // Widening the window past its age brings it back into range.
    expect(skipReason({ run: old, settings: settings({ maxRunAgeHours: 720 }) })).toBe('rerun');
  });

  /**
   * The regression this whole distinction exists for. GitHub never moves `created_at`,
   * so a PR that is actively being retried used to age out of the window while its last
   * attempt was an hour ago — and then went quiet with no way to see why.
   */
  it('judges a re-run run by its latest attempt, not by when it first ran', () => {
    const retried = run({
      created_at: '2026-07-28T09:00:00Z', // 75 h before NOW — outside a 72 h window
      run_started_at: new Date(NOW - 11 * 3600_000).toISOString(), // last try, 11 h ago
      run_attempt: 3,
    });
    expect(skipReason({ run: retried })).toBe('rerun');
  });

  it('keeps a run whose last attempt is only just inside the window', () => {
    const almost = run({ run_started_at: new Date(NOW - 71 * 3600_000).toISOString() });
    expect(skipReason({ run: almost })).toBe('rerun');
  });

  /** First attempts, and older API payloads, have only the one timestamp. */
  it('falls back to created_at when there is no run_started_at', () => {
    expect(
      skipReason({ run: run({ created_at: '2026-07-25T00:00:00Z', run_started_at: null }) }),
    ).toBe('too_old');
    expect(
      skipReason({
        run: run({ created_at: new Date(NOW - 3600_000).toISOString(), run_started_at: null }),
      }),
    ).toBe('rerun');
  });

  /**
   * GitHub's own limit, which is measured from the first run whatever has happened
   * since — so re-running cannot hold a run open past it, and the engine must not keep
   * asking for something that will 403 on every tick.
   */
  it('stops at GitHub’s 30-day ceiling even when the last attempt is fresh', () => {
    const ancient = run({
      created_at: new Date(NOW - 31 * 24 * 3600_000).toISOString(),
      run_started_at: new Date(NOW - 3600_000).toISOString(),
    });
    expect(skipReason({ run: ancient })).toBe('rerun_window_closed');
    // A month-wide staleness window still cannot reopen it.
    expect(skipReason({ run: ancient, settings: settings({ maxRunAgeHours: 720 }) })).toBe(
      'rerun_window_closed',
    );
  });

  it('does not reject a run whose timestamps are unparseable', () => {
    // Better to attempt the re-run than to silently ignore the PR forever.
    expect(skipReason({ run: run({ created_at: 'not-a-date' }) })).toBe('rerun');
    expect(skipReason({ run: run({ run_started_at: 'not-a-date' }) })).toBe('rerun');
  });

  it('does not ask twice for the same attempt', () => {
    const seen = record([{ attempt: 1, fingerprint: 'aaaa1111', at: NOW, ok: true }]);
    expect(skipReason({ record: seen })).toBe('already_requested');
  });

  it('re-runs a later attempt of a run it already handled once', () => {
    const seen = record([{ attempt: 1, fingerprint: 'aaaa1111', at: NOW, ok: true }]);
    // GitHub bumped run_attempt after the first re-run; the failure differs.
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 2 }), fingerprint: 'bbbb2222' }),
    ).toBe('rerun');
  });

  it('stops at the attempt ceiling', () => {
    expect(skipReason({ run: run({ run_attempt: 3 }), settings: settings({ maxAttempts: 3 }) }))
      .toBe('attempts_exhausted');
  });

  it('treats maxAttempts of 1 as "never retry"', () => {
    expect(skipReason({ settings: settings({ maxAttempts: 1 }) })).toBe('attempts_exhausted');
  });

  it('allows the attempt just below the ceiling', () => {
    expect(skipReason({ run: run({ run_attempt: 2 }), settings: settings({ maxAttempts: 3 }) }))
      .toBe('rerun');
  });

  /** A limit of 2 is the tightest useful setting: stop the moment a failure repeats. */
  it('gives up on the first repeat when only two are allowed', () => {
    const seen = record([{ attempt: 1, fingerprint: 'same', at: NOW, ok: true }]);
    expect(
      skipReason({
        record: seen,
        run: run({ run_attempt: 2 }),
        fingerprint: 'same',
        settings: settings({ maxIdenticalFailures: 2 }),
      }),
    ).toBe('identical_failure');
  });

  /**
   * The streak against the limit. A flaky test can fail the same way twice and pass on
   * the third go, so the tolerance is a count rather than a yes/no — it runs out at the
   * configured number and not before.
   */
  it('tolerates the same failure up to the limit, then stops', () => {
    // Attempts 1..n all failed identically; the run now sits at attempt n+1.
    const streakOf = (n: number) =>
      record(
        Array.from({ length: n }, (_, i) => ({
          attempt: i + 1,
          fingerprint: 'same',
          at: NOW,
          ok: true,
        })),
      );

    // Default is 5: four earlier identical failures plus this one is the fifth.
    for (const earlier of [1, 2, 3]) {
      expect(
        skipReason({
          record: streakOf(earlier),
          run: run({ run_attempt: earlier + 1 }),
          fingerprint: 'same',
        }),
      ).toBe('rerun');
    }
    expect(
      skipReason({ record: streakOf(4), run: run({ run_attempt: 5 }), fingerprint: 'same' }),
    ).toBe('identical_failure');
  });

  it('starts the count over when a different failure interrupts the streak', () => {
    const interrupted = record([
      { attempt: 1, fingerprint: 'same', at: NOW, ok: true },
      { attempt: 2, fingerprint: 'same', at: NOW, ok: true },
      { attempt: 3, fingerprint: 'other', at: NOW, ok: true },
      { attempt: 4, fingerprint: 'same', at: NOW, ok: true },
    ]);
    // Only attempts 4 and 5 form the current run of identical failures — two, not four.
    expect(
      skipReason({ record: interrupted, run: run({ run_attempt: 5 }), fingerprint: 'same' }),
    ).toBe('rerun');
  });

  /**
   * A decline is where the engine stopped, and its fingerprint is part of the streak —
   * otherwise re-running by hand would reset the count and the tolerance would never
   * actually run out.
   */
  it('counts the failure it already declined on', () => {
    const settled = record(
      [
        { attempt: 1, fingerprint: 'same', at: NOW, ok: true },
        { attempt: 2, fingerprint: 'same', at: NOW, ok: true },
      ],
      { attempt: 3, reason: 'identical_failure', fingerprint: 'same', at: NOW },
    );
    // A human re-ran it, so this is attempt 4 with the same failure: four in a row.
    expect(
      skipReason({
        record: settled,
        run: run({ run_attempt: 4 }),
        fingerprint: 'same',
        settings: settings({ maxIdenticalFailures: 4 }),
      }),
    ).toBe('identical_failure');
  });

  it('breaks the streak at an attempt whose fingerprint is unknown', () => {
    const withGap = record([
      { attempt: 1, fingerprint: 'same', at: NOW, ok: true },
      { attempt: 2, fingerprint: null, at: NOW, ok: true },
      { attempt: 3, fingerprint: 'same', at: NOW, ok: true },
    ]);
    expect(
      skipReason({
        record: withGap,
        run: run({ run_attempt: 4 }),
        fingerprint: 'same',
        settings: settings({ maxIdenticalFailures: 3 }),
      }),
    ).toBe('rerun');
  });

  /**
   * The latch replays the verdict instead of re-deriving it — the fingerprint behind
   * `identical_failure` costs an annotations fetch per failed job, and paying that every
   * minute forever is what the record exists to avoid.
   */
  it('replays a stored verdict without needing the fingerprint again', () => {
    // Four identical failures already re-run, and the fifth is where it stopped.
    const settled = record(
      [1, 2, 3, 4].map((attempt) => ({ attempt, fingerprint: 'same', at: NOW, ok: true })),
      { attempt: 5, reason: 'identical_failure', fingerprint: 'same', at: NOW },
    );
    expect(
      skipReason({ record: settled, run: run({ run_attempt: 5 }), fingerprint: null }),
    ).toBe('identical_failure');
  });

  /**
   * The bug this separation fixes: a decline used to be filed as an attempt, so the engine
   * answered "this attempt was already re-run" about an attempt it had never re-run —
   * hiding the real reason behind a false one.
   */
  it('reports why it declined, not that it re-ran', () => {
    const settled = record(
      [1, 2, 3, 4].map((attempt) => ({ attempt, fingerprint: 'same', at: NOW, ok: true })),
      { attempt: 5, reason: 'identical_failure', fingerprint: 'same', at: NOW },
    );
    const reason = skipReason({ record: settled, run: run({ run_attempt: 5 }) });
    expect(reason).toBe('identical_failure');
    expect(reason).not.toBe('already_requested');
  });

  /**
   * A decline is a cached decision, and the cache has to notice when the rule changes.
   * The attempt number never moves again once the engine has stopped, so a verdict kept
   * past a raised limit would make the new setting look like it did nothing.
   */
  it('reconsiders a stored verdict once the limit allows more', () => {
    const settled = record(
      [
        { attempt: 1, fingerprint: 'other', at: NOW, ok: true },
        { attempt: 2, fingerprint: 'same', at: NOW, ok: true },
      ],
      { attempt: 3, reason: 'identical_failure', fingerprint: 'same', at: NOW },
    );
    const at3 = { record: settled, run: run({ run_attempt: 3 }), fingerprint: 'same' };

    // The streak is two, which is why it stopped under a limit of two.
    expect(skipReason({ ...at3, settings: settings({ maxIdenticalFailures: 2 }) })).toBe(
      'identical_failure',
    );
    // Allowing five makes the same two-long streak acceptable again.
    expect(skipReason({ ...at3, settings: settings({ maxIdenticalFailures: 5 }) })).toBe('rerun');
    // And switching the brake off entirely certainly does.
    expect(skipReason({ ...at3, settings: settings({ maxIdenticalFailures: 0 }) })).toBe('rerun');
  });

  /** Re-deriving needs the fingerprint, and the pre-pass has none — so it must not act. */
  it('keeps a stored verdict on the pre-pass that cannot re-check it', () => {
    const settled = record([{ attempt: 2, fingerprint: 'same', at: NOW, ok: true }], {
      attempt: 3,
      reason: 'identical_failure',
      fingerprint: null,
      at: NOW,
    });
    expect(skipReason({ record: settled, run: run({ run_attempt: 3 }), fingerprint: null })).toBe(
      'rerun',
    );
  });

  it('lets a new attempt through despite a verdict on the previous one', () => {
    const settled = record([], {
      attempt: 2,
      reason: 'identical_failure',
      fingerprint: 'old',
      at: NOW,
    });
    // GitHub bumped run_attempt, and this failure is different.
    expect(
      skipReason({ record: settled, run: run({ run_attempt: 3 }), fingerprint: 'new' }),
    ).toBe('rerun');
  });

  /** A request we made still reports as a request, not as a decision. */
  it('keeps already_requested for an attempt it really did ask about', () => {
    const asked = record([{ attempt: 3, fingerprint: 'x', at: NOW, ok: true }]);
    expect(skipReason({ record: asked, run: run({ run_attempt: 3 }) })).toBe('already_requested');
  });

  it('keeps retrying while the failure keeps changing', () => {
    const seen = record([
      { attempt: 1, fingerprint: 'first', at: NOW, ok: true },
      { attempt: 2, fingerprint: 'second', at: NOW, ok: true },
    ]);
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 3 }), fingerprint: 'third' }),
    ).toBe('rerun');
  });

  it('compares against the most recent earlier attempt, not the oldest', () => {
    const seen = record([
      { attempt: 1, fingerprint: 'old', at: NOW, ok: true },
      { attempt: 2, fingerprint: 'recent', at: NOW, ok: true },
    ]);
    const tight = settings({ maxIdenticalFailures: 2 });
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 3 }), fingerprint: 'recent', settings: tight }),
    ).toBe('identical_failure');
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 3 }), fingerprint: 'old', settings: tight }),
    ).toBe('rerun');
  });

  it('retries an identical failure when the brake is switched off', () => {
    const seen = record([
      { attempt: 1, fingerprint: 'same', at: NOW, ok: true },
      { attempt: 2, fingerprint: 'same', at: NOW, ok: true },
      { attempt: 3, fingerprint: 'same', at: NOW, ok: true },
      { attempt: 4, fingerprint: 'same', at: NOW, ok: true },
    ]);
    expect(
      skipReason({
        record: seen,
        run: run({ run_attempt: 5 }),
        fingerprint: 'same',
        settings: settings({ maxIdenticalFailures: 0 }),
      }),
    ).toBe('rerun');
  });

  /** 1 falls out of the same rule: the first failure is already one occurrence. */
  it('treats a limit of 1 as never retrying an identical failure', () => {
    expect(
      skipReason({ fingerprint: 'anything', settings: settings({ maxIdenticalFailures: 1 }) }),
    ).toBe('identical_failure');
  });

  /** An uncomputable fingerprint is "unknown", never "same as last time". */
  it('does not treat a missing fingerprint as identical', () => {
    const seen = record([{ attempt: 1, fingerprint: null, at: NOW, ok: true }]);
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 2 }), fingerprint: null }),
    ).toBe('rerun');
  });

  /**
   * Can't check, don't retry. Letting a failed lookup through would suspend the
   * identical-failure limit exactly while something is already going wrong, so the run
   * climbs to `maxAttempts` on a failure nobody ever compared.
   */
  it('refuses to re-run when the fingerprint could not be computed', () => {
    expect(
      skipReason({ fingerprint: null, fingerprintProblem: 'jobs could not be listed' }),
    ).toBe('fingerprint_unavailable');
  });

  /**
   * The pre-pass passes no fingerprint on purpose. Mistaking that for a failed lookup would
   * refuse every run before anything ever tried to compute one.
   */
  it('does not confuse "not computed yet" with "could not be computed"', () => {
    expect(skipReason({ fingerprint: null })).toBe('rerun');
    expect(skipReason({ fingerprint: null, fingerprintProblem: null })).toBe('rerun');
  });

  /** With the brake off there is nothing to check, so nothing to be unable to check. */
  it('ignores a fingerprint problem when the brake is switched off', () => {
    expect(
      skipReason({
        fingerprint: null,
        fingerprintProblem: 'jobs could not be listed',
        settings: settings({ maxIdenticalFailures: 0 }),
      }),
    ).toBe('rerun');
  });

  /** Not a terminal verdict: the next tick may well manage the lookup. */
  it('reports the problem after the cheaper rules, not before them', () => {
    expect(
      skipReason({
        run: run({ status: 'in_progress', conclusion: null }),
        fingerprint: null,
        fingerprintProblem: 'jobs could not be listed',
      }),
    ).toBe('not_final');
  });

  it('checks the cheap conditions before the expensive ones', () => {
    // A disabled feature must short-circuit even when everything else is wrong too,
    // so the engine never pays for jobs/annotations to reach a foregone conclusion.
    const d = decideRerun({
      run: run({ path: '.github/workflows/nope.yml', status: 'in_progress' }),
      pr: pr({ auto_merge: null }),
      settings: settings({ enabled: false }),
      record: undefined,
      fingerprint: null,
      now: NOW,
    });
    expect(d).toEqual({ rerun: false, reason: 'disabled' });
  });

  it('covers every conclusion in the type without throwing', () => {
    const all: RunConclusion[] = [
      'success', 'failure', 'neutral', 'cancelled', 'skipped',
      'timed_out', 'action_required', 'stale', 'startup_failure', null,
    ];
    for (const conclusion of all) {
      expect(() => decide({ run: run({ conclusion }) })).not.toThrow();
    }
  });
});

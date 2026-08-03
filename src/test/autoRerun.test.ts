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
    stopOnIdenticalFailure: true,
    maxRunAgeHours: 72,
    ...over,
  };
}

function record(attempts: RerunRecord['attempts']): RerunRecord {
  return { runId: 1001, attempts, updatedAt: NOW };
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

  it('ignores a run older than the configured window', () => {
    const old = run({ created_at: '2026-07-25T00:00:00Z' }); // 156 h before NOW
    expect(skipReason({ run: old })).toBe('too_old'); // default window is 72 h
    // Widening the window past its age brings it back into range.
    expect(skipReason({ run: old, settings: settings({ maxRunAgeHours: 720 }) })).toBe('rerun');
  });

  it('keeps a run that is only just inside the window', () => {
    const almost = run({ created_at: new Date(NOW - 71 * 3600_000).toISOString() });
    expect(skipReason({ run: almost })).toBe('rerun');
  });

  it('does not reject a run whose created_at is unparseable', () => {
    // Better to attempt the re-run than to silently ignore the PR forever.
    expect(skipReason({ run: run({ created_at: 'not-a-date' }) })).toBe('rerun');
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

  it('gives up when the failure repeats identically', () => {
    const seen = record([{ attempt: 1, fingerprint: 'same', at: NOW, ok: true }]);
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 2 }), fingerprint: 'same' }),
    ).toBe('identical_failure');
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
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 3 }), fingerprint: 'recent' }),
    ).toBe('identical_failure');
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 3 }), fingerprint: 'old' }),
    ).toBe('rerun');
  });

  it('retries an identical failure when the brake is switched off', () => {
    const seen = record([{ attempt: 1, fingerprint: 'same', at: NOW, ok: true }]);
    expect(
      skipReason({
        record: seen,
        run: run({ run_attempt: 2 }),
        fingerprint: 'same',
        settings: settings({ stopOnIdenticalFailure: false }),
      }),
    ).toBe('rerun');
  });

  /** An uncomputable fingerprint is "unknown", never "same as last time". */
  it('does not treat a missing fingerprint as identical', () => {
    const seen = record([{ attempt: 1, fingerprint: null, at: NOW, ok: true }]);
    expect(
      skipReason({ record: seen, run: run({ run_attempt: 2 }), fingerprint: null }),
    ).toBe('rerun');
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

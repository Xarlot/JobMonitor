import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  effectivePrAuthor,
  forkRepo,
  isConfigComplete,
  monitorConfigSchema,
  safeParseConfig,
} from '../storage/configStore';

describe('configStore', () => {
  it('applies defaults for polling and flows', () => {
    const cfg = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
    });
    expect(cfg.polling.prListSeconds).toBe(180);
    expect(cfg.polling.checksSeconds).toBe(60);
    expect(cfg.flows).toEqual([]);
    expect(cfg.fork.branch).toBeNull();
  });

  /**
   * There is no migration step and `version` is a hard literal, so a new field
   * without a default would make loadConfig throw — and it swallows that by
   * returning DEFAULT_CONFIG, silently wiping the user's whole setup.
   */
  it('applies defaults for the PR automation blocks', () => {
    const cfg = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
    });
    expect(cfg.prAutoRerun).toEqual({
      enabled: false,
      workflowFiles: [],
      maxAttempts: 10,
      maxIdenticalFailures: 5,
      maxRunAgeHours: 72,
    });
    expect(cfg.mergedPrs).toEqual({ count: 10 });
    expect(cfg.failureReports).toEqual({
      prefetchAnnotations: true,
      logTailLines: 80,
      format: 'github',
    });
    expect(cfg.notifications).toEqual({ pr: false, flow: false, autoRerun: false });
  });

  it('reads a config stored before these fields existed', () => {
    // Exactly what a v1.1 user has in localStorage: no PR-automation keys at all.
    const legacy = {
      version: 1,
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f', branch: null },
      prAuthor: '',
      polling: { prListSeconds: 180, checksSeconds: 60, flowRunsSeconds: 180, hiddenSeconds: 240 },
      notifications: { pr: true, flow: false },
      autoUpdate: true,
      rateLimitWarnAt: 50,
      flows: [],
      groups: [],
      ungroupedOrder: [],
    };
    const result = safeParseConfig(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Existing preferences survive, and each new field arrives at its own default.
    expect(result.config.notifications).toEqual({ pr: true, flow: false, autoRerun: false });
    expect(result.config.prAutoRerun.enabled).toBe(false);
    expect(result.config.mergedPrs.count).toBe(10);
    /*
     * The log viewer arrives switched **on**, and that is the intended reading of an upgrade: a
     * missing key is the absence of a preference, not a decision against the tab. Nobody who saved
     * this config declined the viewer — it did not exist to decline.
     *
     * The writes are the opposite case and stay off above, because there the default is the safe
     * side of a choice with consequences. A tab that reads a log has none.
     */
    expect(result.config.diagnostics).toEqual({ showLogTab: true, tailKB: 512, followSeconds: 3 });
  });

  it('rejects an out-of-range attempt ceiling', () => {
    const bad = safeParseConfig({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      prAutoRerun: { maxAttempts: 0 },
    });
    expect(bad.ok).toBe(false);
  });

  it('accepts 0 identical failures as "no brake" but rejects a negative limit', () => {
    const base = { upstream: { owner: 'o', repo: 'r' }, fork: { owner: 'f' } };
    expect(safeParseConfig({ ...base, prAutoRerun: { maxIdenticalFailures: 0 } }).ok).toBe(true);
    expect(safeParseConfig({ ...base, prAutoRerun: { maxIdenticalFailures: -1 } }).ok).toBe(false);
    expect(safeParseConfig({ ...base, prAutoRerun: { maxIdenticalFailures: 21 } }).ok).toBe(false);
  });

  /**
   * The identical-failure brake used to be a boolean. A config saved with it lands on the
   * current default rather than being rejected — the old key simply has no counterpart.
   */
  it('loads a config that still carries the old stopOnIdenticalFailure flag', () => {
    const result = safeParseConfig({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      prAutoRerun: { enabled: true, workflowFiles: ['ci.yml'], stopOnIdenticalFailure: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.prAutoRerun.maxIdenticalFailures).toBe(5);
    expect(result.config.prAutoRerun).not.toHaveProperty('stopOnIdenticalFailure');
  });

  it('keeps DEFAULT_CONFIG in step with the schema', () => {
    // DEFAULT_CONFIG is hand-written, so it can drift from the schema's defaults — and it
    // only drifts when someone adds a section and updates one of the two places. So this
    // compares *everything* rather than a list of sections that has to be kept current
    // itself: the coordinates are the only fields that legitimately differ, since the
    // schema requires values the app doesn't have until it is configured.
    const parsed = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
    });
    const { upstream: _u1, fork: _f1, ...defaults } = DEFAULT_CONFIG;
    const { upstream: _u2, fork: _f2, ...fromSchema } = parsed;
    expect(defaults).toEqual(fromSchema);
    expect(Object.keys(DEFAULT_CONFIG).sort()).toEqual(Object.keys(parsed).sort());
  });

  it('defaults the fork repo to the upstream’s name, and honours an override', () => {
    const same = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'me' },
    });
    expect(forkRepo(same)).toBe('r');

    const renamed = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'me', repo: 'r-fork' },
    });
    expect(forkRepo(renamed)).toBe('r-fork');
  });

  it('reports completeness only with required coordinates', () => {
    expect(isConfigComplete(DEFAULT_CONFIG)).toBe(false);
    const complete = monitorConfigSchema.parse({ upstream: { owner: 'o', repo: 'r' }, fork: { owner: 'f' } });
    expect(isConfigComplete(complete)).toBe(true);
  });

  it('falls back prAuthor to fork owner', () => {
    const cfg = monitorConfigSchema.parse({ upstream: { owner: 'o', repo: 'r' }, fork: { owner: 'me' } });
    expect(effectivePrAuthor(cfg)).toBe('me');
  });

  it('reports validation errors via safeParseConfig', () => {
    const result = safeParseConfig({ upstream: { owner: 'o' }, fork: { owner: 'f' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/repo/);
    }
  });

  it('defaults the per-flow empty filter to disabled', () => {
    const cfg = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      flows: [{ id: '1', name: 'CI', workflowFile: 'ci.yml', branches: ['main'] }],
    });
    expect(cfg.flows[0].emptyFilter).toEqual({
      enabled: false,
      mode: 'hide',
      by: 'no_runs',
      minArtifactKB: 0,
      jobName: '',
      jobState: 'skipped',
    });
  });

  it('defaults the regex match to disabled', () => {
    const cfg = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      flows: [{ id: '1', name: 'CI', workflowFile: 'ci.yml', branches: ['main'] }],
    });
    expect(cfg.flows[0].match).toEqual({
      pattern: '',
      by: 'name',
      caseSensitive: false,
      maxMatches: 12,
    });
    expect(cfg.ungroupedOrder).toEqual([]);
  });

  it('accepts a regex flow without a workflow file', () => {
    const cfg = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      flows: [{ id: '1', name: 'nightly', branches: ['main'], match: { pattern: '^nightly-', by: 'file' } }],
    });
    expect(cfg.flows[0].workflowFile).toBe('');
    expect(cfg.flows[0].match.pattern).toBe('^nightly-');
  });

  it('requires a workflow file when there is no regex', () => {
    const result = safeParseConfig({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      flows: [{ id: '1', name: 'CI', branches: ['main'] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/workflowFile/);
  });

  it('rejects a regex that does not compile', () => {
    const result = safeParseConfig({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      flows: [{ id: '1', name: 'bad', branches: ['main'], match: { pattern: '([' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/invalid regex/);
  });

  it('defaults flow events and maxRuns', () => {
    const cfg = monitorConfigSchema.parse({
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'f' },
      flows: [{ id: '1', name: 'CI', workflowFile: 'ci.yml', branches: ['main'] }],
    });
    expect(cfg.flows[0].events).toEqual([]);
    expect(cfg.flows[0].maxRuns).toBe(5);
  });
});

describe('ai defaults', () => {
  const ai = DEFAULT_CONFIG.ai;

  /**
   * On by default so that upgrading doesn't silently remove a feature already in use — it
   * was already gated on `claude` being installed and on an explicit click.
   */
  it('is enabled, with no custom prompt or instructions', () => {
    expect(ai.enabled).toBe(true);
    expect(ai.extraInstructions).toBe('');
    expect([ai.quick.prompt, ai.deep.prompt, ai.log.prompt]).toEqual(['', '', '']);
  });

  /** The pairing is the point of the three tasks; a default that lost it would erase it. */
  it('pairs each task with the model its job needs', () => {
    expect(ai.quick).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(ai.deep).toMatchObject({ model: 'opus', effort: 'high' });
    expect(ai.log).toMatchObject({ model: 'sonnet', effort: 'low' });
  });

  /**
   * There is no migration step and `loadConfig` falls back to DEFAULT_CONFIG on any parse
   * error, so a config saved before this block existed must still parse — otherwise the
   * upgrade wipes every existing user's settings.
   */
  it('fills itself in for a config that predates it', () => {
    // Owner/repo are required, so a bare DEFAULT_CONFIG wouldn't parse for its own reasons.
    const parsed = monitorConfigSchema.parse({
      version: 1,
      upstream: { owner: 'o', repo: 'r' },
      fork: { owner: 'o' },
    });
    expect(parsed.ai).toEqual(ai);
  });

  it('rejects a model or effort outside the offered set', () => {
    const base = { version: 1, upstream: { owner: 'o', repo: 'r' }, fork: { owner: 'o' } };
    expect(monitorConfigSchema.safeParse({ ...base, ai: { quick: { model: 'gpt' } } }).success).toBe(
      false,
    );
    expect(
      monitorConfigSchema.safeParse({ ...base, ai: { deep: { effort: 'ultra' } } }).success,
    ).toBe(false);
  });
});

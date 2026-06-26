import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  effectivePrAuthor,
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
      by: 'no_runs',
      minArtifactKB: 0,
      jobName: '',
      jobState: 'skipped',
    });
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

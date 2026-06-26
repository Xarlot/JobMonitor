import { describe, expect, it } from 'vitest';
import { normalizeRepoRef } from '../lib/repo';
import { monitorConfigSchema } from '../storage/configStore';

describe('normalizeRepoRef', () => {
  it('keeps plain owner + repo', () => {
    expect(normalizeRepoRef('DevExpress', 'dxvcs')).toEqual({ owner: 'DevExpress', repo: 'dxvcs' });
  });

  it('parses a full https URL pasted into the repo field', () => {
    expect(normalizeRepoRef('DevExpress', 'https://github.com/DevExpress/dxvcs.git')).toEqual({
      owner: 'DevExpress',
      repo: 'dxvcs',
    });
  });

  it('parses an owner/repo slug', () => {
    expect(normalizeRepoRef('', 'DevExpress/dxvcs')).toEqual({ owner: 'DevExpress', repo: 'dxvcs' });
  });

  it('parses a URL with extra path and an ssh remote', () => {
    expect(normalizeRepoRef('', 'https://github.com/acme/rocket/tree/main')).toEqual({
      owner: 'acme',
      repo: 'rocket',
    });
    expect(normalizeRepoRef('', 'git@github.com:acme/rocket.git')).toEqual({
      owner: 'acme',
      repo: 'rocket',
    });
  });

  it('parses an owner/repo pasted into the owner field', () => {
    expect(normalizeRepoRef('DevExpress/dxvcs', '')).toEqual({ owner: 'DevExpress', repo: 'dxvcs' });
  });
});

describe('config schema normalizes upstream on parse', () => {
  it('extracts owner/repo from a pasted URL', () => {
    const cfg = monitorConfigSchema.parse({
      upstream: { owner: 'DevExpress', repo: 'https://github.com/DevExpress/dxvcs.git' },
      fork: { owner: 'me' },
    });
    expect(cfg.upstream).toEqual({ owner: 'DevExpress', repo: 'dxvcs' });
  });
});

import { describe, expect, it } from 'vitest';
import { hasYamlExt, isNumericId, matchWorkflow } from '../lib/workflow';
import type { Workflow } from '../api/types';

const workflows: Workflow[] = [
  { id: 42, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  {
    id: 7,
    name: 'Check Pull Request (Java)',
    path: '.github/workflows/check-pull-request-java.yml',
    state: 'active',
  },
];

describe('workflow resolution', () => {
  it('detects numeric ids and yaml extensions', () => {
    expect(isNumericId('42')).toBe(true);
    expect(isNumericId('ci.yml')).toBe(false);
    expect(hasYamlExt('ci.yaml')).toBe(true);
    expect(hasYamlExt('ci')).toBe(false);
  });

  it('matches by bare name without extension (the reported case)', () => {
    expect(matchWorkflow(workflows, 'check-pull-request-java')?.id).toBe(7);
  });

  it('matches by file name, display name, and id', () => {
    expect(matchWorkflow(workflows, 'ci.yml')?.id).toBe(42);
    expect(matchWorkflow(workflows, 'CI')?.id).toBe(42);
    expect(matchWorkflow(workflows, '7')?.id).toBe(7);
    expect(matchWorkflow(workflows, 'Check Pull Request (Java)')?.id).toBe(7);
  });

  it('returns undefined for an unknown workflow', () => {
    expect(matchWorkflow(workflows, 'does-not-exist')).toBeUndefined();
  });
});

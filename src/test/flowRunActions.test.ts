import { describe, expect, it } from 'vitest';
import { parseInputs } from '../components/FlowRunActions';

describe('parseInputs', () => {
  it('reads name=value lines, skipping blanks and trimming around the =', () => {
    expect(parseInputs('target = release\n\n  dry_run=true  \n')).toEqual({
      inputs: { target: 'release', dry_run: 'true' },
    });
  });

  it('keeps an = inside the value', () => {
    expect(parseInputs('args=--flag=1')).toEqual({ inputs: { args: '--flag=1' } });
  });

  it('allows an empty value', () => {
    expect(parseInputs('note=')).toEqual({ inputs: { note: '' } });
  });

  it('refuses a line without a name', () => {
    expect(parseInputs('target=x\njust text')).toEqual({ error: '“just text” is not name=value.' });
    expect(parseInputs('=x')).toHaveProperty('error');
  });

  it('reads nothing as no inputs', () => {
    expect(parseInputs('  \n')).toEqual({ inputs: {} });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetToken,
  getTokenInMemory,
  hasStoredToken,
  lockToken,
  saveToken,
  unlockToken,
} from '../storage/secureTokenStore';

describe('secureTokenStore', () => {
  beforeEach(async () => {
    await forgetToken();
  });

  it('saves, locks, and unlocks a token', async () => {
    await saveToken('ghp_token_value', 'pass1234');
    expect(getTokenInMemory()).toBe('ghp_token_value');
    expect(await hasStoredToken()).toBe(true);

    lockToken();
    expect(getTokenInMemory()).toBeNull();

    const token = await unlockToken('pass1234');
    expect(token).toBe('ghp_token_value');
    expect(getTokenInMemory()).toBe('ghp_token_value');
  });

  it('forget removes the envelope and clears memory', async () => {
    await saveToken('ghp_x', 'pass1234');
    await forgetToken();
    expect(getTokenInMemory()).toBeNull();
    expect(await hasStoredToken()).toBe(false);
    await expect(unlockToken('pass1234')).rejects.toThrow(/no stored token/i);
  });
});

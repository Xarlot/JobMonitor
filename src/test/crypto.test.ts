import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../crypto/webcrypto';

describe('webcrypto', () => {
  it('round-trips a secret with the correct passphrase', async () => {
    const env = await encryptSecret('github_pat_abc123', 'correct horse', 1000);
    expect(env.ciphertext).not.toContain('github_pat');
    const out = await decryptSecret(env, 'correct horse');
    expect(out).toBe('github_pat_abc123');
  });

  it('throws on a wrong passphrase', async () => {
    const env = await encryptSecret('secret-token', 'right-pass', 1000);
    await expect(decryptSecret(env, 'wrong-pass')).rejects.toThrow(/wrong passphrase|failed/i);
  });

  it('produces a fresh salt and iv each time', async () => {
    const a = await encryptSecret('x', 'p', 1000);
    const b = await encryptSecret('x', 'p', 1000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });
});

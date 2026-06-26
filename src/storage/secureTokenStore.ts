/**
 * Persistence + lifecycle for the GitHub PAT.
 *
 * Security model:
 *  - Only the encrypted envelope ({salt, iv, ciphertext}) is persisted, in IndexedDB.
 *  - The plaintext token lives ONLY in a module-scoped variable (process memory),
 *    never in localStorage/sessionStorage, never logged.
 *  - `forget()` wipes both the persisted envelope and the in-memory copy.
 */

import {
  decryptSecret,
  encryptSecret,
  type EncryptedEnvelope,
} from '../crypto/webcrypto';
import { idbDelete, idbGet, idbSet } from './db';

const ENVELOPE_KEY = 'pat.envelope';

/** In-memory plaintext token. Intentionally not exported. */
let memoryToken: string | null = null;

export function getTokenInMemory(): string | null {
  return memoryToken;
}

export function setTokenInMemory(token: string | null): void {
  memoryToken = token;
}

export async function hasStoredToken(): Promise<boolean> {
  return (await idbGet<EncryptedEnvelope>(ENVELOPE_KEY)) !== undefined;
}

/** Encrypt `token` under `passphrase`, persist the envelope, and hold the token in memory. */
export async function saveToken(token: string, passphrase: string): Promise<void> {
  const envelope = await encryptSecret(token, passphrase);
  await idbSet(ENVELOPE_KEY, envelope);
  memoryToken = token;
}

/** Decrypt the stored envelope with `passphrase` and load the token into memory. */
export async function unlockToken(passphrase: string): Promise<string> {
  const envelope = await idbGet<EncryptedEnvelope>(ENVELOPE_KEY);
  if (!envelope) throw new Error('No stored token to unlock.');
  const token = await decryptSecret(envelope, passphrase);
  memoryToken = token;
  return token;
}

/** Remove the persisted envelope and clear the in-memory token. */
export async function forgetToken(): Promise<void> {
  memoryToken = null;
  await idbDelete(ENVELOPE_KEY);
}

/** Drop the in-memory token without touching persisted state (re-lock). */
export function lockToken(): void {
  memoryToken = null;
}

/**
 * Passphrase-based encryption for the GitHub PAT, built on the WebCrypto API.
 *
 *   passphrase --PBKDF2(SHA-256)--> AES-GCM key --encrypt--> ciphertext
 *
 * The derived key is non-extractable. The plaintext token never touches disk;
 * only the {salt, iv, ciphertext} envelope is persisted (see secureTokenStore).
 */

/** PBKDF2 work factor. Current OWASP recommendation for PBKDF2-HMAC-SHA256.
 *  Existing envelopes decrypt with their stored `iterations`, so raising this is
 *  backward-compatible (only new envelopes use the higher count). */
export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_LENGTH_BITS = 256;

export interface EncryptedEnvelope {
  v: 1;
  alg: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** base64 */
  salt: string;
  /** base64 */
  iv: string;
  /** base64 */
  ciphertext: string;
}

function getCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto (crypto.subtle) is unavailable in this environment.');
  }
  return c;
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const crypto = getCrypto();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a plaintext secret under a passphrase, producing a storable envelope. */
export async function encryptSecret(
  plaintext: string,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<EncryptedEnvelope> {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
}

/**
 * Decrypt an envelope with the given passphrase.
 * Throws on a wrong passphrase (AES-GCM auth tag mismatch) or corrupt data.
 */
export async function decryptSecret(
  envelope: EncryptedEnvelope,
  passphrase: string,
): Promise<string> {
  const crypto = getCrypto();
  const salt = fromBase64(envelope.salt);
  const iv = fromBase64(envelope.iv);
  const key = await deriveKey(passphrase, salt, envelope.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      fromBase64(envelope.ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Do not surface crypto internals; most likely a wrong passphrase.
    throw new Error('Decryption failed — wrong passphrase or corrupted data.');
  }
}

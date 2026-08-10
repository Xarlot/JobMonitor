/**
 * NIP-44 v2 — the encryption applied to every telemetry batch before it reaches a public relay.
 *
 * **Implemented to the published specification, not invented.** The original architecture named
 * XChaCha20-Poly1305, which turned out not to be reachable: Electron's BoringSSL exposes no ChaCha
 * cipher through `node:crypto` at all (`createCipheriv('chacha20-poly1305')` throws "Unknown
 * cipher"). NIP-44 v2 is the better target regardless — it is a reviewed spec with an official
 * conformance vector suite, and `test/nip44.test.ts` runs those vectors. A construction with a test
 * suite beats a construction we thought was equivalent.
 *
 * The scheme is ChaCha20 with encrypt-then-MAC over HMAC-SHA256, which is *not* an AEAD primitive
 * in the usual sense but is a standard, sound composition:
 *
 *   conversation_key = hkdf_extract(ikm = ecdh_x, salt = "nip44-v2")
 *   chacha_key ‖ chacha_nonce ‖ hmac_key = hkdf_expand(conversation_key, info = nonce, 76)
 *   ciphertext = chacha20(chacha_key, chacha_nonce, pad(plaintext))
 *   mac        = hmac_sha256(hmac_key, nonce ‖ ciphertext)
 *   payload    = base64(0x02 ‖ nonce ‖ ciphertext ‖ mac)
 *
 * Two details are load-bearing and easy to get wrong:
 *
 *   - The MAC covers the nonce as associated data, not just the ciphertext. Omitting it lets an
 *     attacker swap nonces between messages.
 *   - The MAC is compared in constant time. A byte-by-byte early return here is a padding-oracle
 *     in slow motion.
 *
 * Nothing in this file is original cryptography; every primitive comes from @noble.
 */

import { chacha20 } from '@noble/ciphers/chacha.js';
import { concatBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const VERSION = 2;
const SALT = utf8ToBytes('nip44-v2');
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65_535;

/**
 * Derive the long-lived key shared by two parties.
 *
 * The ECDH output is a compressed point; only its 32-byte x-coordinate is used, which is what makes
 * the key identical from either side. Passing the whole 33-byte point here is the classic
 * implementation bug — it produces a key that works in a round-trip test with itself and with
 * nothing else.
 */
export function conversationKey(privkey: Uint8Array, pubkeyXOnly: Uint8Array): Uint8Array {
  if (pubkeyXOnly.length !== 32) {
    throw new Error('nip44: public key must be 32-byte x-only');
  }
  // Nostr public keys are x-only; secp256k1 needs a parity prefix. NIP-44 fixes it at 0x02, and
  // both parties do the same, so the x-coordinate agrees regardless of the real parity.
  const compressed = concatBytes(new Uint8Array([0x02]), pubkeyXOnly);
  const shared = secp256k1.getSharedSecret(privkey, compressed);
  return extract(sha256, shared.subarray(1, 33), SALT);
}

export interface MessageKeys {
  chachaKey: Uint8Array;
  chachaNonce: Uint8Array;
  hmacKey: Uint8Array;
}

/** Exported so the official `get_message_keys` vectors can be checked directly, rather than only
 *  inferred from whether a round-trip happened to work. */
export function messageKeys(convKey: Uint8Array, nonce: Uint8Array): MessageKeys {
  if (nonce.length !== 32) throw new Error('nip44: nonce must be 32 bytes');
  const keys = expand(sha256, convKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

/**
 * Padded length for a plaintext, per the spec.
 *
 * The padding exists so that ciphertext length leaks only a coarse bucket rather than an exact
 * byte count. For telemetry that matters more than it might seem: batch size correlates with how
 * much someone used the app.
 */
export function calcPaddedLen(unpaddedLen: number): number {
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const unpadded = utf8ToBytes(plaintext);
  const len = unpadded.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) {
    throw new Error(`nip44: plaintext must be ${MIN_PLAINTEXT}..${MAX_PLAINTEXT} bytes, got ${len}`);
  }
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, len, false);
  const suffix = new Uint8Array(calcPaddedLen(len) - len);
  return concatBytes(prefix, unpadded, suffix);
}

function unpad(padded: Uint8Array): string {
  if (padded.length < 2) throw new Error('nip44: padded payload too short');
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  const unpadded = padded.subarray(2, 2 + len);
  // All three conditions matter: a wrong declared length, a truncated body, or a body whose total
  // length disagrees with the padding rule all indicate tampering rather than a benign variation.
  if (
    len < MIN_PLAINTEXT ||
    unpadded.length !== len ||
    padded.length !== 2 + calcPaddedLen(len)
  ) {
    throw new Error('nip44: invalid padding');
  }
  return bytesToUtf8(unpadded);
}

/** Constant-time comparison. Never `===` on a MAC. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Encrypt with a caller-supplied nonce.
 *
 * The nonce is a parameter rather than generated internally so the official test vectors can be
 * replayed exactly. Production callers use {@link encrypt}, which generates one.
 */
export function encryptWithNonce(
  plaintext: string,
  convKey: Uint8Array,
  nonce: Uint8Array,
): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  return bytesToBase64(concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac));
}

export function encrypt(plaintext: string, convKey: Uint8Array): string {
  return encryptWithNonce(plaintext, convKey, randomNonce());
}

export function decrypt(payload: string, convKey: Uint8Array): string {
  // Reject the "unencrypted payload" marker explicitly. NIP-44 reserves '#' for it, and a decryptor
  // that falls through to base64-decoding it would treat attacker-chosen cleartext as authentic.
  if (payload.startsWith('#')) throw new Error('nip44: unsupported encryption version');

  const raw = base64ToBytes(payload);
  if (raw.length < 1 + 32 + 32 + 32) throw new Error('nip44: payload too short');
  if (raw[0] !== VERSION) throw new Error(`nip44: unsupported version ${raw[0]}`);

  const nonce = raw.subarray(1, 33);
  const ciphertext = raw.subarray(33, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);

  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const expected = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));

  // Verify before decrypting. Decrypting first and checking afterwards means running attacker-
  // controlled bytes through the cipher and then through the unpadder, which is where the oracle
  // would be.
  if (!timingSafeEqual(expected, mac)) throw new Error('nip44: invalid MAC');

  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}

function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  return nonce;
}

// ── base64 ──────────────────────────────────────────────────────────────────────────────────────
//
// Hand-rolled because this module runs in three places — Electron's main process, the Node
// receiver, and vitest under jsdom — and none of `Buffer`, `btoa` or `Uint8Array.toBase64` is
// present and correct in all three. Twenty lines beats an environment check.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('nip44: invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/**
 * NIP-44 v2 conformance, against the official vector suite.
 *
 * This is the test that matters most in the repository. Everything else in the telemetry system
 * can be wrong in a way that shows up as a missing chart; this can be wrong in a way that shows up
 * as user data being readable on a public relay. The vectors come from the specification's own
 * suite (`paulmillr/nip44`), checked in verbatim, so "we implemented the spec" is a claim the build
 * verifies rather than one a comment asserts.
 *
 * The suite is run in both the node and jsdom projects — see vitest.config.ts. The client encrypts
 * in Electron's main process and the receiver decrypts in Node, and a divergence between those two
 * environments would look exactly like intermittent data loss.
 */

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  calcPaddedLen,
  conversationKey,
  decrypt,
  encryptWithNonce,
  messageKeys,
} from '../src/nip44';
import vectors from './vectors/nip44.vectors.json' with { type: 'json' };

const v2 = vectors.v2;

describe('conversation key', () => {
  it.each(v2.valid.get_conversation_key)(
    'derives $conversation_key',
    ({ sec1, pub2, conversation_key }) => {
      expect(bytesToHex(conversationKey(hexToBytes(sec1), hexToBytes(pub2)))).toBe(conversation_key);
    },
  );

  // Invalid inputs must throw rather than silently producing a key. A permissive implementation
  // here would happily "encrypt" to a point that is not on the curve.
  it.each(v2.invalid.get_conversation_key)('rejects: $note', ({ sec1, pub2 }) => {
    expect(() => conversationKey(hexToBytes(sec1), hexToBytes(pub2))).toThrow();
  });
});

describe('message keys', () => {
  const convKey = hexToBytes(v2.valid.get_message_keys.conversation_key);

  it.each(v2.valid.get_message_keys.keys)(
    'expands nonce $nonce',
    ({ nonce, chacha_key, chacha_nonce, hmac_key }) => {
      const keys = messageKeys(convKey, hexToBytes(nonce));
      expect(bytesToHex(keys.chachaKey)).toBe(chacha_key);
      expect(bytesToHex(keys.chachaNonce)).toBe(chacha_nonce);
      expect(bytesToHex(keys.hmacKey)).toBe(hmac_key);
    },
  );
});

describe('padding', () => {
  it.each(v2.valid.calc_padded_len)('pads %i to %i', (unpadded, padded) => {
    expect(calcPaddedLen(unpadded)).toBe(padded);
  });
});

describe('encrypt / decrypt', () => {
  it.each(v2.valid.encrypt_decrypt)(
    'produces the specified payload for $plaintext',
    ({ sec1, sec2, conversation_key, nonce, plaintext, payload }) => {
      // Derived from both directions: the whole point of ECDH is that the two sides agree, and a
      // bug that uses the full 33-byte point instead of the x-coordinate still round-trips with
      // itself. Checking both directions is what catches it.
      const fromSec1 = conversationKey(hexToBytes(sec1), hexToBytes(pubkeyOf(sec2)));
      const fromSec2 = conversationKey(hexToBytes(sec2), hexToBytes(pubkeyOf(sec1)));
      expect(bytesToHex(fromSec1)).toBe(conversation_key);
      expect(bytesToHex(fromSec2)).toBe(conversation_key);

      expect(encryptWithNonce(plaintext, fromSec1, hexToBytes(nonce))).toBe(payload);
      expect(decrypt(payload, fromSec2)).toBe(plaintext);
    },
  );

  it.each(v2.valid.encrypt_decrypt_long_msg)(
    'handles a $repeat-byte message',
    ({ conversation_key, nonce, pattern, repeat, plaintext_sha256, payload_sha256 }) => {
      const plaintext = pattern.repeat(repeat);
      expect(bytesToHex(sha256(utf8ToBytes(plaintext)))).toBe(plaintext_sha256);

      const payload = encryptWithNonce(plaintext, hexToBytes(conversation_key), hexToBytes(nonce));
      expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(payload_sha256);
      expect(decrypt(payload, hexToBytes(conversation_key))).toBe(plaintext);
    },
  );

  it.each(v2.invalid.encrypt_msg_lengths)('rejects a %i-byte plaintext', (len) => {
    const convKey = new Uint8Array(32).fill(1);
    expect(() => encryptWithNonce('a'.repeat(len), convKey, new Uint8Array(32))).toThrow();
  });

  // Every one of these is a tampering scenario: a flipped MAC byte, a wrong version marker, an
  // invalid padding length. All must throw — none may return a partial or best-effort plaintext.
  it.each(v2.invalid.decrypt)('rejects: $note', ({ conversation_key, payload }) => {
    expect(() => decrypt(payload, hexToBytes(conversation_key))).toThrow();
  });
});

describe('MAC verification', () => {
  it('rejects a payload whose ciphertext was altered under a valid-looking MAC', () => {
    const convKey = hexToBytes(v2.valid.encrypt_decrypt[0].conversation_key);
    const payload = encryptWithNonce('hello', convKey, new Uint8Array(32).fill(7));

    // Flip a bit in the middle of the base64 body. Whatever it lands on — ciphertext or MAC — the
    // result must not decrypt.
    const mid = Math.floor(payload.length / 2);
    const altered =
      payload.slice(0, mid) + (payload[mid] === 'A' ? 'B' : 'A') + payload.slice(mid + 1);

    expect(() => decrypt(altered, convKey)).toThrow();
  });
});

/** Derive the x-only public key for a secret, the way Nostr keys are expressed. */
function pubkeyOf(sec: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(sec)));
}

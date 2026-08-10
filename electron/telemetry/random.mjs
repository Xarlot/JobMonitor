/**
 * Randomness, behind a seam.
 *
 * Two very different uses, deliberately sharing one source so neither can quietly become
 * predictable:
 *
 *   - Identifiers (`installation_id`, `batch_id`) which must be unguessable and collision-free.
 *   - Jitter, which only needs to be uncorrelated between installations.
 *
 * The seam exists so tests can assert an exact `batch_id`, an exact backoff schedule, and an exact
 * send time, rather than asserting "something in a range" — which is how off-by-one errors in a
 * jitter calculation survive a test suite.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';

let randomBytesFn = nodeRandomBytes;

/** @param {number} n @returns {Buffer} */
export function randomBytes(n) {
  return randomBytesFn(n);
}

/** Replace the source. Tests only. */
export function setRandomBytes(fn) {
  randomBytesFn = fn;
}

export function resetRandomBytes() {
  randomBytesFn = nodeRandomBytes;
}

/** Lowercase hex, the form every identifier travels and is validated in. */
export function randomHex(byteLength) {
  return Buffer.from(randomBytes(byteLength)).toString('hex');
}

/** A float in [0, 1), derived from the same source so a test can pin it. */
export function randomUnit() {
  // 6 bytes = 48 bits of mantissa, which is exactly what a double can hold without rounding.
  const b = randomBytes(6);
  let v = 0;
  for (let i = 0; i < 6; i++) v = v * 256 + b[i];
  return v / 2 ** 48;
}

/** `base` ± `spread`, uniformly. Used for the send interval and for backoff. */
export function jitter(base, spread) {
  return Math.round(base + (randomUnit() * 2 - 1) * spread);
}

#!/usr/bin/env node
/**
 * Generate the telemetry receiver keypair and a deployment id.
 *
 * Run once per deployment. The secret key goes on the ingest VM and nowhere else; the public key is
 * baked into client builds via TELEMETRY_RECEIVER_PUBKEY.
 *
 *   node packages/telemetry-schema/scripts/gen-keys.mjs
 *
 * Read the warning it prints. The single most likely way this system fails permanently is not a
 * bug — it is generating this key, deploying it, and discovering a year later that the only copy
 * was on a VM disk that no longer exists, while every shipped client is still encrypting to it.
 */

import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/ciphers/utils.js';

const seckey = randomBytes(32);
const pubkey = schnorr.getPublicKey(seckey);
const deploymentId = randomBytes(16);

const line = '─'.repeat(78);

console.log(`
${line}
  SECRET — the ingest VM only. Never commit. Never put in an image.
${line}

  TELEMETRY_NOSTR_SECKEYS=${bytesToHex(seckey)}

${line}
  PUBLIC — bake into client builds.
${line}

  TELEMETRY_RECEIVER_PUBKEY=${bytesToHex(pubkey)}
  TELEMETRY_DEPLOYMENT_ID=${bytesToHex(deploymentId)}

${line}

  Next:

    1. Put the secret in /opt/jobmonitor/telemetry/.env on the VM, mode 0600.
    2. Store a copy in the team password manager. This is not optional and it is not
       bureaucracy: the public half ships inside every client binary, so losing the private
       half means every installation is encrypting telemetry that nobody can ever read, and
       recovering costs a client release plus waiting for users to update.
    3. Set the two public values at client build time.

  Rotation, when it comes, is gated on a release: prepend a new secret to the receiver's
  comma-separated list so it accepts both, ship a client carrying the new public key, then
  drop the old secret once old clients have aged out. Rotate on compromise, not on a
  schedule — the cost is a release cycle, not a restart.
`);

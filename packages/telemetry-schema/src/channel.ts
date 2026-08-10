/**
 * The Ably transport envelope — how an encrypted batch becomes a published message.
 *
 * Ably is a managed pub/sub bus, which makes this far simpler than a public relay would have been.
 * Two properties come from the platform rather than from us: delivery to a connected subscriber,
 * and short-term retention so a receiver restart does not lose anything. What Ably does *not* give
 * us is confidentiality from Ably itself, which is why the payload is still encrypted end to end.
 *
 * **The design constraint that shapes everything here**: there is no server the desktop app can
 * reach. Azure exposes no public endpoint by design, so Ably's recommended token authentication —
 * where a backend mints short-lived tokens — is not available. The client therefore carries a
 * long-lived credential, and the whole security model is built around limiting what that
 * credential can do when someone extracts it from a shipped binary, because someone will.
 *
 *   - The key is **publish-only, scoped to one channel**. It cannot subscribe, so no installation
 *     can read another's telemetry, and it cannot touch anything else in the Ably account.
 *   - The payload is **encrypted to the receiver's public key**. Holding the publish key does not
 *     help you read anything; only the ingest VM's private key does.
 *   - A holder of the key can publish junk into our channel. That is bounded by receiver-side
 *     validation, the `deploymentId` check, and Ably's own message limits — not eliminated. The
 *     dashboards are advisory instruments, not audited records.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js';
import { randomBytes } from '@noble/ciphers/utils.js';

import { conversationKey, decrypt, encrypt } from './nip44';
import { MAX_MESSAGE_CHARS } from './limits';

/** The single channel every installation publishes to, and the receiver subscribes to. */
export const TELEMETRY_CHANNEL = 'jobmonitor:telemetry:v1';

/** Ably message name. One value — the channel carries nothing else. */
export const TELEMETRY_MESSAGE_NAME = 'batch';

/** Envelope version, independent of the protobuf `schema_version` inside the ciphertext. */
export const ENVELOPE_VERSION = 1;

/**
 * Publish-only, single-channel Ably key, injected at build time.
 *
 * Left as an obvious placeholder rather than a plausible-looking value so an unconfigured build
 * fails visibly at {@link assertConfigured} instead of silently doing nothing for a release cycle.
 */
export const ABLY_PUBLISH_KEY = process.env.TELEMETRY_ABLY_KEY ?? '';

/**
 * The receiver's x-only public key. The private half exists only on the ingest VM.
 *
 * Generate both with `npm run telemetry:keys`.
 */
export const RECEIVER_PUBKEY_HEX =
  process.env.TELEMETRY_RECEIVER_PUBKEY ??
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Identifies this deployment's telemetry. Carried *inside* the ciphertext.
 *
 * It is not a secret and not a defence against a determined attacker — it is what stops a stranger
 * who extracted the publish key from trivially writing into our dashboards.
 */
export const DEPLOYMENT_ID_HEX =
  process.env.TELEMETRY_DEPLOYMENT_ID ?? '00000000000000000000000000000000';

/** Throw unless real credentials were baked in. Called on the send path, never on the record path. */
export function assertConfigured(): void {
  if (/^0{64}$/.test(RECEIVER_PUBKEY_HEX)) {
    throw new Error(
      'telemetry: RECEIVER_PUBKEY_HEX is unset — this build must not publish. ' +
        'Run `npm run telemetry:keys` and set TELEMETRY_RECEIVER_PUBKEY at build time.',
    );
  }
  if (!ABLY_PUBLISH_KEY) {
    throw new Error('telemetry: TELEMETRY_ABLY_KEY is unset — this build must not publish.');
  }
}

/**
 * What travels as an Ably message payload.
 *
 * `epk` is the load-bearing field. Encryption is ECDH-based, so the receiver needs the sender's
 * public key to derive the shared secret — but that key is generated fresh for every batch and
 * discarded immediately, so it is not an identifier. It exists for exactly one decryption and then
 * refers to nothing.
 */
export interface TelemetryMessage {
  /** Envelope version. */
  v: number;
  /** Ephemeral sender public key, x-only hex. Fresh per batch, never persisted. */
  epk: string;
  /** NIP-44 v2 ciphertext, base64. */
  payload: string;
}

/**
 * Wrap an encoded batch for publication.
 *
 * A new keypair per batch rather than a stored one. With a public relay this mattered enormously —
 * a persistent sender key would have let anyone count distinct publishers and derive our install
 * count and the daily rhythm of the people using the app. On a private Ably channel nobody can
 * observe that, but generating a throwaway key is still simpler than storing one: no key file, no
 * rotation schedule, and nothing on disk that could tie two batches together.
 */
export function sealBatch(
  encodedBatch: string,
  receiverPubkey: string = RECEIVER_PUBKEY_HEX,
): TelemetryMessage {
  const senderSec = randomBytes(32);
  const convKey = conversationKey(senderSec, hexToBytes(receiverPubkey));
  const message: TelemetryMessage = {
    v: ENVELOPE_VERSION,
    epk: bytesToHex(schnorr.getPublicKey(senderSec)),
    payload: encrypt(encodedBatch, convKey),
  };

  const size = JSON.stringify(message).length;
  if (size > MAX_MESSAGE_CHARS) {
    // The caller is expected to have split before reaching this. Throwing rather than publishing,
    // because Ably rejects an oversized message and a rejected publish is data silently lost.
    throw new Error(`telemetry: message is ${size} chars, over the ${MAX_MESSAGE_CHARS} cap`);
  }
  return message;
}

/**
 * Unwrap a published message. Server-side, and therefore hostile input by definition.
 *
 * Every field is validated before it reaches a cryptographic primitive: an `epk` of the wrong
 * length or the wrong alphabet must be rejected here, not discovered as a throw from inside the
 * curve implementation.
 */
export function openBatch(message: unknown, receiverSeckey: Uint8Array): string {
  if (!message || typeof message !== 'object') {
    throw new Error('telemetry: message is not an object');
  }
  const { v, epk, payload } = message as Partial<TelemetryMessage>;

  if (v !== ENVELOPE_VERSION) throw new Error(`telemetry: unsupported envelope version ${v}`);
  if (typeof epk !== 'string' || !/^[0-9a-f]{64}$/.test(epk)) {
    throw new Error('telemetry: malformed sender key');
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('telemetry: missing payload');
  }
  if (payload.length > MAX_MESSAGE_CHARS) {
    throw new Error('telemetry: payload over cap');
  }

  return decrypt(payload, conversationKey(receiverSeckey, hexToBytes(epk)));
}

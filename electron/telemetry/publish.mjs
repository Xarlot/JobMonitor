/**
 * Publishing a sealed batch to Ably.
 *
 * **REST, not Realtime.** The design is "connect only to send, then disconnect" — the client has
 * nothing to subscribe to and no reason to hold a socket open between hourly sends. Ably's REST
 * client is exactly that shape, and it still brings the things worth having: automatic failover to
 * the `*.ably-realtime.com` fallback hosts (deliberately on a separately-managed domain, so a DNS
 * or registrar problem with the primary can be routed around), retry handling, and typed errors.
 *
 * **Idempotency is set explicitly.** Each message carries the batch id, so a publish retried after
 * a timeout cannot become two messages. That matters because the ambiguous case is real: a request
 * that times out may or may not have been accepted, and without an id the safe choice would be to
 * risk double-counting every marginal send. This complements — does not replace — the receiver's
 * own deduplication, which is what protects against a batch resent from the local queue in a later
 * session.
 */

import Ably from 'ably';

import { ABLY_PUBLISH_KEY, TELEMETRY_CHANNEL, TELEMETRY_MESSAGE_NAME } from '@jobmonitor/telemetry-schema';

/** Reasons a publish can fail, mapped to how the sender should react. */
export const PublishResult = {
  OK: 'ok',
  /** Transient — network, 5xx, timeout. Back off and keep the records. */
  RETRY: 'retry',
  /** Permanent for this payload — too large, malformed. Retrying will never help. */
  REJECT: 'reject',
  /** Credentials are wrong or revoked. Stop trying this session; a retry loop would be pointless
   *  and would look like an attack from Ably's side. */
  UNAUTHORIZED: 'unauthorized',
};

let client = null;

function rest() {
  if (!client) {
    client = new Ably.Rest({
      key: ABLY_PUBLISH_KEY,
      // Nothing here should ever hold the process open or retry forever in the background.
      queueMessages: false,
      // The SDK logs to stdout by default, which in a packaged desktop app means either a lost
      // message or a console nobody sees. Everything useful goes through our own diagnostics log.
      logLevel: 0,
    });
  }
  return client;
}

/**
 * Publish one sealed batch.
 *
 * Never throws. The caller is a timer on the send path and has no meaningful way to handle an
 * exception — every outcome is a value it can act on.
 *
 * @param {{v:number, epk:string, payload:string}} message From `sealBatch`.
 * @param {string} batchIdHex Used as the Ably message id, for idempotency.
 * @returns {Promise<{result: string, detail?: string}>}
 */
export async function publishBatch(message, batchIdHex) {
  try {
    const channel = rest().channels.get(TELEMETRY_CHANNEL);
    await channel.publish([{ name: TELEMETRY_MESSAGE_NAME, data: message, id: batchIdHex }]);
    return { result: PublishResult.OK };
  } catch (err) {
    return classify(err);
  }
}

/**
 * Map an Ably error to a reaction.
 *
 * Status code first, then error code. The distinction that matters most is 401 versus everything
 * else: a revoked or mistyped key is not something a backoff can fix, and continuing to retry it
 * every hour for the life of the installation would be both useless and rude.
 */
function classify(err) {
  const status = err?.statusCode ?? err?.status;
  const code = err?.code;
  const detail = `${status ?? '?'}/${code ?? '?'}`;

  if (status === 401 || status === 403) return { result: PublishResult.UNAUTHORIZED, detail };
  // 40009 is "message too large"; 4xx generally means this payload will never be accepted.
  if (status === 400 || code === 40009) return { result: PublishResult.REJECT, detail };
  if (status === 429) return { result: PublishResult.RETRY, detail };
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { result: PublishResult.REJECT, detail };
  }
  // Network failure, timeout, 5xx, or no status at all.
  return { result: PublishResult.RETRY, detail };
}

/** Drop the cached client. Tests, and the disabled path. */
export function resetPublisher() {
  client = null;
}

/** Swap the publisher. The seam that keeps every sender test off the network. */
let publishImpl = publishBatch;
export function setPublisher(fn) {
  publishImpl = fn;
}
export function resetPublisherImpl() {
  publishImpl = publishBatch;
}
export function publish(message, batchIdHex) {
  return publishImpl(message, batchIdHex);
}

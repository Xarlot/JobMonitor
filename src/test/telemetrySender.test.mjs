/**
 * The send state machine.
 *
 * Every test here runs offline through the publisher seam, with an injected clock. That is the
 * point of `tick(now)` being explicit rather than the module owning its own timers: a backoff
 * schedule spanning four hours is asserted in microseconds, and no test can accidentally publish
 * to the real channel.
 *
 * The invariant worth the most scrutiny is that **a failed send changes nothing on disk**. It is
 * what makes at-least-once delivery true, and its failure mode is invisible — telemetry that was
 * dropped looks exactly like telemetry that was never recorded.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSender } from '../../electron/telemetry/sender.mjs';
import { createSpool, PRIORITIES } from '../../electron/telemetry/spool.mjs';
import { PublishResult, setPublisher, resetPublisherImpl } from '../../electron/telemetry/publish.mjs';
import { resetNow, setNow } from '../../electron/telemetry/clock.mjs';
import { resetRandomBytes, setRandomBytes } from '../../electron/telemetry/random.mjs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/ciphers/utils.js';

/**
 * A real receiver key. The build-time constant is a placeholder of 32 zero bytes in a checkout
 * with no credentials, and that is not a valid curve point — sealing against it throws, which is
 * exactly what an unconfigured build should do and exactly what a test must not depend on.
 */
// Plain Uint8Array rather than Buffer: under jsdom the global Uint8Array belongs to a different
// realm, so a Buffer fails noble's `instanceof` check even though Buffer subclasses Uint8Array.
const RECEIVER_PUBKEY = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(3)));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let dir;
let clock;
let published;

const CONTEXT = {
  installationId: '0'.repeat(32),
  deploymentId: '1'.repeat(32),
  appVersion: '2.2.0',
  platform: 'linux',
  arch: 'x64',
  electronVersion: '42.5.0',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telemetry-sender-'));
  clock = 1_754_650_000_000;
  setNow(() => clock);
  // Deterministic ids and jitter, so send times and batch ids are exact rather than "about right".
  setRandomBytes((n) => new Uint8Array(n).fill(7));
  published = [];
  resetPublisherImpl();
});

afterEach(() => {
  resetNow();
  resetRandomBytes();
  resetPublisherImpl();
  rmSync(dir, { recursive: true, force: true });
});

/** A publisher that records what it was given and returns a scripted outcome. */
function fakePublisher(outcomes = []) {
  let i = 0;
  setPublisher(async (message, batchIdHex) => {
    published.push({ message, batchIdHex });
    const next = outcomes[Math.min(i, outcomes.length - 1)] ?? { result: PublishResult.OK };
    i++;
    return next;
  });
}

function makeSender(spool, overrides = {}) {
  return createSender({ spool, context: CONTEXT, receiverPubkey: RECEIVER_PUBKEY, ...overrides });
}

function seed(spool, count = 1) {
  for (let i = 0; i < count; i++) {
    spool.append('usage', 'counters', {
      features: [{ featureId: 300, count: i + 1 }],
      operations: [],
      usage: [],
    });
    clock += 1000;
  }
}

describe('scheduling', () => {
  it('does not send immediately on start', () => {
    // 50 installations that all auto-updated overnight would otherwise publish in lockstep.
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher();

    const sender = makeSender(spool);
    expect(sender.dueAt()).toBeGreaterThan(clock);
    return sender.tick().then((r) => {
      expect(r.sent).toBe(0);
      expect(published).toHaveLength(0);
    });
  });

  it('sends once due', async () => {
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher();

    const sender = makeSender(spool);
    sender.forceDue();
    expect((await sender.tick()).sent).toBe(1);
    expect(published).toHaveLength(1);
  });

  it('schedules roughly an hour out after a successful send', async () => {
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher();

    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();

    const delay = sender.dueAt() - clock;
    expect(delay).toBeGreaterThanOrEqual(HOUR - 10 * MINUTE);
    expect(delay).toBeLessThanOrEqual(HOUR + 10 * MINUTE);
  });

  it('does nothing when the queue is empty', async () => {
    const spool = createSpool({ dir });
    fakePublisher();

    const sender = makeSender(spool);
    sender.forceDue();
    expect((await sender.tick()).sent).toBe(0);
    expect(published).toHaveLength(0);
    // Still reschedules, so an empty queue does not mean checking every tick forever.
    expect(sender.dueAt()).toBeGreaterThan(clock);
  });
});

describe('at-least-once', () => {
  it('leaves the queue byte-identical when a publish fails', async () => {
    // The invariant the whole design rests on.
    const spool = createSpool({ dir });
    seed(spool, 3);
    const before = PRIORITIES.map((p) => readOrEmpty(join(dir, `${p}.ndjson`)));

    fakePublisher([{ result: PublishResult.RETRY, detail: '500/?' }]);
    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();

    expect(PRIORITIES.map((p) => readOrEmpty(join(dir, `${p}.ndjson`)))).toEqual(before);
    expect(spool.readAll()).toHaveLength(3);
  });

  it('removes records only after a confirmed publish', async () => {
    const spool = createSpool({ dir });
    seed(spool, 2);
    fakePublisher();

    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();

    expect(spool.readAll()).toHaveLength(0);
  });

  it('resends the same records after a failure', async () => {
    const spool = createSpool({ dir });
    seed(spool, 2);
    fakePublisher([{ result: PublishResult.RETRY }, { result: PublishResult.OK }]);

    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();
    expect(spool.readAll()).toHaveLength(2);

    clock += 5 * MINUTE;
    sender.forceDue();
    await sender.tick();
    expect(spool.readAll()).toHaveLength(0);
    expect(published).toHaveLength(2);
  });

  it('gives each attempt a distinct batch id', async () => {
    // Ably deduplicates on the message id, so two *different* batches must never share one — and
    // the receiver deduplicates on batch_id, which is what makes a resend safe.
    let n = 0;
    setRandomBytes((size) => new Uint8Array(size).fill(n++));

    const spool = createSpool({ dir });
    seed(spool, 2);
    fakePublisher([{ result: PublishResult.RETRY }, { result: PublishResult.OK }]);

    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();
    clock += 5 * MINUTE;
    sender.forceDue();
    await sender.tick();

    expect(published[0].batchIdHex).not.toBe(published[1].batchIdHex);
  });
});

describe('backoff', () => {
  it('follows the schedule and resets after a success', async () => {
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher([{ result: PublishResult.RETRY }]);

    const sender = makeSender(spool);
    const expected = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 4 * HOUR];

    for (const base of expected) {
      sender.forceDue();
      await sender.tick();
      const delay = sender.dueAt() - clock;
      // ±20% jitter.
      expect(delay).toBeGreaterThanOrEqual(base * 0.75);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
    }

    // Caps rather than growing without bound.
    sender.forceDue();
    await sender.tick();
    expect(sender.dueAt() - clock).toBeLessThanOrEqual(4 * HOUR * 1.25);

    fakePublisher([{ result: PublishResult.OK }]);
    sender.forceDue();
    await sender.tick();
    expect(sender.attempts()).toBe(0);
  });

  it('drains a backlog quickly instead of waiting an hour per batch', async () => {
    // After an outage the queue can hold days of records. Waiting a full interval between batches
    // would take a week to catch up, by which point the oldest have expired.
    const spool = createSpool({ dir });
    seed(spool, 250); // over MAX_RECORDS_PER_SEND
    fakePublisher();

    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();

    expect(spool.readAll().length).toBeGreaterThan(0);
    expect(sender.dueAt() - clock).toBeLessThanOrEqual(MINUTE);
  });
});

describe('permanent failures', () => {
  it('stops trying after an authorization failure', async () => {
    // A revoked or mistyped key is not something backoff can fix, and retrying it hourly for the
    // life of the installation is both useless and rude to Ably.
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher([{ result: PublishResult.UNAUTHORIZED, detail: '401/40160' }]);

    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();

    expect(sender.isOff()).toBe(true);
    const count = published.length;
    sender.forceDue();
    await sender.tick();
    expect(published).toHaveLength(count);
    // The records stay — a later version with working credentials can still send them.
    expect(spool.readAll()).toHaveLength(1);
  });

  it('halves the batch when a payload is rejected', async () => {
    const spool = createSpool({ dir });
    seed(spool, 4);
    fakePublisher([{ result: PublishResult.REJECT, detail: '400/40009' }, { result: PublishResult.OK }]);

    const sender = makeSender(spool);
    sender.forceDue();
    const result = await sender.tick();

    expect(result.sent).toBe(2);
    expect(spool.readAll()).toHaveLength(2);
  });

  it('drops a single unsendable record rather than wedging the queue forever', async () => {
    // Without this, one poisoned record sits at the head and everything behind it expires unsent —
    // which looks exactly like the app not being used.
    const spool = createSpool({ dir });
    seed(spool, 1);
    fakePublisher([{ result: PublishResult.REJECT, detail: '400/40009' }]);

    const sender = makeSender(spool);
    sender.forceDue();
    const result = await sender.tick();

    expect(result.dropped).toBe(1);
    expect(spool.readAll()).toHaveLength(0);
  });

  it('never throws when the publisher throws', async () => {
    const spool = createSpool({ dir });
    seed(spool);
    setPublisher(async () => {
      throw new Error('socket exploded');
    });

    const sender = makeSender(spool);
    sender.forceDue();
    await expect(sender.tick()).resolves.toEqual({ sent: 0 });
    expect(spool.readAll()).toHaveLength(1);
  });
});

describe('disabled sending', () => {
  it('never publishes when send is off', async () => {
    // Dev runs and the screenshot scripts spool but must not reach the real channel.
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher();

    const sender = makeSender(spool, { enabled: false });
    sender.forceDue();
    await sender.tick();

    expect(published).toHaveLength(0);
    expect(spool.readAll()).toHaveLength(1);
  });

  it('stops after shutdown', async () => {
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher();

    const sender = makeSender(spool);
    sender.stop();
    sender.forceDue();
    await sender.tick();

    expect(published).toHaveLength(0);
  });
});

describe('batch contents', () => {
  it('sends a sealed envelope, never anything readable', async () => {
    const spool = createSpool({ dir });
    seed(spool);
    fakePublisher();

    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();

    const { message } = published[0];
    expect(message).toHaveProperty('v');
    expect(message).toHaveProperty('epk');
    expect(message).toHaveProperty('payload');
    // Nothing recognisable from the batch appears outside the ciphertext.
    const envelope = JSON.stringify({ v: message.v, epk: message.epk });
    expect(envelope).not.toContain(CONTEXT.installationId);
    expect(envelope).not.toContain('2.2.0');
  });

  it('reports dropped records so a gap arrives as a number, not silence', async () => {
    const spool = createSpool({ dir, maxAgeMs: 1000 });
    seed(spool, 2);
    clock += 10_000;
    spool.evict();
    expect(spool.droppedCount()).toBe(2);

    seed(spool, 1);
    fakePublisher();
    const sender = makeSender(spool);
    sender.forceDue();
    await sender.tick();

    expect(published).toHaveLength(1);
    // Cleared only after the batch carrying the count was accepted.
    expect(spool.droppedCount()).toBe(0);
  });
});

function readOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

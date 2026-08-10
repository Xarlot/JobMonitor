/**
 * The processing pipeline.
 *
 * Two things are being defended here, and they pull in opposite directions.
 *
 * **Nothing gets in that should not.** The receiver's input is hostile by definition — the client's
 * credentials ship inside a binary distributed to users — so every test that feeds it garbage is
 * testing the actual threat model, not a hypothetical.
 *
 * **Nothing that should get in is lost.** A duplicate must not double-count, a retry must be safe,
 * and a single bad record must not cost the good ones beside it. These failures are all silent:
 * the symptom is a chart that reads wrong, with nothing anywhere flagging it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/ciphers/utils.js';

import {
  Arch,
  CrashSource,
  Platform,
  SCHEMA_VERSION,
  TelemetryBatchSchema,
  encodeBatch,
  sealBatch,
} from '@jobmonitor/telemetry-schema';
import { ErrorCategory, Feature, Operation } from '@jobmonitor/telemetry-schema/registry';

import { database, resetDatabase } from '../src/lib/db.js';
import { processMessage, type PipelineDeps } from '../src/receiver/pipeline.js';

const RECEIVER_SEC = new Uint8Array(32).fill(9);
const RECEIVER_PUB = bytesToHex(schnorr.getPublicKey(RECEIVER_SEC));
const DEPLOYMENT = 'a'.repeat(32);

let dir: string;
let deps: PipelineDeps;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'receiver-'));
  process.env.TELEMETRY_DB = join(dir, 'telemetry.db');
  resetDatabase();
  clock = Date.UTC(2026, 7, 8, 20, 30, 0);
  deps = {
    db: database(),
    secretKeys: [RECEIVER_SEC],
    deploymentId: DEPLOYMENT,
    ratePerHour: 10,
    now: () => clock,
  };
});

afterEach(() => {
  resetDatabase();
  delete process.env.TELEMETRY_DB;
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (fill: number, n = 16) => new Uint8Array(n).fill(fill);

function batchOf(overrides: Record<string, unknown> = {}) {
  return create(TelemetryBatchSchema, {
    batchId: bytes(1),
    schemaVersion: SCHEMA_VERSION,
    installationId: bytes(2),
    deploymentId: Uint8Array.from(Buffer.from(DEPLOYMENT, 'hex')),
    appVersion: '2.2.0',
    platform: Platform.LINUX,
    arch: Arch.X64,
    electronVersion: '42.5.0',
    periodStartMs: BigInt(clock - 3_600_000),
    periodEndMs: BigInt(clock),
    features: [{ featureId: Feature.FLOW_CREATED, count: 3 }],
    operations: [
      {
        operationId: Operation.GH_PR_LIST_POLL,
        count: 2,
        durationSumMs: 300n,
        durationMaxMs: 200,
        buckets: [0, 0, 1, 1, 0, 0, 0, 0],
        failures: [{ errorCategory: ErrorCategory.NETWORK, count: 1 }],
      },
    ],
    usage: [
      {
        bucketStartMs: BigInt(Date.UTC(2026, 7, 8, 20, 0, 0)),
        appStarts: 1,
        sessionCount: 1,
        foregroundSeconds: 120,
        runningSeconds: 600,
        cleanShutdowns: 0,
        uncleanExits: 0,
      },
    ],
    crashes: [],
    droppedRecords: 0,
    ...overrides,
  });
}

const seal = (b: ReturnType<typeof batchOf>) => sealBatch(encodeBatch(b), RECEIVER_PUB);

describe('happy path', () => {
  it('accepts a well-formed batch and stores every record', () => {
    const result = processMessage(deps, seal(batchOf()));

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.records).toBe(3); // feature + operation + usage
    expect(result.dropped).toBe(0);

    const usage = deps.db.prepare('SELECT record_type, feature_key, operation_key, count FROM usage ORDER BY record_type').all();
    expect(usage).toHaveLength(3);
    // Keys denormalised at ingest — numeric ids alone make a dashboard unreadable.
    expect(usage.find((r) => (r as { record_type: string }).record_type === 'feature')).toMatchObject({
      feature_key: 'flow.created',
      count: 3,
    });

    const failures = deps.db.prepare('SELECT operation_key, error_key, count FROM failures').all();
    expect(failures[0]).toMatchObject({ operation_key: 'gh.pr_list_poll', error_key: 'network' });
  });

  it('files a usage record at its own hour, not at the batch end', () => {
    // Otherwise a night's activity smears onto one point.
    processMessage(deps, seal(batchOf()));
    const row = deps.db.prepare("SELECT ts FROM usage WHERE record_type = 'usage'").get() as { ts: number };
    expect(row.ts).toBe(Date.UTC(2026, 7, 8, 20, 0, 0));
  });
});

describe('deduplication', () => {
  it('counts a replayed batch exactly once', () => {
    const message = seal(batchOf());

    expect(processMessage(deps, message).status).toBe('accepted');
    expect(processMessage(deps, message).status).toBe('duplicate');

    const { n } = deps.db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number };
    expect(n).toBe(3);
  });

  it('treats a different batch id as new even with identical contents', () => {
    // A genuine resend after an ambiguous timeout carries a fresh id, and must not be discarded.
    processMessage(deps, seal(batchOf()));
    processMessage(deps, seal(batchOf({ batchId: bytes(2) })));

    const { n } = deps.db.prepare('SELECT COUNT(*) AS n FROM processed_batches').get() as { n: number };
    expect(n).toBe(2);
  });

  it('writes data and the dedup row atomically', () => {
    // If these could diverge, a crash between them would lose a batch permanently and silently —
    // it would be replayed and immediately discarded as already-processed.
    processMessage(deps, seal(batchOf()));
    const batches = deps.db.prepare('SELECT COUNT(*) AS n FROM processed_batches').get() as { n: number };
    const rows = deps.db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number };
    expect(batches.n).toBe(1);
    expect(rows.n).toBeGreaterThan(0);
  });
});

describe('rejects hostile input without dying', () => {
  const cases: [string, unknown][] = [
    ['null', null],
    ['a string', 'not a message'],
    ['an empty object', {}],
    ['wrong envelope version', { v: 99, epk: 'a'.repeat(64), payload: 'x' }],
    ['malformed sender key', { v: 1, epk: 'nope', payload: 'x' }],
    ['garbage payload', { v: 1, epk: 'a'.repeat(64), payload: 'not-base64!!' }],
  ];

  it.each(cases)('rejects %s', (_label, input) => {
    const result = processMessage(deps, input);
    expect(result.status).toBe('rejected');
  });

  it('rejects a batch encrypted to someone else', () => {
    const stranger = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(4)));
    const message = sealBatch(encodeBatch(batchOf()), stranger);
    expect(processMessage(deps, message)).toMatchObject({ status: 'rejected', rule: 'undecryptable' });
  });

  it('rejects a batch from another deployment', () => {
    // What stops a stranger who extracted the publish key from writing into our dashboards.
    const message = seal(batchOf({ deploymentId: bytes(0xbb) }));
    expect(processMessage(deps, message)).toMatchObject({ rule: 'deployment-mismatch' });
  });

  it('rejects an implausible period', () => {
    const message = seal(batchOf({ periodEndMs: BigInt(clock + 86_400_000) }));
    expect(processMessage(deps, message)).toMatchObject({ rule: 'future-period' });
  });

  it('survives every rejection and keeps accepting afterwards', () => {
    for (const [, bad] of cases) processMessage(deps, bad);
    expect(processMessage(deps, seal(batchOf())).status).toBe('accepted');
  });

  it('records the rule but never the value', () => {
    processMessage(deps, { v: 1, epk: 'nope', payload: 'x' });
    const rows = deps.db.prepare('SELECT rule, field FROM rejections').all();
    expect(rows.length).toBeGreaterThan(0);
    // A privacy validator that logged the data it rejected would have moved the problem, not
    // solved it — and moved it somewhere with weaker retention controls.
    expect(JSON.stringify(rows)).not.toContain('nope');
  });
});

describe('record-level validation drops one record, not the batch', () => {
  it('drops an unknown feature id and keeps the rest', () => {
    const message = seal(
      batchOf({ features: [{ featureId: 999_999, count: 1 }, { featureId: Feature.FLOW_CREATED, count: 2 }] }),
    );
    const result = processMessage(deps, message);

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.dropped).toBe(1);

    const rows = deps.db.prepare("SELECT feature_key FROM usage WHERE record_type = 'feature'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature_key: 'flow.created' });
  });

  it('drops an operation whose histogram disagrees with its count', () => {
    // The invariant that catches a client aggregation bug. Either number alone looks reasonable.
    const message = seal(
      batchOf({
        operations: [
          {
            operationId: Operation.GH_PR_LIST_POLL,
            count: 5,
            durationSumMs: 100n,
            durationMaxMs: 50,
            buckets: [1, 0, 0, 0, 0, 0, 0, 0], // sums to 1, not 5
            failures: [],
          },
        ],
      }),
    );
    const result = processMessage(deps, message);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.dropped).toBe(1);
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM usage WHERE record_type = 'operation'").get()).toMatchObject({ n: 0 });
  });

  it('drops a usage record claiming more than an hour inside an hour', () => {
    // Catches a broken clamp on the client — the sleeping-laptop bug.
    const message = seal(
      batchOf({
        usage: [
          {
            bucketStartMs: BigInt(Date.UTC(2026, 7, 8, 20, 0, 0)),
            appStarts: 1,
            sessionCount: 1,
            foregroundSeconds: 0,
            runningSeconds: 28_800, // eight hours in a one-hour bucket
            cleanShutdowns: 0,
            uncleanExits: 0,
          },
        ],
      }),
    );
    const result = processMessage(deps, message);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.dropped).toBe(1);
  });
});

describe('crash handling', () => {
  const crash = (over: Record<string, unknown> = {}) => ({
    occurredAtMs: BigInt(clock - 1000),
    appVersion: '2.2.0',
    source: CrashSource.REACT_BOUNDARY,
    exceptionType: 'TypeError',
    fingerprint: bytes(7),
    stack: 'at FlowRunsGrid (app:/assets/index.js:42:13)',
    count: 1,
    ...over,
  });

  it('stores a sanitized crash', () => {
    processMessage(deps, seal(batchOf({ crashes: [crash()] })));
    const row = deps.db.prepare('SELECT exception_type, stack, stack_redacted FROM crashes').get();
    expect(row).toMatchObject({ exception_type: 'TypeError', stack_redacted: 0 });
  });

  it('keeps the crash but drops a trace containing a token', () => {
    // Losing the fact of a crash is worse than losing its detail: fingerprint, version and count
    // are what the reliability dashboards run on, and all three survive.
    const leaky = crash({ stack: 'at f (app:/a.js:1:1 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789)' });
    processMessage(deps, seal(batchOf({ crashes: [leaky] })));

    const row = deps.db.prepare('SELECT exception_type, stack, stack_redacted FROM crashes').get() as {
      exception_type: string;
      stack: string;
      stack_redacted: number;
    };
    expect(row.exception_type).toBe('TypeError');
    expect(row.stack_redacted).toBe(1);
    expect(row.stack).toBe('');
    expect(row.stack).not.toContain('ghp_');
  });

  it.each([
    ['home directory', 'at f (/home/maksim/proj/a.js:1:1)'],
    ['email', 'at f (a.js:1:1) someone@devexpress.com'],
    ['url', 'at f (https://github.com/DevExpress/private:1:1)'],
    ['windows path', 'at f (C:\\Users\\maksim\\a.js:1:1)'],
  ])('redacts a trace containing a %s', (_label, stack) => {
    processMessage(deps, seal(batchOf({ crashes: [crash({ stack })] })));
    const row = deps.db.prepare('SELECT stack, stack_redacted FROM crashes').get() as {
      stack: string;
      stack_redacted: number;
    };
    expect(row.stack_redacted).toBe(1);
    expect(row.stack).toBe('');
  });

  it('rejects an exception type that is really a token', () => {
    // `error.name` is writable, so this field is user-controllable — and a token is itself a valid
    // identifier, so a shape check alone would let it through.
    const message = seal(
      batchOf({ crashes: [crash({ exceptionType: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })] }),
    );
    const result = processMessage(deps, message);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.dropped).toBe(1);
    expect(deps.db.prepare('SELECT COUNT(*) AS n FROM crashes').get()).toMatchObject({ n: 0 });
  });

  it('stores nothing anywhere that matches a secret pattern', () => {
    // The acceptance test for the whole privacy claim, run against the database rather than
    // against any one function.
    const leaky = crash({
      stack: 'at f (/home/maksim/x.js:1:1)\nat g (a.js:2:2) ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    });
    processMessage(deps, seal(batchOf({ crashes: [leaky] })));

    for (const table of ['usage', 'crashes', 'failures', 'rejections']) {
      const dump = JSON.stringify(deps.db.prepare(`SELECT * FROM ${table}`).all());
      expect(dump, table).not.toContain('maksim');
      expect(dump, table).not.toContain('ghp_');
      expect(dump, table).not.toContain('/home/');
    }
  });
});

describe('rate limiting', () => {
  it('drops batches past the hourly budget for one installation', () => {
    // The real control on a model that cannot authenticate senders.
    for (let i = 0; i < 10; i++) {
      expect(processMessage(deps, seal(batchOf({ batchId: bytes(i + 20) }))).status).toBe('accepted');
    }
    expect(processMessage(deps, seal(batchOf({ batchId: bytes(99) })))).toMatchObject({
      status: 'rejected',
      rule: 'rate-limited',
    });
  });

  it('does not penalise a different installation', () => {
    for (let i = 0; i < 10; i++) processMessage(deps, seal(batchOf({ batchId: bytes(i + 20) })));
    const other = seal(batchOf({ batchId: bytes(60), installationId: bytes(0x33) }));
    expect(processMessage(deps, other).status).toBe('accepted');
  });

  it('resets on the next hour', () => {
    for (let i = 0; i < 10; i++) processMessage(deps, seal(batchOf({ batchId: bytes(i + 20) })));
    clock += 3_600_000;
    const later = seal(batchOf({ batchId: bytes(70), periodEndMs: BigInt(clock) }));
    expect(processMessage(deps, later).status).toBe('accepted');
  });
});

describe('key rotation', () => {
  it('accepts batches sealed to either key while both are configured', () => {
    const oldSec = new Uint8Array(32).fill(5);
    const oldPub = bytesToHex(schnorr.getPublicKey(oldSec));
    deps.secretKeys = [RECEIVER_SEC, oldSec];

    expect(processMessage(deps, seal(batchOf())).status).toBe('accepted');
    const older = sealBatch(encodeBatch(batchOf({ batchId: bytes(50) })), oldPub);
    expect(processMessage(deps, older).status).toBe('accepted');
  });
});

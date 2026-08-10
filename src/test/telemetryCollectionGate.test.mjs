/**
 * The development collection gate.
 *
 * Two claims are being defended, and they point in opposite directions.
 *
 * **A development build records nothing until told to**, and forgets that instruction on restart.
 * Without it, every `npm run electron:dev` leaves counters from whatever was being poked at, and
 * that noise then has to be told apart from anything real.
 *
 * **A packaged build cannot be switched off.** Collection is always on with no opt-out — that was
 * a deliberate product decision — so a control that worked there would quietly become the opt-out
 * the documentation says does not exist. The refusal lives in the main process rather than in the
 * UI, because a control the renderer merely hides is not a control.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initTelemetry, shutdownTelemetry } from '../../electron/telemetry/index.mjs';
import { resetNow, setNow } from '../../electron/telemetry/clock.mjs';

let dir;
let clock;

const FEATURE = 300; // flow.created
const OPERATION = 1000; // gh.pr_list_poll

function start({ packaged }) {
  return initTelemetry({
    dir,
    appVersion: '2.2.0',
    platform: 'linux',
    arch: 'x64',
    electronVersion: '42.5.0',
    // `send` is exactly `app.isPackaged` in main.cjs, so it is also what distinguishes the builds.
    send: packaged,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telemetry-gate-'));
  clock = 1_754_650_000_000;
  setNow(() => clock);
});

afterEach(() => {
  shutdownTelemetry();
  resetNow();
  rmSync(dir, { recursive: true, force: true });
});

describe('a development build', () => {
  it('records nothing by default', () => {
    const t = start({ packaged: false });
    expect(t.stats().collecting).toBe(false);

    t.ingestDelta({ features: [[FEATURE, 5]], operations: [[OPERATION, [10]]], failures: [] });
    t.flushToSpool('test');

    expect(t.spool.readAll()).toHaveLength(0);
  });

  it('records once switched on', () => {
    const t = start({ packaged: false });
    expect(t.setCollecting(true)).toMatchObject({ ok: true, collecting: true });

    t.ingestDelta({ features: [[FEATURE, 5]], operations: [], failures: [] });
    t.flushToSpool('test');

    const records = t.spool.readAll();
    expect(records).toHaveLength(1);
    expect(records[0].body.features).toEqual([{ featureId: FEATURE, count: 5 }]);
  });

  it('stops recording when switched off, and keeps what it already had', () => {
    const t = start({ packaged: false });
    t.setCollecting(true);
    t.ingestDelta({ features: [[FEATURE, 2]], operations: [], failures: [] });

    // Switching off flushes first: the counters already gathered are real and should not evaporate
    // just because recording stopped.
    t.setCollecting(false);
    expect(t.spool.readAll()).toHaveLength(1);

    t.ingestDelta({ features: [[FEATURE, 99]], operations: [], failures: [] });
    t.flushToSpool('test');
    const total = t.spool
      .readAll()
      .flatMap((r) => r.body.features ?? [])
      .reduce((n, f) => n + f.count, 0);
    expect(total).toBe(2);
  });

  it('drops crashes too, not only counters', () => {
    // A crash is the one thing tempting to record regardless. It is still noise from a build
    // nobody is running.
    const t = start({ packaged: false });
    expect(
      t.recordRendererCrash({ name: 'TypeError', stack: 'at x (app:/a.js:1:1)', source: 4 }),
    ).toBe(false);
    expect(t.spool.readAll()).toHaveLength(0);
  });

  it('starts clean on the next run, because the setting is never persisted', () => {
    const first = start({ packaged: false });
    first.setCollecting(true);
    expect(first.stats().collecting).toBe(true);
    shutdownTelemetry();

    // Same directory — the queue and the installation id survive; the switch does not.
    const second = start({ packaged: false });
    expect(second.stats().collecting).toBe(false);
  });
});

describe('a packaged build', () => {
  it('collects without being asked', () => {
    const t = start({ packaged: true });
    expect(t.stats().collecting).toBe(true);

    t.ingestDelta({ features: [[FEATURE, 1]], operations: [], failures: [] });
    t.flushToSpool('test');
    expect(t.spool.readAll().length).toBeGreaterThan(0);
  });

  it('refuses to be switched off', () => {
    // The refusal is here, in the main process, and not in the UI. A control the renderer merely
    // hides is not a control — and this is the difference between "no opt-out" being true and
    // being a claim in a document.
    const t = start({ packaged: true });

    expect(t.setCollecting(false)).toMatchObject({ ok: false, collecting: true });
    expect(t.stats().collecting).toBe(true);

    t.ingestDelta({ features: [[FEATURE, 3]], operations: [], failures: [] });
    t.flushToSpool('test');
    expect(t.spool.readAll().length).toBeGreaterThan(0);
  });
});

describe('forced send', () => {
  it('refuses without credentials rather than failing silently', async () => {
    // A dev checkout has no keys baked in, and the placeholder is 32 zero bytes — not a valid
    // curve point. The button must say so rather than appear to work.
    const t = start({ packaged: false });
    t.setCollecting(true);
    t.ingestDelta({ features: [[FEATURE, 1]], operations: [], failures: [] });

    const result = await t.sendNow();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/RECEIVER_PUBKEY|TELEMETRY_ABLY_KEY|must not publish/i);
    // Nothing was lost: the records are still queued for a later, configured run.
    expect(t.spool.readAll().length).toBeGreaterThan(0);
  });

  it('reports having nothing to send rather than claiming success', async () => {
    const t = start({ packaged: false });
    const result = await t.sendNow();
    expect(result.ok).toBe(false);
  });
});

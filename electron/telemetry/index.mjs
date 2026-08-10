/**
 * Main-process telemetry: composition, the IPC boundary, and the flush loop.
 *
 * Everything here is wrapped in a single failure latch. Any throw anywhere disables telemetry for
 * the rest of the session and writes one line to the existing diagnostics log — the same "one
 * warning, then stay quiet" discipline `electron/runLog.cjs` uses, for the same reason. Nothing in
 * the app ever awaits a telemetry call, so the only acceptable behaviour when this breaks is for it
 * to go silent.
 */

import { Features, Operations, ErrorCategories } from '@jobmonitor/telemetry-schema/registry';
import { DEPLOYMENT_ID_HEX } from '@jobmonitor/telemetry-schema';

import { createAggregate } from './aggregate.mjs';
import { createSession } from './session.mjs';
import { createSpool } from './spool.mjs';
import { hourBucket, now } from './clock.mjs';
import { HEARTBEAT_MS, MAX_CRASHES_PER_FINGERPRINT, MAX_CRASHES_PER_SESSION, SPOOL_FLUSH_MS } from './constants.mjs';
import { loadInstallationId, markSessionEnd, markSessionStart, takeUncleanExit } from './install.mjs';
import {
  fingerprint,
  sanitizeComponentStack,
  sanitizeExceptionType,
  sanitizeStack,
} from './sanitize.mjs';
import { createSender } from './sender.mjs';

/** @type {ReturnType<typeof createTelemetry> | null} */
let instance = null;

export function initTelemetry(options) {
  if (instance) return instance;
  try {
    instance = createTelemetry(options);
    return instance;
  } catch (err) {
    options.onLog?.('telemetry', 'WARN: disabled at init', {
      message: String(err?.message ?? err),
    });
    instance = null;
    return null;
  }
}

export function getTelemetry() {
  return instance;
}

export function shutdownTelemetry() {
  try {
    instance?.shutdown();
  } catch {
    // A quit must never be blocked by telemetry.
  }
  instance = null;
}

function createTelemetry({
  dir,
  appVersion,
  platform,
  arch,
  electronVersion,
  send = false,
  onLog = () => {},
  /**
   * Path context for the sanitizer, injected rather than read from `os` here so tests can exercise
   * Windows and macOS path shapes on a Linux runner.
   */
  sanitizeContext = {},
}) {
  let disabled = false;
  const warn = (message, detail) => onLog('telemetry', `WARN: ${message}`, detail);

  /**
   * Whether anything is being recorded at all.
   *
   * **Packaged builds: always true.** Collection is always on with no opt-out — that is the
   * product decision, and the transparency pane exists to make it defensible.
   *
   * **Development builds: off until switched on, and never remembered.** A dev run would otherwise
   * fill the local queue with counters from whatever was being poked at, and that noise then has
   * to be told apart from anything real. Not persisting it is the point rather than an omission:
   * every `npm run electron:dev` starts clean, so nothing accumulates across sessions and nobody
   * has to remember to turn it back off.
   */
  const devBuild = !send;
  let collecting = !devBuild;

  /** Trip the latch. Called from every catch in this module. */
  function fail(where, err) {
    if (disabled) return;
    disabled = true;
    warn('disabled', { where, message: String(err?.message ?? err) });
  }

  const spool = createSpool({ dir, onWarn: (m, d) => warn(m, d) });
  const aggregate = createAggregate();
  const session = createSession();
  const installationId = loadInstallationId(dir, warn);

  // Detect a previous session that died without running its shutdown path. This is the only way we
  // learn about crashes that killed the process too fast to write anything.
  const uncleanAt = takeUncleanExit(dir);
  if (uncleanAt !== null) {
    session.uncleanExitDetected(uncleanAt);
    spool.append('crash', 'unclean-exit', { occurredAtMs: uncleanAt, appVersion });
  }
  markSessionStart(dir);
  session.started();

  /** fingerprint → records emitted this session, for the crash-storm guard. */
  const crashCounts = new Map();
  let crashesThisSession = 0;

  let lastSpoolFlush = now();
  let ticker = null;

  // The sender exists even when `send` is false, so that a dev build still exercises the same code
  // path up to the point of publishing. It simply never becomes due.
  const sender = createSender({
    spool,
    context: {
      installationId,
      deploymentId: DEPLOYMENT_ID_HEX,
      appVersion,
      platform,
      arch,
      electronVersion,
    },
    onLog,
    enabled: send,
  });
  if (send) sender.verifyConfigured();

  /**
   * Move the in-memory aggregate into the durable queue.
   *
   * Snapshot-and-reset is one operation: taking a copy and clearing separately loses whatever was
   * recorded in between, and that window is exactly when the app is busiest.
   */
  function flushToSpool(reason) {
    if (disabled) return;
    try {
      session.tick();
      const counters = aggregate.snapshotAndReset();
      const usage = session.snapshotAndReset();

      // Drained, then dropped. Session totals — app starts, running time — are gathered by the
      // session tracker rather than by the aggregate, so gating only the recording calls left them
      // leaking into the queue with collection switched off. Draining rather than skipping matters
      // too: the state has to be cleared, or switching collection on would publish however long
      // the app had been sitting there beforehand.
      if (!collecting) {
        lastSpoolFlush = now();
        return;
      }

      if (counters.features.length === 0 && counters.operations.length === 0 && usage.length === 0) {
        lastSpoolFlush = now();
        return;
      }

      spool.append('usage', 'counters', { ...counters, usage });
      lastSpoolFlush = now();
      onLog('telemetry', 'flushed to queue', {
        reason,
        features: counters.features.length,
        operations: counters.operations.length,
        buckets: usage.length,
      });
    } catch (err) {
      fail('flushToSpool', err);
    }
  }

  /**
   * The single driver.
   *
   * A 60-second tick rather than a 15-minute timer, so a clock jump or a wake from sleep is noticed
   * within a minute instead of being absorbed into one enormous interval. `tick` is exported for
   * tests, and `start()` does nothing but wire an interval to it — which makes the whole
   * flush/retention machine synchronously testable with an injected clock.
   */
  function tick() {
    if (disabled) return;
    try {
      session.tick();

      const at = now();
      // Close the aggregate at an hour boundary as well as on the interval, so a usage bucket is
      // never split across a flush in a way that loses which hour it belonged to.
      const crossedHour = hourBucket(at) !== hourBucket(lastSpoolFlush);
      if (at - lastSpoolFlush >= SPOOL_FLUSH_MS || crossedHour) {
        flushToSpool(crossedHour ? 'hour-boundary' : 'interval');
      }

      // Fire-and-forget. Nothing in the app awaits a send, and a rejected promise here must not
      // become an unhandled rejection — which would be recorded as a crash by our own handler.
      void sender.tick().catch(() => {});
    } catch (err) {
      fail('tick', err);
    }
  }

  return {
    installationId,

    /**
     * Handle one renderer delta.
     *
     * **This is the security boundary of the strongly-typed API.** The renderer is sandboxed but
     * not trusted: an XSS in a dependency, or simply a mistake, could send anything down this
     * channel. Every id is checked against the registry and anything unrecognised is dropped. That
     * is what makes "there is no way to send a string" a structural property rather than a
     * convention — a compromised renderer still cannot introduce a new dimension.
     */
    ingestDelta(delta) {
      if (disabled || !collecting || !delta || typeof delta !== 'object') return;
      try {
        for (const entry of delta.features ?? []) {
          const [id, count] = entry ?? [];
          if (Features.has(id) && Number.isFinite(count) && count > 0) {
            aggregate.featureUsed(id, Math.min(count, 100_000));
          }
        }
        for (const entry of delta.operations ?? []) {
          const [id, samples] = entry ?? [];
          if (!Operations.has(id) || !Array.isArray(samples)) continue;
          // Cap the sample count so a runaway renderer cannot make one delta unbounded work.
          for (const ms of samples.slice(0, 10_000)) aggregate.operationCompleted(id, ms);
        }
        for (const entry of delta.failures ?? []) {
          const [id, category] = entry ?? [];
          if (Operations.has(id) && ErrorCategories.has(category)) {
            aggregate.operationFailed(id, category);
          }
        }
      } catch (err) {
        fail('ingestDelta', err);
      }
    },

    /**
     * Record a crash. Persists synchronously and never transmits.
     *
     * `sanitize` is injected by the caller (Phase 2 supplies the real one) so this module stays
     * testable without pulling in path handling, and so there is exactly one place a raw stack can
     * be converted — in the main process, at the moment of persistence.
     */
    recordCrash({
      exceptionType,
      fingerprint: fp,
      stack,
      source,
      occurredAtMs = now(),
      priority = 'crash',
    }) {
      if (disabled || !collecting) return false;
      try {
        // Storm guard. A crash loop on a timer would otherwise evict every other crash record —
        // the same reasoning behind `createVerdictLog` in src/lib/devLog.ts.
        if (crashesThisSession >= MAX_CRASHES_PER_SESSION) return false;
        const seen = crashCounts.get(fp) ?? 0;
        if (seen >= MAX_CRASHES_PER_FINGERPRINT) {
          // Still counted, so the occurrence total stays truthful even though the record is not
          // written. A crash loop should report "this happened 400 times", not 3.
          crashCounts.set(fp, seen + 1);
          return false;
        }
        crashCounts.set(fp, seen + 1);
        crashesThisSession++;

        // Flush counters first: what the app was doing immediately before the crash is often the
        // whole explanation, and it is about to be lost with the process.
        flushToSpool('pre-crash');

        return spool.append(priority, 'crash', {
          occurredAtMs,
          appVersion,
          source,
          exceptionType,
          fingerprint: fp,
          stack,
          count: 1,
        });
      } catch (err) {
        fail('recordCrash', err);
        return false;
      }
    },

    /**
     * Sanitize and record a crash reported by the renderer.
     *
     * The renderer sends the raw stack over in-process IPC — which never leaves the machine — and
     * everything identifying is stripped here, before anything touches disk. Doing it this way
     * round means there is one sanitizer rather than two, and the renderer has no code path that
     * could write an unsanitized trace anywhere even if it wanted to.
     *
     * `name` is passed through {@link sanitizeExceptionType} rather than trusted: `error.name` is
     * writable, so it is user-controllable in exactly the way the wire format's string fields must
     * not be.
     */
    recordRendererCrash({ name, stack, componentStack, source }) {
      if (disabled) return false;
      try {
        const exceptionType = sanitizeExceptionType(name);
        const { frames, text } = sanitizeStack(stack, sanitizeContext);
        const components = sanitizeComponentStack(componentStack, sanitizeContext);

        // The component stack is appended to the trace rather than given its own field. It is the
        // single most useful thing for locating a React error, and adding a sixth string field to
        // the wire format to carry it would mean widening the allowlist the descriptor test guards.
        const combined = components ? `${text}\nin ${components}` : text;

        return this.recordCrash({
          exceptionType,
          fingerprint: fingerprint(exceptionType, frames),
          stack: combined,
          source: Number.isInteger(source) ? source : 0,
          priority: 'crash',
        });
      } catch (err) {
        fail('recordRendererCrash', err);
        return false;
      }
    },

    /** A fatal error in the main process. Same sanitization path as a renderer crash. */
    recordMainCrash({ name, stack, source }) {
      return this.recordRendererCrash({ name, stack, componentStack: undefined, source });
    },

    /**
     * A process that died without producing a stack — a renderer killed by the OS, a GPU fault, a
     * frozen window.
     *
     * There is nothing to sanitize and nothing to parse, so the fingerprint is built from the
     * reason and exit code instead. Those are a closed vocabulary produced by Electron, not by
     * anything the user typed, which is why `detail` is safe to include verbatim.
     */
    recordProcessCrash({ exceptionType, detail, source, priority = 'crash' }) {
      if (disabled) return false;
      try {
        const type = sanitizeExceptionType(exceptionType);
        const frames = detail ? [String(detail).slice(0, 200)] : [];
        return this.recordCrash({
          exceptionType: type,
          fingerprint: fingerprint(type, frames),
          stack: frames.join('\n'),
          source: Number.isInteger(source) ? source : 0,
          priority,
        });
      } catch (err) {
        fail('recordProcessCrash', err);
        return false;
      }
    },

    /** Occurrences suppressed by the storm guard, so the count is still truthful. */
    crashOccurrences(fp) {
      return crashCounts.get(fp) ?? 0;
    },

    windowFocused: () => !disabled && session.foregroundStarted(),
    windowBlurred: () => !disabled && session.foregroundEnded(),

    featureUsed(id) {
      if (!disabled && collecting && Features.has(id)) aggregate.featureUsed(id);
    },

    /*
     * Operations, for the main process.
     *
     * The renderer reaches these through `ingestDelta`, which carries samples and failure
     * categories in bulk; the main process has no bridge to itself, so it calls straight in. Both
     * paths validate the id against the registry — a number that drifted out of the mirrored table
     * in main.cjs is dropped here rather than stored under whatever name happens to hold that id.
     */
    operationCompleted(id, elapsedMs) {
      if (!disabled && collecting && Operations.has(id)) aggregate.operationCompleted(id, elapsedMs);
    },

    operationFailed(id, errorCategory) {
      if (!disabled && collecting && Operations.has(id) && ErrorCategories.has(errorCategory)) {
        aggregate.operationFailed(id, errorCategory);
      }
    },

    /**
     * Turn collection on or off for this session. Development builds only.
     *
     * Deliberately not persisted and deliberately refused in a packaged build: the product has no
     * opt-out, and a switch that worked there would be one.
     */
    setCollecting(next) {
      if (!devBuild) return { ok: false, collecting, reason: 'packaged build: always collecting' };
      // Flush before flipping, not after: what was gathered while collection was on is real, and
      // a flush that ran after the flag changed would drop it on the floor.
      if (!next && collecting) flushToSpool('collection-off');
      collecting = Boolean(next);
      onLog('telemetry', `collection ${collecting ? 'enabled' : 'disabled'}`, { dev: true });
      return { ok: true, collecting };
    },

    /** Publish whatever is queued, now. Ignores the schedule and the dev send gate. */
    async sendNow() {
      if (disabled) return { ok: false, reason: 'telemetry disabled' };
      // Move anything still in memory into the queue first, or a manual send would publish
      // everything except what was just done — which is the part you are usually testing.
      flushToSpool('send-now');
      return sender.sendNow();
    },

    tick,
    flushToSpool,
    sender,

    start() {
      if (disabled || ticker) return;
      ticker = setInterval(tick, HEARTBEAT_MS);
      // Never hold the process open for telemetry. If everything else has finished, so has this.
      ticker.unref?.();
    },

    shutdown() {
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
      // Deliberately no final send: a network round trip on the quit path either blocks the quit
      // or is killed halfway. Whatever is queued goes out next launch.
      sender.stop();
      if (disabled) return;
      try {
        session.cleanShutdown();
        flushToSpool('shutdown');
        markSessionEnd(dir);
      } catch (err) {
        fail('shutdown', err);
      }
    },

    /**
     * Everything queued locally, for the Diagnostics pane.
     *
     * The point of this is disclosure, not debugging. Collection is always on with no opt-out, and
     * "you cannot turn it off" is only a defensible position if paired with "you can read every
     * byte before it leaves". So this returns the records verbatim rather than a summary — a
     * summary is something the user has to trust.
     */
    readSpool() {
      if (disabled) return { records: [], stats: null };
      try {
        return { records: spool.readAll(), stats: spool.stats() };
      } catch (err) {
        fail('readSpool', err);
        return { records: [], stats: null };
      }
    },

    /** For the Diagnostics pane and for tests. */
    stats() {
      return {
        installationId,
        appVersion,
        platform,
        arch,
        electronVersion,
        sendEnabled: send,
        devBuild,
        collecting,
        disabled,
        crashesThisSession,
        spool: spool.stats(),
      };
    },

    /** Exposed so the send path (Phase 5) and the Diagnostics pane can read the queue. */
    spool,
    isDisabled: () => disabled,
  };
}

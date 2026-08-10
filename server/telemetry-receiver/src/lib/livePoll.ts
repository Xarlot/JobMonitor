/**
 * Live polling while someone is watching, and nothing at all when they are not.
 *
 * The scheduled run happens three times a day, which is right for keeping the data complete and
 * useless for looking at something as it happens — publish a batch and you would wait up to eight
 * hours to see it. So: opening any page starts a loop that reads Ably every few seconds, and the
 * loop **terminates itself** once nobody has loaded a page for a while.
 *
 * Two properties this shape has that a plain interval does not:
 *
 *   - **It costs nothing when idle.** No timer, no Ably requests, no wake-ups. An App Service
 *     instance with the dashboard closed does exactly as much work as one with no poller at all.
 *   - **It cannot outlive its usefulness.** The stop condition is the absence of interest rather
 *     than a shutdown signal, so a forgotten browser tab is the *only* thing that keeps it alive,
 *     and closing that tab is enough to end it. Nothing has to remember to turn it off.
 *
 * The cron remains underneath as the completeness guarantee. This layer is about latency.
 */

import { loadConfig, type Config } from './config';
import { database } from './db';
import { log } from './log';
import { pullOnce } from '../receiver/puller';

interface LiveState {
  /** Set while the loop is alive. */
  running: boolean;
  /** Last time a page was rendered. The loop's reason to exist. */
  lastActivity: number;
  /** When the loop started, for the health page. */
  startedAt: number | null;
  /** Reads completed since it started. */
  polls: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __livePoll: LiveState | undefined;
}

function state(): LiveState {
  globalThis.__livePoll ??= { running: false, lastActivity: 0, startedAt: null, polls: 0 };
  return globalThis.__livePoll;
}

/**
 * Called from the layout on every page render.
 *
 * Records interest, and starts the loop if it is not already running. Cheap enough to call on every
 * request: two field writes and a boolean check in the common case.
 */
export function noteActivity(): void {
  const s = state();
  s.lastActivity = Date.now();
  if (!s.running) start();
}

function start(): void {
  const s = state();
  if (s.running) return;

  let config: Config;
  try {
    config = loadConfig();
  } catch {
    // Unconfigured — the banner already says so, and a poller with no credentials would do nothing
    // but log failures every few seconds.
    return;
  }

  s.running = true;
  s.startedAt = Date.now();
  s.polls = 0;
  log.info('live poll started', {
    intervalSeconds: config.livePollSeconds,
    idleTimeoutMinutes: config.liveIdleMinutes,
  });

  void loop(config).catch((err) => {
    log.warn('live poll loop ended unexpectedly', { message: String(err?.message ?? err) });
    s.running = false;
  });
}

async function loop(config: Config): Promise<void> {
  const s = state();
  const idleMs = config.liveIdleMinutes * 60_000;

  try {
    while (Date.now() - s.lastActivity < idleMs) {
      const result = await pullOnce({
        ablyKey: config.ablySubscribeKey,
        retentionHours: config.retentionHours,
        intervalHours: config.intervalHours,
        dedupRetentionDays: config.dedupRetentionDays,
        deps: {
          db: database(),
          secretKeys: config.receiverSecKeys.map((k) => Uint8Array.from(Buffer.from(k, 'hex'))),
          deploymentId: config.deploymentId,
          ratePerHour: config.ratePerHour,
          now: () => Date.now(),
        },
      });
      s.polls++;

      if (!result.ok) {
        // Back off rather than hammering a service that is refusing us. Still bounded by the idle
        // check above, so a persistent failure with nobody watching still ends the loop.
        await sleep(config.livePollSeconds * 4_000);
      } else {
        await sleep(config.livePollSeconds * 1_000);
      }
    }
  } finally {
    // Always runs, including on a throw — a loop that died without clearing this flag could never
    // be restarted, and the dashboard would silently stop updating until the process recycled.
    s.running = false;
    log.info('live poll stopped', {
      reason: 'idle',
      polls: s.polls,
      aliveSeconds: s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
    });
    s.startedAt = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open. If everything else has finished, so has this — which matters on
    // a host that may recycle an idle instance.
    timer.unref?.();
  });
}

/** For the health page: whether live polling is active, and for how long. */
export function livePollState(): Readonly<LiveState> {
  return state();
}

/**
 * Configuration, parsed once at startup and validated to death.
 *
 * Every problem here is a **fail-fast**: log one line and refuse to start. A receiver that starts
 * successfully and then silently does the wrong thing is far worse than one that crash-loops,
 * because the symptom of the former is a dashboard that looks entirely plausible.
 */

export interface Config {
  /** Ably key with subscribe + history capability on the telemetry channel. */
  ablySubscribeKey: string;
  /**
   * Receiver secret keys, newest first.
   *
   * A list rather than a single value so a key can be rotated without dropping in-flight batches:
   * clients carry the *public* half inside their binary, so during a rollout both old and new
   * builds are publishing, and both must decrypt.
   */
  receiverSecKeys: string[];
  /** Expected deployment id, hex. Batches carrying anything else are rejected. */
  deploymentId: string;

  dedupRetentionDays: number;

  /**
   * How long Ably retains a published message on this channel, hours.
   *
   * **Free tier is 24.** Standard is 72 or more. Getting this wrong in the optimistic direction is
   * the one mistake in this system that destroys data silently: messages that expire unread are
   * gone, and every chart simply shows less than happened with nothing reporting why.
   */
  retentionHours: number;

  /** How often the schedule runs, hours. Used for the startup safety check against retention. */
  intervalHours: number;

  /**
   * How often to read Ably while someone has the dashboard open, seconds.
   *
   * This is a latency knob, not a completeness one — the schedule guarantees the data arrives
   * eventually, and this decides how soon you see it while looking.
   */
  livePollSeconds: number;

  /**
   * How long after the last page render the live loop keeps going, minutes.
   *
   * The loop's only reason to exist is that somebody is watching, so this is how long "watching"
   * survives a closed tab. Short enough that a forgotten tab does not poll all night; long enough
   * that reading a page for a few minutes does not stop and restart it repeatedly.
   */
  liveIdleMinutes: number;

  /** Shared secret for POST /api/ingest, so the scheduled trigger is not open to the world. */
  ingestToken: string;

  /** Batches accepted per installation per hour. The real control on a model that cannot
   *  authenticate senders. */
  ratePerHour: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

export function loadConfig(): Config {
  const receiverSecKeys = required('TELEMETRY_RECEIVER_SECKEYS')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  for (const key of receiverSecKeys) {
    // Never echo the value — this is the one place a mistyped secret could reach a log.
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error('TELEMETRY_RECEIVER_SECKEYS entries must be 64 hex characters');
    }
  }

  const deploymentId = required('TELEMETRY_DEPLOYMENT_ID').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(deploymentId)) {
    throw new Error('TELEMETRY_DEPLOYMENT_ID must be 32 hex characters');
  }

  const config: Config = {
    ablySubscribeKey: required('TELEMETRY_ABLY_SUBSCRIBE_KEY'),
    receiverSecKeys,
    deploymentId,
    dedupRetentionDays: number('DEDUP_RETENTION_DAYS', 7),
    // Defaults to the free tier. Raise it only if the Ably plan actually says so — an optimistic
    // value here does not fail, it loses data.
    retentionHours: number('ABLY_RETENTION_HOURS', 24),
    intervalHours: number('INGEST_INTERVAL_HOURS', 8),
    livePollSeconds: number('LIVE_POLL_SECONDS', 20),
    liveIdleMinutes: number('LIVE_IDLE_MINUTES', 5),
    ingestToken: required('INGEST_TOKEN'),
    ratePerHour: number('SENDER_RATE_PER_HOUR', 10),
  };

  /**
   * The invariant that loses data if it is wrong.
   *
   * The schedule has to come round again well inside Ably's retention, or the messages published
   * in the gap expire unread. Nothing reports that — the charts just show less than happened.
   *
   * Three intervals inside the window is the minimum worth accepting, so two consecutive failures
   * (a bad deploy plus a transient error) are survivable. On the free tier's 24 hours that means an
   * interval of 8 hours exactly, with no slack beyond those two failures — which is why the
   * dashboard also triggers an ingest when it finds stale data.
   */
  if (config.intervalHours * 3 > config.retentionHours) {
    throw new Error(
      `INGEST_INTERVAL_HOURS (${config.intervalHours}) x3 exceeds ABLY_RETENTION_HOURS ` +
        `(${config.retentionHours}). Two consecutive failed runs would lose data permanently. ` +
        `Run at least every ${(config.retentionHours / 3).toFixed(1)}h.`,
    );
  }

  return config;
}

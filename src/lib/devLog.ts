/**
 * Diagnostics for the DevTools console (F12 in the desktop app).
 *
 * The app's failure modes are mostly invisible from the UI: a log that couldn't be
 * fetched, a request served from cache, a `gh` call that fell back, an auto-rerun that
 * decided not to fire. Each of those is a decision worth being able to read after the
 * fact, and "add a console.log and rebuild" is a bad answer when the interesting run
 * already happened.
 *
 * Off by default in a packaged build, because logging every poll would bury the console
 * and these lines name repositories and branches. On in dev, and switchable at runtime
 * from the console itself — see {@link installDevLogControls}.
 */

const FLAG_KEY = 'job-monitor.debug';

/** Scopes, so the console can be filtered to the thing being chased. */
export type LogScope =
  | 'api'
  | 'log-cache'
  | 'claude'
  | 'auto-rerun'
  | 'failures'
  | 'desktop';

const SCOPE_STYLE: Record<LogScope, string> = {
  api: 'color:#58a6ff',
  'log-cache': 'color:#a371f7',
  claude: 'color:#3fb950',
  'auto-rerun': 'color:#d29922',
  failures: 'color:#f85149',
  desktop: 'color:#8b949e',
};

function readFlag(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    // Storage can be unavailable (private mode, blocked); dev still logs.
    return false;
  }
}

let enabled = Boolean(import.meta.env?.DEV) || readFlag();

export function devLogEnabled(): boolean {
  return enabled;
}

export function setDevLogEnabled(on: boolean): void {
  enabled = on;
  try {
    if (on) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    /* not persistable; still applies for this session */
  }
}

/**
 * The desktop shell's on-disk log, when there is one.
 *
 * Written to **regardless of the console flag**: the console is for whoever is watching
 * now, the file is for whoever reads it afterwards, and the run worth reading is always one
 * that already happened. Fire-and-forget, so it cannot delay what it describes.
 */
function persist(scope: LogScope, message: string, detail?: unknown): void {
  const logs = (globalThis as { desktop?: { logs?: { write?: (s: string, m: string, d?: unknown) => void } } })
    .desktop?.logs;
  try {
    logs?.write?.(scope, message, detail);
  } catch {
    /* diagnostics must never break the app */
  }
}

/**
 * One diagnostic line: to the file always, to the console when enabled.
 *
 * `detail` is passed to the console as a real object rather than stringified, so DevTools
 * renders it inspectable. Callers should assume the console half may be a no-op and must
 * not do work only for its sake — pass values you already have, not values you computed to
 * log.
 */
export function devLog(scope: LogScope, message: string, detail?: unknown): void {
  persist(scope, message, detail);
  if (!enabled) return;
  const prefix = `%c[${scope}]%c ${message}`;
  if (detail === undefined) console.log(prefix, SCOPE_STYLE[scope], '');
  else console.log(prefix, SCOPE_STYLE[scope], '', detail);
}

/** As {@link devLog}, but survives the flag being off — for genuine problems. */
export function devWarn(scope: LogScope, message: string, detail?: unknown): void {
  persist(scope, `WARN: ${message}`, detail);
  const prefix = `%c[${scope}]%c ${message}`;
  if (detail === undefined) console.warn(prefix, SCOPE_STYLE[scope], '');
  else console.warn(prefix, SCOPE_STYLE[scope], '', detail);
}

/**
 * A {@link devLog} that speaks only when the verdict for a key *changes*.
 *
 * For anything on a poll, the same conclusion is re-derived every few seconds — an
 * auto-rerun that decides not to fire will decide it again all day. Writing each pass
 * would fill the size-capped log file with one repeated sentence and evict everything
 * worth keeping, so a caller on a timer needs a gate rather than restraint. The
 * transition is also the more informative line: the moment a verdict was first reached
 * is what explains the silence that follows it.
 *
 * `key` identifies the subject (a run, a PR, the engine); `verdict` is what is true of
 * it now. A repeat is dropped; a change is logged.
 *
 * Returns whether it wrote, so a caller that wants to do something *else* once per change
 * — raise a notification, add a row to a UI list — can hang it off the same gate instead of
 * keeping a second copy of the same bookkeeping.
 *
 * @param maxKeys Bound on remembered subjects. Once past it the memory is cleared
 *   wholesale, which costs one repeated line per still-current verdict — cheaper than
 *   growing forever, and self-correcting.
 */
export function createVerdictLog(
  scope: LogScope,
  maxKeys = 500,
): (key: string, verdict: string, message: string, detail?: unknown) => boolean {
  const seen = new Map<string, string>();
  return (key, verdict, message, detail) => {
    if (seen.get(key) === verdict) return false;
    if (seen.size >= maxKeys) seen.clear();
    seen.set(key, verdict);
    devLog(scope, message, detail);
    return true;
  };
}

/**
 * Expose the switch on `window` and say it exists.
 *
 * Without the hint, a diagnostic channel that defaults to off is one nobody finds when
 * they need it — which is the moment it has to be discoverable.
 */
export function installDevLogControls(): void {
  const api = {
    enable: () => {
      setDevLogEnabled(true);
      console.log('[job-monitor] debug logging on');
    },
    disable: () => {
      setDevLogEnabled(false);
      console.log('[job-monitor] debug logging off');
    },
    get enabled() {
      return enabled;
    },
  };
  (window as unknown as { jobMonitorDebug: typeof api }).jobMonitorDebug = api;

  console.log(
    `%c[job-monitor]%c debug logging is ${enabled ? 'on' : 'off'} — toggle with jobMonitorDebug.enable() / .disable()`,
    'color:#58a6ff;font-weight:bold',
    '',
  );
}

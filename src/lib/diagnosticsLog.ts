/**
 * Reading the app's own NDJSON diagnostics log.
 *
 * The writer is `electron/runLog.cjs`; this is the other half, kept pure so the viewer's
 * behaviour — what parses, what a bad line does, how a filter narrows — is testable
 * without Electron or a file.
 *
 * The guiding constraint is that this file is read when something has already gone wrong,
 * so it must never be the second thing that goes wrong: a truncated tail, a half-written
 * final line or a record from a future version all have to degrade to "show what you can"
 * rather than to an empty screen.
 */

/** One parsed record. `raw` is kept so a line can be copied out verbatim. */
export interface LogRecord {
  /** Monotonic index in the tail, oldest first — stable React key, unlike `at`. */
  seq: number;
  /** ISO timestamp as written, or null when the line had none. */
  at: string | null;
  scope: string;
  message: string;
  detail?: unknown;
  raw: string;
  /** True when the line wasn't valid JSON and only `raw` is meaningful. */
  malformed: boolean;
}

/**
 * Parse a tail of NDJSON, oldest first.
 *
 * Unparseable lines are kept rather than dropped: a line that won't parse is usually a
 * crash mid-write or a truncation, and knowing one is there beats a silent gap. Blank
 * lines are dropped, since a trailing newline is normal and not worth a row.
 */
export function parseDiagnosticsLog(text: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const seq = out.length;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      out.push({
        seq,
        at: typeof parsed.at === 'string' ? parsed.at : null,
        scope: typeof parsed.scope === 'string' ? parsed.scope : 'unknown',
        message,
        detail: parsed.detail,
        raw,
        // Valid JSON that isn't one of our records (a bare array, a number) has no
        // message to show, so it is worth flagging as odd rather than rendering blank.
        malformed: message === '',
      });
    } catch {
      out.push({ seq, at: null, scope: 'unknown', message: raw, detail: undefined, raw, malformed: true });
    }
  }
  return out;
}

/**
 * Scopes present, in a stable order for a filter menu.
 *
 * Derived from the data rather than from the `LogScope` union, because the file also
 * holds main-process scopes (`app`, `claude`, `gh`) and the `renderer:` prefix the IPC
 * hop adds — a hard-coded list would quietly omit whichever scope was new.
 */
export function logScopes(records: readonly LogRecord[]): string[] {
  return [...new Set(records.map((r) => r.scope))].sort();
}

/** A warning, in the `devWarn` sense — those lines are prefixed at the source. */
export function isWarning(record: LogRecord): boolean {
  return record.message.startsWith('WARN:');
}

export interface LogFilter {
  /** Exact scope match; empty means every scope. */
  scope?: string;
  /** Case-insensitive substring of the message, the scope or the serialised detail. */
  query?: string;
  /** Keep only `devWarn` lines. */
  warningsOnly?: boolean;
}

/**
 * Narrow the records, newest first.
 *
 * Newest first because this is a diagnostics feed rather than a transcript: the reason
 * anyone opens it is the thing that just happened. The search covers `detail` as well as
 * the message, since the identifier being chased — a run id, a PR number, a fingerprint —
 * is usually in there and not in the sentence.
 */
export function filterRecords(
  records: readonly LogRecord[],
  filter: LogFilter = {},
): LogRecord[] {
  const { scope, query, warningsOnly } = filter;
  const needle = query?.trim().toLowerCase();

  const matches = records.filter((record) => {
    if (scope && record.scope !== scope) return false;
    if (warningsOnly && !isWarning(record)) return false;
    if (!needle) return true;
    // `raw` already contains the message, the scope and the detail as text, so one
    // search over it beats reserialising the detail per keystroke.
    return record.raw.toLowerCase().includes(needle);
  });

  return matches.reverse();
}

/** Compact `HH:MM:SS` for the row gutter; the full stamp stays in the copied line. */
export function formatLogTime(at: string | null): string {
  if (!at) return '--:--:--';
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return '--:--:--';
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

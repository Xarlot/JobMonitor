import { describe, expect, it } from 'vitest';
import {
  filterRecords,
  formatLogTime,
  isWarning,
  logScopes,
  parseDiagnosticsLog,
} from '../lib/diagnosticsLog';

const LINES = [
  '{"at":"2026-08-03T12:42:41.230Z","scope":"renderer:auto-rerun","message":"armed","detail":{"canWrite":true}}',
  '{"at":"2026-08-03T12:42:42.298Z","scope":"renderer:auto-rerun","message":"#41763 check-pull-request.yml attempt 3 failure not re-run — the run is older than the configured window","detail":{"runId":30619940666,"ageHours":75.3}}',
  '{"at":"2026-08-03T12:42:43.000Z","scope":"claude","message":"WARN: gh could not produce the run log"}',
  '{"at":"2026-08-03T12:42:44.000Z","scope":"app","message":"started"}',
].join('\n');

describe('parseDiagnosticsLog', () => {
  it('parses one record per line, oldest first', () => {
    const records = parseDiagnosticsLog(LINES);
    expect(records).toHaveLength(4);
    expect(records[0].message).toBe('armed');
    expect(records[0].scope).toBe('renderer:auto-rerun');
    expect(records[3].message).toBe('started');
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
  });

  it('keeps the detail as a live object for inspection', () => {
    const [first] = parseDiagnosticsLog(LINES);
    expect(first.detail).toEqual({ canWrite: true });
  });

  it('ignores blank lines, including the trailing newline', () => {
    expect(parseDiagnosticsLog('\n\n')).toHaveLength(0);
    expect(parseDiagnosticsLog(`${LINES}\n`)).toHaveLength(4);
  });

  /**
   * A line that won't parse is usually a crash mid-write or a cut tail. Showing it
   * beats a silent gap where the interesting record should have been.
   */
  it('keeps an unparseable line instead of dropping it', () => {
    const records = parseDiagnosticsLog('{"at":"x","scope":"app"\n{"scope":"app","message":"ok"}');
    expect(records).toHaveLength(2);
    expect(records[0].malformed).toBe(true);
    expect(records[0].raw).toContain('"at":"x"');
    expect(records[1].malformed).toBe(false);
  });

  it('survives a record with no scope or timestamp', () => {
    const [record] = parseDiagnosticsLog('{"message":"bare"}');
    expect(record.scope).toBe('unknown');
    expect(record.at).toBeNull();
    expect(record.malformed).toBe(false);
  });

  it('flags valid JSON that is not one of our records', () => {
    const [record] = parseDiagnosticsLog('[1,2,3]');
    expect(record.malformed).toBe(true);
  });
});

describe('logScopes', () => {
  it('lists the scopes actually present, sorted and deduplicated', () => {
    expect(logScopes(parseDiagnosticsLog(LINES))).toEqual([
      'app',
      'claude',
      'renderer:auto-rerun',
    ]);
  });
});

describe('filterRecords', () => {
  const records = parseDiagnosticsLog(LINES);

  /** A diagnostics feed, not a transcript: the reason to open it just happened. */
  it('returns newest first', () => {
    const shown = filterRecords(records);
    expect(shown[0].message).toBe('started');
    expect(shown[shown.length - 1].message).toBe('armed');
  });

  it('narrows to one scope', () => {
    const shown = filterRecords(records, { scope: 'renderer:auto-rerun' });
    expect(shown).toHaveLength(2);
    expect(shown.every((r) => r.scope === 'renderer:auto-rerun')).toBe(true);
  });

  it('searches the message case-insensitively', () => {
    expect(filterRecords(records, { query: 'ARMED' })).toHaveLength(1);
  });

  /** The id being chased is usually in the detail, not in the sentence. */
  it('searches the detail too', () => {
    const shown = filterRecords(records, { query: '30619940666' });
    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain('older than the configured window');
  });

  it('combines a scope with a search', () => {
    expect(filterRecords(records, { scope: 'app', query: 'armed' })).toHaveLength(0);
    expect(filterRecords(records, { scope: 'app', query: 'started' })).toHaveLength(1);
  });

  it('keeps only devWarn lines when asked', () => {
    const shown = filterRecords(records, { warningsOnly: true });
    expect(shown).toHaveLength(1);
    expect(shown[0].scope).toBe('claude');
  });

  it('treats a blank query as no filter', () => {
    expect(filterRecords(records, { query: '   ' })).toHaveLength(4);
  });
});

describe('isWarning', () => {
  it('recognises the WARN prefix devWarn writes', () => {
    const [, , warn, plain] = parseDiagnosticsLog(LINES);
    expect(isWarning(warn)).toBe(true);
    expect(isWarning(plain)).toBe(false);
  });
});

describe('formatLogTime', () => {
  it('renders a placeholder rather than "Invalid Date"', () => {
    expect(formatLogTime(null)).toBe('--:--:--');
    expect(formatLogTime('not a date')).toBe('--:--:--');
  });

  it('formats a real stamp as a 24-hour clock', () => {
    expect(formatLogTime('2026-08-03T12:42:41.230Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

/**
 * Structured logging to stdout, with one hard rule.
 *
 * **Never log a value.** Log the batch id, the rule that rejected it, and the field name — never
 * the field's contents. A privacy validator that writes the PII it rejected into a log file has
 * moved the problem rather than solved it, and it has moved it somewhere with weaker retention
 * controls than the database it was protecting.
 *
 * This is not a style preference. The whole reason `stack_trace` is scanned for tokens and paths is
 * that they occasionally end up there; the rejection path is by definition the path where that has
 * just happened.
 */

type Level = 'info' | 'warn' | 'error';

/** Fields that may never appear in a log line, whatever a caller passes. */
const FORBIDDEN = new Set(['stack', 'stackTrace', 'stack_trace', 'payload', 'data', 'content', 'value']);

function emit(level: Level, message: string, detail?: Record<string, unknown>) {
  const record: Record<string, unknown> = {
    at: new Date().toISOString(),
    level,
    message,
  };

  if (detail) {
    for (const [key, value] of Object.entries(detail)) {
      if (FORBIDDEN.has(key)) {
        // Defence against a future caller who reaches for the obvious thing while debugging.
        record[key] = '<redacted>';
        continue;
      }
      record[key] = typeof value === 'bigint' ? Number(value) : value;
    }
  }

  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  info: (message: string, detail?: Record<string, unknown>) => emit('info', message, detail),
  warn: (message: string, detail?: Record<string, unknown>) => emit('warn', message, detail),
  error: (message: string, detail?: Record<string, unknown>) => emit('error', message, detail),
};

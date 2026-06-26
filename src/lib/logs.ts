/**
 * Splits a GitHub Actions job log (one timestamped line per row) into per-step
 * chunks. Each line looks like:  `2026-06-26T16:52:19.3567497Z <text>`.
 * Steps are sequential and non-overlapping, so a line belongs to the latest step
 * whose `started_at` is <= the line's timestamp.
 */

import type { JobStep } from '../api/types';

const TS_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/;
// Strip ANSI color/SGR escape sequences (ESC [ ... m).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;

export interface LogLine {
  ts: number; // epoch ms, NaN if the line had no timestamp
  text: string;
}

export function parseLogLines(log: string): LogLine[] {
  return log.split(/\r?\n/).map((line) => {
    const m = TS_RE.exec(line);
    if (m) return { ts: Date.parse(m[1]), text: m[2].replace(ANSI_RE, '') };
    return { ts: NaN, text: line.replace(ANSI_RE, '') };
  });
}

/**
 * Returns a map of step.number -> log text for that step. Lines before the first
 * step (runner setup) attach to the earliest step; untimestamped lines continue
 * the current step.
 */
export function splitLogBySteps(log: string, steps: JobStep[]): Record<number, string> {
  const ordered = steps
    .filter((s) => s.started_at)
    .map((s) => ({ number: s.number, start: Date.parse(s.started_at as string) }))
    .sort((a, b) => a.start - b.start);

  if (ordered.length === 0) return {};

  const out: Record<number, string[]> = {};
  for (const s of ordered) out[s.number] = [];

  let current = ordered[0].number;
  for (const { ts, text } of parseLogLines(log)) {
    if (!Number.isNaN(ts)) {
      let pick = ordered[0].number;
      for (const s of ordered) {
        if (s.start <= ts) pick = s.number;
        else break;
      }
      current = pick;
    }
    out[current]?.push(text);
  }

  const result: Record<number, string> = {};
  for (const key of Object.keys(out)) {
    result[Number(key)] = out[Number(key)].join('\n').replace(/\n+$/, '');
  }
  return result;
}

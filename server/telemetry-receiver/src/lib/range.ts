/**
 * The selected time range, parsed from the URL.
 *
 * **The URL is the state.** Not a cookie, not local storage, not a React context: a range in the
 * query string can be linked to, bookmarked and pasted into a bug report, and every server
 * component can read it without any of them talking to each other. "Look at this crash spike" is a
 * link rather than a set of instructions.
 *
 * Everything here treats the input as hostile, because it is — it comes out of a URL anyone can
 * type into. A malformed range must fall back to the default rather than reach SQL or produce a
 * chart with no axis.
 */

const DAY = 86_400_000;

export interface Range {
  from: number;
  to: number;
  /** The preset this matches, or `custom`. Drives which button looks pressed. */
  preset: string;
  /** What to show above the charts. */
  label: string;
}

export interface RangePresetDef {
  id: string;
  days: number;
  label: string;
}

/**
 * Ranges worth one click.
 *
 * 24h and 7d answer "is it happening now"; 30d and 90d answer "is it getting worse". Anything else
 * is a custom range, and the presets exist so that the common questions do not require typing two
 * dates.
 */
export const PRESETS: RangePresetDef[] = [
  { id: '24h', days: 1, label: 'Last 24 hours' },
  { id: '7d', days: 7, label: 'Last 7 days' },
  { id: '30d', days: 30, label: 'Last 30 days' },
  { id: '90d', days: 90, label: 'Last 90 days' },
];

export const DEFAULT_PRESET = '30d';

/** A year, matching the retention. Asking for more is not wrong, there is simply nothing there. */
const MAX_SPAN_MS = 366 * DAY;

export type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** `YYYY-MM-DD` at UTC midnight, or null. */
function parseDay(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** The last instant of a day, so a window includes the whole of the day it names. */
const endOfDay = (ms: number) => ms + DAY - 1;

/** `YYYY-MM-DD` in UTC, for date inputs. */
export function toDayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Formatted in **UTC**, because that is the timezone the data is bucketed in.
 *
 * Rendering a UTC instant in local time misattributes it by the offset. `to` is the last
 * millisecond of the chosen day, so east of Greenwich it formats as the *next* day — picking
 * "01 Aug – 09 Aug" and being told "01 Aug — 10 Aug" reads as an off-by-one in the filter. West of
 * Greenwich the same bug moves every day-bucket label back one day instead.
 */
const formatDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * Resolve the range for a request.
 *
 * @param params The page's search params.
 * @param now Injected so the presets are testable without freezing the clock globally.
 */
export function resolveRange(params: SearchParams, now: number = Date.now()): Range {
  const from = parseDay(one(params, 'from'));
  const to = parseDay(one(params, 'to'));

  if (from !== null && to !== null) {
    // Swapped rather than rejected. Two date inputs make this easy to do by accident, and the
    // intent is never ambiguous — nobody means "an empty range".
    //
    // Both are parsed as midnight and the day is extended *after* ordering, deliberately. Marking
    // the `to` parameter as end-of-day while parsing puts the extension on whichever box the later
    // date was typed into: reversed input then yields a window running from 23:59:59.999 on the
    // first day to midnight on the last, quietly dropping a day off each end of a window the user
    // can see is right.
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const clamped = Math.min(endOfDay(hi), lo + MAX_SPAN_MS);
    return {
      from: lo,
      to: clamped,
      preset: 'custom',
      label: `${formatDay(lo)} — ${formatDay(clamped)}`,
    };
  }

  const requested = one(params, 'range');
  const preset = PRESETS.find((p) => p.id === requested) ?? PRESETS.find((p) => p.id === DEFAULT_PRESET)!;
  return {
    from: now - preset.days * DAY,
    to: now,
    preset: preset.id,
    label: preset.label,
  };
}

/**
 * Bucket width for a range, in ms.
 *
 * A 24-hour range grouped by day is two points, which is not a chart. The queries group by whatever
 * this returns so a short range stays readable without a second set of queries.
 */
export function bucketMs(range: { from: number; to: number }): number {
  return range.to - range.from <= 2 * DAY ? 3_600_000 : DAY;
}

/**
 * The unit the range is bucketed by, for chart captions.
 *
 * A caption reading "per day" above an hourly series is a small lie that changes how the numbers
 * are read — a peak of 2 means something different per hour than per day. The caption has to follow
 * the same switch the buckets do.
 */
export function bucketName(range: { from: number; to: number }): string {
  return bucketMs(range) === DAY ? 'day' : 'hour';
}

/** Build a query string for a preset, for links. */
export function presetHref(id: string): string {
  return id === DEFAULT_PRESET ? '?' : `?range=${id}`;
}

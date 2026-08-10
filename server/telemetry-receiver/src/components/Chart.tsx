/**
 * Server-rendered SVG charts.
 *
 * No charting library and no client JavaScript. In React Server Components an SVG is just markup,
 * so the page arrives complete — nothing to hydrate, nothing to load, and no chart library to keep
 * in step with a framework major. For five fixed dashboards of aggregate data that is the whole
 * requirement; interactivity would buy hover tooltips and cost a client bundle.
 *
 * The charts are deliberately plain. Every one of them is read at a glance to answer "is this
 * going up or down", and decoration gets in the way of that.
 */

interface Point {
  x: number;
  y: number;
}

const PALETTE = {
  ink: '#1f2328',
  muted: '#59636e',
  grid: '#d1d9e0',
  accent: '#0969da',
  danger: '#cf222e',
  ok: '#1a7f37',
};

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/**
 * The axis label, in whatever unit the series is actually bucketed by.
 *
 * A 24-hour range is bucketed hourly, and labelling both ends "09 Aug" tells the reader nothing
 * about a chart whose whole content is one day. So the unit has to come from the data.
 *
 * It is read off **bucket alignment**, not off the span. Span is the tempting signal and it gets
 * this wrong in both directions: a day-bucketed series that happens to hold two days inside a
 * 30-day range would be labelled in hours, printing "04:00" twice — day buckets sit on UTC
 * midnight, which is 04:00 here — while an hourly series covering a full day would be labelled by
 * date. Every point in a day-bucketed series is a UTC midnight by construction, so the alignment
 * *is* the bucket rather than a guess at it.
 *
 * Hourly labels carry the date too. Both ends of a 24-hour range read "15:00" otherwise, and the
 * axis stops distinguishing the two ends of the chart at all.
 *
 * Everything is UTC, matching the buckets. A day bucket is a UTC midnight, and formatting it in
 * local time labels it with the wrong day for anyone west of Greenwich.
 */
const DAY_MS = 86_400_000;

const axisLabel = (ms: number, dayAligned: boolean) =>
  dayAligned
    ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
    : new Date(ms).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      });

export function LineChart({
  points,
  height = 180,
  width = 720,
  colour = PALETTE.accent,
  label,
  format = (n: number) => String(n),
}: {
  points: Point[];
  height?: number;
  width?: number;
  colour?: string;
  label?: string;
  format?: (n: number) => string;
}) {
  if (points.length === 0) return <Empty label={label} />;

  const pad = { top: 12, right: 12, bottom: 24, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.y)));

  /**
   * Positioned by **time**, not by array index.
   *
   * Index positioning is the obvious way and it silently lies: a series with missing days — a
   * crash count that only has rows on days something crashed — gets drawn as if those days did
   * not exist, so five scattered crashes render as a flat line implying one every day. The reader
   * has no way to tell. Spacing by timestamp makes a gap look like a gap.
   */
  const first = points[0].x;
  const last = points[points.length - 1].x;
  // A single point, or several sharing a timestamp, has no span; treat it as one so the divisor is
  // never zero and the point lands at the left edge.
  const span = Math.max(1, last - first);
  // Every point, not just the ends — one stray unaligned value means the series is not day-bucketed.
  const dayAligned = points.every((p) => p.x % DAY_MS === 0);

  const at = (p: Point) => ({
    x: pad.left + ((p.x - first) / span) * plotW,
    y: pad.top + plotH - (p.y / max) * plotH,
  });

  const path = points.map((p, i) => {
    const { x, y } = at(p);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <figure className="chart">
      {label && <figcaption>{label}</figcaption>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? 'chart'}>
        {[0, 0.5, 1].map((f) => {
          const y = pad.top + plotH - f * plotH;
          return (
            <g key={f}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke={PALETTE.grid} strokeWidth="1" />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill={PALETTE.muted}>
                {format(max * f)}
              </text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke={colour} strokeWidth="2" strokeLinejoin="round" />
        {points.length <= 40 &&
          points.map((p) => {
            const { x, y } = at(p);
            return <circle key={p.x} cx={x} cy={y} r="2.5" fill={colour} />;
          })}
        <text x={pad.left} y={height - 6} fontSize="11" fill={PALETTE.muted}>
          {axisLabel(points[0].x, dayAligned)}
        </text>
        <text x={width - pad.right} y={height - 6} fontSize="11" fill={PALETTE.muted} textAnchor="end">
          {axisLabel(points[points.length - 1].x, dayAligned)}
        </text>
      </svg>
    </figure>
  );
}

export function BarChart({
  bars,
  width = 720,
  label,
  colour = PALETTE.accent,
}: {
  bars: { name: string; value: number }[];
  width?: number;
  label?: string;
  colour?: string;
}) {
  if (bars.length === 0) return <Empty label={label} />;

  const rowH = 22;
  const gap = 6;
  const labelW = 220;
  // Height follows the content. A fixed minimum left a single-bar chart — one version in use, one
  // feature — sitting at the top of a mostly empty box, which reads as missing data rather than as
  // a short list.
  const total = bars.length * (rowH + gap);
  const max = niceMax(Math.max(...bars.map((b) => b.value)));

  return (
    <figure className="chart">
      {label && <figcaption>{label}</figcaption>}
      <svg viewBox={`0 0 ${width} ${total}`} role="img" aria-label={label ?? 'chart'}>
        {bars.map((b, i) => {
          const y = i * (rowH + gap);
          const w = (b.value / max) * (width - labelW - 60);
          return (
            <g key={b.name}>
              <text x={0} y={y + rowH * 0.7} fontSize="12" fill={PALETTE.ink}>
                {b.name}
              </text>
              <rect x={labelW} y={y} width={Math.max(w, b.value > 0 ? 2 : 0)} height={rowH} fill={colour} rx="2" />
              <text x={labelW + Math.max(w, 2) + 8} y={y + rowH * 0.7} fontSize="12" fill={PALETTE.muted}>
                {b.value.toLocaleString('en-GB')}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function Empty({ label }: { label?: string }) {
  return (
    <figure className="chart empty">
      {label && <figcaption>{label}</figcaption>}
      {/* Explicit rather than an empty box: "no data yet" and "the pipe is broken" look identical
          on a blank chart, and only one of them is fine. */}
      <p>No data in this period.</p>
    </figure>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'ok' | 'danger';
}) {
  const colour = tone === 'danger' ? PALETTE.danger : tone === 'ok' ? PALETTE.ok : PALETTE.ink;
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value" style={{ color: colour }}>
        {typeof value === 'number' ? value.toLocaleString('en-GB') : value}
      </strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

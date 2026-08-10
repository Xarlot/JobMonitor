import type { ReactNode } from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
// Primer 38 ships CSS modules; this is the whole style setup, with no server-side extraction step.
/*
 * Two imports, not one, and the split is not obvious: `primitives.css` defines the sizes, radii and
 * typography, while colours live only in the per-theme files. With the themes alone every
 * `--base-size-*` resolves to nothing, so a stylesheet written against them renders in the right
 * colours with no spacing at all — which looks like a layout bug rather than a missing import.
 */
import '@primer/primitives/dist/css/primitives.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import { Providers } from '@/components/Providers';
import { RangeControl } from '@/components/RangeControl';
import { noteActivity } from '@/lib/livePoll';
import { ingestHealth } from '@/lib/queries';

export const metadata = {
  title: 'Job Monitor telemetry',
  description: 'Anonymous usage and reliability telemetry',
};

/**
 * Every page is a server component reading SQLite directly, so nothing here is cached: a dashboard
 * showing yesterday's numbers while claiming to show today's is worse than one that is slow.
 */
export const dynamic = 'force-dynamic';

const NAV = [
  ['/', 'Overview'],
  ['/features', 'Features'],
  ['/reliability', 'Reliability'],
  ['/map', 'Feature map'],
  ['/health', 'Pipeline health'],
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  // Every render is a signal that somebody is watching. This starts the live poll if it is not
  // already going, and keeps it alive; it stops on its own once the renders stop. Nothing is
  // awaited — the pages serve stored data, and blocking on Ably would make every visit slow to
  // show numbers that are already here.
  noteActivity();
  const health = ingestHealth();
  return (
    <html lang="en">
      <body>
        <style>{CSS}</style>
        <header>
          <h1>Job Monitor telemetry</h1>
          <nav>
            {NAV.map(([href, label]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </nav>
        </header>
        {health.stale && (
          /* On every page, not only on /health. A chart reading zero because ingest stopped looks
             exactly like a chart reading zero because nobody used the app, and only one of those
             is fine to scroll past. */
          <div className="banner">
            <strong>Telemetry may be incomplete.</strong> {health.reason} Ably keeps published
            messages for {health.retentionHours}h, so a gap longer than that is lost permanently.
          </div>
        )}
        <Providers>
          {/*
            The control lives here rather than in each page because a layout is the one place it
            can be written once — and it resolves the range from the URL itself, because layouts in
            the App Router are not given `searchParams`. That is safe: preset labels are constants,
            and a custom label is derived from the same two dates the server reads, so there is
            nothing for the two to disagree about.

            Suspense because `useSearchParams` opts its subtree into client rendering; without a
            boundary that would opt out the whole page rather than this strip.
          */}
          <Suspense fallback={<div className="rangebar" style={{ height: 53 }} />}>
            <div className="rangebar">
              <RangeControl />
            </div>
          </Suspense>
          <main>{children}</main>
        </Providers>
        <footer>
          {/* Stated on every page rather than once in a doc nobody opens. Both halves matter: the
              first stops someone treating an install count as a headcount, the second stops them
              treating a chart as complete. */}
          An <em>active installation</em> is a distinct installation id, not a person. Counts are
          lower bounds — delivery is best-effort and a client can be offline for up to seven days.
        </footer>
      </body>
    </html>
  );
}

const CSS = `
  :root { color-scheme: light dark; --ink:#1f2328; --muted:#59636e; --line:#d1d9e0; --bg:#fff; --panel:#f6f8fa; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e6edf3; --muted:#9198a1; --line:#3d444d; --bg:#0d1117; --panel:#151b23; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  header { border-bottom:1px solid var(--line); padding:16px 24px; display:flex; gap:24px; align-items:baseline; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  nav { display:flex; gap:16px; }
  nav a { color:var(--muted); text-decoration:none; }
  nav a:hover { color:var(--ink); text-decoration:underline; }
  main { padding:0 24px 24px; max-width:1100px; }
  .rangebar { padding:0 24px; max-width:1100px; }
  .range { display:flex; align-items:center; gap:16px; flex-wrap:wrap;
           padding:12px 0; border-bottom:1px solid var(--line); margin-bottom:20px; }
  .range-custom { display:flex; align-items:center; gap:8px; }
  .range-dash { color:var(--muted); }
  .range-status { display:flex; align-items:center; gap:8px; margin-left:auto;
                  color:var(--muted); font-size:13px; }
  .range-status strong { color:var(--ink); }
  .range-tz { font-size:11px; letter-spacing:.04em; padding:1px 4px; border-radius:3px;
              border:1px solid var(--line); color:var(--muted); }
  footer { padding:16px 24px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; max-width:1100px; }
  h2 { font-size:15px; margin:32px 0 12px; font-weight:600; }
  h2:first-child { margin-top:0; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
  .stat { border:1px solid var(--line); border-radius:6px; padding:12px 16px; min-width:130px; background:var(--panel); }
  .stat-label { display:block; color:var(--muted); font-size:12px; }
  .stat-value { display:block; font-size:22px; font-weight:600; margin-top:2px; }
  .stat-hint { display:block; color:var(--muted); font-size:11px; margin-top:2px; }
  .chart { margin:0 0 24px; }
  .chart figcaption { color:var(--muted); font-size:12px; margin-bottom:6px; }
  .chart svg { width:100%; height:auto; overflow:visible; }
  .chart svg text { fill:var(--muted); }
  .chart.empty p { color:var(--muted); border:1px dashed var(--line); border-radius:6px; padding:24px; text-align:center; margin:0; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:12px; overflow-x:auto; }
  a { color:#0969da; }
  .note { color:var(--muted); font-size:12px; margin:-4px 0 16px; }
  .keylist { display:flex; flex-wrap:wrap; gap:6px 12px; margin-bottom:16px; }
  /* Belt and braces: a single very long key should wrap inside itself rather than widen the page. */
  .keylist code { overflow-wrap:anywhere; }
  .banner { background:#fff1e5; border-bottom:1px solid #d4a72c; color:#7d4e00; padding:10px 24px; font-size:13px; }
  @media (prefers-color-scheme: dark) { .banner { background:#341a00; color:#e3b341; border-color:#845306; } }
`;

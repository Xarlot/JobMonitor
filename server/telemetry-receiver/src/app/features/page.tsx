import { BarChart } from '@/components/Chart';
import { failureBreakdown, featureAdoption, operationTimings } from '@/lib/queries';
import { resolveRange } from '@/lib/range';

const pct = (n: number) => `${n.toFixed(0)}%`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

export default async function Features({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The range comes from the URL, so a link carries it. Resolved here rather than in the control —
  // the control only displays it, and these queries must use exactly what the URL asked for.
  const range = resolveRange(await searchParams);
  const adoption = featureAdoption(range);
  const timings = operationTimings(range);
  const failures = failureBreakdown(range);

  const used = adoption.filter((f) => f.uses > 0);
  const unused = adoption.filter((f) => f.uses === 0);

  return (
    <>
      <h2>Feature adoption</h2>
      <p className="note">Last 30 days. Percentage is of installations that reported anything.</p>
      <BarChart
        bars={used.slice(0, 25).map((f) => ({ name: f.key, value: f.uses }))}
        label="Uses per feature"
      />

      <table>
        <thead>
          <tr>
            <th>Feature</th>
            <th className="num">Uses</th>
            <th className="num">Installations</th>
            <th className="num">% of active</th>
          </tr>
        </thead>
        <tbody>
          {used.map((f) => (
            <tr key={f.key}>
              <td><code>{f.key}</code></td>
              <td className="num">{f.uses.toLocaleString('en-GB')}</td>
              <td className="num">{f.installs}</td>
              <td className="num">{pct(f.pctOfActive)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Used by nobody</h2>
      {/*
        The reason the registry is joined in rather than the table being read alone: a feature with
        no usage produces no rows, so a query over the data can only ever show what *was* used. This
        is the list that informs what to remove.
      */}
      <p className="note">
        Features in the registry with no recorded use in this period. Either nobody needs them, or
        they are not reachable — both are worth knowing.
      </p>
      {unused.length === 0 ? (
        <p className="note">Every registered feature was used at least once.</p>
      ) : (
        // A flex container rather than inline elements in a paragraph. Adjacent JSX elements have
        // no whitespace text node between them, so the browser saw one unbreakable 7,300px word —
        // `app.launchedapp.second_instancewindow.shown…` — and the page scrolled sideways forever.
        // Flex wrapping does not depend on whitespace existing.
        <div className="keylist">
          {unused.map((f) => (
            <code key={f.key}>{f.key}</code>
          ))}
        </div>
      )}

      <h2>Operation timings</h2>
      <p className="note">
        Reported as share under a threshold, never as a percentile — eight histogram buckets cannot
        produce a true p95, and a fabricated one on a page people act on is worse than no number.
      </p>
      <table>
        <thead>
          <tr>
            <th>Operation</th>
            <th className="num">Count</th>
            <th className="num">Mean</th>
            <th className="num">Max</th>
            <th className="num">&lt;100ms</th>
            <th className="num">&lt;500ms</th>
            <th className="num">&lt;2s</th>
            <th className="num">&ge;5s</th>
          </tr>
        </thead>
        <tbody>
          {timings.map((t) => (
            <tr key={t.operation_key}>
              <td><code>{t.operation_key}</code></td>
              <td className="num">{t.n.toLocaleString('en-GB')}</td>
              <td className="num">{ms(t.total_ms / Math.max(t.n, 1))}</td>
              <td className="num">{ms(t.max_ms)}</td>
              <td className="num">{pct((t.under_100 / t.n) * 100)}</td>
              <td className="num">{pct((t.under_500 / t.n) * 100)}</td>
              <td className="num">{pct((t.under_2s / t.n) * 100)}</td>
              <td className="num">{pct((t.over_5s / t.n) * 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Failures</h2>
      <table>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Category</th>
            <th className="num">Count</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((f) => (
            <tr key={`${f.operation_key}:${f.error_key}`}>
              <td><code>{f.operation_key}</code></td>
              <td>{f.error_key}</td>
              <td className="num">{f.n.toLocaleString('en-GB')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

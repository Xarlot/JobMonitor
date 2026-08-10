import Link from 'next/link';
import { LineChart, Stat } from '@/components/Chart';
import { crashFreeByDay, crashesByDay, topFingerprints } from '@/lib/queries';
import { bucketName, resolveRange } from '@/lib/range';

const when = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

export default async function Reliability({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The range comes from the URL, so a link carries it. Resolved here rather than in the control —
  // the control only displays it, and these queries must use exactly what the URL asked for.
  const range = resolveRange(await searchParams);
  const per = bucketName(range);
  const daily = crashesByDay(range);
  const crashFree = crashFreeByDay(range);
  const fingerprints = topFingerprints(range);

  const crashFreePoints = crashFree
    .filter((d) => d.active > 0)
    .map((d) => ({ x: d.day, y: ((d.active - d.crashed) / d.active) * 100 }));

  const latest = crashFreePoints.at(-1)?.y;
  const totalCrashes = daily.reduce((n, d) => n + d.crashes, 0);

  return (
    <>
      <h2>Reliability</h2>
      <div className="stats">
        <Stat
          label="Crash-free installations"
          value={latest === undefined ? '—' : `${latest.toFixed(1)}%`}
          hint={`most recent ${per}`}
          tone={latest !== undefined && latest < 95 ? 'danger' : 'ok'}
        />
        <Stat label="Crashes" value={totalCrashes} hint={range.label.toLowerCase()} />
        <Stat label="Distinct fingerprints" value={fingerprints.length} hint="in this period" />
      </div>

      <LineChart
        label={`Crash-free installations, % per ${per}`}
        points={crashFreePoints}
        colour="#1a7f37"
        format={(n) => `${n.toFixed(0)}%`}
      />
      <LineChart
        label={`Crashes per ${per}`}
        points={daily.map((d) => ({ x: d.day, y: d.crashes }))}
        colour="#cf222e"
      />

      <h2>Top fingerprints</h2>
      <p className="note">
        <em>First seen</em> is computed over all time, not over the selected period — scoped to the
        window it would make every old fingerprint look new whenever the range narrows, which is
        exactly the number you would use to judge a release.
      </p>
      <table>
        <thead>
          <tr>
            <th>Exception</th>
            <th className="num">Occurrences</th>
            <th className="num">Installations</th>
            <th>First seen</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {fingerprints.map((f) => (
            <tr key={f.fingerprint}>
              <td>
                <Link href={`/reliability/${f.fingerprint}`}>{f.exception_type}</Link>{' '}
                <code style={{ color: 'var(--muted)' }}>{f.fingerprint.slice(0, 8)}</code>
              </td>
              <td className="num">{f.occurrences.toLocaleString('en-GB')}</td>
              <td className="num">{f.installs}</td>
              <td>{when(f.first_seen)}</td>
              <td>{when(f.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {fingerprints.length === 0 && <p className="note">No crashes recorded in this period.</p>}
    </>
  );
}

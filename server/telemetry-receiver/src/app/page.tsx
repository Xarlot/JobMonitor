import { BarChart, LineChart, Stat } from '@/components/Chart';
import {
  activeByDay,
  activeInstallations,
  sessionTotals,
  versionSpread,
} from '@/lib/queries';
import { bucketName, resolveRange } from '@/lib/range';

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The range comes from the URL, so a link carries it. Resolved here rather than in the control —
  // the control only displays it, and these queries must use exactly what the URL asked for.
  const range = resolveRange(await searchParams);
  const per = bucketName(range);
  const active = activeInstallations(range.to);
  const byDay = activeByDay(range);
  const versions = versionSpread(range);
  const sessions = sessionTotals(range);

  const hoursPerDay = sessions.map((s) => ({ x: s.day, y: Math.round(s.foreground / 3600) }));

  return (
    <>
      <h2>Active installations</h2>
      <div className="stats">
        <Stat label="Today" value={active.dau} hint="distinct installation ids, 24h" />
        <Stat label="This week" value={active.wau} hint="7 days" />
        <Stat label="This month" value={active.mau} hint="30 days" />
      </div>

      <LineChart
        label={`Distinct installations per ${per}`}
        points={byDay.map((d) => ({ x: d.day, y: d.installs }))}
      />

      <h2>Versions in use</h2>
      <p className="note">Distinct installations reporting each version in the selected period.</p>
      <BarChart
        bars={versions.map((v) => ({ name: v.app_version, value: v.installs }))}
        label="Installations by version"
      />

      <h2>Usage</h2>
      <LineChart
        label={`Sessions per ${per}`}
        points={sessions.map((s) => ({ x: s.day, y: s.sessions }))}
      />
      <LineChart
        label={`Foreground hours per ${per} (across all installations)`}
        points={hoursPerDay}
        format={(n) => `${Math.round(n)}h`}
      />
      <p className="note">
        Foreground time is the window visible and focused. It is deliberately separate from running
        time — Job Monitor lives in the tray and keeps polling with the window hidden, so a single
        “active” number would conflate someone working in it with it merely being open.
      </p>
    </>
  );
}

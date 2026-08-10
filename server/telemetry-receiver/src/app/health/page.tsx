import { Stat } from '@/components/Chart';
import { ingestHealth, recentRuns, rejectionsByRule } from '@/lib/queries';
import { livePollState } from '@/lib/livePoll';

const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const ago = (ms: number) => {
  const h = (Date.now() - ms) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} min ago` : `${h.toFixed(1)}h ago`;
};

export default function Health() {
  const health = ingestHealth();
  const runs = recentRuns();
  const rejections = rejectionsByRule();
  const live = livePollState();

  return (
    <>
      <h2>Ingest health</h2>
      {/*
        The whole reason this page exists. Every other chart reads zero both when nobody used the
        app and when ingest stopped, and those need completely different responses.
      */}
      <p className="note">
        Two things read Ably. A schedule every {health.intervalHours}h keeps the data complete, and
        a live loop reads every few seconds while anyone has a page open — including this one, which
        is why the numbers below move. The live loop stops itself a few minutes after the last page
        render, so an idle instance does no work at all. Ably keeps published messages for{' '}
        {health.retentionHours}h; a gap wider than that is lost permanently, and is the one failure
        here that running again cannot repair.
      </p>

      <div className="stats">
        <Stat
          label="Last run"
          value={health.last ? ago(health.last.ts) : 'never'}
          hint={health.last ? when(health.last.ts) : undefined}
          tone={health.stale ? 'danger' : 'ok'}
        />
        <Stat
          label="Outcome"
          value={health.last ? (health.last.ok ? 'ok' : 'failed') : '—'}
          hint={health.last?.error ?? undefined}
          tone={health.last?.ok ? 'ok' : health.last ? 'danger' : undefined}
        />
        <Stat
          label="Margin to expiry"
          value={
            health.last
              ? `${Math.max(0, health.retentionHours - health.ageHours).toFixed(1)}h`
              : '—'
          }
          hint="before unread messages expire"
          tone={health.last && health.retentionHours - health.ageHours < 4 ? 'danger' : 'ok'}
        />
        <Stat label="Accepted, last run" value={health.last?.accepted ?? 0} />
        <Stat
          label="Live polling"
          value={live.running ? 'active' : 'idle'}
          hint={live.running ? `${live.polls} reads this session` : 'starts when a page is opened'}
          tone={live.running ? 'ok' : undefined}
        />
      </div>

      <h2>Recent runs</h2>
      {runs.length === 0 ? (
        <p className="note">No runs recorded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Result</th>
              <th className="num">Messages</th>
              <th className="num">Accepted</th>
              <th className="num">Duplicates</th>
              <th className="num">Rejected</th>
              <th className="num">Took</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.ts}>
                <td>{when(r.ts)}</td>
                <td>{r.ok ? 'ok' : <span title={r.error ?? ''}>failed</span>}</td>
                <td className="num">{r.messages}</td>
                <td className="num">{r.accepted}</td>
                {/* Duplicates are expected, not a fault: every run re-reads a short overlap so
                    nothing settling at the cursor boundary is missed. */}
                <td className="num">{r.duplicates}</td>
                <td className="num">{r.rejected}</td>
                <td className="num">{(r.duration_ms / 1000).toFixed(1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Rejections by rule, last 7 days</h2>
      <p className="note">
        How a client bug is found. A spike in one rule names both the defect and, usually, the
        version that introduced it. Values are never recorded — only the rule and the field.
      </p>
      {rejections.length === 0 ? (
        <p className="note">Nothing rejected in the last 7 days.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Rule</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {rejections.map((r) => (
              <tr key={r.rule}>
                <td><code>{r.rule}</code></td>
                <td className="num">{r.n.toLocaleString('en-GB')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

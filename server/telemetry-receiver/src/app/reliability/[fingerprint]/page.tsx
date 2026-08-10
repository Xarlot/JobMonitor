import { notFound } from 'next/navigation';
import { Stat } from '@/components/Chart';
import { fingerprintDetail } from '@/lib/queries';

const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export default async function Fingerprint({
  params,
}: {
  params: Promise<{ fingerprint: string }>;
}) {
  const { fingerprint } = await params;
  // Validated before it reaches SQL. The parameter is user-controllable by definition — it comes
  // out of a URL — and a fingerprint is always lowercase hex, so anything else is not a lookup.
  if (!/^[0-9a-f]{16,64}$/.test(fingerprint)) notFound();

  const { summary, versions, variants, variantCount } = fingerprintDetail(fingerprint);
  if (!summary) notFound();

  return (
    <>
      <h2>{summary.exception_type}</h2>
      <p className="note">
        <code>{fingerprint}</code>
      </p>

      <div className="stats">
        <Stat label="Occurrences" value={summary.occurrences} />
        <Stat label="Installations affected" value={summary.installs} />
        <Stat label="First seen" value={when(summary.first_seen)} />
        <Stat label="Last seen" value={when(summary.last_seen)} />
      </div>

      <h2>Affected versions</h2>
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th className="num">Occurrences</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.app_version}>
              <td>{v.app_version}</td>
              <td className="num">{v.occurrences.toLocaleString('en-GB')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>
        Stack traces{' '}
        <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
          {variantCount === 1 ? '1 variant' : `${variantCount} distinct variants`}
        </span>
      </h2>
      {/*
        Grouped by the trace itself rather than listed by time. Every record under one fingerprint
        shares its top five frames by construction, so listing recent rows prints the same text
        repeatedly; the differing tail is the only part worth reading once the fingerprint is known.
      */}
      <p className="note">
        Identical traces are collapsed — each block below is a genuinely different one. Sanitized on
        the client before storage and re-checked on arrival: absolute paths, home directories,
        usernames and anything token-shaped are removed, and the exception message is never
        collected at all.
      </p>

      {variants.map((v) => (
        <div key={v.stack || 'redacted'}>
          <p className="note">
            ×{v.occurrences} · {v.versions.split(',').sort().join(', ')} ·{' '}
            {v.first_seen === v.last_seen
              ? when(v.first_seen)
              : `${when(v.first_seen)} — ${when(v.last_seen)}`}
          </p>
          {v.stack_redacted === 1 ? (
            <p className="note">
              Trace withheld: it matched a pattern that can carry identifying data, so it was
              discarded on arrival. The crash itself is still counted.
            </p>
          ) : (
            <pre>{v.stack}</pre>
          )}
        </div>
      ))}

      {variantCount > variants.length && (
        // Say so rather than implying the list is complete.
        <p className="note">
          Showing the {variants.length} most common of {variantCount} variants.
        </p>
      )}
    </>
  );
}

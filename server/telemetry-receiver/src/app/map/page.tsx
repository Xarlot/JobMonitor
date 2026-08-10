import { Suspense } from 'react';
import { FeatureMap } from '@/components/FeatureMap';
import { featureMap } from '@/lib/graph';
import { resolveRange } from '@/lib/range';

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const range = resolveRange(params);
  const raw = params.installation;
  const installation = typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw) ? raw : undefined;
  const data = featureMap(range, installation);

  return (
    <>
      <h2>Feature map</h2>
      <p className="note">
        What follows what. An edge means one installation used the second feature within five
        minutes of the first — the client records the order inside each bucket, so this is a real
        sequence rather than two things happening in the same hour. It is not causal: people who
        open a failure and then its log produce this edge whether or not anything led them there.
      </p>
      {installation && (
        <p className="note">
          Narrowed to one installation. An installation is one copy of the app, not a person — a
          laptop and a desktop are two, and a reinstall is a third. This view shows a single
          machine’s sequence of actions, which is the most identifying thing this dashboard can
          draw; the id is random and tied to nothing, and nothing here should be treated as
          belonging to a known individual.
        </p>
      )}
      <Suspense fallback={<p className="note">Loading…</p>}>
        <FeatureMap data={data} />
      </Suspense>
    </>
  );
}

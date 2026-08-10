/**
 * The feature map: which features follow which, over time.
 *
 * ## What an edge means
 *
 * A real one. The client records the order features were used in within each bucket and sends it as
 * a trail — feature ids plus the seconds between them — and the ingest turns each consecutive pair
 * into a row here. An edge A→B therefore means "someone did A and then did B", within five minutes,
 * on one installation. Not "used both in the same hour".
 *
 * Two things it still is not. It is not causal: people who look at a failure and then open its log
 * would produce this edge whether the app suggested it or not. And a bucket that hit the trail cap
 * contributes its first events only, so a very long session is represented by its beginning — which
 * is the right bias if there is to be one, since the beginning is where the navigation is.
 *
 * ## Clusters
 *
 * By registry block — 100 shell, 200 PRs, 300 flows, and so on. Deliberately the given grouping
 * rather than one found in the data: a community-detection pass over a graph this size would draw
 * boundaries that shift with every week's data, and a map whose regions move is a map nobody can
 * learn. What the edges are for is showing where the given grouping is *wrong* — a thick edge
 * between two clusters says those two areas are one workflow, and that is a finding.
 */

import { database } from './db';
import { FEATURE_DEFS } from '@jobmonitor/telemetry-schema/registry';
import type { Range } from './queries';

export interface MapNode {
  key: string;
  /** The registry block — 100 shell, 200 PRs, 300 flows, … */
  cluster: number;
  clusterLabel: string;
  /** Total uses in the range, across every installation in scope. */
  total: number;
}

/** `[from, to, weight]`, indexes into `nodes`. A tuple because there are a lot of these. */
export type MapEdge = [number, number, number];

export interface MapStep {
  /** UTC midnight of the day this slice covers. */
  day: number;
  edges: MapEdge[];
}

export interface FeatureMap {
  nodes: MapNode[];
  /** One per day with any transition, ascending. The time control steps through these. */
  steps: MapStep[];
  /** Installation ids that reported a transition in the range, for the filter. */
  installations: string[];
  /** Transitions in scope, before any client-side filtering. */
  total: number;
}

const CLUSTER_LABEL: Record<number, string> = {
  100: 'Shell and lifecycle',
  200: 'Navigation and PRs',
  300: 'Flows',
  400: 'Failures and logs',
  500: 'Writes',
  600: 'AI',
  700: 'Artifacts',
  800: 'Configuration',
  900: 'Feature branches',
};

/**
 * Build the map for a range, optionally narrowed to one installation.
 *
 * @param installation An opaque installation id, or undefined for all of them. It is **not** a
 *   person: one id is one copy of the app, so somebody with a laptop and a desktop is two of them,
 *   and a reinstall is a third.
 */
export function featureMap(range: Range, installation?: string): FeatureMap {
  const db = database();
  const scope = installation ? 'AND installation = :installation' : '';
  const params = {
    from: range.from,
    to: range.to,
    ...(installation ? { installation } : {}),
  };

  const rows = db
    .prepare(
      `SELECT day, from_id, to_id, SUM(n) AS n
       FROM feature_transitions
       WHERE day BETWEEN :from AND :to ${scope}
       GROUP BY day, from_id, to_id
       ORDER BY day`,
    )
    .all(params) as { day: number; from_id: number; to_id: number; n: number }[];

  const totals = db
    .prepare(
      `SELECT feature_key, SUM(count) AS total
       FROM usage
       WHERE record_type = 'feature' AND ts BETWEEN :from AND :to ${scope}
       GROUP BY feature_key`,
    )
    .all(params) as { feature_key: string; total: number }[];

  const installations = (
    db
      .prepare(
        `SELECT DISTINCT installation FROM feature_transitions
         WHERE day BETWEEN :from AND :to
         ORDER BY installation`,
      )
      .all({ from: range.from, to: range.to }) as { installation: string }[]
  ).map((r) => r.installation);

  // Nodes come from the registry, not from the rows: a feature nobody used still belongs on the
  // map, in its cluster, at zero. Which corner of the product is dark is half the point of a map.
  const byKey = new Map(totals.map((t) => [t.feature_key, t.total]));
  const nodes: MapNode[] = Object.values(FEATURE_DEFS)
    .map((def) => {
      const cluster = Math.floor(def.id / 100) * 100;
      return {
        key: def.key,
        cluster,
        clusterLabel: CLUSTER_LABEL[cluster] ?? 'Other',
        total: byKey.get(def.key) ?? 0,
      };
    })
    .sort((a, b) => a.cluster - b.cluster || b.total - a.total || a.key.localeCompare(b.key));

  // Keyed by a plain number: the ids coming back from SQLite are numbers, not the literal union
  // the registry narrows them to, and asserting one into the other would only hide a real
  // mismatch — an id the registry has never heard of has to miss this lookup, not be cast into it.
  const indexById = new Map<number, number>(
    Object.values(FEATURE_DEFS).map((def) => [
      def.id as number,
      nodes.findIndex((n) => n.key === def.key),
    ]),
  );

  const byDay = new Map<number, MapEdge[]>();
  for (const r of rows) {
    const from = indexById.get(r.from_id);
    const to = indexById.get(r.to_id);
    // An id this receiver does not know is a client running ahead of it. The ingest already refused
    // to store it, so this is belt and braces — but a map is not the place to find out.
    if (from === undefined || to === undefined || from < 0 || to < 0) continue;
    const list = byDay.get(r.day) ?? [];
    list.push([from, to, r.n]);
    byDay.set(r.day, list);
  }

  const steps: MapStep[] = [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, edges]) => ({ day, edges: edges.sort((x, y) => y[2] - x[2]) }));

  return { nodes, steps, installations, total: rows.reduce((sum, r) => sum + r.n, 0) };
}

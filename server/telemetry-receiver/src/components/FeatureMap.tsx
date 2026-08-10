'use client';

/**
 * The feature map.
 *
 * A circular layout rather than a force simulation, deliberately. A force layout finds a different
 * arrangement every time the data shifts, so the same feature lands somewhere new each week and
 * nobody can build a mental picture of where things are. Here a feature's position is a pure
 * function of its cluster and its rank within it: the map looks the same tomorrow, and a change on
 * it is a change in the data rather than in the solver.
 *
 * Everything is drawn as SVG from props. The only state is which day is selected and which
 * installation is in scope — the arithmetic is small enough to redo on every frame of a drag, which
 * is what makes the time control feel like scrubbing rather than like paging.
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Select, SegmentedControl } from '@primer/react';
import type { FeatureMap as MapData, MapEdge } from '@/lib/graph';
import styles from './FeatureMap.module.css';

const SIZE = 860;
const CENTRE = SIZE / 2;
const RADIUS = SIZE / 2 - 130;
/** Blank arc between clusters, in radians, so the groups read as groups. */
const CLUSTER_GAP = 0.14;

const CLUSTER_COLOUR = [
  '#0969da', '#8250df', '#1a7f37', '#cf222e', '#bf8700',
  '#1b7c83', '#a40e26', '#6e7781', '#953800',
];

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

interface Placed {
  x: number;
  y: number;
  angle: number;
}

export function FeatureMap({ data }: { data: MapData }) {
  const router = useRouter();
  const params = useSearchParams();
  const installation = params.get('installation') ?? '';

  const [stepIndex, setStepIndex] = useState(Math.max(0, data.steps.length - 1));
  const [mode, setMode] = useState<'cumulative' | 'day'>('cumulative');
  const [hover, setHover] = useState<number | null>(null);

  /**
   * Positions, computed once per node set.
   *
   * Each cluster gets an arc proportional to how many features it holds, so a big area is a big
   * region rather than a crowded one, and the nodes inside it sit in the order the data arrives —
   * which the query fixes as cluster, then usage, then name.
   */
  const placed = useMemo<Placed[]>(() => {
    const counts = new Map<number, number>();
    for (const n of data.nodes) counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);
    const clusters = [...counts.keys()].sort((a, b) => a - b);
    const gaps = clusters.length * CLUSTER_GAP;
    const perNode = (Math.PI * 2 - gaps) / data.nodes.length;

    const start = new Map<number, number>();
    let angle = -Math.PI / 2;
    for (const c of clusters) {
      start.set(c, angle);
      angle += (counts.get(c) ?? 0) * perNode + CLUSTER_GAP;
    }

    const used = new Map<number, number>();
    return data.nodes.map((n) => {
      const i = used.get(n.cluster) ?? 0;
      used.set(n.cluster, i + 1);
      const a = (start.get(n.cluster) ?? 0) + (i + 0.5) * perNode;
      return { x: CENTRE + Math.cos(a) * RADIUS, y: CENTRE + Math.sin(a) * RADIUS, angle: a };
    });
  }, [data.nodes]);

  const clusterOf = useMemo(() => {
    const order = [...new Set(data.nodes.map((n) => n.cluster))].sort((a, b) => a - b);
    return new Map(order.map((c, i) => [c, i]));
  }, [data.nodes]);

  /** The edges in scope, summed over whatever slice of time is selected. */
  const edges = useMemo<MapEdge[]>(() => {
    const slice =
      mode === 'day' ? data.steps.slice(stepIndex, stepIndex + 1) : data.steps.slice(0, stepIndex + 1);
    const merged = new Map<string, MapEdge>();
    for (const step of slice) {
      for (const [from, to, n] of step.edges) {
        const key = `${from}:${to}`;
        const existing = merged.get(key);
        if (existing) existing[2] += n;
        else merged.set(key, [from, to, n]);
      }
    }
    return [...merged.values()].sort((a, b) => a[2] - b[2]);
  }, [data.steps, stepIndex, mode]);

  const maxWeight = edges.reduce((m, e) => Math.max(m, e[2]), 1);
  const maxTotal = data.nodes.reduce((m, n) => Math.max(m, n.total), 1);

  /** Degree per node for the current slice, so an unused feature can be drawn as unused. */
  const degree = useMemo(() => {
    const d = new Array(data.nodes.length).fill(0);
    for (const [from, to, n] of edges) {
      d[from] += n;
      d[to] += n;
    }
    return d;
  }, [edges, data.nodes.length]);

  const chooseInstallation = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set('installation', value);
      else next.delete('installation');
      router.push(next.toString() ? `?${next}` : '?', { scroll: false });
    },
    [params, router],
  );

  const step = data.steps[stepIndex];

  return (
    <>
      <div className={styles.controls}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Installation</span>
          <Select value={installation} onChange={(e) => chooseInstallation(e.target.value)}>
            <Select.Option value="">All ({data.installations.length})</Select.Option>
            {data.installations.map((id) => (
              <Select.Option key={id} value={id}>
                {id.slice(0, 12)}…
              </Select.Option>
            ))}
          </Select>
        </label>

        <SegmentedControl aria-label="What the slider shows" size="small">
          <SegmentedControl.Button
            selected={mode === 'cumulative'}
            onClick={() => setMode('cumulative')}
          >
            Up to day
          </SegmentedControl.Button>
          <SegmentedControl.Button selected={mode === 'day'} onClick={() => setMode('day')}>
            That day
          </SegmentedControl.Button>
        </SegmentedControl>

        <label className={styles.scrub}>
          <input
            type="range"
            min={0}
            max={Math.max(0, data.steps.length - 1)}
            value={stepIndex}
            onChange={(e) => setStepIndex(Number(e.target.value))}
            disabled={data.steps.length < 2}
            aria-label="Day"
          />
          <span className={styles.scrubLabel}>
            {step ? day(step.day) : '—'}
            <span className={styles.scrubCount}>
              {edges.reduce((n, e) => n + e[2], 0).toLocaleString('en-GB')} transitions
            </span>
          </span>
        </label>
      </div>

      {data.steps.length === 0 ? (
        <p className={styles.empty}>
          No transitions in this period. Trails arrive with the next batch from a client built after
          this feature shipped — older clients send counts only, and those cannot be ordered.
        </p>
      ) : (
        <figure className={styles.figure}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Feature transition map">
            {/*
              Edges first, so nodes sit on top of them. Drawn as quadratic curves bent towards the
              middle: straight chords across a circle overlap into a solid mass, while a consistent
              bend keeps them separable and shows direction — the curve leaves its source flatter
              than it arrives at its target.
            */}
            {edges.map(([from, to, n]) => {
              const a = placed[from];
              const b = placed[to];
              const dim = hover !== null && hover !== from && hover !== to;
              return (
                <path
                  key={`${from}:${to}`}
                  d={`M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${CENTRE},${CENTRE} ${b.x.toFixed(1)},${b.y.toFixed(1)}`}
                  fill="none"
                  stroke={CLUSTER_COLOUR[clusterOf.get(data.nodes[from].cluster) ?? 0]}
                  strokeWidth={0.6 + (n / maxWeight) * 5}
                  strokeOpacity={dim ? 0.04 : 0.1 + (n / maxWeight) * 0.5}
                  strokeLinecap="round"
                />
              );
            })}

            {data.nodes.map((node, i) => {
              const p = placed[i];
              const colour = CLUSTER_COLOUR[clusterOf.get(node.cluster) ?? 0];
              const r = 3 + Math.sqrt(node.total / maxTotal) * 9;
              const right = Math.cos(p.angle) > 0;
              const lx = CENTRE + Math.cos(p.angle) * (RADIUS + 12);
              const ly = CENTRE + Math.sin(p.angle) * (RADIUS + 12);
              const active = hover === i;
              return (
                <g
                  key={node.key}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  className={styles.node}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill={degree[i] > 0 || node.total > 0 ? colour : 'var(--borderColor-muted)'}
                    fillOpacity={active ? 1 : 0.85}
                  />
                  <text
                    x={lx}
                    y={ly}
                    fontSize="10"
                    textAnchor={right ? 'start' : 'end'}
                    dominantBaseline="middle"
                    transform={`rotate(${(p.angle * 180) / Math.PI + (right ? 0 : 180)} ${lx} ${ly})`}
                    fill={active ? 'var(--fgColor-default)' : 'var(--fgColor-muted)'}
                    fontWeight={active ? 600 : 400}
                  >
                    {node.key}
                  </text>
                </g>
              );
            })}
          </svg>
        </figure>
      )}

      <div className={styles.legend}>
        {[...clusterOf.entries()].map(([cluster, i]) => {
          const label = data.nodes.find((n) => n.cluster === cluster)?.clusterLabel ?? '';
          return (
            <span key={cluster} className={styles.legendItem}>
              <span className={styles.swatch} style={{ backgroundColor: CLUSTER_COLOUR[i] }} />
              {label}
            </span>
          );
        })}
      </div>
    </>
  );
}

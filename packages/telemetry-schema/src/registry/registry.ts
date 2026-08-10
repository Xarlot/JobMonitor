/**
 * The registry primitive.
 *
 * Every dimension the telemetry format carries — features, operations, error categories — is a
 * numeric id chosen from a fixed table. There is no string path anywhere in the wire format for a
 * label, which is what makes it structurally impossible for a repository name or a file path to
 * travel as telemetry even by accident.
 *
 * The table lives here rather than being duplicated per side, because the receiver *drops* records
 * carrying an id it does not recognise. A copy-pasted table means a client ships a new id, the
 * receiver silently discards every record containing it, and nobody notices for weeks.
 *
 * The human-readable key is carried alongside the id for one reason only: the receiver denormalizes
 * it at ingest so dashboards read `flows.pattern.used` rather than `303`. It is never sent.
 */

export interface Def {
  /** Permanent. Never renumbered, never reused — see the rules in the proto header. */
  readonly id: number;
  /** Stable dotted key for dashboards. Renaming one silently breaks a year of history. */
  readonly key: string;
}

export interface Registry<T extends Record<string, Def>> {
  readonly defs: T;
  /** Every valid id. */
  readonly ids: ReadonlySet<number>;
  /** Dashboard key for an id, or `unknown(<id>)` — never a throw, never a dropped batch. */
  keyOf(id: number): string;
  has(id: number): boolean;
}

/**
 * Build a registry and check its own invariants at module load.
 *
 * Loudly, at import time, rather than in a test: a duplicate id is a data-corruption bug that would
 * merge two unrelated features into one number for as long as it went unnoticed. Better to refuse
 * to start.
 */
export function buildRegistry<T extends Record<string, Def>>(
  name: string,
  defs: T,
  /** Ids that once existed and must never be reused. */
  tombstones: readonly number[] = [],
): Registry<T> {
  const byId = new Map<number, string>();
  const seenKeys = new Set<string>();
  const dead = new Set(tombstones);

  for (const [symbol, def] of Object.entries(defs)) {
    if (!Number.isInteger(def.id) || def.id < 0) {
      throw new Error(`${name}: ${symbol} has a non-integer id ${def.id}`);
    }
    if (byId.has(def.id)) {
      throw new Error(`${name}: id ${def.id} used by both ${byId.get(def.id)} and ${symbol}`);
    }
    if (dead.has(def.id)) {
      throw new Error(`${name}: ${symbol} reuses retired id ${def.id}`);
    }
    if (seenKeys.has(def.key)) {
      throw new Error(`${name}: duplicate key ${def.key} on ${symbol}`);
    }
    byId.set(def.id, def.key);
    seenKeys.add(def.key);
  }

  return {
    defs,
    ids: new Set(byId.keys()),
    keyOf: (id) => byId.get(id) ?? `unknown(${id})`,
    has: (id) => byId.has(id),
  };
}

/** Narrow a def table to the union of its ids, so a caller cannot pass an arbitrary number. */
export type IdOf<T extends Record<string, Def>> = T[keyof T]['id'];

/**
 * Derive the call-site enum from the def table: `Feature.FLOW_CREATED` instead of
 * `FEATURE_DEFS.FLOW_CREATED.id`. Derived rather than written out so there is still exactly one
 * place an id appears.
 */
export function idEnum<T extends Record<string, Def>>(
  defs: T,
): { readonly [K in keyof T]: T[K]['id'] } {
  const out: Record<string, number> = {};
  for (const [symbol, def] of Object.entries(defs)) out[symbol] = def.id;
  return out as { readonly [K in keyof T]: T[K]['id'] };
}

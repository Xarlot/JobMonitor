/**
 * Folds one poll's workflow-run responses into the runs a flow already holds, without letting
 * a stale response roll the board back.
 *
 * **Why this exists.** GitHub's *filtered* run lists — `branch` and/or `event` on
 * `/actions/workflows/{id}/runs`, and on the repo-wide `/actions/runs` alike — are served from
 * more than one backend, and some of them lag by days. The same request answers `200` with the
 * live list one moment and an old snapshot the next: seen with `total_count` 283 against a live
 * 309 and the newest run #291 where the live list starts at #316, and for another workflow stuck
 * on a run from thirteen days earlier. The unfiltered list does not do this. Taken at face value,
 * such a response replaced the flow's runs, was written to the persisted run cache, and moved
 * the Failures tab onto a long-gone run; the next poll usually put it back, so the board
 * flickered between then and now.
 *
 * **The rule.** Per (branch × event) query, a response whose newest run is *older* than the
 * newest run already held for that query is stale: the runs held for that query are kept and
 * the response is ignored. A run present in both keeps whichever copy GitHub updated last, so
 * a partly stale answer can't turn a finished run back into a running one either.
 *
 * A held run can legitimately disappear — someone deletes it — and then every answer looks
 * stale. Counting stale answers is no way out of that: the lagging backend can answer several
 * times running. So after {@link STALE_LIMIT} stale answers in a row the caller is asked to
 * check the held run itself (`needsCheck`), and once it reports the run gone (`gone`), the
 * response is believed.
 *
 * Pure: the caller keeps the streak map and the set of gone runs between polls.
 */

import type { WorkflowRun } from '../api/types';

/** Consecutive stale answers for one query after which the newest held run is checked. */
export const STALE_LIMIT = 3;

export interface RunsQuery {
  branch: string;
  event?: string;
}

export interface QueryResponse {
  query: RunsQuery;
  /** The runs of a fulfilled request, or null when that request failed. */
  runs: readonly WorkflowRun[] | null;
}

export interface StaleAnswer {
  query: RunsQuery;
  newestHeld: WorkflowRun;
  newestReceived: WorkflowRun | null;
  /** How many stale answers in a row this query has given, this one included. */
  streak: number;
  /** True when the newest held run is known to be gone and the response was believed. */
  accepted: boolean;
  /** True when the caller should check whether the newest held run still exists. */
  needsCheck: boolean;
}

export interface MergeResult {
  /** Newest first. */
  runs: WorkflowRun[];
  stale: StaleAnswer[];
}

export function queryKey(q: RunsQuery): string {
  return `${q.branch}\u0000${q.event ?? ''}`;
}

function belongsTo(run: WorkflowRun, q: RunsQuery): boolean {
  return run.head_branch === q.branch && (!q.event || run.event === q.event);
}

function createdMs(run: WorkflowRun): number {
  return Date.parse(run.created_at) || 0;
}

function updatedMs(run: WorkflowRun): number {
  return Date.parse(run.updated_at) || 0;
}

function newest(runs: readonly WorkflowRun[]): WorkflowRun | null {
  let best: WorkflowRun | null = null;
  for (const r of runs) if (!best || createdMs(r) > createdMs(best)) best = r;
  return best;
}

/**
 * @param held      The runs the flow shows now (newest first), possibly from the persisted cache.
 * @param responses One entry per query of this poll.
 * @param maxRuns   Runs kept per query.
 * @param streaks   Stale-answer streak per {@link queryKey}; updated in place.
 * @param gone      Ids of held runs the caller found deleted.
 */
export function mergeRunResponses(
  held: readonly WorkflowRun[],
  responses: readonly QueryResponse[],
  maxRuns: number,
  streaks: Map<string, number>,
  gone: ReadonlySet<number> = new Set(),
): MergeResult {
  const heldById = new Map(held.map((r) => [r.id, r]));
  const merged = new Map<number, WorkflowRun>();
  const stale: StaleAnswer[] = [];

  for (const { query, runs } of responses) {
    const key = queryKey(query);
    const mine = held.filter((r) => belongsTo(r, query)).slice(0, maxRuns);
    if (runs === null) {
      // A failed request says nothing new about its query; keep what was there.
      for (const r of mine) merged.set(r.id, r);
      continue;
    }

    const received = runs.slice(0, maxRuns);
    const newestHeld = newest(mine);
    const newestReceived = newest(received);
    const isStale =
      newestHeld !== null &&
      (newestReceived === null || createdMs(newestReceived) < createdMs(newestHeld));

    if (isStale) {
      const streak = (streaks.get(key) ?? 0) + 1;
      const accepted = gone.has(newestHeld.id);
      stale.push({
        query,
        newestHeld,
        newestReceived,
        streak,
        accepted,
        needsCheck: !accepted && streak >= STALE_LIMIT,
      });
      if (!accepted) {
        streaks.set(key, streak);
        for (const r of mine) merged.set(r.id, r);
        continue;
      }
    }
    streaks.delete(key);

    for (const r of received) {
      const prev = heldById.get(r.id);
      merged.set(r.id, prev && updatedMs(prev) > updatedMs(r) ? prev : r);
    }
  }

  const sorted = [...merged.values()].sort((a, b) => createdMs(b) - createdMs(a));
  return { runs: sorted, stale };
}

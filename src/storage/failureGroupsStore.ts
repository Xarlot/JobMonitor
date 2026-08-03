/**
 * How the user has arranged the Failures list.
 *
 * Two things with opposite defaults, so each is stored as its exceptions:
 *  - **Groups** (a PR, a flow) start collapsed, so what's remembered is which ones
 *    were *opened* — a handful, rather than the long tail left shut.
 *  - **Sections** ("Pull requests", "Flows") start open, so what's remembered is
 *    which were *closed*.
 *
 * Persisted because the Failures tab unmounts on every tab switch. Group ids are
 * derived (`pr:123`, `flow:<id>`), so entries for PRs and flows that have gone away
 * are pruned on write rather than accumulating; section ids are fixed and few.
 */

const STORAGE_KEY = 'job-monitor.failures.layout';

export interface FailuresLayout {
  expandedGroups: Set<string>;
  collapsedSections: Set<string>;
}

function toStringSet(value: unknown): Set<string> {
  return Array.isArray(value)
    ? new Set(value.filter((v): v is string => typeof v === 'string'))
    : new Set();
}

export function loadFailuresLayout(): FailuresLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { expandedGroups: new Set(), collapsedSections: new Set() };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      expandedGroups: toStringSet(parsed?.expandedGroups),
      collapsedSections: toStringSet(parsed?.collapsedSections),
    };
  } catch {
    return { expandedGroups: new Set(), collapsedSections: new Set() };
  }
}

/** Store the layout, keeping only group ids still present on the board. */
export function saveFailuresLayout(layout: FailuresLayout, liveGroupIds: ReadonlySet<string>): void {
  try {
    const expandedGroups = [...layout.expandedGroups].filter((id) => liveGroupIds.has(id));
    const collapsedSections = [...layout.collapsedSections];
    if (expandedGroups.length === 0 && collapsedSections.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ expandedGroups, collapsedSections }));
  } catch {
    /* storage full/unavailable — the layout still works for this session */
  }
}

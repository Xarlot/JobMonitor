/**
 * Pure logic for the feature-branch tab: what counts as a feature branch, what a pull
 * request's text says when no model wrote it, how to read a model's reply when one did,
 * and — the part the tab exists for — how far along a merge actually is.
 *
 * Kept free of React and of the network so the interesting decisions are testable, and so
 * the display and the action path derive "is this blocked?" from the same function rather
 * than from two readings of the same field.
 */

import type { CheckRun, CombinedStatus, OverallStatus, PullRequest } from '../api/types';
import { combineChecksAndStatus } from './status';

/**
 * The two pull requests a shared feature branch has.
 *
 * Both flow *into* the branch — the tab is about keeping one branch fed from two sides, not
 * about getting it into the default branch, which is somebody else's decision.
 */
export type MergeDirection =
  /** The upstream's default branch into the feature branch: a backmerge, keeping it current. */
  | 'sync'
  /** The fork's copy of the branch into the upstream's: offering your work back. */
  | 'offer';

export const TITLE_MARKER = '<<<TITLE>>>';
export const BODY_MARKER = '<<<BODY>>>';

/** GitHub accepts 256, but a title that long is unreadable in every list it appears in. */
const MAX_TITLE_LENGTH = 100;

export function isFeatureBranch(ref: string, prefix: string): boolean {
  // Case-sensitive: git refs are, and pairing `feature/Payments` with `feature/payments`
  // would silently act on a different branch.
  return ref.startsWith(prefix) && ref.length > prefix.length;
}

/**
 * The title used when no model wrote one.
 *
 * Also the sync direction's *only* title. A backmerge has no story to tell — "merge the
 * default branch in" is the whole of it — and asking a model to describe hundreds of
 * unrelated commits would produce a worse title at a real cost.
 *
 * For an offer both sides are the same branch name, so naming them twice says nothing;
 * the branch alone is the fallback, and it is only ever seen when composition produced
 * nothing usable.
 */
export function staticPrTitle(direction: MergeDirection, branch: string, base: string): string {
  return direction === 'sync' ? `Merge ${base} into ${branch}` : `Changes for ${branch}`;
}

/** Commit subjects and file counts, for a description nobody had to write. */
export interface ChangeSummary {
  /** Commit subjects, first line only, most recent first. */
  subjects: string[];
  /** How many commits there really are, which `subjects` may be capped below. */
  totalCommits: number;
  files: { filename: string; additions: number; deletions: number }[];
  /** True when GitHub capped the file list (it stops at 300). */
  filesTruncated: boolean;
}

/**
 * Whether there is anything here worth describing.
 *
 * The guard that keeps a model from being asked to summarise nothing. Handed an empty
 * change set it does not answer "nothing to say" — it hedges, at length: *"No commit or
 * file information was provided, so specifics cannot be confirmed. Based on the branch
 * name, this appears to relate to… A reviewer should check the actual diff."* That is worse
 * than an empty description in every way: it fills the space a reader scans, says nothing,
 * and speculates from the branch name. An empty body is honest and costs nothing to read.
 */
export function hasMaterialToDescribe(
  summary: ChangeSummary | null,
): summary is ChangeSummary {
  if (!summary) return false;
  if (summary.totalCommits > 0) return true;
  // A comparison can carry files without commits when the range is odd; either is enough.
  return summary.subjects.length > 0 || summary.files.length > 0;
}

export function staticPrBody(direction: MergeDirection, summary: ChangeSummary | null): string {
  if (direction === 'sync') return '';
  if (!hasMaterialToDescribe(summary)) return '';

  const lines: string[] = [];
  const shown = summary.subjects.slice(0, 20);
  for (const subject of shown) lines.push(`- ${subject}`);
  if (summary.totalCommits > shown.length) {
    lines.push(`- …and ${summary.totalCommits - shown.length} more commits`);
  }
  const fileCount = summary.files.length;
  if (fileCount > 0) {
    lines.push('');
    lines.push(`${fileCount}${summary.filesTruncated ? '+' : ''} files changed.`);
  }
  return lines.join('\n');
}

export interface ComposedPr {
  title: string;
  body: string;
}

/**
 * Normalise a model-written title into one line fit for a PR.
 *
 * Strips the wrapping quotes and backticks a model reaches for when asked for a title,
 * and any leading "Title:" it echoed back, then caps the length.
 */
export function normaliseTitle(raw: string): string {
  let title = raw.trim().split('\n')[0]?.trim() ?? '';
  title = title.replace(/^title:\s*/i, '').trim();
  title = title.replace(/^["'`]+|["'`]+$/g, '').trim();
  title = title.replace(/\s+/g, ' ');
  if (title.length > MAX_TITLE_LENGTH) title = `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
  return title;
}

/**
 * Neutralise the two references that would do something on their own.
 *
 * `Fixes #123` in a merged pull request **closes issue 123**, and `@someone` notifies a
 * real person — so a number or handle the model invented, or lifted out of an unrelated
 * commit subject, has consequences outside this app. The prompt forbids both; this does
 * not trust it to have worked.
 *
 * Wrapped in backticks rather than deleted: the text stays readable and the reader can
 * see what was claimed, while GitHub stops treating it as a reference. Content already
 * inside a code span is left alone, since it is inert there already.
 */
export function defangReferences(body: string): string {
  // Split on code spans so the substitution never reaches inside one — and never nests a
  // second pair of backticks, which would break the span it landed in.
  return body
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith('`')
        ? part
        : part
            .replace(/(^|[^\w/`])#(\d+)\b/g, '$1`#$2`')
            .replace(/(^|[^\w/`])@([A-Za-z0-9][A-Za-z0-9-]*)/g, '$1`@$2`'),
    )
    .join('');
}

/**
 * Split the model's reply into a title and a body.
 *
 * Never fails: unlike the failure analysis, where a reply without markers means there is
 * no answer, here the pull request is the product and the prose is decoration. A reply
 * that ignored the contract still becomes a description, under the title we would have
 * used anyway — `fallbackTitle` is what makes that possible, so this always returns
 * something openable.
 */
export function parseComposedPr(reply: string, fallbackTitle: string): ComposedPr {
  const titleAt = reply.indexOf(TITLE_MARKER);
  const bodyAt = reply.indexOf(BODY_MARKER);

  if (titleAt === -1 && bodyAt === -1) {
    return { title: fallbackTitle, body: defangReferences(reply.trim()) };
  }

  const rawTitle =
    titleAt === -1
      ? ''
      : reply.slice(titleAt + TITLE_MARKER.length, bodyAt === -1 ? undefined : bodyAt);
  const rawBody = bodyAt === -1 ? '' : reply.slice(bodyAt + BODY_MARKER.length);

  const title = normaliseTitle(rawTitle) || fallbackTitle;
  return { title, body: defangReferences(rawBody.trim()) };
}

/* ------------------------------------------------------------------ progress ---- */

/**
 * What `mergeable_state` means, in a sentence.
 *
 * This is the field that answers "why is this sitting there", and it is the only part of
 * the progress display that isn't already solved elsewhere in the app. The set is
 * undocumented and GitHub extends it, so an unrecognised value gets a truthful
 * placeholder rather than being forced into one of the known cases.
 */
export function mergeVerdict(pr: PullRequest): { text: string; tone: 'ok' | 'wait' | 'stuck' } {
  if (pr.merged_at || pr.merged) return { text: 'Merged', tone: 'ok' };
  if (pr.state === 'closed') return { text: 'Closed without merging', tone: 'stuck' };
  if (pr.draft) return { text: 'Draft — mark it ready to merge it', tone: 'wait' };

  switch (pr.mergeable_state) {
    case 'clean':
      return { text: 'Ready to merge', tone: 'ok' };
    case 'blocked':
      return { text: 'Waiting on required checks or a review', tone: 'wait' };
    case 'behind':
      return { text: 'Behind the base branch — needs updating first', tone: 'wait' };
    case 'unstable':
      return { text: 'Some checks failed, but none of them are required', tone: 'ok' };
    case 'dirty':
      return { text: 'Conflicts — this one needs a working copy', tone: 'stuck' };
    case 'has_hooks':
      return { text: 'Ready to merge (a pre-receive hook will run)', tone: 'ok' };
    case 'unknown':
    case undefined:
      return { text: 'GitHub is still working out whether this can merge', tone: 'wait' };
    default:
      return { text: `GitHub reports "${pr.mergeable_state}"`, tone: 'wait' };
  }
}

export type StageState = 'done' | 'active' | 'pending' | 'stuck';

export interface MergeStage {
  id: 'opened' | 'checks' | 'mergeable' | 'armed' | 'merged';
  label: string;
  state: StageState;
  /** A count, a reason — whatever makes this stage's state legible. */
  detail?: string;
}

/** How many check runs are finished, and how many of those went badly. */
export function checkCounts(checkRuns: CheckRun[]): {
  total: number;
  done: number;
  failed: number;
} {
  let done = 0;
  let failed = 0;
  for (const run of checkRuns) {
    if (run.status !== 'completed') continue;
    done++;
    if (run.conclusion === 'failure' || run.conclusion === 'timed_out') failed++;
  }
  return { total: checkRuns.length, done, failed };
}

/**
 * The merge, as a list of stages.
 *
 * The point is to answer "where has this stopped" without making anyone read three
 * separate badges and infer it. Auto-merge is shown as a stage rather than a label
 * because for these pull requests it is the mechanism by which they land: a PR that is
 * armed and green is *finished* as far as anyone here is concerned, and one that is green
 * and unarmed is waiting for a person.
 */
export function mergeStages(
  pr: PullRequest,
  checkRuns: CheckRun[],
  combined: CombinedStatus | null,
  checksFetched: boolean,
): MergeStage[] {
  const merged = Boolean(pr.merged_at || pr.merged);
  const overall: OverallStatus = combineChecksAndStatus(checkRuns, combined);
  const counts = checkCounts(checkRuns);
  const verdict = mergeVerdict(pr);

  const opened: MergeStage = {
    id: 'opened',
    label: 'Pull request opened',
    state: 'done',
    detail: `#${pr.number}`,
  };

  const checks: MergeStage = {
    id: 'checks',
    label: 'Checks',
    state: !checksFetched
      ? 'pending'
      : counts.total === 0
        ? 'done'
        : counts.failed > 0
          ? 'stuck'
          : counts.done < counts.total
            ? 'active'
            : 'done',
    detail: !checksFetched
      ? undefined
      : counts.total === 0
        ? 'none required'
        : counts.failed > 0
          ? `${counts.failed} failed of ${counts.total}`
          : `${counts.done} of ${counts.total} passed`,
  };

  const mergeable: MergeStage = {
    id: 'mergeable',
    label: 'Mergeable',
    state: merged
      ? 'done'
      : verdict.tone === 'stuck'
        ? 'stuck'
        : pr.mergeable_state === 'clean' ||
            pr.mergeable_state === 'unstable' ||
            pr.mergeable_state === 'has_hooks'
          ? 'done'
          : pr.mergeable == null
            ? 'active'
            : 'pending',
    detail: merged ? undefined : verdict.text,
  };

  const armed: MergeStage = {
    id: 'armed',
    label: 'Auto-merge',
    state: merged ? 'done' : pr.auto_merge ? 'done' : 'pending',
    detail: pr.auto_merge
      ? `enabled · ${pr.auto_merge.merge_method}`
      : merged
        ? undefined
        : overall === 'failure'
          ? 'off — checks are failing'
          : 'off',
  };

  const mergedStage: MergeStage = {
    id: 'merged',
    label: 'Merged',
    state: merged ? 'done' : pr.state === 'closed' ? 'stuck' : 'pending',
    detail: pr.state === 'closed' && !merged ? 'closed without merging' : undefined,
  };

  return [opened, checks, mergeable, armed, mergedStage];
}

/**
 * Whether arming auto-merge is the right move for this pull request.
 *
 * GitHub only permits auto-merge on a pull request it **cannot merge right now**; arming
 * a clean one is refused outright. So this is not a preference — it decides between two
 * different API calls, and getting it wrong means a write that always fails.
 */
export function autoMergeIsAvailable(pr: PullRequest): boolean {
  if (pr.auto_merge) return false;
  if (pr.state !== 'open') return false;
  // `clean` is the refusal case; anything blocked, behind or unstable can be queued.
  return pr.mergeable_state !== 'clean' && pr.mergeable_state !== 'has_hooks';
}

/* ------------------------------------------------------------------ what next ---- */

/** Where the fork's copy stands, as the tab computes it. Mirrors ForkStanding. */
export interface StandingFacts {
  state: 'identical' | 'behind' | 'ahead' | 'diverged' | 'unknown';
  behindBy: number;
  aheadBy: number;
  ownCommits: number;
  filesDiffering: number | null;
}

/** Just enough of a tracked pull request to decide what it needs. */
export interface PullFacts {
  pr: PullRequest;
  overall: OverallStatus;
}

export interface NextStep {
  /** One imperative line: the thing to do. */
  text: string;
  /** Which control it points at, so the card can mark it. `none` = nothing to press. */
  target: 'sync' | 'pull' | 'offer' | 'arm' | 'none';
  tone: 'ok' | 'action' | 'stuck';
}

/**
 * What to do about this branch, in one line.
 *
 * Derived, not written by a model: everything it needs is already in hand — the standing and
 * the two pull requests — and a recommendation that arrived a few seconds later, cost a
 * model call and might hedge would be worse than one computed from the same facts the card
 * is already showing.
 *
 * The order is the point. An open pull request outranks the branch's standing, because
 * whatever is wrong with it blocks everything behind it; and among the standings, getting
 * current outranks offering, since offering from a stale branch is how conflicts are made.
 *
 * The counts deliberately do not decide anything on their own. After a **squash merge** the
 * fork keeps its original commits under different SHAs, so git reports a divergence for work
 * that is already upstream — which is exactly the case that reads as "you still have two
 * commits to send" when the honest answer is "nothing to do".
 */
export function nextStep(
  standing: StandingFacts,
  offer: PullFacts | null,
  sync: PullFacts | null,
): NextStep {
  // 1. The offer, if one is open: it is the work in flight, and it comes first.
  if (offer) {
    const n = offer.pr.number;
    if (offer.pr.mergeable === false || offer.pr.mergeable_state === 'dirty') {
      return { text: `Resolve the conflicts on #${n}`, target: 'none', tone: 'stuck' };
    }
    if (offer.overall === 'failure') {
      return { text: `Fix the failing checks on #${n}`, target: 'none', tone: 'stuck' };
    }
    if (offer.pr.auto_merge) {
      return { text: `Nothing to do — #${n} merges when its checks pass`, target: 'none', tone: 'ok' };
    }
    return { text: `Enable auto-merge on #${n}`, target: 'arm', tone: 'action' };
  }

  // 2. A backmerge in flight blocks the branch itself, not you.
  if (sync && sync.overall === 'failure') {
    return {
      text: `Fix the failing checks on #${sync.pr.number}, the incoming backmerge`,
      target: 'none',
      tone: 'stuck',
    };
  }

  // 3. Otherwise the standing decides.
  switch (standing.state) {
    case 'unknown':
      return {
        text: 'Could not compare the two copies — open the branch on GitHub',
        target: 'none',
        tone: 'stuck',
      };
    case 'identical':
      return { text: 'Nothing to do', target: 'none', tone: 'ok' };
    case 'behind':
      return { text: 'Pull it into your fork', target: 'pull', tone: 'action' };
    case 'diverged':
      if (standing.filesDiffering === 0) {
        return {
          text: 'Already merged upstream — pull to line the histories up',
          target: 'pull',
          tone: 'ok',
        };
      }
      // Get current first: offering from a stale branch is how conflicts are made.
      return { text: 'Pull it into your fork, then commit your changes', target: 'pull', tone: 'action' };
    case 'ahead':
      if (standing.filesDiffering === 0 || standing.ownCommits === 0) {
        return { text: 'Nothing to do', target: 'none', tone: 'ok' };
      }
      return { text: 'Commit your changes to the upstream', target: 'offer', tone: 'action' };
  }
}

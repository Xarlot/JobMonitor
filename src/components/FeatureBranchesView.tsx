/**
 * The Feature branches tab: one card per branch shared by the fork and the upstream, with
 * the state of the work moving in and out of it and the three actions that move it.
 *
 * The tab's reason for existing is the **stage strip** — the row of steps under each pull
 * request. A pull request that is "open" tells you nothing; a pull request that is open,
 * green, mergeable and unarmed tells you it is waiting for a person, and one that is open,
 * green and armed tells you to stop looking at it. That distinction is what the PR list
 * cannot show for these, because both their ends are in the upstream and its fork-head
 * filter excludes them entirely.
 *
 * Actions hide themselves when the token cannot write, as every other write control here
 * does — but the tab still renders, because reading where something is stuck is worth
 * doing with a read-only token.
 */

import { useMemo, useState } from 'react';
import { BranchName, Button, Flash, Heading, IconButton, Label, Link, Spinner, Text } from '@primer/react';
import { Tooltip } from '@primer/react/next';
import {
  AlertIcon,
  ArrowDownIcon,
  CheckCircleFillIcon,
  CheckIcon,
  CopyIcon,
  LinkExternalIcon,
  DotFillIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  RepoForkedIcon,
  SyncIcon,
  XCircleFillIcon,
} from '@primer/octicons-react';
import { useConfig } from '../context/ConfigContext';
import { useDashboard } from '../context/DashboardContext';
import { useNavigation } from '../context/NavigationContext';
import { useFeatureBranchesState } from '../context/FeatureBranchesContext';
import type { FeatureBranchRow, ForkStanding, MainStanding } from '../hooks/useFeatureBranches';
import { useCopy } from '../hooks/useCopy';
import { useTokenCapability } from '../hooks/useTokenCapability';
import type { PrEntry } from '../hooks/useGitHubDashboard';
import { mergeStages, nextStep, type MergeStage, type NextStep } from '../lib/featureBranch';
import { forkRepo } from '../storage/configStore';
import { FeatureBranchActionDialog, type PendingAction } from './FeatureBranchActionDialog';
import { StatusBadge } from './StatusBadge';
import styles from './FeatureBranchesView.module.css';
import { Icon } from './Icon';
import { tooltipWrap } from '../lib/tooltipWrap';

const STAGE_ICON = {
  done: { icon: CheckCircleFillIcon, color: 'var(--fgColor-success)' },
  stuck: { icon: XCircleFillIcon, color: 'var(--fgColor-danger)' },
  pending: { icon: DotFillIcon, color: 'var(--fgColor-muted)' },
} as const;

/** Nothing-to-do is quiet, something-to-do is emphasised, something-wrong is red. */
const STEP_TONE: Record<NextStep['tone'], string> = {
  ok: 'var(--fgColor-muted)',
  action: 'var(--fgColor-accent)',
  stuck: 'var(--fgColor-danger)',
};

/** How many, and which way. */
function plural(n: number): string {
  return n === 1 ? '1 commit' : `${n} commits`;
}

/**
 * Say where the fork stands in words someone can act on.
 *
 * The point of the counts: "at a different commit" described being three commits behind and
 * having diverged forty commits ago identically, and those want opposite things — the first
 * wants the sync button pressed, the second warns that pressing it writes a merge commit.
 */
/**
 * How far the shared branch trails the branch it will merge into.
 *
 * Deliberately silent when the branch is level or ahead. A row that says "up to date with 2026.1"
 * on every branch that is fine trains people to stop reading the line, and this line only earns its
 * place when it is telling you something you would act on. Behind is the only such state: it is what
 * the "bring the default branch in" action is for, and it is what makes a long-lived branch
 * gradually stop being mergeable.
 */
export function describeMainStanding(
  standing: MainStanding | null,
  defaultBranch: string,
): string | null {
  if (!standing || standing.behindBy === 0) return null;
  // `diverged` also lands here, and correctly: the branch is behind *and* ahead, and the part worth
  // saying on one line is the part that is going to get worse on its own.
  return `${plural(standing.behindBy)} behind ${defaultBranch}`;
}

export function describeStanding(standing: ForkStanding): string {
  /**
   * Content, not history, when the two disagree.
   *
   * A **squash merge** rewrites the contributed commits into one new commit, so the branch
   * that contributed them keeps the originals under different SHAs and git calls it a
   * divergence. "2 commits of your own ahead" then describes work that is already upstream,
   * which is the opposite of what it sounds like. Saying no file differs settles it — and
   * where files *do* differ, saying how many is more use than the commit counts alone.
   */
  const identicalContent = standing.filesDiffering === 0;
  const files =
    standing.filesDiffering == null
      ? ''
      : ` (${standing.filesDiffering === 1 ? '1 file differs' : `${standing.filesDiffering} files differ`})`;

  switch (standing.state) {
    case 'identical':
      return 'your fork matches the upstream';
    case 'behind':
      return `your fork is ${plural(standing.behindBy)} behind`;
    case 'ahead':
      if (identicalContent) return 'your fork matches the upstream — its extra commits change nothing';
      return standing.ownCommits > 0
        ? `your fork is up to date, plus ${plural(standing.ownCommits)} of your own${files}`
        : `your fork is up to date, plus a merge commit from syncing${files}`;
    case 'diverged':
      if (identicalContent) {
        // The squash-merge case, said plainly: nothing to do, whatever the counts say.
        return 'same content as the upstream — only the commits differ, from a squash merge';
      }
      return `diverged — ${plural(standing.behindBy)} behind, ${plural(standing.ownCommits)} of your own ahead${files}`;
    case 'unknown':
      return 'your fork is at a different commit';
  }
}

/**
 * What pulling into the fork will actually do, given where it stands.
 *
 * Deliberately not a repeat of `describeStanding` — that sentence is already on the card
 * beside the button. What the tooltip adds is the consequence, and one of these is
 * irreversible while the others are nothing at all.
 */
function describeSyncConsequence(standing: ForkStanding): string {
  switch (standing.state) {
    case 'behind':
      return 'It can be fast-forwarded, so no merge commit.';
    case 'diverged':
      return 'It cannot be fast-forwarded, so GitHub will write a merge commit into your fork — which nothing here can undo.';
    case 'ahead':
      return 'Your copy already has everything the upstream does, so there is nothing to bring down. Commit your changes instead.';
    case 'identical':
      return 'It is already level, so this will report that there was nothing to do.';
    case 'unknown':
      return 'How the two relate could not be read, so this may fast-forward or may write a merge commit.';
  }
}

/**
 * Whether each direction has anything to move, given where the two copies stand.
 *
 * The standing is already known, so an action that can only report "there was nothing to do"
 * is disabled rather than offered — a button whose single possible outcome is a shrug is
 * worse than an absent one, and here it would also spend a write to find out.
 *
 * `unknown` leaves both enabled: the comparison failed, so "nothing to do" is a guess, and
 * guessing in the direction of disabling would hide a working action.
 */
function nothingToPullFor(standing: ForkStanding): boolean {
  return standing.state === 'identical' || standing.state === 'ahead';
}

function nothingToOfferFor(standing: ForkStanding): boolean {
  // Behind means the upstream has commits you lack and you have none it lacks — so there is
  // something to pull and nothing to offer. The mirror image of the case above.
  if (standing.state === 'identical' || standing.state === 'behind') return true;
  // And after a squash merge the histories diverge while the content does not: a pull
  // request from here would carry commits but change no file, which is nothing to offer.
  return standing.filesDiffering === 0;
}

/**
 * One action, as an icon carrying its own explanation.
 *
 * The tooltip is the point, not a courtesy. These four buttons each write to a repository,
 * and three of them involve two branches in two repositories — which no icon and no button
 * label can convey. `label` is the short name and the accessible name; `description` is the
 * sentence naming both ends of what is about to happen, including *why* it is unavailable
 * when it is, since a disabled control that explains nothing is a dead end.
 */
function ActionIcon({
  icon,
  label,
  description,
  disabled,
  suggested,
  onClick,
}: {
  icon: typeof SyncIcon;
  label: string;
  description: string;
  disabled?: boolean;
  /** The one the recommendation points at, so reading it and finding it are one step. */
  suggested?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`${tooltipWrap} ${styles.tipWide}`}
    >
      <Tooltip text={`${label}\n${description}`} type="description">
        {/*
          A disabled button reports nothing to a pointer, so the tooltip would never appear
          on the very controls whose explanation matters most. Kept enabled and inert
          instead: aria-disabled tells assistive technology, and the handler declines.
        */}
        <IconButton
          icon={icon}
          aria-label={label}
          aria-disabled={disabled || undefined}
          variant={suggested ? 'primary' : 'invisible'}
          size="small"
          className={disabled ? styles.disabled : undefined}
          onClick={() => {
            if (!disabled) onClick();
          }}
        />
      </Tooltip>
    </div>
  );
}

/** One step of a merge. `active` spins, because something is genuinely happening. */
function Stage({ stage }: { stage: MergeStage }) {
  const style = stage.state === 'active' ? null : STAGE_ICON[stage.state];
  return (
    <div className={styles.flexCenter}>
      {style ? (
        <Icon icon={style.icon} size={16} style={{ color: style.color }} />
      ) : (
        <Spinner size="small" className={styles.width} />
      )}
      <Text
        className={stage.state === 'pending' ? styles.stagePending : styles.stage}
      >
        {stage.label}
      </Text>
      {stage.detail && (
        <Text className={stage.state === 'stuck' ? styles.stageNoteStuck : styles.stageNote}>
          {stage.detail}
        </Text>
      )}
    </div>
  );
}

/** A pull request and how far it has got. */
function PrProgress({
  entry,
  label,
  onOpenPr,
}: {
  entry: PrEntry;
  label: string;
  /** Absent when this pull request is not one the Pull requests tab can show. */
  onOpenPr?: () => void;
}) {
  const { copied, failed, copy } = useCopy();
  const stages = mergeStages(
    entry.pr,
    entry.checkRuns,
    entry.combined,
    entry.checksUpdatedAt !== null,
  );
  return (
    <div className={styles.p3}>
      <div className={styles.flexCenter2}>
        <GitPullRequestIcon size={16} className={styles.fgMuted} />
        {/* Not uppercased, however much it reads like a section heading: it is a pair of
            branch names, and git branch names are case-sensitive. */}
        <Text className={styles.smallFgMuted}>{label}</Text>
        <Link
          href={entry.pr.html_url}
          target="_blank"
          rel="noreferrer"
          className={styles.boldFgDefault}
        >
          {entry.pr.title}
        </Link>
        <Text className={styles.smallFgMuted2}>#{entry.pr.number}</Text>
        <StatusBadge status={entry.overall} />
        {entry.pr.auto_merge && (
          <Label variant="done">
            <GitMergeIcon size={12} /> auto-merge
          </Label>
        )}
        <div className={styles.grow} />
        {/*
          Where to go next with this pull request. Read-only, so unlike the write actions
          above they are offered whatever the token can do.
        */}
        <div className={styles.flexGap1}>
          {onOpenPr && (
            <ActionIcon
              icon={GitPullRequestIcon}
              label={`Show #${entry.pr.number} in Pull requests`}
              description="Switches to the Pull requests tab, opens this one and scrolls to it — for the checks, the logs and the failure reports, which live there."
              onClick={onOpenPr}
            />
          )}
          <ActionIcon
            icon={LinkExternalIcon}
            label={`Open #${entry.pr.number} on GitHub`}
            description={entry.pr.html_url}
            onClick={() => window.open(entry.pr.html_url, '_blank', 'noopener,noreferrer')}
          />
          <ActionIcon
            icon={copied ? CheckIcon : CopyIcon}
            label={
              copied
                ? 'Link copied'
                : failed
                  ? 'Could not copy — the clipboard is unavailable'
                  : `Copy the link to #${entry.pr.number}`
            }
            description={failed ? `Copy it by hand: ${entry.pr.html_url}` : entry.pr.html_url}
            onClick={() => copy(entry.pr.html_url)}
          />
        </div>
      </div>

      <div
        className={styles.flexBgCanvasSubtle}
      >
        {stages.map((stage) => (
          <Stage key={stage.id} stage={stage} />
        ))}
      </div>

      {entry.checksError && (
        <Flash variant="warning" className={styles.smallMt2}>
          The checks could not be read: {entry.checksError}
        </Flash>
      )}
    </div>
  );
}

function BranchCard({
  row,
  defaultBranch,
  canWrite,
  canSyncFork,
  canMergeCommit,
  onAct,
  onOpenPr,
  shownInPrTab,
}: {
  row: FeatureBranchRow;
  defaultBranch: string;
  canWrite: boolean;
  canSyncFork: boolean;
  /** The repository permits merge commits, which the backmerge direction requires. */
  canMergeCommit: boolean;
  onAct: (action: PendingAction) => void;
  onOpenPr?: (prNumber: number) => void;
  /** Pull request numbers the Pull requests tab lists, so a jump can't be a dead end. */
  shownInPrTab: Set<number>;
}) {
  const { branch, sync, offer } = row;
  const step = nextStep(
    row.standing,
    offer ? { pr: offer.pr, overall: offer.overall } : null,
    sync ? { pr: sync.pr, overall: sync.overall } : null,
  );
  const behindMain = describeMainStanding(row.mainStanding, defaultBranch);
  const nothingToPull = nothingToPullFor(row.standing);
  const nothingToOffer = nothingToOfferFor(row.standing);
  const jumpTo = (entry: PrEntry) =>
    onOpenPr && shownInPrTab.has(entry.pr.number) ? () => onOpenPr(entry.pr.number) : undefined;
  /**
   * There is no "merge now" here, deliberately.
   *
   * Landing directly in a feature branch is forbidden by the repository, so this tab only
   * ever opens a pull request and arms auto-merge — GitHub does the merging. A button that
   * merged on the spot would be a route around the rule the branch protection exists to
   * enforce.
   */

  return (
    <div className={styles.card}>
      <div
        className={styles.flexCenter3}
      >
        <BranchName as="span" className={styles.body}>
          {branch.name}
        </BranchName>
        {/*
          What to do, first and in plain words; the standing that justifies it second and
          quieter. The counts used to lead, and they describe rather than advise — worse,
          after a squash merge they describe it wrongly.
        */}
        <div className={styles.flexGap2}>
          <Text
            className={styles.step} style={{ color: STEP_TONE[step.tone] }}
          >
            {step.text}
          </Text>
          <Text className={styles.smallFgMuted2}>{describeStanding(row.standing)}</Text>
          {behindMain && (
            /*
              Warning-coloured, and only present when it applies. A branch drifting behind the
              branch it merges into is the one thing on this row that gets worse while nobody is
              looking — the fork standing above it only changes when somebody pushes.
            */
            <Label variant="attention">{behindMain}</Label>
          )}
        </div>
        <div className={styles.grow} />
        {canWrite && (
          <div className={styles.flexGap1_2}>
            {/*
              The three legs of the loop, in the order they happen: the branch is fed from
              the default branch, then pulled down to the fork, then offered back.

              Icons rather than labels, because four labelled buttons naming two branches
              filled the row and still read alike ("Sync from main" beside "Ship to main").
              The tooltip carries the whole sentence, which a button label could not — each
              one names both ends of what it is about to do, since that is the thing worth
              being certain of before pressing.
            */}
            <ActionIcon
              icon={ArrowDownIcon}
              label={`Bring ${defaultBranch} into ${branch.name}`}
              description={
                canMergeCommit
                  ? `Opens a pull request from ${defaultBranch} into ${branch.name} in the upstream and arms auto-merge, so GitHub lands it once the required checks pass. Nothing is merged here.`
                  : 'Unavailable: this repository does not allow merge commits, and a backmerge cannot be done any other way without rewriting shared history.'
              }
              disabled={!canMergeCommit}
              suggested={step.target === 'sync'}
              onClick={() => onAct({ kind: 'sync', branch: branch.name })}
            />
            <ActionIcon
              icon={RepoForkedIcon}
              label={`Pull ${branch.name} into your fork`}
              description={
                !canSyncFork
                  ? 'Unavailable: your fork is not a fork of the configured upstream, so GitHub would sync it from somewhere else.'
                  : nothingToPull
                    ? `Unavailable: ${describeStanding(row.standing)}, so there is nothing to bring down.`
                    : `Updates your fork's ${branch.name} to match the upstream's. ${describeSyncConsequence(row.standing)}`
              }
              disabled={!canSyncFork || nothingToPull}
              suggested={step.target === 'pull'}
              onClick={() => onAct({ kind: 'pull', branch: branch.name })}
            />
            {/*
              Opening the offer and queueing it are two different actions, not one button
              with two labels: with a pull request already open there is nothing to write,
              and its text is left alone rather than replaced.
            */}
            {!offer ? (
              <ActionIcon
                icon={GitPullRequestIcon}
                label={`Commit your ${branch.name} to the upstream`}
                description={
                  nothingToOffer
                    ? `Unavailable: ${describeStanding(row.standing)} — a pull request from here would change no file.`
                    : `Opens a pull request from your fork's ${branch.name} into the upstream's, with a title and description written for you to edit first.`
                }
                disabled={nothingToOffer}
                suggested={step.target === 'offer'}
                onClick={() => onAct({ kind: 'offer', branch: branch.name })}
              />
            ) : !offer.pr.auto_merge ? (
              <ActionIcon
                icon={GitMergeIcon}
                label="Enable auto-merge"
                description={`Lets GitHub merge #${offer.pr.number} when its checks pass. Its title and description are left as they are.`}
                suggested={step.target === 'arm'}
                onClick={() => onAct({ kind: 'arm', branch: branch.name })}
              />
            ) : null}
          </div>
        )}
      </div>

      {sync && (
        <PrProgress
          entry={sync}
          label={`${defaultBranch} → ${branch.name}`}
          onOpenPr={jumpTo(sync)}
        />
      )}
      {offer && (
        <PrProgress
          entry={offer}
          label={`your ${branch.name} → upstream's ${branch.name}`}
          onOpenPr={jumpTo(offer)}
        />
      )}
      {!sync && !offer && (
        <div className={styles.px3Pb3}>
          <Text className={styles.smallFgMuted2}>
            No open pull request into this branch.
          </Text>
        </div>
      )}
    </div>
  );
}

/** Why the fork sync is unavailable, said plainly rather than as a disabled button. */
function ForkParentWarning({ problem }: { problem: NonNullable<ReturnType<typeof describeProblem>> }) {
  return (
    <Flash variant="warning" className={styles.mb3Body}>
      <AlertIcon /> {problem}
    </Flash>
  );
}

function describeProblem(
  state: ReturnType<typeof useFeatureBranchesState>['forkParent'],
): string | null {
  if (!state || state.ok || !state.problem) return null;
  const p = state.problem;
  switch (p.kind) {
    case 'not-a-fork':
      return `“Pull into my fork” is unavailable: GitHub doesn't consider ${p.forkSlug} a fork of anything, so there is no upstream for it to sync from.`;
    case 'wrong-parent':
      return `“Pull into my fork” is unavailable: ${p.forkSlug} was forked from ${
        p.actualParent || 'an unknown repository'
      }, not ${p.expected}. Syncing would pull from the wrong repository, and GitHub gives no way to say otherwise.`;
    case 'unreadable':
      return `“Pull into my fork” is unavailable: your fork could not be read (${p.message}).`;
  }
}

export function FeatureBranchesView() {
  const { config } = useConfig();
  const capability = useTokenCapability();
  const state = useFeatureBranchesState();
  const dashboard = useDashboard();
  const navigation = useNavigation();
  const [pending, setPending] = useState<PendingAction | null>(null);

  /**
   * Which of these pull requests the Pull requests tab can actually show.
   *
   * Asked of the dashboard's own list rather than worked out from the config, because that
   * list *is* the answer — it applies the fork-owner, branch and author filters, and
   * re-deriving them here would be a second implementation free to disagree. The offer
   * usually qualifies (its head is in the fork); the incoming backmerge never does (its head
   * is in the upstream). A button that jumped to a list without the pull request in it would
   * be a dead end, so it is not offered.
   */
  const shownInPrTab = useMemo(
    () => new Set(dashboard.prs.map((e) => e.pr.number)),
    [dashboard.prs],
  );

  const defaultBranch = state.repo?.defaultBranch ?? 'main';
  const forkProblem = describeProblem(state.forkParent);
  const canSyncFork = state.forkParent?.ok === true;

  return (
    <div>
      <div className={styles.flexCenter4}>
        <Heading as="h2" className={styles.title}>
          Feature branches
        </Heading>
        <Text className={styles.smallFgMuted2}>
          Branches under <code>{config.featureBranches.prefix}</code> that exist in both{' '}
          {config.upstream.owner}/{config.upstream.repo} and {config.fork.owner}/
          {forkRepo(config)}
        </Text>
        <div className={styles.grow} />
        {(state.isFetchingList || state.isFetchingChecks) && <Spinner size="small" />}
        <Button size="small" leadingVisual={SyncIcon} onClick={state.refreshAll}>
          Refresh
        </Button>
      </div>

      {state.listError && (
        <Flash variant="danger" className={styles.mb3}>
          {state.listError.message}
        </Flash>
      )}

      {forkProblem && <ForkParentWarning problem={forkProblem} />}

      {/*
        Both are read from the repository up front rather than discovered from a refused
        mutation, because by the time GitHub refuses it the pull request already exists.
      */}
      {state.repo && !state.repo.allowMergeCommit && (
        <Flash variant="warning" className={styles.mb3Body}>
          <AlertIcon /> This repository doesn't allow merge commits, so
          “Sync from {defaultBranch}” is unavailable: bringing the default branch into a feature
          branch any other way would rewrite history the two repositories share.
        </Flash>
      )}
      {state.repo && !state.repo.allowAutoMerge && (
        <Flash variant="warning" className={styles.mb3Body}>
          <AlertIcon /> Auto-merge is switched off for this repository, so pull
          requests opened here will stay open until someone merges them. Everything else works.
        </Flash>
      )}

      {!capability.canRerun && (
        <Flash className={styles.mb3Body}>
          This token can't write to the repository, so the actions are hidden. Everything below
          is still live.
        </Flash>
      )}

      {state.truncated && (
        <Flash variant="warning" className={styles.mb3Body}>
          More feature branches exist than are shown. Only the first 25 are tracked, so that a
          repository with a great many of them can't spend the whole rate limit here.
        </Flash>
      )}

      {state.rows.length === 0 ? (
        <Flash variant="default">
          {state.listUpdatedAt === null ? (
            'Looking for feature branches…'
          ) : (
            <>
              No branch under <code>{config.featureBranches.prefix}</code> exists in both{' '}
              <strong>
                {config.upstream.owner}/{config.upstream.repo}
              </strong>{' '}
              and{' '}
              <strong>
                {config.fork.owner}/{forkRepo(config)}
              </strong>
              . A branch has to be in your fork as well as the upstream to appear here.
              {/*
                Naming both repositories because GitHub answers 404 for "no matching refs"
                and for "no such repository" alike — so a mistyped fork name produces this
                same reassuring sentence, and without the names there is nothing to notice.
              */}
              {' '}If that fork name looks wrong, check <strong>Settings → Repository</strong>.
            </>
          )}
        </Flash>
      ) : (
        state.rows.map((row) => (
          <BranchCard
            key={row.branch.name}
            row={row}
            defaultBranch={defaultBranch}
            canWrite={capability.canRerun}
            canSyncFork={canSyncFork}
            canMergeCommit={state.repo?.allowMergeCommit ?? true}
            onAct={setPending}
            onOpenPr={navigation ? (n: number) => navigation.openPr(n) : undefined}
            shownInPrTab={shownInPrTab}
          />
        ))
      )}

      {pending && (
        <FeatureBranchActionDialog
          action={pending}
          defaultBranch={defaultBranch}
          onClose={() => setPending(null)}
          onDone={state.refreshAll}
        />
      )}
    </div>
  );
}

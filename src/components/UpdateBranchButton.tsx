/**
 * "Update branch" for a pull request — GitHub's button of the same name, beside the re-run one.
 *
 * It swallows the row click, owns its dialog, and renders nothing unless the token is known to
 * permit writes.
 *
 * The PR list does not say whether a branch is behind (`mergeable_state` is single-PR only, and
 * reads `behind` only when the base requires up-to-date branches), so the button asks a
 * comparison itself and shows the count on a badge.
 *
 * Shaped like the review-comments button beside it: a menu of the two ways to update, each with
 * what it does underneath, then a small dialog that confirms and shows the outcome — an update
 * starts a fresh round of CI, and a rebase rewrites the PR's commits.
 */

import { useEffect, useMemo, useState } from 'react';
import { ActionList, ActionMenu, Button, Flash, IconButton, Spinner, Text } from '@primer/react';
import { GitCommitIcon, GitMergeIcon, RepoPullIcon } from '@primer/octicons-react';
import { comparePath } from '../api/endpoints';
import { ghGet } from '../api/githubClient';
import type { Comparison, PullRequest } from '../api/types';
import { updatePullRequestBranch, type UpdateBranchMethod } from '../api/updateBranch';
import { useTokenCapability } from '../hooks/useTokenCapability';
import { useDashboard } from '../context/DashboardContext';
import { Modal } from './Modal';
import { Feature, Operation, Telemetry } from '../lib/telemetry';
import styles from './UpdateBranchButton.module.css';

/** How far behind the base the head is: a count, or null when it could not be told. */
type Behind = { state: 'loading' } | { state: 'known'; behindBy: number } | { state: 'unknown'; reason: string };

/**
 * How often the count is re-read from list polls. Not on every poll: on a busy repository the
 * base moves between any two polls, so each re-read would be a fresh 200 per PR, not a free 304.
 */
const BEHIND_REFRESH_MS = 10 * 60_000;

/** The list-poll time, coarsened so it changes at most once per {@link BEHIND_REFRESH_MS}. */
function slowTick(listUpdatedAt: number | null): number | null {
  return listUpdatedAt === null ? null : Math.floor(listUpdatedAt / BEHIND_REFRESH_MS);
}

/**
 * How far the PR's head is behind its base: re-read when the head moves, when the menu opens
 * (`opened`), and on the slow tick. Keeps the last answer while a new one is in flight, so the
 * badge doesn't blink.
 */
function useBehind(
  owner: string,
  repo: string,
  pr: PullRequest,
  tick: number | null,
  opened: number,
): Behind {
  const [behind, setBehind] = useState<Behind>({ state: 'loading' });
  useEffect(() => {
    // comparePath can't take a branch name with a slash; the base branch is named, not a SHA,
    // because the list's base SHA is the base as of the PR's last update, not its tip now.
    if (pr.base.ref.includes('/')) {
      setBehind({ state: 'unknown', reason: `Can't compare against ${pr.base.ref} by name.` });
      return;
    }
    let active = true;
    ghGet<Comparison>(comparePath(owner, repo, pr.base.ref, pr.head.sha))
      .then(({ data }) => active && setBehind({ state: 'known', behindBy: data.behind_by ?? 0 }))
      .catch(
        (e) =>
          active && setBehind({ state: 'unknown', reason: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      active = false;
    };
  }, [owner, repo, pr.base.ref, pr.head.sha, tick, opened]);
  return behind;
}

/** The pull icon with the behind count on a badge at its upper right. */
function BehindCountIcon({ count }: { count: number }) {
  return (
    <span className={styles.icon} aria-hidden="true">
      <RepoPullIcon size={16} />
      {count > 0 && <span className={styles.badge}>{count > 99 ? '99+' : count}</span>}
    </span>
  );
}

/** What each method does, for the menu and the confirmation. */
const METHOD: Record<UpdateBranchMethod, { label: string; title: string; describe: (base: string) => string }> = {
  MERGE: {
    label: 'With a merge commit',
    title: 'Update with a merge commit',
    describe: (base) => `Merges ${base} into this branch. The PR's own commits stay as they are.`,
  },
  REBASE: {
    label: 'With a rebase',
    title: 'Update with a rebase',
    describe: (base) =>
      `Replays this PR's commits onto ${base} and force-pushes — anyone with the branch checked out has to reset.`,
  },
};

function behindText(behind: Behind, base: string): string {
  if (behind.state === 'loading') return `Comparing with ${base}…`;
  if (behind.state === 'unknown') return `Couldn't tell how far behind ${base} it is.`;
  if (behind.behindBy === 0) return `Up to date with ${base}.`;
  return `${behind.behindBy} commit${behind.behindBy === 1 ? '' : 's'} behind ${base}.`;
}

export function UpdateBranchButton({
  owner,
  repo,
  pr,
  onUpdated,
  size = 'small',
}: {
  owner: string;
  repo: string;
  pr: PullRequest;
  /** Called after the branch is updated, to re-poll the PR list — the head SHA has moved. */
  onUpdated: () => void;
  size?: 'small' | 'medium';
}) {
  const [chosen, setChosen] = useState<UpdateBranchMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { canRerun: canWrite } = useTokenCapability();
  const { listUpdatedAt } = useDashboard();
  const live = canWrite && pr.state === 'open';
  // Opening the menu asks again, so what it says is current even between the slow re-reads.
  const [opened, setOpened] = useState(0);
  const behind = useBehind(owner, repo, pr, live ? slowTick(listUpdatedAt) : null, opened);
  const count = behind.state === 'known' ? behind.behindBy : 0;
  // IconButton takes a component, not an element; memoised so the count changing re-renders it
  // rather than mounting a new component type every render.
  const CountIcon = useMemo(() => {
    const Icon = () => <BehindCountIcon count={count} />;
    return Icon;
  }, [count]);

  // Hidden, not disabled, as the other writes are: Settings → Token carries the explanation.
  if (!live && !chosen) return null;

  const upToDate = behind.state === 'known' && behind.behindBy === 0;
  const label =
    behind.state === 'known' ? `Update branch — ${behindText(behind, pr.base.ref)}` : 'Update branch';

  const choose = (m: UpdateBranchMethod) => {
    setResult(null);
    setChosen(m);
  };
  const close = () => {
    if (busy) return;
    setChosen(null);
    setResult(null);
  };
  const update = async (method: UpdateBranchMethod) => {
    setBusy(true);
    try {
      Telemetry.featureUsed(Feature.PR_BRANCH_UPDATED);
      const head = await Telemetry.measure(Operation.GH_UPDATE_BRANCH_WRITE, () =>
        updatePullRequestBranch(pr, method),
      );
      setResult({ ok: true, message: `Branch updated — head is now ${head.slice(0, 7)}. The checks will run again.` });
      onUpdated();
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <ActionMenu onOpenChange={(o) => o && setOpened((n) => n + 1)}>
        <ActionMenu.Anchor>
          <IconButton
            size={size}
            variant="invisible"
            icon={busy ? Spinner : CountIcon}
            aria-label={label}
            disabled={busy}
          />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium">
          <ActionList>
            <ActionList.Group>
              <ActionList.GroupHeading>Update branch</ActionList.GroupHeading>
              <ActionList.Item disabled>
                <ActionList.LeadingVisual>
                  <RepoPullIcon />
                </ActionList.LeadingVisual>
                {behindText(behind, pr.base.ref)}
              </ActionList.Item>
              {(['MERGE', 'REBASE'] as const).map((m) => (
                <ActionList.Item key={m} disabled={upToDate} onSelect={() => choose(m)}>
                  <ActionList.LeadingVisual>
                    {m === 'MERGE' ? <GitMergeIcon /> : <GitCommitIcon />}
                  </ActionList.LeadingVisual>
                  {METHOD[m].label}
                  <ActionList.Description variant="block">{METHOD[m].describe(pr.base.ref)}</ActionList.Description>
                </ActionList.Item>
              ))}
            </ActionList.Group>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {chosen && (
        <Modal
          title={METHOD[chosen].title}
          subtitle={`${pr.title} · #${pr.number}`}
          width="min(480px, 94vw)"
          onClose={close}
          footer={
            <div className={styles.footer}>
              <span className={styles.grow} />
              {result?.ok || busy ? (
                <Button disabled={busy} onClick={close}>
                  Close
                </Button>
              ) : (
                <>
                  <Button onClick={close}>Cancel</Button>
                  <Button variant="primary" onClick={() => void update(chosen)}>
                    Update
                  </Button>
                </>
              )}
            </div>
          }
        >
          {busy ? (
            <Text as="p" className={styles.progress}>
              <Spinner size="small" /> Updating {pr.head.ref}…
            </Text>
          ) : result ? (
            <Flash variant={result.ok ? 'success' : 'danger'}>{result.message}</Flash>
          ) : (
            <Text as="p">
              Bring {behind.state === 'known' ? `${behind.behindBy} new commit${behind.behindBy === 1 ? '' : 's'}` : 'the new commits'} from{' '}
              <code>{pr.base.ref}</code> into <code>{pr.head.ref}</code>? {METHOD[chosen].describe(pr.base.ref)} The
              checks run again.
            </Text>
          )}
        </Modal>
      )}
    </span>
  );
}

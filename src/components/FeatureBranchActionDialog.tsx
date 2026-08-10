/**
 * The confirm-then-write dialog for the four feature-branch actions.
 *
 * Modelled on ArmDialog, and for the same reason: every one of these changes a repository
 * in a way this app cannot undo, so each states what it is about to do *before* the button
 * that does it. Where they differ is that these are multi-step — opening a pull request
 * and then queueing it are two writes — so the outcome is reported as the list of steps
 * that ran rather than as a single success or failure. "It didn't work" is not a useful
 * thing to be told when a pull request now exists.
 *
 * The offer gets an extra beat: the title and description are prepared first and shown in
 * editable fields. Whether they came from the local model or from a template, the person
 * pressing the button is the one whose name goes on the pull request, so they get to read
 * it first.
 */

import { useEffect, useState } from 'react';
import { Button, FormControl, Flash, Label, Spinner, Text, TextInput, Textarea } from '@primer/react';
import { CheckCircleFillIcon, SkipIcon, XCircleFillIcon } from '@primer/octicons-react';
import {
  armExistingPull,
  pullIntoFork,
  proposeToFeatureBranch,
  syncIntoFeatureBranch,
  type ActionOutcome,
  type ActionStep,
} from '../api/featureBranchActions';
import { useConfig } from '../context/ConfigContext';
import { useFeatureBranchesState } from '../context/FeatureBranchesContext';
import type { ForkStanding } from '../hooks/useFeatureBranches';
import { useComposePrText } from '../hooks/useComposePrText';
import { forkRepo } from '../storage/configStore';
import { Modal } from './Modal';
import { ErrorCategory, Feature, Operation, Telemetry } from '../lib/telemetry';
import { categorizeError } from '../lib/telemetry/errorCategory';
import styles from './FeatureBranchActionDialog.module.css';
import { Icon } from './Icon';
import { syncBranchName } from '../api/featureBranchActions';

export type PendingAction =
  | { kind: 'sync'; branch: string }
  | { kind: 'offer'; branch: string }
  /** Queue a pull request that is already open. No text is written. */
  | { kind: 'arm'; branch: string }
  | { kind: 'pull'; branch: string };

const STEP_ICON = {
  done: { icon: CheckCircleFillIcon, color: 'var(--fgColor-success)' },
  skipped: { icon: SkipIcon, color: 'var(--fgColor-muted)' },
  failed: { icon: XCircleFillIcon, color: 'var(--fgColor-danger)' },
} as const;

function Steps({ steps }: { steps: ActionStep[] }) {
  return (
    <div className={styles.mb3}>
      {steps.map((step, i) => {
        const style = STEP_ICON[step.state];
        return (
          <div key={i} className={styles.flexCenter}>
            <Icon icon={style.icon} size={16} style={{ color: style.color }} />
            <Text>{step.label}</Text>
            {step.detail && (
              <Text className={styles.smallFgMuted}>{step.detail}</Text>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TITLES: Record<PendingAction['kind'], string> = {
  sync: 'Sync the feature branch',
  offer: "Commit your changes to the upstream's branch",
  arm: 'Enable auto-merge',
  pull: 'Pull the branch into your fork',
};

export function FeatureBranchActionDialog({
  action,
  defaultBranch,
  onClose,
  onDone,
}: {
  action: PendingAction;
  defaultBranch: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { config } = useConfig();
  const state = useFeatureBranchesState();
  const composer = useComposePrText();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const { owner, repo } = config.upstream;
  const row = state.rows.find((r) => r.branch.name === action.branch);
  const mergeMethod = config.autoMerge.mergeMethod;

  // The offer needs its text before there is anything to confirm, so it is prepared as the
  // dialog opens rather than behind a second click.
  useEffect(() => {
    if (action.kind !== 'offer' || !row) return;
    let cancelled = false;
    void composer
      .compose({
        branch: action.branch,
        forkSha: row.branch.forkSha,
        upstreamSha: row.branch.upstreamSha,
      })
      .then((text) => {
        if (cancelled) return;
        setTitle(text.title);
        setBody(text.body);
      });
    return () => {
      cancelled = true;
    };
    // composer.compose is recreated with config; re-running on every config change would
    // spend another model call for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.kind, action.branch, row?.branch.forkSha, row?.branch.upstreamSha]);

  const perform = async () => {
    setBusy(true);
    // Every branch action is several requests behind one button, and the button reports only
    // "working…". Timing the whole switch measures what the person is actually waiting through;
    // timing the individual requests inside would measure something nobody experiences.
    //
    // `pull` gets its own operation: it is the fork-sync path and it is the slow one, since it
    // waits on GitHub's merge-upstream rather than on a write we control.
    const operation = action.kind === 'pull' ? Operation.GH_FORK_SYNC : Operation.GH_BRANCH_ACTION;
    const startedAtMs = performance.now();
    try {
      let result: ActionOutcome;
      switch (action.kind) {
        case 'sync':
          Telemetry.featureUsed(Feature.BRANCH_SYNC);
          result = await syncIntoFeatureBranch({
            owner,
            repo,
            branch: action.branch,
            defaultBranch,
          });
          break;
        case 'offer':
          Telemetry.featureUsed(Feature.BRANCH_OFFER);
          result = await proposeToFeatureBranch({
            owner,
            repo,
            forkOwner: config.fork.owner,
            branch: action.branch,
            title,
            body,
            method: mergeMethod,
          });
          break;
        case 'arm': {
          const open = row?.offer?.pr;
          if (!open) {
            setOutcome({
              ok: false,
              steps: [{ label: 'Enable auto-merge', state: 'failed' }],
              message: 'That pull request is no longer open.',
            });
            return;
          }
          result = await armExistingPull(owner, repo, open, mergeMethod);
          break;
        }
        case 'pull':
          Telemetry.featureUsed(Feature.BRANCH_FORK_SYNCED);
          result = await pullIntoFork(config.fork.owner, forkRepo(config), action.branch);
          break;
      }
      setOutcome(result);
      // A refused action is a failure of the operation even though nothing threw: the request was
      // made, GitHub answered, and the person did not get what they asked for.
      if (result.ok) Telemetry.operationCompleted(operation, performance.now() - startedAtMs);
      else Telemetry.operationFailed(operation, ErrorCategory.UNKNOWN);
      onDone();
    } catch (error) {
      Telemetry.operationFailed(operation, categorizeError(error));
      throw error;
    } finally {
      setBusy(false);
    }
  };

  // The branch is gone from under the dialog — deleted, or renamed out of the prefix,
  // between opening this and the poll that followed. Without this the offer dialog would
  // spin forever waiting for text it can never prepare.
  const branchGone = !row;
  const preparing = action.kind === 'offer' && !branchGone && composer.status !== 'ready';
  const canConfirm =
    !busy && !preparing && !branchGone && (action.kind !== 'offer' || title.trim().length > 0);

  return (
    <Modal
      title={TITLES[action.kind]}
      subtitle={action.branch}
      onClose={onClose}
      width="min(640px, 94vw)"
      footer={
        <div className={styles.flexGap2}>
          <Button onClick={onClose}>{outcome ? 'Close' : 'Cancel'}</Button>
          {!outcome && (
            <Button variant="primary" disabled={!canConfirm} onClick={() => void perform()}>
              {busy ? 'Working…' : CONFIRM_LABEL[action.kind]}
            </Button>
          )}
        </div>
      }
    >
      {!outcome && branchGone && (
        <Flash variant="warning" className={styles.bodyMb3}>
          <strong>{action.branch}</strong> is no longer listed in both repositories. It may have
          been deleted or renamed since this dialog opened.
        </Flash>
      )}

      {!outcome && !branchGone && (
        <div className={styles.mb3}>
          <ActionExplanation
            action={action}
            defaultBranch={defaultBranch}
            mergeMethod={mergeMethod}
            forkSlug={`${config.fork.owner}/${forkRepo(config)}`}
            upstreamSlug={`${owner}/${repo}`}
            standing={row?.standing ?? { state: 'unknown', behindBy: 0, aheadBy: 0 }}
          />
        </div>
      )}

      {action.kind === 'offer' && !outcome && !branchGone && (
        <>
          {preparing ? (
            <div className={styles.flexCenter2}>
              <Spinner size="small" />
              <Text className={styles.bodyFgMuted}>
                Working out what this branch changes…
              </Text>
            </div>
          ) : (
            <>
              <div className={styles.flexCenter3}>
                <Label variant={composer.text?.source === 'claude' ? 'accent' : 'secondary'}>
                  {composer.text?.source === 'claude' ? 'written by Claude' : 'from a template'}
                </Label>
                {composer.text?.summary && (
                  <Text className={styles.smallFgMuted}>
                    {composer.text.summary.totalCommits} commits ·{' '}
                    {composer.text.summary.files.length}
                    {composer.text.summary.filesTruncated ? '+' : ''} files
                  </Text>
                )}
              </div>
              {composer.text?.note && (
                <Flash variant="warning" className={styles.smallMb3}>
                  {composer.text.note}
                </Flash>
              )}
              <FormControl className={styles.mb3}>
                <FormControl.Label>Title</FormControl.Label>
                <TextInput block value={title} onChange={(e) => setTitle(e.target.value)} />
              </FormControl>
              <FormControl className={styles.mb3}>
                <FormControl.Label>Description</FormControl.Label>
                <Textarea
                  block
                  rows={10}
                  resize="vertical"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <FormControl.Caption>
                  Edit anything before it is published — this is what everyone reviewing the
                  branch will read.
                </FormControl.Caption>
              </FormControl>
            </>
          )}
        </>
      )}

      {outcome && (
        <>
          <Steps steps={outcome.steps} />
          <Flash variant={outcome.ok ? 'success' : 'danger'} className={styles.body}>
            {outcome.message}
          </Flash>
        </>
      )}
    </Modal>
  );
}

const CONFIRM_LABEL: Record<PendingAction['kind'], string> = {
  sync: 'Open the pull request',
  offer: 'Open the pull request',
  arm: 'Enable auto-merge',
  pull: 'Sync my fork',
};

function ActionExplanation({
  action,
  defaultBranch,
  mergeMethod,
  forkSlug,
  upstreamSlug,
  standing,
}: {
  action: PendingAction;
  defaultBranch: string;
  mergeMethod: string;
  forkSlug: string;
  upstreamSlug: string;
  standing: ForkStanding;
}) {
  if (action.kind === 'sync') {
    return (
      <>
        <Text as="p" className={styles.bodyMb2}>
          Opens a pull request from{' '}
          <strong>{syncBranchName(defaultBranch, action.branch)}</strong> — a new branch at{' '}
          <strong>{defaultBranch}</strong>&rsquo;s tip — into <strong>{action.branch}</strong>, with
          auto-merge armed.
        </Text>
        <Text as="p" className={styles.bodyFgMuted2}>
          GitHub merges it once the required checks pass. Nothing is merged from here.
        </Text>
      </>
    );
  }

  if (action.kind === 'offer') {
    return (
      <>
        <Text as="p" className={styles.bodyMb2}>
          This opens a pull request from <strong>{action.branch}</strong> in{' '}
          <strong>{forkSlug}</strong> into the branch of the same name in{' '}
          <strong>{upstreamSlug}</strong>, and arms auto-merge (<Label>{mergeMethod}</Label>) so
          it lands once its required checks pass.
        </Text>
        <Text as="p" className={styles.bodyFgMuted2}>
          If GitHub can already merge it, nothing is queued and nothing is merged — you get a{' '}
          <strong>Merge now</strong> button instead. Nothing here touches{' '}
          <strong>{defaultBranch}</strong>.
        </Text>
      </>
    );
  }

  if (action.kind === 'arm') {
    return (
      <Text as="p" className={styles.bodyMb0}>
        The pull request from <strong>{action.branch}</strong> into{' '}
        <strong>{defaultBranch}</strong> is already open, so this only asks GitHub to merge it
        (<Label>{mergeMethod}</Label>) once its required checks pass. Its title and description
        are left exactly as they are. If GitHub can already merge it, nothing is queued — you
        get a <strong>Merge now</strong> button instead.
      </Text>
    );
  }

  if (action.kind === 'pull') {
    return (
      <>
        <Text as="p" className={styles.bodyMb2}>
          This updates <strong>{action.branch}</strong> in <strong>{forkSlug}</strong> to match
          the upstream's copy.
        </Text>
        {/*
          Now that the standing is known, the warning can be specific about the one
          irreversible outcome — a merge commit — instead of raising it for every case.
          Being merely behind fast-forwards, and nothing needs warning about.
        */}
        <Flash
          variant={standing.state === 'diverged' || standing.state === 'unknown' ? 'warning' : 'default'}
          className={styles.small}
        >
          {standing.state === 'behind' &&
            `Your copy is ${standing.behindBy} commit${standing.behindBy === 1 ? '' : 's'} behind and has nothing of its own, so this fast-forwards it. No merge commit.`}
          {standing.state === 'diverged' &&
            `Your copy has ${standing.aheadBy} commit${standing.aheadBy === 1 ? '' : 's'} the upstream doesn't, so this cannot fast-forward: GitHub writes a merge commit into your fork, and nothing here can undo that.`}
          {standing.state === 'ahead' &&
            'Your copy already has everything the upstream does, so this will most likely report that there was nothing to do.'}
          {standing.state === 'identical' &&
            'Your copy is already level with the upstream, so this will most likely report that there was nothing to do.'}
          {standing.state === 'unknown' &&
            'The two copies are at different commits, but how they relate could not be read. If it can be fast-forwarded it will be; otherwise GitHub writes a merge commit into your fork, and nothing here can undo that.'}
        </Flash>
      </>
    );
  }

  // Every kind is covered above; TypeScript proves it, so there is no fallback to write.
  return null;
}

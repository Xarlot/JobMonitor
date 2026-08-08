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
import {
  Box,
  Button,
  FormControl,
  Flash,
  Label,
  Octicon,
  Spinner,
  Text,
  TextInput,
  Textarea,
} from '@primer/react';
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

export type PendingAction =
  | { kind: 'sync'; branch: string }
  | { kind: 'offer'; branch: string }
  /** Queue a pull request that is already open. No text is written. */
  | { kind: 'arm'; branch: string }
  | { kind: 'pull'; branch: string };

const STEP_ICON = {
  done: { icon: CheckCircleFillIcon, color: 'success.fg' },
  skipped: { icon: SkipIcon, color: 'fg.muted' },
  failed: { icon: XCircleFillIcon, color: 'danger.fg' },
} as const;

function Steps({ steps }: { steps: ActionStep[] }) {
  return (
    <Box sx={{ mb: 3 }}>
      {steps.map((step, i) => {
        const style = STEP_ICON[step.state];
        return (
          <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1, fontSize: 1 }}>
            <Octicon icon={style.icon} size={16} sx={{ color: style.color }} />
            <Text>{step.label}</Text>
            {step.detail && (
              <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{step.detail}</Text>
            )}
          </Box>
        );
      })}
    </Box>
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
    try {
      let result: ActionOutcome;
      switch (action.kind) {
        case 'sync':
          result = await syncIntoFeatureBranch({
            owner,
            repo,
            branch: action.branch,
            defaultBranch,
          });
          break;
        case 'offer':
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
          result = await pullIntoFork(config.fork.owner, forkRepo(config), action.branch);
          break;
      }
      setOutcome(result);
      onDone();
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
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button onClick={onClose}>{outcome ? 'Close' : 'Cancel'}</Button>
          {!outcome && (
            <Button variant="primary" disabled={!canConfirm} onClick={() => void perform()}>
              {busy ? 'Working…' : CONFIRM_LABEL[action.kind]}
            </Button>
          )}
        </Box>
      }
    >
      {!outcome && branchGone && (
        <Flash variant="warning" sx={{ fontSize: 1, mb: 3 }}>
          <strong>{action.branch}</strong> is no longer listed in both repositories. It may have
          been deleted or renamed since this dialog opened.
        </Flash>
      )}

      {!outcome && !branchGone && (
        <Box sx={{ mb: 3 }}>
          <ActionExplanation
            action={action}
            defaultBranch={defaultBranch}
            mergeMethod={mergeMethod}
            forkSlug={`${config.fork.owner}/${forkRepo(config)}`}
            upstreamSlug={`${owner}/${repo}`}
            standing={row?.standing ?? { state: 'unknown', behindBy: 0, aheadBy: 0 }}
          />
        </Box>
      )}

      {action.kind === 'offer' && !outcome && !branchGone && (
        <>
          {preparing ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
              <Spinner size="small" />
              <Text sx={{ fontSize: 1, color: 'fg.muted' }}>
                Working out what this branch changes…
              </Text>
            </Box>
          ) : (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
                <Label variant={composer.text?.source === 'claude' ? 'accent' : 'secondary'}>
                  {composer.text?.source === 'claude' ? 'written by Claude' : 'from a template'}
                </Label>
                {composer.text?.summary && (
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                    {composer.text.summary.totalCommits} commits ·{' '}
                    {composer.text.summary.files.length}
                    {composer.text.summary.filesTruncated ? '+' : ''} files
                  </Text>
                )}
              </Box>
              {composer.text?.note && (
                <Flash variant="warning" sx={{ fontSize: 0, mb: 3 }}>
                  {composer.text.note}
                </Flash>
              )}
              <FormControl sx={{ mb: 3 }}>
                <FormControl.Label>Title</FormControl.Label>
                <TextInput block value={title} onChange={(e) => setTitle(e.target.value)} />
              </FormControl>
              <FormControl sx={{ mb: 3 }}>
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
          <Flash variant={outcome.ok ? 'success' : 'danger'} sx={{ fontSize: 1 }}>
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
        <Text as="p" sx={{ fontSize: 1, mb: 2 }}>
          This opens a pull request from <strong>{defaultBranch}</strong> into{' '}
          <strong>{action.branch}</strong> in the upstream and arms auto-merge, so GitHub lands
          it as soon as the required checks pass.
        </Text>
        <Text as="p" sx={{ fontSize: 1, color: 'fg.muted', mb: 0 }}>
          Always a merge commit, never a squash: squashing the default branch into a feature
          branch would rewrite history the two repositories share, and every later merge between
          them would conflict against it. Nothing is merged from here — if GitHub declines to
          queue it, that is reported rather than worked around.
        </Text>
      </>
    );
  }

  if (action.kind === 'offer') {
    return (
      <>
        <Text as="p" sx={{ fontSize: 1, mb: 2 }}>
          This opens a pull request from <strong>{action.branch}</strong> in{' '}
          <strong>{forkSlug}</strong> into the branch of the same name in{' '}
          <strong>{upstreamSlug}</strong>, and arms auto-merge (<Label>{mergeMethod}</Label>) so
          it lands once its required checks pass.
        </Text>
        <Text as="p" sx={{ fontSize: 1, color: 'fg.muted', mb: 0 }}>
          If GitHub can already merge it, nothing is queued and nothing is merged — you get a{' '}
          <strong>Merge now</strong> button instead. Nothing here touches{' '}
          <strong>{defaultBranch}</strong>.
        </Text>
      </>
    );
  }

  if (action.kind === 'arm') {
    return (
      <Text as="p" sx={{ fontSize: 1, mb: 0 }}>
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
        <Text as="p" sx={{ fontSize: 1, mb: 2 }}>
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
          sx={{ fontSize: 0 }}
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

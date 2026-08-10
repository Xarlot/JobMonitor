/**
 * Arm auto-merge on a pull request, and clear its description on the way.
 *
 * Self-contained in the style of RerunFailedJobsButton: it swallows the row click, owns its
 * dialog, and renders nothing unless the token is known to permit writes — a control that
 * 403s is worse than no control.
 *
 * It confirms first, which the re-run button does not need to. Re-running costs CI minutes
 * and can be undone by not caring; **clearing a description destroys text nobody can get
 * back** — a PR body has no exposed edit history, so neither this app nor the API can
 * restore it. So the dialog states both effects before the button that performs them.
 */

import { useState } from 'react';
import { Button, Flash, IconButton, Label, Text } from '@primer/react';
import { Tooltip } from '@primer/react/next';
import { GitMergeIcon } from '@primer/octicons-react';
import { armAutoMerge, type MergeMethod } from '../api/autoMerge';
import type { PullRequest } from '../api/types';
import { useConfig } from '../context/ConfigContext';
import { useTokenCapability } from '../hooks/useTokenCapability';
import { Modal } from './Modal';
import { Feature, Operation, Telemetry } from '../lib/telemetry';
import styles from './AutoMergeButton.module.css';
import { tooltipWrapFixed } from '../lib/tooltipWrap';

/** Config stores the strategy lower-case; GraphQL's enum is upper-case. */
export function toMergeMethod(setting: 'squash' | 'merge' | 'rebase'): MergeMethod {
  return setting.toUpperCase() as MergeMethod;
}

function ArmDialog({
  owner,
  repo,
  pr,
  onClose,
  onArmed,
}: {
  owner: string;
  repo: string;
  pr: PullRequest;
  onClose: () => void;
  onArmed: () => void;
}) {
  const { config } = useConfig();
  const method = config.autoMerge.mergeMethod;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const hasDescription = Boolean(pr.body && pr.body.trim().length > 0);

  const arm = async () => {
    setBusy(true);
    try {
      const outcome = await Telemetry.measure(Operation.GH_AUTOMERGE_WRITE, () =>
        armAutoMerge(owner, repo, pr, toMergeMethod(method)),
      );
      if (outcome.autoMergeEnabled) Telemetry.featureUsed(Feature.AUTOMERGE_ARMED);
      if (outcome.autoMergeEnabled) {
        setResult({ ok: true, message: `Auto-merge enabled (${method}). The description is cleared.` });
        onArmed();
      } else {
        // Which half succeeded matters: the description is already gone in one case and
        // untouched in the other, and the user has to know which they are looking at.
        setResult({
          ok: false,
          message: outcome.descriptionCleared
            ? `The description was cleared, but auto-merge was not enabled: ${outcome.error}`
            : `Nothing was changed: ${outcome.error}`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Enable auto-merge"
      subtitle={`${pr.title} · #${pr.number}`}
      onClose={onClose}
      width="min(560px, 94vw)"
      footer={
        <div className={styles.flexGap2}>
          <Button onClick={onClose}>{result?.ok ? 'Close' : 'Cancel'}</Button>
          {!result?.ok && (
            <Button variant="danger" disabled={busy} onClick={() => void arm()}>
              {busy ? 'Working…' : 'Clear description and enable'}
            </Button>
          )}
        </div>
      }
    >
      <Text as="p" className={styles.bodyMb2}>
        This will do two things to <strong>#{pr.number}</strong> on GitHub:
      </Text>
      <ol className={styles.pl4Body}>
        <li className={styles.mb1}>
          {hasDescription ? (
            <>
              <strong>Delete the description.</strong> It cannot be recovered — a pull request
              body has no edit history to restore from.
            </>
          ) : (
            <>
              Clear the description — <Text className={styles.fgMuted}>already empty.</Text>
            </>
          )}
        </li>
        <li>
          <strong>Enable auto-merge</strong> with the <Label>{method}</Label> strategy, so
          GitHub merges it when the checks pass — immediately, if they already have.
        </li>
      </ol>

      {hasDescription && (
        <pre
          className={styles.m0Mb3}
        >
          {pr.body}
        </pre>
      )}

      {result && (
        <Flash variant={result.ok ? 'success' : 'danger'} className={styles.small}>
          {result.message}
        </Flash>
      )}
    </Modal>
  );
}

/**
 * The armed state, as a badge among the PR's other badges.
 *
 * Separate from the button, and placed with the labels rather than with the actions,
 * because it is a fact about the PR rather than something to press. It exists because an
 * absent control explains nothing — and because auto-merge being on is worth seeing for its
 * own sake: it is the condition the auto-rerun engine acts on, and until this badge the PR
 * list gave no way to tell which PRs qualified.
 */
export function AutoMergeLabel({ pr }: { pr: PullRequest }) {
  if (!pr.auto_merge) return null;
  return <ArmedLabel pr={pr} />;
}

function ArmedLabel({ pr }: { pr: PullRequest }) {
  const method = pr.auto_merge?.merge_method ?? 'merge';
  const by = pr.auto_merge?.enabled_by?.login;
  const tip = [
    `Auto-merge is enabled (${method})${by ? ` by ${by}` : ''}.`,
    'GitHub will merge this pull request when its checks pass.',
    'Change or cancel it on GitHub — this app only ever turns it on.',
  ].join('\n');

  return (
    <div
      className={tooltipWrapFixed}
    >
      <Tooltip text={tip} type="description">
        <button
          type="button"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className={styles.centerDefault}
        >
          <Label variant="done">
            <GitMergeIcon size={12} className={styles.mr1} />
            auto-merge
          </Label>
        </button>
      </Tooltip>
    </div>
  );
}

export function AutoMergeButton({
  owner,
  repo,
  pr,
  onArmed,
  size = 'small',
}: {
  owner: string;
  repo: string;
  pr: PullRequest;
  /** Called after auto-merge is armed, to re-poll the PR list. */
  onArmed: () => void;
  size?: 'small' | 'medium';
}) {
  const [open, setOpen] = useState(false);
  const { canRerun: canWrite } = useTokenCapability();

  // Already armed: GitHub errors on those, so there is no action to offer. The state is
  // shown by AutoMergeLabel instead, over with the PR's other badges.
  if (pr.auto_merge) return null;
  // Hidden, not disabled, exactly as the re-run control is: the token can't do this, and
  // Settings → Token carries the explanation.
  if (!canWrite) return null;
  // A merged or closed PR cannot be armed either.
  if (pr.state !== 'open') return null;

  return (
    <span onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <IconButton
        size={size}
        variant="invisible"
        icon={GitMergeIcon}
        aria-label="Enable auto-merge (clears the description)"
        onClick={() => setOpen(true)}
      />
      {open && (
        <ArmDialog
          owner={owner}
          repo={repo}
          pr={pr}
          onClose={() => setOpen(false)}
          onArmed={onArmed}
        />
      )}
    </span>
  );
}

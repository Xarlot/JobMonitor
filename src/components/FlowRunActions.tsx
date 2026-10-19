/**
 * The two Actions writes a flow card offers: re-running one of its runs, and starting its
 * workflow anew by `workflow_dispatch`.
 *
 * Self-contained in the style of RerunFailedJobsButton and UpdateBranchButton: each swallows the
 * row click, owns its dialog, and renders nothing unless the token is known to permit writes.
 *
 * Write capability is proven for the upstream repository only — that is the repo whose
 * `permissions.push` is probed. A flow pointed at another repository therefore gets neither
 * control: offering a write we never verified would 403, and a 403 latches every write in the
 * app off.
 */

import { useState } from 'react';
import {
  ActionList,
  ActionMenu,
  Button,
  Flash,
  FormControl,
  IconButton,
  Spinner,
  Text,
  Textarea,
  TextInput,
} from '@primer/react';
import { PlayIcon, SyncIcon, XCircleIcon } from '@primer/octicons-react';
import { dispatchWorkflow, rerunFailedJobs, rerunRun } from '../api/workflows';
import type { WorkflowRun } from '../api/types';
import { useConfig } from '../context/ConfigContext';
import { useTokenCapability } from '../hooks/useTokenCapability';
import { MANUALLY_RERUNNABLE_CONCLUSIONS } from '../lib/autoRerun';
import { Modal } from './Modal';
import { Feature, Operation, Telemetry } from '../lib/telemetry';
import styles from './FlowRunActions.module.css';

type Result = { ok: boolean; message: string };

/**
 * Whether writes to `owner/repo` are proven. Split from the controls so the config is read only
 * once the token can write at all — and so a grid rendered without a config never asks for one.
 */
function useCanWriteTo(owner: string, repo: string): boolean {
  const { config } = useConfig();
  const up = config.upstream;
  return up.owner.toLowerCase() === owner.toLowerCase() && up.repo.toLowerCase() === repo.toLowerCase();
}

type RerunMode = 'all' | 'failed';

const MODE: Record<RerunMode, { label: string; title: string; describe: string }> = {
  all: {
    label: 'Re-run all jobs',
    title: 'Re-run all jobs',
    describe: 'Every job of this run runs again, as a new attempt.',
  },
  failed: {
    label: 'Re-run failed jobs',
    title: 'Re-run failed jobs',
    describe: 'Only the failed and cancelled jobs run again, with the jobs that depend on them.',
  },
};

function RerunRunMenu({
  owner,
  repo,
  run,
  onDone,
}: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  onDone: () => void;
}) {
  const [chosen, setChosen] = useState<RerunMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  if (!useCanWriteTo(owner, repo)) return null;

  const failedRerunnable =
    run.status === 'completed' && MANUALLY_RERUNNABLE_CONCLUSIONS.has(run.conclusion);

  const close = () => {
    if (busy) return;
    setChosen(null);
    setResult(null);
  };
  const rerun = async (mode: RerunMode) => {
    setBusy(true);
    try {
      Telemetry.featureUsed(Feature.FLOW_RUN_RERUN);
      await Telemetry.measure(Operation.GH_FLOW_RERUN_WRITE, () =>
        mode === 'all' ? rerunRun(owner, repo, run.id) : rerunFailedJobs(owner, repo, run.id),
      );
      setResult({ ok: true, message: `Re-run requested (attempt ${run.run_attempt + 1}).` });
      onDone();
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <ActionMenu>
        <ActionMenu.Anchor>
          <IconButton
            size="small"
            variant="invisible"
            icon={busy ? Spinner : SyncIcon}
            aria-label="Re-run this run"
            disabled={busy}
          />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium">
          <ActionList>
            <ActionList.Group>
              <ActionList.GroupHeading>Re-run run #{run.run_number}</ActionList.GroupHeading>
              {run.status !== 'completed' ? (
                // GitHub refuses to re-run a run that hasn't finished.
                <ActionList.Item disabled>Still running — re-run it once it finishes.</ActionList.Item>
              ) : (
                (['all', 'failed'] as const).map((m) => (
                  <ActionList.Item
                    key={m}
                    disabled={m === 'failed' && !failedRerunnable}
                    onSelect={() => {
                      setResult(null);
                      setChosen(m);
                    }}
                  >
                    <ActionList.LeadingVisual>
                      {m === 'all' ? <SyncIcon /> : <XCircleIcon />}
                    </ActionList.LeadingVisual>
                    {MODE[m].label}
                    <ActionList.Description variant="block">{MODE[m].describe}</ActionList.Description>
                  </ActionList.Item>
                ))
              )}
            </ActionList.Group>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {chosen && (
        <Modal
          title={MODE[chosen].title}
          subtitle={`${run.display_title || run.name} · run #${run.run_number}`}
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
                  <Button variant="primary" onClick={() => void rerun(chosen)}>
                    Re-run
                  </Button>
                </>
              )}
            </div>
          }
        >
          {busy ? (
            <Text as="p" className={styles.progress}>
              <Spinner size="small" /> Requesting the re-run…
            </Text>
          ) : result ? (
            <Flash variant={result.ok ? 'success' : 'danger'}>{result.message}</Flash>
          ) : (
            <Text as="p">
              {MODE[chosen].describe} It costs the CI minutes of{' '}
              {chosen === 'all' ? 'the whole run' : 'those jobs'}.
            </Text>
          )}
        </Modal>
      )}
    </span>
  );
}

/** Re-run one run of a flow: all its jobs, or only the failed ones. */
export function RerunFlowRunButton(props: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  /** Called after a successful request, to re-poll the flow's runs. */
  onDone: () => void;
}) {
  const { canRerun } = useTokenCapability();
  // Hidden, not disabled: Settings → Token carries the explanation.
  if (!canRerun) return null;
  return <RerunRunMenu {...props} />;
}

/** `name=value` per line; blank lines skipped. Returns an error for a line without `=`. */
export function parseInputs(text: string): { inputs: Record<string, string> } | { error: string } {
  const inputs: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `“${line}” is not name=value.` };
    inputs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { inputs };
}

/** How long after a dispatch to look again: GitHub creates the run a few seconds later. */
const DISPATCH_REPOLL_MS = [3_000, 10_000];

function RunWorkflowDialog({
  owner,
  repo,
  title,
  branches,
  workflowRef,
  onClose,
  onDone,
}: {
  owner: string;
  repo: string;
  title: string;
  branches: string[];
  workflowRef: () => Promise<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [ref, setRef] = useState(branches[0] ?? '');
  const [inputsText, setInputsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const parsed = parseInputs(inputsText);
  const inputError = 'error' in parsed ? parsed.error : null;

  const close = () => {
    if (!busy) onClose();
  };
  const run = async () => {
    if ('error' in parsed) return;
    setBusy(true);
    try {
      Telemetry.featureUsed(Feature.FLOW_WORKFLOW_DISPATCHED);
      await Telemetry.measure(Operation.GH_DISPATCH_WRITE, async () =>
        dispatchWorkflow(owner, repo, await workflowRef(), ref.trim(), parsed.inputs),
      );
      setResult({ ok: true, message: `Started on ${ref.trim()}. The run appears in a few seconds.` });
      onDone();
      for (const ms of DISPATCH_REPOLL_MS) setTimeout(onDone, ms);
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const listId = `dispatch-branches-${title.replace(/\W+/g, '-')}`;

  return (
    <Modal
      title="Run workflow"
      subtitle={`${title} · ${owner}/${repo}`}
      width="min(520px, 94vw)"
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
              <Button
                variant="primary"
                disabled={!ref.trim() || inputError !== null}
                onClick={() => void run()}
              >
                Run workflow
              </Button>
            </>
          )}
        </div>
      }
    >
      {busy ? (
        <Text as="p" className={styles.progress}>
          <Spinner size="small" /> Starting the workflow…
        </Text>
      ) : result?.ok ? (
        <Flash variant="success">{result.message}</Flash>
      ) : (
        <div className={styles.form}>
          {result && <Flash variant="danger">{result.message}</Flash>}
          <FormControl required>
            <FormControl.Label>Branch or tag</FormControl.Label>
            <TextInput
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              list={listId}
              block
              className={styles.mono}
            />
            <datalist id={listId}>
              {branches.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </FormControl>
          <FormControl>
            <FormControl.Label>Inputs</FormControl.Label>
            <Textarea
              value={inputsText}
              onChange={(e) => setInputsText(e.target.value)}
              placeholder={'name=value, one per line'}
              rows={3}
              block
              resize="vertical"
              className={styles.mono}
            />
            {inputError ? (
              <FormControl.Validation variant="error">{inputError}</FormControl.Validation>
            ) : (
              <FormControl.Caption>
                Optional. Inputs left out take their defaults from the workflow.
              </FormControl.Caption>
            )}
          </FormControl>
          <Text as="p" className={styles.note}>
            Needs a <code>workflow_dispatch</code> trigger in the workflow — GitHub refuses otherwise.
          </Text>
        </div>
      )}
    </Modal>
  );
}

function RunWorkflowControl(props: {
  owner: string;
  repo: string;
  title: string;
  branches: string[];
  workflowRef: () => Promise<string>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!useCanWriteTo(props.owner, props.repo) && !open) return null;
  return (
    <span onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <Button leadingVisual={PlayIcon} size="small" onClick={() => setOpen(true)}>
        Run
      </Button>
      {open && <RunWorkflowDialog {...props} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** Start a flow's workflow by `workflow_dispatch`, on a branch of the user's choosing. */
export function RunWorkflowButton(props: {
  owner: string;
  repo: string;
  /** The flow's name, for the dialog's subtitle. */
  title: string;
  /** Offered as suggestions; the first is preselected. */
  branches: string[];
  workflowRef: () => Promise<string>;
  /** Re-polls the flow's runs, so the new run shows up. */
  onDone: () => void;
}) {
  const { canRerun } = useTokenCapability();
  if (!canRerun) return null;
  return <RunWorkflowControl {...props} />;
}

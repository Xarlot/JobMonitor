/**
 * A pull request's open review conversations: who left them, and what to do about them.
 *
 * Each open conversation is a small chip on the PR's meta line — who started it and how it
 * starts — because "is anyone waiting on me, and who" is the same kind of glance as the reviewer
 * avatars. Among the row's action buttons, one menu resolves every open conversation, only the
 * ones an AI review bot started, or only the outdated ones. Clicking a chip opens the conversations at that one; clicking a comment in
 * there opens a panel to resolve it or reply: a box for your own text, a field to tell Claude how
 * to improve that text, a button to have Claude write it, and Resolve.
 *
 * The writes follow the rest of the app: hidden unless the token is known to permit them, and
 * nothing is ever posted that the user did not see first. Whatever Claude writes lands in the
 * same editable box as typed text and goes out only on the same button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionList,
  ActionMenu,
  Avatar,
  Button,
  Checkbox,
  Flash,
  IconButton,
  Label,
  Link,
  Spinner,
  Text,
  TextInput,
  Textarea,
} from '@primer/react';
import { Tooltip } from '@primer/react/next';
import {
  CheckIcon,
  CommentDiscussionIcon,
  CommentIcon,
  CopilotIcon,
  FileDiffIcon,
  LinkExternalIcon,
  PencilIcon,
  SparkleFillIcon,
} from '@primer/octicons-react';
import {
  commentSnippet,
  fetchFileAtRef,
  replyToReviewThread,
  resolveAllReviewThreads,
  resolveReviewThread,
  type ReviewComment,
  type ReviewThread,
} from '../api/reviewThreads';
import type { PullRequest } from '../api/types';
import { useConfig } from '../context/ConfigContext';
import { useDashboard } from '../context/DashboardContext';
import { useTokenCapability } from '../hooks/useTokenCapability';
import { newRequestId } from '../hooks/useClaudeTriage';
import {
  buildImproveReplyPrompt,
  buildResolveNotePrompt,
  buildReviewReplyPrompt,
  codeExcerpt,
  parseResolveNote,
  parseReviewReply,
  type CurrentCode,
  type ResolveVerdict,
} from '../lib/reviewReply';
import { formatRelative } from '../lib/format';
import { devWarn } from '../lib/devLog';
import { ErrorCategory, Feature, Operation, Telemetry } from '../lib/telemetry';
import { tooltipWrap, tooltipWrapFixed } from '../lib/tooltipWrap';
import {
  cancelClaudeAnalysis,
  claudeToolsReady,
  composeAvailable,
  composeWithClaude,
  probeClaudeTools,
} from '../storage/desktopClaude';
import { MarkdownView } from './MarkdownView';
import { Modal } from './Modal';
import styles from './ReviewThreads.module.css';

type FeatureId = (typeof Feature)[keyof typeof Feature];
type OperationId = (typeof Operation)[keyof typeof Operation];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const plural = (n: number) => (n === 1 ? 'conversation' : 'conversations');

// ── Resolving many at once ──────────────────────────────────────────────────────────────────────

/** Which open conversations a bulk resolve acts on. */
type Bulk = 'all' | 'outdated' | 'bots';

const BULK: Record<Bulk, { button: string; adjective: string; feature: FeatureId }> = {
  all: { button: 'Resolve all', adjective: 'open', feature: Feature.REVIEW_THREADS_RESOLVED_ALL },
  outdated: { button: 'Resolve outdated', adjective: 'outdated', feature: Feature.REVIEW_THREADS_RESOLVED_OUTDATED },
  bots: { button: 'Resolve AI comments', adjective: 'AI review', feature: Feature.REVIEW_THREADS_RESOLVED_BOTS },
};

function bulkTargets(threads: readonly ReviewThread[], bulk: Bulk): ReviewThread[] {
  const open = threads.filter((t) => !t.isResolved && t.viewerCanResolve);
  if (bulk === 'outdated') return open.filter((t) => t.isOutdated);
  if (bulk === 'bots') return open.filter((t) => t.comments[0]?.author?.isBot === true);
  return open;
}

/** One bulk resolve at a time per PR, its progress, and what came of it — for the row and the dialog. */
function useBulkResolve(pr: PullRequest) {
  const { reviewThreads, refreshReviewThreads } = useDashboard();
  const threads = reviewThreads.get(pr.number) ?? [];
  const [running, setRunning] = useState<{ bulk: Bulk; done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const run = async (bulk: Bulk) => {
    const list = bulkTargets(threads, bulk);
    if (list.length === 0) return;
    setResult(null);
    setRunning({ bulk, done: 0, total: list.length });
    const feature = BULK[bulk].feature;
    Telemetry.featureUsed(feature);
    try {
      const outcome = await Telemetry.measure(Operation.GH_REVIEW_THREAD_WRITE, () =>
        resolveAllReviewThreads(list, (done) => setRunning({ bulk, done, total: list.length })),
      );
      const adjective = bulk === 'all' ? '' : `${BULK[bulk].adjective} `;
      setResult(
        outcome.failed.length === 0
          ? { ok: true, message: `Resolved ${outcome.resolved} ${adjective}${plural(outcome.resolved)}.` }
          : { ok: false, message: `Resolved ${outcome.resolved} of ${list.length}. ${outcome.failed[0].error}` },
      );
    } finally {
      setRunning(null);
      await refreshReviewThreads(pr.number).catch((e: unknown) =>
        devWarn('api', `review threads of #${pr.number} could not be re-read`, e),
      );
    }
  };

  return { threads, running, result, setResult, run, targets: (bulk: Bulk) => bulkTargets(threads, bulk) };
}

// ── The PR row ──────────────────────────────────────────────────────────────────────────────────

/** Chips rendered at most; those past the width of the line are hidden by it anyway. */
const MAX_CHIPS = 8;

/**
 * The open conversations on the PR's title line: a count, then one chip each — the avatar and
 * login of whoever started it, and the start of what they said. Chips that do not fit wrap onto
 * a second line that is clipped away, so none is ever shown cut in half; the count says how many
 * there are in all. Absent until the threads are read, and when none are open.
 */
export function ReviewThreadChips({ pr }: { pr: PullRequest }) {
  const { reviewThreads } = useDashboard();
  // `null` closed; `''` open at the top; otherwise open at that thread.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const unresolved = (reviewThreads.get(pr.number) ?? []).filter((t) => !t.isResolved);
  // Kept mounted while the dialog is open, so resolving the last one doesn't close it mid-read.
  if (unresolved.length === 0 && openAt === null) return null;

  const countTip = `${unresolved.length} unresolved review ${plural(unresolved.length)} — click to see them all`;
  return (
    <div className={styles.chipsLine} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      {unresolved.length > 0 && (
        <span className={tooltipWrapFixed}>
          <Tooltip text={countTip} type="description">
            <button type="button" className={styles.chipCount} aria-label={countTip} onClick={() => setOpenAt('')}>
              <CommentDiscussionIcon size={12} />
              {unresolved.length}
            </button>
          </Tooltip>
        </span>
      )}
      <div className={styles.chips}>
        {unresolved.slice(0, MAX_CHIPS).map((t) => (
          <ThreadChip key={t.id} thread={t} onOpen={() => setOpenAt(t.id)} />
        ))}
      </div>
      {openAt !== null && (
        <ReviewThreadsDialog pr={pr} focusThreadId={openAt || undefined} onClose={() => setOpenAt(null)} />
      )}
    </div>
  );
}

/**
 * The icon for the resolve menu: a speech bubble with the number still unresolved on a red badge,
 * like an unread count. A green check there read as "all resolved" — the opposite of the news.
 */
function UnresolvedCountIcon({ count }: { count: number }) {
  return (
    <span className={styles.resolveIcon} aria-hidden="true">
      <CommentDiscussionIcon size={16} />
      {count > 0 && <span className={styles.resolveIconBadge}>{count > 99 ? '99+' : count}</span>}
    </span>
  );
}

/**
 * Resolve the PR's open review conversations from the row's action buttons: a menu to pick all of
 * them or only the ones an AI review bot started, then a small dialog that asks first and shows
 * the progress and the outcome, so nothing in the row shifts while it runs.
 */
export function ReviewThreadsResolveButton({ pr }: { pr: PullRequest }) {
  const bulk = useBulkResolve(pr);
  const { canRerun: canWrite } = useTokenCapability();
  const [chosen, setChosen] = useState<Bulk | null>(null);
  const all = bulk.targets('all').length;
  const bots = bulk.targets('bots').length;
  const outdated = bulk.targets('outdated').length;
  // IconButton takes a component, not an element; memoised so the count changing re-renders it
  // rather than mounting a new component type every render.
  const CountIcon = useMemo(() => {
    const Icon = () => <UnresolvedCountIcon count={all} />;
    return Icon;
  }, [all]);
  if (!canWrite || (all === 0 && !chosen)) return null;

  const choose = (b: Bulk) => {
    bulk.setResult(null);
    setChosen(b);
  };
  const close = () => {
    if (bulk.running) return;
    setChosen(null);
    bulk.setResult(null);
  };
  const n = chosen ? bulk.targets(chosen).length : 0;
  const what = chosen ? `${BULK[chosen].adjective}${chosen === 'all' ? ' review' : ''}` : '';

  return (
    <span onClick={(e: React.MouseEvent) => e.stopPropagation()}>
      <ActionMenu>
        <ActionMenu.Anchor>
          <IconButton
            size="small"
            variant="invisible"
            icon={bulk.running ? Spinner : CountIcon}
            aria-label={`${all} unresolved review ${plural(all)} — resolve…`}
            disabled={bulk.running !== null}
          />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay width="medium">
          <ActionList>
            <ActionList.Group>
              <ActionList.GroupHeading>Resolve review conversations</ActionList.GroupHeading>
              <ActionList.Item onSelect={() => choose('all')}>
                <ActionList.LeadingVisual>
                  <CommentDiscussionIcon />
                </ActionList.LeadingVisual>
                All
                <ActionList.TrailingVisual>{all}</ActionList.TrailingVisual>
                <ActionList.Description variant="block">Every open conversation on this pull request.</ActionList.Description>
              </ActionList.Item>
              <ActionList.Item disabled={bots === 0} onSelect={() => choose('bots')}>
                <ActionList.LeadingVisual>
                  <CopilotIcon />
                </ActionList.LeadingVisual>
                Only AI comments
                <ActionList.TrailingVisual>{bots}</ActionList.TrailingVisual>
                <ActionList.Description variant="block">
                  The ones a review bot started — Copilot and the like. People’s comments stay open.
                </ActionList.Description>
              </ActionList.Item>
              <ActionList.Item disabled={outdated === 0} onSelect={() => choose('outdated')}>
                <ActionList.LeadingVisual>
                  <FileDiffIcon />
                </ActionList.LeadingVisual>
                Only outdated
                <ActionList.TrailingVisual>{outdated}</ActionList.TrailingVisual>
                <ActionList.Description variant="block">
                  The ones left on code that has changed since. Comments on the current code stay open.
                </ActionList.Description>
              </ActionList.Item>
            </ActionList.Group>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {chosen && (
        <Modal
          title={chosen === 'bots' ? 'Resolve AI comments' : chosen === 'outdated' ? 'Resolve outdated comments' : 'Resolve all comments'}
          subtitle={`${pr.title} · #${pr.number}`}
          width="min(480px, 94vw)"
          onClose={close}
          footer={
            <div className={styles.footer}>
              <span className={styles.grow} />
              {bulk.result || bulk.running ? (
                <Button disabled={bulk.running !== null} onClick={close}>
                  Close
                </Button>
              ) : (
                <>
                  <Button onClick={close}>Cancel</Button>
                  <Button variant="primary" leadingVisual={CheckIcon} disabled={n === 0} onClick={() => void bulk.run(chosen)}>
                    Resolve {n}
                  </Button>
                </>
              )}
            </div>
          }
        >
          {bulk.running ? (
            <Text as="p" className={styles.progress}>
              <Spinner size="small" /> Resolving {bulk.running.done} of {bulk.running.total}…
            </Text>
          ) : bulk.result ? (
            <Flash variant={bulk.result.ok ? 'success' : 'danger'}>{bulk.result.message}</Flash>
          ) : (
            <Text as="p">
              Resolve {n} {what} {plural(n)} on GitHub? They can be unresolved again there.
            </Text>
          )}
        </Modal>
      )}
    </span>
  );
}

function ThreadChip({ thread, onOpen }: { thread: ReviewThread; onOpen: () => void }) {
  const first = thread.comments[0];
  const login = first?.author?.login ?? 'ghost';
  const isBot = first?.author?.isBot === true;
  const snippet = commentSnippet(first?.body ?? '');
  const where = thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
  const replies = thread.comments.length - 1;
  const tip = `${login}${isBot ? ' (bot)' : ''} on ${where}${thread.isOutdated ? ' (outdated)' : ''}: ${
    snippet.length > 240 ? `${snippet.slice(0, 240)}…` : snippet
  }`;
  return (
    <span className={tooltipWrap}>
      <Tooltip text={tip} type="description">
        <button
          type="button"
          className={thread.isOutdated ? styles.chipOutdated : styles.chip}
          aria-label={`Review comment by ${tip}`}
          onClick={onOpen}
        >
          {first?.author && <Avatar src={first.author.avatarUrl} size={16} alt="" className={styles.chipAvatar} />}
          <span className={styles.chipAuthor}>{login}</span>
          {isBot && <span className={styles.chipBot}>bot</span>}
          <span className={styles.chipText}>{snippet || where}</span>
          {replies > 0 && (
            <span className={styles.chipReplies}>
              <CommentIcon size={12} />
              {replies}
            </span>
          )}
        </button>
      </Tooltip>
    </span>
  );
}

// ── The dialog ──────────────────────────────────────────────────────────────────────────────────

/** Whether Claude can write here: desktop, the AI switch on, and `claude` installed. */
function useClaudeAvailable(): boolean {
  const { config } = useConfig();
  const [ready, setReady] = useState(false);
  const wanted = config.ai.enabled && composeAvailable();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void probeClaudeTools().then((status) => {
      if (live) setReady(claudeToolsReady(status));
    });
    return () => {
      live = false;
    };
  }, [wanted]);
  return wanted && ready;
}

export function ReviewThreadsDialog({
  pr,
  focusThreadId,
  onClose,
}: {
  pr: PullRequest;
  /** The thread whose chip was clicked: scrolled to and marked. */
  focusThreadId?: string;
  onClose: () => void;
}) {
  const { refreshReviewThreads } = useDashboard();
  const { canRerun: canWrite } = useTokenCapability();
  const claudeAvailable = useClaudeAvailable();
  const bulk = useBulkResolve(pr);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Bulk | null>(null);

  const reload = useCallback(async () => {
    try {
      await refreshReviewThreads(pr.number);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [refreshReviewThreads, pr.number]);

  // Always re-read on open: resolving a thread on GitHub is not known to bump the PR's
  // `updated_at`, so the polled copy may be behind.
  useEffect(() => {
    void reload();
  }, [reload]);

  const threads = bulk.threads;
  const unresolved = threads.filter((t) => !t.isResolved);
  const outdatedCount = unresolved.filter((t) => t.isOutdated).length;
  const visible = showResolved ? threads : unresolved;

  const bulkButton = (b: Bulk) => {
    const n = bulk.targets(b).length;
    if (!canWrite || n === 0 || confirm) return null;
    const running = bulk.running?.bulk === b ? bulk.running : null;
    return (
      <Button
        leadingVisual={b === 'bots' ? CopilotIcon : CheckIcon}
        disabled={bulk.running !== null}
        onClick={() => {
          bulk.setResult(null);
          setConfirm(b);
        }}
      >
        {running ? `Resolving ${running.done}/${running.total}…` : `${BULK[b].button} (${n})`}
      </Button>
    );
  };

  const footer = (
    <div className={styles.footer}>
      {bulkButton('bots')}
      {bulkButton('outdated')}
      {bulkButton('all')}
      {confirm && (
        <>
          <Text className={styles.small}>
            Resolve {bulk.targets(confirm).length} {BULK[confirm].adjective} {plural(bulk.targets(confirm).length)} on GitHub?
          </Text>
          <Button
            variant="primary"
            onClick={() => {
              setConfirm(null);
              void bulk.run(confirm);
            }}
          >
            {BULK[confirm].button}
          </Button>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
        </>
      )}
      <span className={styles.grow} />
      <Button onClick={onClose}>Close</Button>
    </div>
  );

  return (
    <Modal
      title="Review comments"
      subtitle={`${pr.title} · #${pr.number} · ${unresolved.length} unresolved of ${threads.length}${
        outdatedCount > 0 ? `, ${outdatedCount} outdated` : ''
      }`}
      onClose={onClose}
      width="min(880px, 94vw)"
      footer={footer}
    >
      <div className={styles.toolbar}>
        <label className={styles.check}>
          <Checkbox checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
        {loading && <Spinner size="small" />}
      </div>
      {loadError && (
        <Flash variant="danger" className={styles.mb2}>
          The review comments could not be read: {loadError}
        </Flash>
      )}
      {bulk.result && (
        <Flash variant={bulk.result.ok ? 'success' : 'danger'} className={styles.mb2}>
          {bulk.result.message}
        </Flash>
      )}
      {!canWrite && threads.length > 0 && (
        <Text as="p" className={styles.muted}>
          This token can’t write to the repository, so the comments are read-only here.
        </Text>
      )}
      {visible.length === 0 && !loading ? (
        <Text as="p" className={styles.muted}>
          {threads.length === 0 ? 'No review comments on this pull request.' : 'Every conversation is resolved.'}
        </Text>
      ) : (
        visible.map((t) => (
          <ThreadCard
            key={t.id}
            pr={pr}
            thread={t}
            focused={t.id === focusThreadId}
            canWrite={canWrite}
            claudeAvailable={claudeAvailable}
            onChanged={reload}
          />
        ))
      )}
    </Modal>
  );
}

// ── One conversation, and the panel that resolves or replies to it ──────────────────────────────

/**
 * The panel under a conversation. `resolveAfter` resolves it once the text (if any) is posted;
 * `claude` is what Claude is doing to the text right now, and `fromClaude` whether the box holds
 * Claude's words, so the panel can say so.
 */
interface Composer {
  text: string;
  instruction: string;
  resolveAfter: boolean;
  claude: null | { kind: 'write' | 'improve'; requestId: string };
  fromClaude: boolean;
  verdict: ResolveVerdict | null;
  note?: string;
}

const VERDICT_LABEL: Record<ResolveVerdict, { text: string; variant: 'success' | 'secondary' | 'accent' | 'danger' }> = {
  addressed: { text: 'addressed in the code', variant: 'success' },
  obsolete: { text: 'no longer applies', variant: 'secondary' },
  settled: { text: 'settled in the conversation', variant: 'accent' },
  unaddressed: { text: 'not addressed yet', variant: 'danger' },
};

function ThreadCard({
  pr,
  thread,
  focused,
  canWrite,
  claudeAvailable,
  onChanged,
}: {
  pr: PullRequest;
  thread: ReviewThread;
  focused: boolean;
  canWrite: boolean;
  claudeAvailable: boolean;
  onChanged: () => Promise<void>;
}) {
  const { config } = useConfig();
  const [composer, setComposer] = useState<Composer | null>(null);
  const [busy, setBusy] = useState<'resolve' | 'post' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claudeId = useRef<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  // A draft still being written when the dialog closes is a `claude` process nobody will read.
  useEffect(
    () => () => {
      if (claudeId.current) void cancelClaudeAnalysis(claudeId.current);
    },
    [],
  );

  // The chip that opened the dialog was this thread's: bring it into view once.
  useEffect(() => {
    if (focused) card.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);

  const canResolve = canWrite && thread.viewerCanResolve && !thread.isResolved;
  const canReply = canWrite && thread.viewerCanReply;

  const patch = (p: Partial<Composer>) => setComposer((c) => (c ? { ...c, ...p } : c));

  const stopClaude = () => {
    if (claudeId.current) void cancelClaudeAnalysis(claudeId.current);
    claudeId.current = null;
  };

  const resolveNow = async () => {
    setBusy('resolve');
    setError(null);
    try {
      await Telemetry.measure(Operation.GH_REVIEW_THREAD_WRITE, () => resolveReviewThread(thread.id));
      Telemetry.featureUsed(Feature.REVIEW_THREAD_RESOLVED);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /** The file as it is now at the PR head, around the thread's line — the evidence for a resolve note. */
  const readCurrentCode = async (): Promise<CurrentCode> => {
    const { owner, repo } = config.upstream;
    try {
      const file = await fetchFileAtRef(owner, repo, thread.path, pr.head.sha);
      return file == null ? { kind: 'deleted' } : { kind: 'excerpt', text: codeExcerpt(file, thread.line) };
    } catch (e) {
      devWarn('api', `review thread: ${thread.path} at the PR head could not be read`, e);
      return { kind: 'unavailable' };
    }
  };

  /**
   * Have Claude fill the box: `write` from scratch — the note saying why, when resolving, or a
   * reply — and `improve` to rewrite what the user typed, on their instruction.
   */
  const askClaude = async (kind: 'write' | 'improve', start: Composer) => {
    stopClaude();
    const requestId = newRequestId();
    claudeId.current = requestId;
    setError(null);
    setComposer({ ...start, claude: { kind, requestId }, note: undefined });

    const { owner, repo } = config.upstream;
    const resolving = start.resolveAfter && canResolve;
    const settings = kind === 'improve' ? config.ai.reply : resolving ? config.ai.resolve : config.ai.reply;
    const base = {
      repoSlug: `${owner}/${repo}`,
      prNumber: pr.number,
      prTitle: pr.title,
      thread,
      extraInstructions: config.ai.extraInstructions,
    };
    let prompt: string;
    let operation: OperationId;
    let feature: FeatureId;
    if (kind === 'improve') {
      prompt = buildImproveReplyPrompt({ ...base, draft: start.text, instruction: start.instruction, resolving });
      operation = Operation.CLAUDE_REVIEW_REPLY_IMPROVE;
      feature = Feature.AI_REVIEW_REPLY_IMPROVED;
    } else if (resolving) {
      const currentCode = await readCurrentCode();
      prompt = buildResolveNotePrompt({ ...base, promptOverride: settings.prompt, currentCode });
      operation = Operation.CLAUDE_REVIEW_RESOLVE_NOTE;
      feature = Feature.AI_REVIEW_RESOLVE_NOTE;
    } else {
      prompt = buildReviewReplyPrompt({ ...base, promptOverride: settings.prompt });
      operation = Operation.CLAUDE_REVIEW_REPLY;
      feature = Feature.AI_REVIEW_REPLY;
    }
    if (claudeId.current !== requestId) return; // cancelled while the file was read
    Telemetry.featureUsed(feature);
    const startedAtMs = performance.now();
    // All three run as the bridge's `reply` task: one turn, no tools, over a brief written here.
    const result = await composeWithClaude({ prompt, requestId, task: 'reply', model: settings.model, effort: settings.effort });
    if (claudeId.current !== requestId) return; // cancelled or superseded
    claudeId.current = null;
    if (!result.ok) {
      if (!result.cancelled) {
        Telemetry.operationFailed(operation, ErrorCategory.UNKNOWN);
        devWarn('claude', `review ${kind}: no text`, result.error);
      }
      // What the user had stays in the box.
      patch({ claude: null, note: `Claude could not do this one (${result.error}).` });
      return;
    }
    Telemetry.operationCompleted(operation, performance.now() - startedAtMs);
    const parsed =
      kind === 'write' && resolving
        ? parseResolveNote(result.reply)
        : { verdict: null, text: parseReviewReply(result.reply) };
    patch({
      text: parsed.text,
      verdict: kind === 'write' ? parsed.verdict : null,
      claude: null,
      fromClaude: true,
      note: result.incompleteReason ? `Claude stopped early (${result.incompleteReason}).` : undefined,
    });
  };

  const openComposer = (resolveAfter: boolean, claudeWrites = false) => {
    const start: Composer = { text: '', instruction: '', resolveAfter, claude: null, fromClaude: false, verdict: null };
    if (claudeWrites) void askClaude('write', start);
    else setComposer(start);
  };

  const cancelComposer = () => {
    stopClaude();
    setComposer(null);
  };

  /** Post the text, if there is any, then resolve if asked — or just resolve, with nothing to say. */
  const submit = async () => {
    if (!composer) return;
    const text = composer.text.trim();
    const andResolve = composer.resolveAfter && canResolve;
    if (!text) {
      if (andResolve) {
        setComposer(null);
        await resolveNow();
      }
      return;
    }
    setBusy('post');
    setError(null);
    try {
      await Telemetry.measure(Operation.GH_REVIEW_THREAD_WRITE, () => replyToReviewThread(thread.id, text));
      Telemetry.featureUsed(Feature.REVIEW_THREAD_REPLIED);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
      return;
    }
    // The reply is out; from here a failure must not leave it in the box to be posted twice.
    setComposer(null);
    if (andResolve) {
      try {
        await Telemetry.measure(Operation.GH_REVIEW_THREAD_WRITE, () => resolveReviewThread(thread.id));
        Telemetry.featureUsed(Feature.REVIEW_THREAD_RESOLVED);
      } catch (e) {
        setError(`The reply was posted, but the conversation could not be resolved: ${errorText(e)}`);
      }
    }
    try {
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const where = thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
  const cardClass = thread.isResolved ? styles.threadResolved : focused ? styles.threadFocused : styles.thread;

  return (
    <div ref={card} className={cardClass}>
      <div className={styles.threadHeader}>
        <Link href={thread.comments[0]?.url ?? pr.html_url} target="_blank" rel="noreferrer" className={styles.path}>
          {where}
        </Link>
        {thread.isOutdated && <Label variant="secondary">outdated</Label>}
        {thread.isResolved && <Label variant="done">resolved</Label>}
        <span className={styles.grow} />
        {busy === 'resolve' && <Spinner size="small" />}
      </div>
      {thread.comments.map((c) => (
        <CommentItem
          key={c.id}
          comment={c}
          canResolve={canResolve && busy === null}
          canReply={canReply && !composer}
          claudeAvailable={claudeAvailable}
          onResolveNow={() => void resolveNow()}
          onResolve={() => openComposer(true)}
          onResolveWithClaude={() => openComposer(true, true)}
          onReply={() => openComposer(false)}
          onReplyWithClaude={() => openComposer(false, true)}
        />
      ))}
      {thread.commentsTruncated && (
        <Text as="p" className={styles.muted}>
          Longer conversation —{' '}
          <Link href={thread.comments[thread.comments.length - 1]?.url ?? pr.html_url} target="_blank" rel="noreferrer">
            read the rest on GitHub
          </Link>
          .
        </Text>
      )}
      {composer && (
        <ComposerPanel
          composer={composer}
          canResolve={canResolve}
          claudeAvailable={claudeAvailable}
          posting={busy === 'post'}
          onChange={patch}
          onAskClaude={(kind) => void askClaude(kind, composer)}
          onStopClaude={() => {
            stopClaude();
            patch({ claude: null });
          }}
          onSubmit={() => void submit()}
          onCancel={cancelComposer}
        />
      )}
      {error && (
        <Flash variant="danger" className={styles.mt2}>
          {error}
        </Flash>
      )}
    </div>
  );
}

/**
 * The text box and what can be done with it: type it yourself, tell Claude how to improve what
 * you typed, have Claude write it, then resolve (posting the text first, if there is any) or reply.
 */
function ComposerPanel({
  composer,
  canResolve,
  claudeAvailable,
  posting,
  onChange,
  onAskClaude,
  onStopClaude,
  onSubmit,
  onCancel,
}: {
  composer: Composer;
  canResolve: boolean;
  claudeAvailable: boolean;
  posting: boolean;
  onChange: (p: Partial<Composer>) => void;
  onAskClaude: (kind: 'write' | 'improve') => void;
  onStopClaude: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const resolving = composer.resolveAfter && canResolve;
  const working = composer.claude !== null;
  const hasText = composer.text.trim().length > 0;
  const locked = working || posting;
  const workingText =
    composer.claude?.kind === 'improve'
      ? 'Claude is improving your text…'
      : resolving
        ? 'Claude is checking the current code…'
        : 'Claude is writing a reply…';

  return (
    <div className={styles.composer}>
      {(working || composer.fromClaude || composer.note) && (
        <div className={styles.composerNote}>
          {(working || composer.fromClaude) && (
            <Label variant="accent">
              <SparkleFillIcon size={12} className={styles.mr1} />
              {working ? workingText : 'written by Claude — edit before posting'}
            </Label>
          )}
          {!working && composer.verdict && (
            <Label variant={VERDICT_LABEL[composer.verdict].variant}>{VERDICT_LABEL[composer.verdict].text}</Label>
          )}
          {working && (
            <>
              <Spinner size="small" />
              <Button size="small" variant="invisible" onClick={onStopClaude}>
                Stop
              </Button>
            </>
          )}
          {composer.note && <Text className={styles.small}>{composer.note}</Text>}
        </div>
      )}
      {!working && composer.verdict === 'unaddressed' && resolving && (
        <Flash variant="warning">
          Claude doesn’t think the comment is addressed in the current code. The note says what is
          missing — you can still post it and resolve, or untick “Resolve the conversation” to only reply.
        </Flash>
      )}
      <Textarea
        block
        rows={4}
        resize="vertical"
        disabled={locked}
        value={composer.text}
        placeholder={
          working ? '' : resolving ? 'Why it’s resolved — optional; leave empty to resolve without a comment' : 'Write a reply…'
        }
        aria-label={resolving ? 'Comment posted with resolving' : 'Reply'}
        onChange={(e) => onChange({ text: e.target.value, verdict: null })}
      />
      {claudeAvailable && (
        <div className={styles.claudeRow}>
          <TextInput
            block
            size="small"
            className={styles.grow}
            disabled={locked}
            value={composer.instruction}
            placeholder="How should Claude improve your text? e.g. shorter, more polite, mention the null check"
            aria-label="How Claude should improve the text"
            onChange={(e) => onChange({ instruction: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && hasText && !locked) onAskClaude('improve');
            }}
          />
          <Button size="small" leadingVisual={SparkleFillIcon} disabled={locked || !hasText} onClick={() => onAskClaude('improve')}>
            Improve with Claude
          </Button>
          <Button size="small" leadingVisual={SparkleFillIcon} disabled={locked} onClick={() => onAskClaude('write')}>
            {resolving ? 'Write why with Claude' : 'Reply with Claude'}
          </Button>
        </div>
      )}
      <div className={styles.composerActions}>
        <Button
          variant="primary"
          size="small"
          leadingVisual={resolving ? CheckIcon : undefined}
          disabled={locked || (!hasText && !resolving)}
          onClick={onSubmit}
        >
          {posting ? 'Posting…' : resolving ? (hasText ? 'Post and resolve' : 'Resolve') : 'Post reply'}
        </Button>
        <Button size="small" onClick={onCancel} disabled={posting}>
          Cancel
        </Button>
        {canResolve && (
          <label className={styles.check}>
            <Checkbox
              checked={composer.resolveAfter}
              disabled={posting}
              onChange={(e) => onChange({ resolveAfter: e.target.checked })}
            />
            Resolve the conversation
          </label>
        )}
      </div>
    </div>
  );
}

/** One comment; clicking it opens the choice of what to do with its conversation. */
function CommentItem({
  comment,
  canResolve,
  canReply,
  claudeAvailable,
  onResolveNow,
  onResolve,
  onResolveWithClaude,
  onReply,
  onReplyWithClaude,
}: {
  comment: ReviewComment;
  canResolve: boolean;
  canReply: boolean;
  claudeAvailable: boolean;
  onResolveNow: () => void;
  onResolve: () => void;
  onResolveWithClaude: () => void;
  onReply: () => void;
  onReplyWithClaude: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <div
        ref={anchor}
        role="button"
        tabIndex={0}
        className={styles.comment}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          // A link inside the comment body is followed, not treated as a click on the comment.
          if ((e.target as HTMLElement).closest('a')) return;
          setMenuOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        <div className={styles.commentMeta}>
          {comment.author && <Avatar src={comment.author.avatarUrl} size={16} alt="" />}
          <Text className={styles.author}>{comment.author?.login ?? 'ghost'}</Text>
          {comment.author?.isBot && <Label size="small">bot</Label>}
          <Text className={styles.small}>{formatRelative(comment.createdAt)}</Text>
        </div>
        <div className={styles.commentBody}>
          <MarkdownView markdown={comment.body} />
        </div>
      </div>
      <ActionMenu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={anchor}>
        {/* Above the Modal, whose backdrop sits at z-index 1000 in the same root stacking context. */}
        <ActionMenu.Overlay width="medium" className={styles.menuOverlay}>
          <ActionList>
            <ActionList.Item disabled={!canResolve} onSelect={onResolveNow}>
              <ActionList.LeadingVisual>
                <CheckIcon />
              </ActionList.LeadingVisual>
              Resolve now
            </ActionList.Item>
            <ActionList.Item disabled={!canResolve || !canReply} onSelect={onResolve}>
              <ActionList.LeadingVisual>
                <PencilIcon />
              </ActionList.LeadingVisual>
              Resolve with a comment…
              <ActionList.Description variant="block">
                Say why it is resolved — type it yourself, or have Claude write or improve it.
              </ActionList.Description>
            </ActionList.Item>
            {claudeAvailable && (
              <ActionList.Item disabled={!canResolve || !canReply} onSelect={onResolveWithClaude}>
                <ActionList.LeadingVisual>
                  <SparkleFillIcon />
                </ActionList.LeadingVisual>
                Resolve with a note from Claude
                <ActionList.Description variant="block">
                  Claude checks the current code and writes why the conversation can be closed. You
                  review it before it is posted and resolved.
                </ActionList.Description>
              </ActionList.Item>
            )}
            <ActionList.Divider />
            <ActionList.Item disabled={!canReply} onSelect={onReply}>
              <ActionList.LeadingVisual>
                <CommentIcon />
              </ActionList.LeadingVisual>
              Reply…
            </ActionList.Item>
            {claudeAvailable && (
              <ActionList.Item disabled={!canReply} onSelect={onReplyWithClaude}>
                <ActionList.LeadingVisual>
                  <SparkleFillIcon />
                </ActionList.LeadingVisual>
                Reply with Claude
                <ActionList.Description variant="block">
                  Drafts a reply for you to edit; nothing is posted until you post it.
                </ActionList.Description>
              </ActionList.Item>
            )}
            <ActionList.Divider />
            <ActionList.LinkItem href={comment.url} target="_blank" rel="noreferrer">
              <ActionList.LeadingVisual>
                <LinkExternalIcon />
              </ActionList.LeadingVisual>
              Open on GitHub
            </ActionList.LinkItem>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
    </>
  );
}

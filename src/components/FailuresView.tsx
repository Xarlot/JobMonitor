/**
 * Every failing job the app can see — across open and recently-merged pull
 * requests, and the latest run of each tracked flow — with a ready-to-paste
 * Markdown bug report for each.
 *
 * The list rides the existing polls, so a test that breaks shows up here within one
 * cycle without anyone going looking for it. Annotations are prefetched, so the test
 * names are visible in the list rather than behind a click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  CounterLabel,
  Flash,
  IconButton,
  Label,
  Octicon,
  SegmentedControl,
  Spinner,
  Text,
  Tooltip,
} from '@primer/react';
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  GitPullRequestIcon,
  LinkExternalIcon,
  SparkleFillIcon,
  FileIcon,
  GitCommitIcon,
  SyncIcon,
  WorkflowIcon,
  ZapIcon,
} from '@primer/octicons-react';
import type { NavigationRequest } from '../context/NavigationContext';
import { useCopy } from '../hooks/useCopy';
import { useClaudeTriage } from '../hooks/useClaudeTriage';
import type { ClaudeAnalysis, ClaudeDepth } from '../lib/claudePrompt';
import { ClaudeTriageDialog } from './ClaudeTriageDialog';
import { ghLogAvailable } from '../storage/desktopClaude';
import { analysedFailures } from '../storage/failureCaches';
import { LogPanel } from './LogPanel';
import { MarkdownView } from './MarkdownView';
import { useFillHeight } from '../hooks/useFillHeight';
import { useConfig } from '../context/ConfigContext';
import { useDashboard } from '../context/DashboardContext';
import { sectionFailures, type FailedJobRef, type FailureGroup } from '../lib/failures';
import { useFailures } from '../context/FailuresContext';
import { loadFailuresLayout, saveFailuresLayout } from '../storage/failureGroupsStore';
import {
  blameVerdict,
  buildFailureReport,
  failureAnnotations,
  failureFingerprint,
  joinReports,
  signatureFromAnnotations,
  type ReportFormat,
} from '../lib/failureReport';
import { markdownToHtml } from '../lib/markdownToHtml';
import { formatRelative } from '../lib/format';
import { subtleScrollbarSx } from '../lib/scrollbar';
import {
  EMPTY_FAILURE_DETAIL,
  useFailureDetails,
  type FailureDetail,
} from '../hooks/useFailureDetails';

/** Rendered-HTML preview for the Teams target. */
const richBoxSx = {
  p: 3,
  bg: 'canvas.default',
  color: 'fg.default',
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'border.default',
  overflowY: 'auto',
  flex: 1,
  minHeight: 0,
  fontSize: 1,
  '& h3': { fontSize: 2, mt: 0, mb: 2 },
  '& h4': { fontSize: 1, mt: 3, mb: 1 },
  '& p': { my: 2 },
  '& ul': { pl: 4, my: 2 },
  '& pre': { overflowX: 'auto', fontSize: 0 },
  '& a': { color: 'accent.fg' },
  ...subtleScrollbarSx,
} as const;

const monoBoxSx = {
  m: 0,
  p: 3,
  fontFamily: 'mono',
  fontSize: 0,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  bg: 'canvas.inset',
  color: 'fg.default',
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'border.default',
  overflowY: 'auto',
  flex: 1,
  minHeight: 0,
  ...subtleScrollbarSx,
} as const;

/**
 * Assemble the Markdown report for one failure. Module scope, not a closure over
 * the component, so it is cheap to memoize and testable on its own.
 */
function buildReport(
  failure: FailedJobRef,
  detail: FailureDetail,
  format: ReportFormat,
  analysis: ClaudeAnalysis | null = null,
  blame: string | null = null,
): string {
  const annotations = detail.annotations ?? [];
  return buildFailureReport({
    jobName: failure.jobName,
    failedStep: detail.failedStep,
    origin: failure.origin,
    headRef: failure.headRef,
    headSha: failure.headSha,
    workflowFile: detail.workflowFile ?? failure.workflowFile,
    runUrl:
      failure.runId != null
        ? `https://github.com/${failure.owner}/${failure.repo}/actions/runs/${failure.runId}`
        : null,
    runNumber: detail.runNumber ?? failure.runNumber,
    runAttempt: detail.runAttempt ?? failure.runAttempt,
    jobUrl: failure.url,
    completedAt: failure.completedAt,
    annotations,
    logTail: detail.logTail ?? [],
    fingerprint: failureFingerprint(
      signatureFromAnnotations(failure.jobName, detail.failedStep, annotations),
    ),
    format,
    appVersion: __APP_VERSION__,
    generatedAt: new Date(),
    analysis,
    blame,
  });
}

/** How many failing tests we know about, for the list row. */
function testCountLabel(detail: FailureDetail): string | null {
  if (detail.annotations === null) return null;
  const failures = failureAnnotations(detail.annotations).length;
  if (failures === 0) return 'no annotations';
  return `${failures} ${failures === 1 ? 'test' : 'tests'}`;
}

/**
 * What has already been produced for a failure, as one icon per task.
 *
 * The list is where you decide what to spend a call on next, and without this the only way
 * to know whether a row had been looked at was to open it — which is the same click you
 * were trying to avoid. Results live a week, so on a Monday morning most of a red board
 * may already be answered.
 */
const RESULT_ICONS: { depth: ClaudeDepth; icon: typeof ZapIcon; label: string }[] = [
  { depth: 'quick', icon: ZapIcon, label: 'has a quick read' },
  { depth: 'deep', icon: SparkleFillIcon, label: 'has a deep analysis' },
  { depth: 'log', icon: FileIcon, label: 'has a rewritten log' },
  { depth: 'blame', icon: GitCommitIcon, label: 'has traced who broke it' },
];

function ResultIcons({ have }: { have: ReadonlySet<string> | undefined }) {
  if (!have?.size) return null;
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      {RESULT_ICONS.filter((r) => have.has(r.depth)).map((r) => (
        <Tooltip key={r.depth} text={`Claude ${r.label}`} direction="n">
          <Octicon icon={r.icon} size={12} sx={{ color: 'done.fg' }} />
        </Tooltip>
      ))}
    </Box>
  );
}

function FailureRow({
  failure,
  detail,
  selected,
  focused,
  results,
  onToggle,
  onFocus,
}: {
  failure: FailedJobRef;
  detail: FailureDetail;
  selected: boolean;
  focused: boolean;
  results: ReadonlySet<string> | undefined;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const count = testCountLabel(detail);
  return (
    <Box
      // Anchor for arriving from a run — see the focus effect in FailuresView.
      id={`failure-${failure.key}`}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        py: 2,
        borderTop: '1px solid',
        borderColor: 'border.muted',
        bg: focused ? 'accent.subtle' : 'transparent',
        cursor: 'pointer',
        ':hover': { bg: focused ? 'accent.subtle' : 'canvas.subtle' },
      }}
      onClick={onFocus}
    >
      <Box as="span" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <Checkbox checked={selected} onChange={onToggle} aria-label={`Select ${failure.jobName}`} />
      </Box>
      <Octicon icon={AlertIcon} size={14} sx={{ color: 'danger.fg', flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Text sx={{ fontSize: 1, display: 'block', wordBreak: 'break-word' }}>
          {failure.jobName}
        </Text>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            color: 'fg.muted',
          }}
        >
          {count && <Text sx={{ fontSize: 0 }}>{count}</Text>}
          {failure.completedAt && (
            <Text sx={{ fontSize: 0 }}>{formatRelative(failure.completedAt)}</Text>
          )}
          <ResultIcons have={results} />
        </Box>
      </Box>
    </Box>
  );
}


/** One PR's or one flow's failures, under a header that collapses. */
function FailureGroupBlock({
  group,
  collapsed,
  details,
  results,
  selected,
  focusedKey,
  onToggleGroup,
  onToggleRow,
  onFocusRow,
}: {
  group: FailureGroup;
  collapsed: boolean;
  details: Record<string, FailureDetail>;
  /** Which Claude results exist, per failure key — scanned once for the whole list. */
  results: Map<string, Set<string>>;
  selected: ReadonlySet<string>;
  focusedKey: string | null;
  onToggleGroup: () => void;
  onToggleRow: (key: string) => void;
  onFocusRow: (key: string) => void;
}) {
  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          pl: 3,
          pr: 2,
          py: 2,
          bg: 'canvas.subtle',
          borderTop: '1px solid',
          borderColor: 'border.default',
          cursor: 'pointer',
          ':hover': { bg: 'canvas.inset' },
        }}
        onClick={onToggleGroup}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleGroup();
          }
        }}
      >
        <Octicon
          icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
          size={14}
          sx={{ color: 'fg.muted', flexShrink: 0 }}
        />
        <Octicon
          icon={group.kind === 'flow' ? WorkflowIcon : GitPullRequestIcon}
          size={14}
          sx={{ color: 'fg.muted', flexShrink: 0 }}
        />
        {/*
          Plain text, not a link: the whole header toggles, and a wide title link
          would swallow the click that people naturally aim at it. Opening on GitHub
          gets its own button on the right.
        */}
        <Text
          sx={{
            fontSize: 0,
            fontWeight: 'bold',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={group.title}
        >
          {group.title}
        </Text>
        <Box sx={{ flex: 1 }} />
        {/* A collapsed group must still say how much it is hiding. */}
        {collapsed && <CounterLabel>{group.jobs.length}</CounterLabel>}
        <Label variant={GROUP_BADGE_VARIANT[group.badge] ?? 'secondary'}>{group.badge}</Label>
        <IconButton
          as="a"
          size="small"
          variant="invisible"
          icon={LinkExternalIcon}
          aria-label={
            group.kind === 'flow'
              ? `Open ${group.title} run on GitHub`
              : `Open ${group.title} on GitHub`
          }
          href={group.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        />
      </Box>
      {!collapsed &&
        group.jobs.map((failure) => (
          <FailureRow
            key={failure.key}
            failure={failure}
            detail={details[failure.key] ?? EMPTY_FAILURE_DETAIL}
            selected={selected.has(failure.key)}
            focused={failure.key === focusedKey}
            results={results.get(failure.key)}
            onToggle={() => onToggleRow(failure.key)}
            onFocus={() => onFocusRow(failure.key)}
          />
        ))}
    </Box>
  );
}

/** Colour the group badge by what it says: PR state, or a run's trigger. */
const GROUP_BADGE_VARIANT: Record<string, 'success' | 'done' | 'secondary'> = {
  open: 'success',
  merged: 'done',
};

export function FailuresView({ focusFailure }: { focusFailure?: NavigationRequest<string> } = {}) {
  const { config } = useConfig();
  const { isFetchingChecks } = useDashboard();
  const { failures, groups } = useFailures();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** The user's explicit pick — nothing is focused until a row is clicked. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [format, setFormat] = useState<ReportFormat>(config.failureReports.format);
  /**
   * Groups start **collapsed** and sections start **open**, so each is persisted as
   * its exceptions. A red board is then a short scannable list of what is broken,
   * and expanding is how you say "show me this one" — which also means no requests
   * are spent on rows nobody is looking at.
   */
  const [layout, setLayout] = useState(loadFailuresLayout);
  const { expandedGroups, collapsedSections } = layout;

  const sections = useMemo(() => sectionFailures(groups), [groups]);

  // Persist, pruned to the groups that still exist so ids for long-gone PRs don't
  // pile up.
  const groupIdsSig = groups.map((g) => g.id).join(',');
  useEffect(() => {
    saveFailuresLayout(layout, new Set(groupIdsSig ? groupIdsSig.split(',') : []));
  }, [layout, groupIdsSig]);

  const toggleIn = (which: 'expandedGroups' | 'collapsedSections', id: string) =>
    setLayout((prev) => {
      const next = new Set(prev[which]);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [which]: next };
    });

  const toggleGroup = (id: string) => toggleIn('expandedGroups', id);
  const toggleSection = (kind: string) => toggleIn('collapsedSections', kind);

  /**
   * Rows actually on screen — what prefetching should be scoped to. A row counts as
   * visible only if its group is open *and* its section is.
   */
  const visible = useMemo(
    () =>
      sections
        .filter((section) => !collapsedSections.has(section.kind))
        .flatMap((section) =>
          section.groups.filter((g) => expandedGroups.has(g.id)).flatMap((g) => g.jobs),
        ),
    [sections, collapsedSections, expandedGroups],
  );

  // Derived rather than synced by an effect: failures come and go between polls, and
  // a stale focus would otherwise survive. Selections are likewise filtered against
  // the live list at use, so a vanished failure can't end up in a copied report.
  /**
   * Arriving from a run, for one failure.
   *
   * Focusing it is not enough: this list starts with its groups **collapsed**, so the row
   * would be focused inside something shut and the tab would look like it had ignored the
   * request. So the group and section holding it are opened, and only then is it scrolled to
   * — a frame later, since it does not exist in the DOM until that expansion has rendered.
   *
   * Keyed on the request's nonce rather than the failure key, so asking for the same one
   * twice still scrolls back to it.
   */
  const requestedKey = focusFailure?.target ?? null;
  const requestNonce = focusFailure?.nonce ?? 0;
  useEffect(() => {
    if (!requestedKey) return;
    const target = failures.find((f) => f.key === requestedKey);
    if (!target) return;

    setFocusKey(requestedKey);
    const owner = sections.find((section) =>
      section.groups.some((g) => g.jobs.some((j) => j.key === requestedKey)),
    );
    const group = owner?.groups.find((g) => g.jobs.some((j) => j.key === requestedKey));
    if (owner || group) {
      setLayout((prev) => ({
        expandedGroups: group ? new Set(prev.expandedGroups).add(group.id) : prev.expandedGroups,
        collapsedSections: owner
          ? new Set([...prev.collapsedSections].filter((k) => k !== owner.kind))
          : prev.collapsedSections,
      }));
    }

    const raf = requestAnimationFrame(() => {
      document
        .getElementById(`failure-${requestedKey}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
    // `failures` and `sections` are read at the moment of the request; re-running when they
    // change would re-scroll on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestNonce, requestedKey]);

  const focused = focusKey ? (failures.find((f) => f.key === focusKey) ?? null) : null;

  const { details, reloadLog } = useFailureDetails(failures, visible, focused?.key ?? null, {
    prefetchAnnotations: config.failureReports.prefetchAnnotations,
    logTailLines: config.failureReports.logTailLines,
  });

  const { copied, failed: copyFailed, copy, copyRich } = useCopy();
  const triage = useClaudeTriage();
  /** Which depth's dialog is open, if any. */
  const [triageOpen, setTriageOpen] = useState<ClaudeDepth | null>(null);

  // Measured, so the panes fill whatever the header/nav/toolbar leave behind.
  const panesRef = useRef<HTMLDivElement>(null);
  const fillHeight = useFillHeight(panesRef, { min: 360, bottomGap: 32 });

  const focusedDetail = focused ? (details[focused.key] ?? EMPTY_FAILURE_DETAIL) : null;

  // Memoized because it is what the preview renders: rebuilding it on every poll
  // would re-run the whole normalize/hash/format pass, and — since the footer
  // stamps the current time — would also mean the copied text never quite matched
  // what was on screen.
  // One scan for the whole list rather than a lookup per row. Recomputed each render:
  // the cache has no subscription, and this view re-renders on every poll anyway, so an
  // icon appears within a cycle of the analysis landing.
  const results = analysedFailures();

  /** Which half of the right pane is showing. */
  const [pane, setPane] = useState<'report' | 'log'>('report');
  /** Show the report as the literal Markdown that Copy puts on the clipboard. */
  const [raw, setRaw] = useState(false);
  const quickTriage = focused ? triage.stateFor(focused.key, 'quick') : null;
  const logTriage = focused ? triage.stateFor(focused.key, 'log') : null;
  const blameTriage = focused ? triage.stateFor(focused.key, 'blame') : null;
  const deepTriage = focused ? triage.stateFor(focused.key, 'deep') : null;
  // The deep read supersedes the quick one in the report when both exist.
  const reportAnalysis = deepTriage?.analysis ?? quickTriage?.analysis ?? null;
  // Only when the reader asked for it: a verdict naming a person does not belong in a bug
  // report by default.
  const reportBlame =
    blameTriage?.inReport && blameTriage.document ? blameVerdict(blameTriage.document) : null;
  // Keyed off the open depth rather than a chain of ternaries, so adding a task cannot
  // leave its dialog silently unopenable — which is exactly what happened when blame was
  // added and this mapping still only knew about quick and deep.
  const openTriage = focused && triageOpen ? triage.stateFor(focused.key, triageOpen) : null;
  const focusedReport = useMemo(
    () =>
      focused && focusedDetail
        ? buildReport(focused, focusedDetail, format, reportAnalysis, reportBlame)
        : null,
    [focused, focusedDetail, format, reportAnalysis],
  );

  const startTriage = (depth: ClaudeDepth, options?: { resume?: boolean }) => {
    if (!focused || !focusedDetail) return;
    triage.run(
      focused,
      {
        failedStep: focusedDetail.failedStep,
        workflowFile: focusedDetail.workflowFile,
        annotations: focusedDetail.annotations ?? [],
      },
      depth,
      options,
    );
  };

  /**
   * GitHub's issue editor renders Markdown you paste; Teams does not — it only applies
   * its shortcuts as you type, so a pasted `.md` arrives as literal `**` and `####`.
   * For Teams the report therefore goes on the clipboard as rendered HTML, with the
   * Markdown as the plain-text alternative.
   */
  const putOnClipboard = (markdown: string) => {
    if (format === 'teams') copyRich(markdownToHtml(markdown), markdown);
    else copy(markdown);
  };

  const chosen = failures.filter((f) => selected.has(f.key));

  const copySelected = () => {
    if (chosen.length === 0) return;
    putOnClipboard(
      joinReports(
        chosen.map((f) =>
          buildReport(
            f,
            details[f.key] ?? EMPTY_FAILURE_DETAIL,
            format,
            triage.stateFor(f.key, 'deep').analysis ?? triage.stateFor(f.key, 'quick').analysis,
            (() => {
              const b = triage.stateFor(f.key, 'blame');
              return b.inReport && b.document ? blameVerdict(b.document) : null;
            })(),
          ),
        ),
      ),
    );
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (failures.length === 0) {
    return (
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          <Octicon icon={CheckIcon} size={16} sx={{ color: 'success.fg' }} />
          <Text sx={{ fontWeight: 'bold' }}>Nothing is failing</Text>
          {isFetchingChecks && <Spinner size="small" />}
        </Box>
        <Text as="p" sx={{ color: 'fg.muted', fontSize: 1 }}>
          Failing jobs from your open pull requests, the{' '}
          {config.mergedPrs.count > 0
            ? `${config.mergedPrs.count} most recently merged`
            : 'recently merged'}{' '}
          ones, and the latest run of every flow you track appear here as soon as they are reported
          — with a Markdown report ready to paste into Teams or a GitHub issue.
          {config.mergedPrs.count === 0 && ' Merged PRs are currently switched off in Settings.'}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          mb: 3,
          flexWrap: 'wrap',
        }}
      >
        <Text sx={{ fontWeight: 'bold' }}>
          {failures.length} failing {failures.length === 1 ? 'job' : 'jobs'}
        </Text>
        {isFetchingChecks && <Spinner size="small" />}
        <Box sx={{ flex: 1 }} />
        {chosen.length > 0 && (
          <Button leadingVisual={CopyIcon} onClick={copySelected}>
            Copy {chosen.length} selected
          </Button>
        )}
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          {format === 'teams' ? 'copies as rich text' : 'copies as Markdown'}
        </Text>
        <SegmentedControl aria-label="Report format" size="small">
          <SegmentedControl.Button
            selected={format === 'github'}
            onClick={() => setFormat('github')}
          >
            GitHub
          </SegmentedControl.Button>
          <SegmentedControl.Button selected={format === 'teams'} onClick={() => setFormat('teams')}>
            Teams
          </SegmentedControl.Button>
        </SegmentedControl>
      </Box>

      {copied && (
        <Flash variant="success" sx={{ mb: 3 }}>
          Copied to the clipboard.
        </Flash>
      )}
      {copyFailed && (
        <Flash variant="warning" sx={{ mb: 3 }}>
          Couldn’t reach the clipboard — select the text below and copy it manually.
        </Flash>
      )}

      <Box
        ref={panesRef}
        sx={{
          display: 'grid',
          gridTemplateColumns: ['1fr', '1fr', 'minmax(280px, 380px) 1fr'],
          gap: 3,
          alignItems: 'stretch',
          // Fill the rest of the viewport: the report is the tall thing here, and
          // capping it left most of the window empty. Each column scrolls on its own.
          height: fillHeight ?? undefined,
        }}
      >
        {/* Left: the failures, grouped by the PR or flow they came from. */}
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'border.default',
            borderRadius: 2,
            overflowY: 'auto',
            minHeight: 0,
            ...subtleScrollbarSx,
          }}
        >
          {sections.map((section) => {
            const sectionOpen = !collapsedSections.has(section.kind);
            return (
              <Box key={section.kind}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 2,
                    py: 2,
                    borderTop: '1px solid',
                    borderColor: 'border.default',
                    cursor: 'pointer',
                    ':hover': { bg: 'canvas.subtle' },
                  }}
                  onClick={() => toggleSection(section.kind)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={sectionOpen}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleSection(section.kind);
                    }
                  }}
                >
                  <Octicon
                    icon={sectionOpen ? ChevronDownIcon : ChevronRightIcon}
                    size={16}
                    sx={{ color: 'fg.muted', flexShrink: 0 }}
                  />
                  <Text sx={{ fontSize: 1, fontWeight: 'bold' }}>{section.title}</Text>
                  <Box sx={{ flex: 1 }} />
                  <CounterLabel>{section.count}</CounterLabel>
                </Box>
                {sectionOpen &&
                  section.groups.map((group) => (
                    <FailureGroupBlock
                      key={group.id}
                      group={group}
                      collapsed={!expandedGroups.has(group.id)}
                      details={details}
                      results={results}
                      selected={selected}
                      focusedKey={focused?.key ?? null}
                      onToggleGroup={() => toggleGroup(group.id)}
                      onToggleRow={toggle}
                      onFocusRow={setFocusKey}
                    />
                  ))}
              </Box>
            );
          })}
        </Box>

        {/* Right: the report for whatever is focused. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {focused && focusedDetail && (
            <>
              {/*
                Title left, actions right, and the actions are one group rather than
                siblings of the title. With a flat row plus a spacer, a long job name
                pushed the buttons past the edge and they wrapped *individually* — half
                the cluster right-aligned on the first line, the rest left-aligned on the
                second.

                Both children are `flex: 1 1` so they share one line when it fits. When it
                doesn't, the actions wrap as a whole and — being growable with their own
                content right-aligned — fill that line and stay on the right. The title
                keeps a floor rather than shrinking first: a job name squeezed to "…f-pdfs"
                identifies nothing, and losing a row is cheaper than losing the name.
              */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  mb: 2,
                  flexWrap: 'wrap',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    minWidth: 0,
                    // Natural width, and it does not grow: a short name shares the row
                    // with the buttons, a long one takes what it needs and pushes them to
                    // their own line. Shrinking is the last resort (ellipsis), not the
                    // first response.
                    flex: '0 1 auto',
                  }}
                >
                  <Text
                    // Truncated rather than wrapped: the report immediately below repeats
                    // the job name in full as its heading.
                    title={focused.jobName}
                    sx={{
                      fontWeight: 'bold',
                      fontSize: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {focused.jobName}
                  </Text>
                  {focusedDetail.loadingLog && <Spinner size="small" />}
                </Box>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    flexWrap: 'wrap',
                    justifyContent: 'flex-end',
                    // Grows so that on a line of its own it fills the width and its
                    // right-aligned contents land on the right edge; never shrinks, which
                    // is what forces the wrap instead of crushing the buttons.
                    flex: '1 1 auto',
                    flexShrink: 0,
                  }}
                >
                  {/*
                  Desktop only, and only when both CLIs are there: this shells out to
                  the developer's own `gh` and `claude`. It is the one action in the
                  app that sends data anywhere other than api.github.com, so it never
                  runs on its own — only on this click.
                */}
                  {triage.available && focused.runId != null && (
                    <>
                      {/*
                      Two depths, two buttons. The quick read is for "is this even
                      mine?" while triaging; the deep one goes and fetches artifacts.
                      Re-opening a finished analysis just shows it — only a fresh
                      failure starts a run.
                    */}
                      <Button
                        // The spinner replaces the icon rather than sitting beside it, so
                        // the button keeps its width and the row doesn't reflow when one
                        // of several concurrent analyses starts or finishes.
                        leadingVisual={quickTriage?.running ? undefined : ZapIcon}
                        onClick={() => {
                          setTriageOpen('quick');
                          if (!quickTriage?.running && !quickTriage?.analysis) startTriage('quick');
                        }}
                      >
                        {quickTriage?.running ? (
                          <>
                            <Spinner size="small" sx={{ mr: 1, verticalAlign: 'text-bottom' }} />
                            Checking…
                          </>
                        ) : quickTriage?.analysis ? (
                          'Quick read ✓'
                        ) : (
                          'Quick read'
                        )}
                      </Button>
                      <Button
                        leadingVisual={blameTriage?.running ? undefined : GitCommitIcon}
                        onClick={() => {
                          setTriageOpen('blame');
                          if (!blameTriage?.running && !blameTriage?.document) startTriage('blame');
                        }}
                      >
                        {blameTriage?.running ? (
                          <>
                            <Spinner size="small" sx={{ mr: 1, verticalAlign: 'text-bottom' }} />
                            Tracing…
                          </>
                        ) : blameTriage?.document ? (
                          'Who broke it ✓'
                        ) : (
                          'Who broke it'
                        )}
                      </Button>
                      <Button
                        leadingVisual={deepTriage?.running ? undefined : SparkleFillIcon}
                        onClick={() => {
                          setTriageOpen('deep');
                          if (!deepTriage?.running && !deepTriage?.analysis) startTriage('deep');
                        }}
                      >
                        {deepTriage?.running ? (
                          <>
                            <Spinner size="small" sx={{ mr: 1, verticalAlign: 'text-bottom' }} />
                            Investigating…
                          </>
                        ) : deepTriage?.analysis ? (
                          'Deep analysis ✓'
                        ) : (
                          'Deep analysis'
                        )}
                      </Button>
                    </>
                  )}
                  <Button
                    variant="primary"
                    leadingVisual={CopyIcon}
                    onClick={() => focusedReport && putOnClipboard(focusedReport)}
                  >
                    {format === 'teams' ? 'Copy for Teams' : 'Copy markdown'}
                  </Button>
                  {focused.jobId != null && (
                    <IconButton
                      icon={SyncIcon}
                      aria-label="Reload log"
                      onClick={() => reloadLog(focused.key)}
                    />
                  )}
                  {focused.url && (
                    <IconButton
                      as="a"
                      icon={LinkExternalIcon}
                      aria-label="Open job on GitHub"
                      href={focused.url}
                      target="_blank"
                      rel="noreferrer"
                    />
                  )}
                </Box>
              </Box>
              {focusedDetail.error && (
                <Flash variant="warning" sx={{ mb: 2, fontSize: 0 }}>
                  {focusedDetail.error}
                </Flash>
              )}

              {/*
                The report is what you paste into a bug; the log is what you read to
                understand it. Separate views rather than one long scroll, because the
                report deliberately carries only a tail of the log.
              */}
              <SegmentedControl aria-label="What to show" size="small" sx={{ mb: 2 }}>
                <SegmentedControl.Button
                  selected={pane === 'report'}
                  onClick={() => setPane('report')}
                >
                  Report
                </SegmentedControl.Button>
                <SegmentedControl.Button selected={pane === 'log'} onClick={() => setPane('log')}>
                  Log
                </SegmentedControl.Button>
              </SegmentedControl>
              {pane === 'report' && format === 'github' && (
                <Button
                  size="small"
                  variant="invisible"
                  sx={{ ml: 2 }}
                  aria-pressed={raw}
                  onClick={() => setRaw((v) => !v)}
                >
                  {raw ? 'Rendered' : 'Raw Markdown'}
                </Button>
              )}

              {pane === 'log' ? (
                <LogPanel
                  jobId={focused.jobId}
                  runId={focused.runId}
                  runAttempt={focused.runAttempt}
                  owner={focused.owner}
                  repo={focused.repo}
                  rewrittenLog={logTriage?.document ?? null}
                  rewriteRunning={Boolean(logTriage?.running)}
                  // Two different permissions: `gh` can fetch the run log with AI off,
                  // and AI can rewrite a log with no `gh` at all.
                  ghAvailable={ghLogAvailable(triage.tools)}
                  aiAvailable={triage.available}
                  onRewrite={() => startTriage('log')}
                  maxHeight="60vh"
                />
              ) : format === 'teams' ? (
                // Rendered, because that is what goes on the clipboard for Teams — and
                // it doubles as a fallback: selecting this and copying by hand gives
                // Teams the same rich text.
                <Box
                  sx={richBoxSx}
                  dangerouslySetInnerHTML={{
                    __html: markdownToHtml(focusedReport ?? ''),
                  }}
                />
              ) : raw ? (
                <Box as="pre" sx={monoBoxSx}>
                  {focusedReport}
                </Box>
              ) : (
                // Rendered by default. GitHub renders this Markdown when you paste it, so
                // showing it rendered is the truer preview — and it puts the log tail
                // through the highlighter instead of leaving a wall of grey `###` and
                // `<details>` tags. The raw text is one click away, since it is what the
                // Copy button actually puts on the clipboard.
                <Box sx={{ ...richBoxSx, p: 0, border: 'none' }}>
                  <MarkdownView markdown={focusedReport ?? ''} />
                </Box>
              )}
            </>
          )}
          {triageOpen && focused && openTriage && (
            <ClaudeTriageDialog
              jobName={focused.jobName}
              depth={triageOpen}
              state={openTriage}
              onCancel={() => triage.cancel(focused.key, triageOpen)}
              onRetry={() => startTriage(triageOpen)}
              onContinue={() => startTriage(triageOpen, { resume: true })}
              onToggleInReport={() =>
                triage.setInReport(focused.key, triageOpen, !openTriage.inReport)
              }
              onClose={() => setTriageOpen(null)}
            />
          )}
          {/* Nothing auto-focuses, since every group starts collapsed. */}
          {!focused && (
            <Box
              sx={{
                border: '1px dashed',
                borderColor: 'border.default',
                borderRadius: 2,
                p: 4,
                color: 'fg.muted',
                fontSize: 1,
              }}
            >
              Open a group and pick a failing job to see its bug report.
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

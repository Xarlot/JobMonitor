import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Flash, FormControl, Heading, IconButton, Label, Link, SegmentedControl, Select, Spinner, Text, TextInput, Textarea, UnderlineNav } from '@primer/react';
import {
  BellIcon,
  BugIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  GearIcon,
  PlusIcon,
  SearchIcon,
  ShieldLockIcon,
  AlertFillIcon,
  CheckCircleFillIcon,
  ChecklistIcon,
  CopyIcon,
  SparkleFillIcon,
  XCircleFillIcon,
  SyncIcon,
  TrashIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { useConfig } from '../context/ConfigContext';
import { WorkflowBrowserDialog, type FlowPick } from './WorkflowBrowserDialog';
import { WorkflowFilesField } from './WorkflowFilesField';
import { useAuth } from '../context/AuthContext';
import {
  AI_EFFORTS,
  AI_MODELS,
  MAX_FLOW_MATCHES,
  monitorConfigSchema,
  newFlowId,
  safeParseConfig,
  type AiConfig,
  type AiTaskConfig,
  type AutoMergeConfig,
  type DiagnosticsConfig,
  type FeatureBranchesConfig,
  type EmptyFlowFilter,
  type FailureReportsConfig,
  type Flow,
  type FlowMatch,
  type MergedPrsConfig,
  type MonitorConfig,
  type NotificationPrefs,
  type PrAutoRerunConfig,
} from '../storage/configStore';
import {
  claudeBridgeAvailable,
  diagnosticsLogPath,
  probeClaudeTools,
  revealDiagnosticsLog,
  type ClaudeToolStatus,
} from '../storage/desktopClaude';
import { compileFlowPattern, isPatternFlow, matchWorkflowsUncapped } from '../lib/flowPatterns';
import { workflowBasename } from '../lib/workflow';
import {
  ensureNotificationPermission,
  notificationPermission,
  notificationsSupported,
} from '../lib/notifications';
import { canRememberSecret, isDesktop } from '../storage/desktopSecret';
import { autoUpdateSupported } from '../storage/desktopUpdates';
import { isMockMode } from '../mocks/mockMode';
import { useTokenCapability } from '../hooks/useTokenCapability';
import { useWorkflowList } from '../hooks/useWorkflowList';
import type { TokenCapability } from '../api/tokenCapability';
import { Feature, Telemetry } from '../lib/telemetry';
import styles from './SettingsPage.module.css';
import { Icon } from './Icon';

/**
 * Plain-language summary of what the token may do, so that re-run controls being
 * absent is explained rather than mysterious. Re-running failed jobs needs a
 * classic PAT with `repo` *and* the Write role on the repository; a fine-grained
 * token's Actions permission can't be verified through the API at all, so it is
 * treated as read-only.
 */
function capabilityReadout(cap: TokenCapability): { text: string; variant: 'success' | 'attention' } {
  if (cap.canRerun) {
    return { text: 'can re-run failed jobs', variant: 'success' };
  }
  switch (cap.reason) {
    case 'pending':
      return { text: 'checking permissions…', variant: 'attention' };
    case 'no-repo-scope':
      return { text: 'read-only (no repo scope) — re-run features hidden', variant: 'attention' };
    case 'no-push-access':
      return { text: 'read-only on this repository — re-run features hidden', variant: 'attention' };
    case 'refused':
      return { text: 'GitHub refused a re-run — re-run features hidden', variant: 'attention' };
    case 'not-classic':
      return {
        text:
          cap.kind === 'fine-grained'
            ? "fine-grained — Actions permission can't be verified, so re-run features are hidden; use a classic repo token"
            : 're-run features hidden — use a classic token with the repo scope',
        variant: 'attention',
      };
    default:
      return { text: 're-run features hidden', variant: 'attention' };
  }
}

function clone(config: MonitorConfig): MonitorConfig {
  return JSON.parse(JSON.stringify(config)) as MonitorConfig;
}

/** Token credentials: encrypt + store a PAT, or forget an active one. */
function TokenSection() {
  const { status, saveToken, forget, error } = useAuth();
  const readout = capabilityReadout(useTokenCapability());
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(false);
  const [canRemember, setCanRemember] = useState(false);

  useEffect(() => {
    let active = true;
    canRememberSecret().then((ok) => active && setCanRemember(ok));
    return () => {
      active = false;
    };
  }, []);

  const mismatch = confirm.length > 0 && confirm !== passphrase;

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSaved(false);
    if (token.trim().length < 10) {
      setLocalError('That does not look like a valid token.');
      return;
    }
    // Report each unmet requirement specifically so it's clear which rule failed.
    // Unicode-aware so non-Latin layouts work: an uppercase letter is any
    // upper-case letter in any script (\p{Lu}) — e.g. Cyrillic "Й" counts — and a
    // "special character" is anything that is not a letter, digit or whitespace,
    // so letters from other scripts are NOT mistaken for special characters.
    const missing: string[] = [];
    if (passphrase.length < 8) missing.push('at least 8 characters');
    if (!/\p{Lu}/u.test(passphrase)) missing.push('an uppercase letter');
    if (!/[^\p{L}\p{N}\s]/u.test(passphrase)) missing.push('a special character (e.g. ! @ # -)');
    if (missing.length > 0) {
      setLocalError(`Passphrase needs ${missing.join(', ')}.`);
      return;
    }
    if (passphrase !== confirm) {
      setLocalError('Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      await saveToken(token.trim(), passphrase, remember);
      setToken('');
      setPassphrase('');
      setConfirm('');
      setSaved(true);
    } catch {
      // surfaced via context error
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.roundedP4}>
      <div className={styles.flexCenter}>
        <ShieldLockIcon size={20} className={styles.accentFg} />
        <Heading as="h2" className={styles.title}>GitHub token</Heading>
        {status === 'unlocked' && <Label variant="success">loaded in memory</Label>}
        {status === 'unlocked' && <Label variant={readout.variant}>{readout.text}</Label>}
      </div>
      <Text as="p" className={styles.fgMutedBody}>
        Use a{' '}
        <Link
          href="https://github.com/settings/tokens/new?scopes=repo&description=Job%20Monitor"
          target="_blank"
          rel="noreferrer"
        >
          classic token
        </Link>{' '}
        with the <strong>repo</strong> scope. A fine-grained PAT covers most data but
        {' '}<strong>can’t download Actions logs</strong> (GitHub returns 404), and its Actions
        permission can’t be verified through the API — so <strong>re-running failed jobs is only
        offered with a classic <code>repo</code> token</strong> on a repository you can write to.
        {' '}<code>public_repo</code> is enough to read a public repo, but not to re-run anything.
      </Text>

      {isMockMode() ? (
        <Flash variant="warning">Mock mode is active — no real token is used.</Flash>
      ) : (
        <>
          {(localError || error) && (
            <Flash variant="danger" className={styles.mb3}>{localError ?? error}</Flash>
          )}
          {saved && <Flash variant="success" className={styles.mb3}>Token encrypted and stored.</Flash>}

          <form onSubmit={onSave}>
            <FormControl className={styles.mb3}>
              <FormControl.Label>Personal access token</FormControl.Label>
              <TextInput
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… (classic token)"
                block
                autoComplete="off"
              />
            </FormControl>
            <div className={styles.flexGap3}>
              <FormControl className={styles.mb3Grow}>
                <FormControl.Label>Passphrase</FormControl.Label>
                <TextInput
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  block
                  autoComplete="new-password"
                />
              </FormControl>
              <FormControl className={styles.mb3Grow}>
                <FormControl.Label>Confirm passphrase</FormControl.Label>
                <TextInput
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  block
                  autoComplete="new-password"
                  validationStatus={mismatch ? 'error' : undefined}
                />
              </FormControl>
            </div>
            {canRemember && (
              <FormControl className={styles.mb3}>
                <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <FormControl.Label>Remember on this device</FormControl.Label>
                <FormControl.Caption>
                  Stores the passphrase in your OS keychain so the app unlocks automatically.
                </FormControl.Caption>
              </FormControl>
            )}
            <div className={styles.flexGap2}>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Saving…' : status === 'unlocked' ? 'Replace token' : 'Encrypt & store token'}
              </Button>
              {status === 'unlocked' && (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => {
                    if (window.confirm('Forget the stored token?')) void forget();
                  }}
                >
                  Forget token
                </Button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}

/** Common GitHub workflow-run event types offered as checkboxes, with a hint. */
const KNOWN_WORKFLOW_EVENTS = [
  'workflow_dispatch',
  'push',
  'pull_request',
  'pull_request_target',
  'schedule',
  'release',
  'workflow_run',
];

const EVENT_HINTS: Record<string, string> = {
  workflow_dispatch: 'manual',
  schedule: 'cron',
  workflow_run: 'after another workflow',
  pull_request_target: 'PR from fork',
};

/** Checkbox group for selecting workflow events (preserves any custom values). */
function EventsField({
  events,
  onChange,
}: {
  events: string[];
  onChange: (next: string[]) => void;
}) {
  const options = Array.from(new Set([...KNOWN_WORKFLOW_EVENTS, ...events]));
  const toggle = (ev: string, on: boolean) =>
    onChange(on ? [...events, ev] : events.filter((e) => e !== ev));
  return (
    <div>
      <Text as="label" className={styles.blockBody}>
        Events (optional)
      </Text>
      <div className={styles.flex}>
        {options.map((ev) => (
          <FormControl key={ev}>
            <Checkbox
              checked={events.includes(ev)}
              onChange={(e) => toggle(ev, e.target.checked)}
            />
            <FormControl.Label className={styles.normal}>
              {ev}
              {EVENT_HINTS[ev] && (
                <Text as="span" className={styles.fgMutedMl1}>
                  ({EVENT_HINTS[ev]})
                </Text>
              )}
            </FormControl.Label>
          </FormControl>
        ))}
      </div>
      <Text className={styles.blockSmall}>
        None selected = any event
      </Text>
    </div>
  );
}

const MATCH_BY_LABELS: Record<FlowMatch['by'], string> = {
  name: 'workflow name',
  file: 'file name',
  any: 'name or file',
};

/**
 * Live answer to "what does this regex actually match?" — the repo's workflow list
 * is fetched once (ETag-cached) and re-filtered locally on every keystroke.
 */
function PatternPreview({
  owner,
  repo,
  match,
}: {
  owner: string;
  repo: string;
  match: FlowMatch;
}) {
  const { workflows, loading, error } = useWorkflowList(owner, repo);

  const patternError = compileFlowPattern(match).error;
  if (patternError) {
    return (
      <Flash variant="danger" className={styles.mt2Body}>
        Invalid regex: {patternError}
      </Flash>
    );
  }
  if (!match.pattern.trim()) {
    return (
      <Text className={styles.blockSmall2}>
        Enter a regex to see which workflows it matches.
      </Text>
    );
  }
  if (!owner || !repo) {
    return (
      <Text className={styles.blockSmall2}>
        Set an upstream repo (or this flow’s owner/repo) to preview the matches.
      </Text>
    );
  }
  if (error) {
    return (
      <Flash variant="warning" className={styles.mt2Body}>
        Couldn’t load the workflow list: {error}
      </Flash>
    );
  }
  if (!workflows) {
    return (
      <div className={styles.flexCenter2}>
        {loading && <Spinner size="small" />}
        <Text className={styles.smallFgMuted}>Loading the repo’s workflows…</Text>
      </div>
    );
  }

  // Uncapped first, so we can tell the user when `maxMatches` is what's limiting them.
  const matched = matchWorkflowsUncapped(workflows, match);
  const shown = matched.slice(0, match.maxMatches);

  return (
    <div className={styles.mt2}>
      <Text className={matched.length === 0 ? styles.smallAttention : styles.smallFgMuted}>
        Matches <strong>{matched.length}</strong> of {workflows.length} workflows
        {matched.length > shown.length &&
          (matched.length > MAX_FLOW_MATCHES
            ? ` · showing ${shown.length}; past the ${MAX_FLOW_MATCHES}-flow cap — tighten the regex`
            : ` · showing ${shown.length} (raise “Max matches”)`)}
      </Text>
      {shown.length > 0 && (
        <ul
          className={styles.m0Mt1}
        >
          {shown.map((w) => (
            <li key={w.id} className={styles.smallFlex}>
              <Text className={styles.bold}>{w.name}</Text>
              <Text className={styles.fgMutedMono}>
                {workflowBasename(w.path)}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The regex source of a flow: pattern + what it is matched against + the cap. */
function PatternFields({
  match,
  owner,
  repo,
  onChange,
}: {
  match: FlowMatch;
  owner: string;
  repo: string;
  onChange: (next: FlowMatch) => void;
}) {
  return (
    <div>
      <div className={styles.gridWide}>
        <FormControl>
          <FormControl.Label>Regex</FormControl.Label>
          <TextInput
            value={match.pattern}
            onChange={(e) => onChange({ ...match, pattern: e.target.value })}
            placeholder="^check-.*|tests?$"
            className={styles.mono}
            block
          />
          <FormControl.Caption>
            JavaScript regex, unanchored — it just has to match somewhere.
          </FormControl.Caption>
        </FormControl>
        <FormControl>
          <FormControl.Label>Match against</FormControl.Label>
          <Select
            value={match.by}
            onChange={(e) => onChange({ ...match, by: e.target.value as FlowMatch['by'] })}
            block
          >
            {(Object.keys(MATCH_BY_LABELS) as FlowMatch['by'][]).map((by) => (
              <Select.Option key={by} value={by}>
                {MATCH_BY_LABELS[by]}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
      </div>
      <div className={styles.flexGap4}>
        <FormControl>
          <Checkbox
            checked={match.caseSensitive}
            onChange={(e) => onChange({ ...match, caseSensitive: e.target.checked })}
          />
          <FormControl.Label>Case sensitive</FormControl.Label>
        </FormControl>
        <FormControl className={styles.width}>
          <FormControl.Label>Max matches</FormControl.Label>
          <TextInput
            type="number"
            value={String(match.maxMatches)}
            onChange={(e) =>
              onChange({
                ...match,
                maxMatches: Math.min(MAX_FLOW_MATCHES, Math.max(1, Number(e.target.value) || 1)),
              })
            }
            title="Each match polls on its own — keep this tight"
            block
          />
        </FormControl>
      </div>
      <PatternPreview owner={owner} repo={repo} match={match} />
    </div>
  );
}

function FlowEditor({
  flow,
  upstream,
  onChange,
  onRemove,
}: {
  flow: Flow;
  /** Effective fallback coordinates used when the flow has no owner/repo override. */
  upstream: { owner: string; repo: string };
  onChange: (next: Flow) => void;
  onRemove: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // A flow *is* a regex flow when its pattern is non-empty; the mode is separate UI
  // state so the fields stay put while the pattern box is still empty.
  const [regexMode, setRegexMode] = useState(() => isPatternFlow(flow));
  const set = <K extends keyof Flow>(key: K, value: Flow[K]) => onChange({ ...flow, [key]: value });
  const csv = (arr: string[]) => arr.join(', ');
  const parseCsv = (s: string) =>
    s
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  // The browser queries the flow's own coordinates, falling back to upstream.
  const browseOwner = (flow.owner ?? '').trim() || upstream.owner.trim();
  const browseRepo = (flow.repo ?? '').trim() || upstream.repo.trim();
  const canBrowse = Boolean(browseOwner && browseRepo);

  const applyPick = (pick: FlowPick) => {
    onChange({
      ...flow,
      name: pick.name || flow.name,
      workflowFile: pick.workflowFile || flow.workflowFile,
      branches: pick.branch ? [pick.branch] : flow.branches,
      events: pick.event ? [pick.event] : flow.events,
    });
    setAdvanced(true); // reveal the just-filled branch/event so the change is visible
  };

  return (
    <div className={styles.roundedP3}>
      {/* Header: name + remove */}
      <div className={styles.flexGap3_2}>
        {/* A flow name is a short label; `flex: 1` alone stretched it across the card. */}
        <FormControl className={styles.grow}>
          <FormControl.Label>Name</FormControl.Label>
          <TextInput value={flow.name} onChange={(e) => set('name', e.target.value)} block />
        </FormControl>
        <div className={styles.grow2} />
        <IconButton
          aria-label="Remove flow"
          icon={TrashIcon}
          variant="danger"
          onClick={onRemove}
        />
      </div>

      {/* What this flow watches: one workflow, or every workflow matching a regex */}
      <div>
        <SegmentedControl aria-label="What this flow watches" size="small" className={styles.mb3}>
          <SegmentedControl.Button
            selected={!regexMode}
            onClick={() => {
              setRegexMode(false);
              // Clear the pattern, otherwise the flow keeps expanding into matches.
              if (isPatternFlow(flow)) set('match', { ...flow.match, pattern: '' });
            }}
          >
            One workflow
          </SegmentedControl.Button>
          <SegmentedControl.Button selected={regexMode} onClick={() => setRegexMode(true)}>
            Every workflow matching a regex
          </SegmentedControl.Button>
        </SegmentedControl>

        {regexMode ? (
          <>
            <PatternFields
              match={flow.match}
              owner={browseOwner}
              repo={browseRepo}
              onChange={(next) => set('match', next)}
            />
            <Text className={styles.blockSmall2}>
              Each match becomes its own card on the board — with the branches, events and
              visibility filter below — and can be dragged into any group.
            </Text>
          </>
        ) : (
          <>
            <div className={styles.flexGap2_2}>
              <FormControl className={styles.grow2}>
                <FormControl.Label>Workflow name, file, or id</FormControl.Label>
                <TextInput
                  value={flow.workflowFile}
                  onChange={(e) => set('workflowFile', e.target.value)}
                  placeholder="ci.yml, CI, or 42"
                  block
                />
              </FormControl>
              <Button
                leadingVisual={SearchIcon}
                onClick={() => {
                  Telemetry.featureUsed(Feature.FLOW_WORKFLOW_BROWSER_OPENED);
                  setBrowsing(true);
                }}
                disabled={!canBrowse}
                title={
                  canBrowse
                    ? 'Browse workflows that ran in the last day'
                    : 'Set an upstream repo (or this flow’s owner/repo) first'
                }
              >
                Browse…
              </Button>
            </div>
            <Text className={styles.blockSmall}>
              Display name, file name (with/without .yml), or numeric id — resolved automatically.
            </Text>
          </>
        )}
      </div>

      {/* Additional settings — collapsed by default */}
      <div className={styles.mt3Pt3}>
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
          className={styles.flexCenter3}
        >
          <Icon icon={advanced ? ChevronDownIcon : ChevronRightIcon} size={16} />
          Additional settings
        </button>

        {advanced && (
          <div className={styles.mt3}>
            <div className={styles.grid2}>
              <FormControl>
                <FormControl.Label>Owner</FormControl.Label>
                <TextInput
                  value={flow.owner ?? ''}
                  onChange={(e) => set('owner', e.target.value || undefined)}
                  placeholder="defaults to upstream"
                  block
                />
              </FormControl>
              <FormControl>
                <FormControl.Label>Repo</FormControl.Label>
                <TextInput
                  value={flow.repo ?? ''}
                  onChange={(e) => set('repo', e.target.value || undefined)}
                  placeholder="defaults to upstream"
                  block
                />
              </FormControl>
              <FormControl className={styles.fullRow}>
                <FormControl.Label>Branches</FormControl.Label>
                <TextInput
                  value={csv(flow.branches)}
                  onChange={(e) => set('branches', parseCsv(e.target.value))}
                  placeholder="main, release/*"
                  block
                />
                <FormControl.Caption>Comma-separated</FormControl.Caption>
              </FormControl>
              <div className={styles.fullRow}>
                <EventsField events={flow.events} onChange={(next) => set('events', next)} />
              </div>
              <FormControl className={styles.width}>
                <FormControl.Label>Max runs / event</FormControl.Label>
                <TextInput
                  type="number"
                  value={String(flow.maxRuns)}
                  onChange={(e) => set('maxRuns', Math.max(1, Number(e.target.value) || 1))}
                  title="Kept per branch × event"
                  block
                />
              </FormControl>
            </div>

            {/* Per-flow visibility filter */}
            <div className={styles.mt3Pt3}>
              <FormControl className={flow.emptyFilter.enabled ? styles.mb3 : undefined}>
          <Checkbox
            checked={flow.emptyFilter.enabled}
            onChange={(e) => set('emptyFilter', { ...flow.emptyFilter, enabled: e.target.checked })}
          />
          <FormControl.Label>Filter this flow by activity</FormControl.Label>
        </FormControl>
        {flow.emptyFilter.enabled && (
          <div className={styles.grid3}>
            <FormControl>
              <FormControl.Label>Visibility</FormControl.Label>
              <Select
                value={flow.emptyFilter.mode}
                onChange={(e) =>
                  set('emptyFilter', { ...flow.emptyFilter, mode: e.target.value as EmptyFlowFilter['mode'] })
                }
                block
              >
                <Select.Option value="hide">Hide when</Select.Option>
                <Select.Option value="show">Show when</Select.Option>
              </Select>
            </FormControl>
            <FormControl>
              <FormControl.Label>Condition</FormControl.Label>
              <Select
                value={flow.emptyFilter.by}
                onChange={(e) =>
                  set('emptyFilter', { ...flow.emptyFilter, by: e.target.value as EmptyFlowFilter['by'] })
                }
                block
              >
                <Select.Option value="no_runs">no runs</Select.Option>
                <Select.Option value="only_skipped">all runs skipped</Select.Option>
                <Select.Option value="no_artifacts">no / tiny artifacts</Select.Option>
                <Select.Option value="job">a job is in a state</Select.Option>
              </Select>
            </FormControl>
            {flow.emptyFilter.by === 'no_artifacts' && (
              <FormControl>
                <FormControl.Label>Min artifact KB</FormControl.Label>
                <TextInput
                  type="number"
                  value={String(flow.emptyFilter.minArtifactKB)}
                  onChange={(e) =>
                    set('emptyFilter', {
                      ...flow.emptyFilter,
                      minArtifactKB: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  block
                />
              </FormControl>
            )}
            {flow.emptyFilter.by === 'job' && (
              <>
                <FormControl>
                  <FormControl.Label>Job name contains</FormControl.Label>
                  <TextInput
                    value={flow.emptyFilter.jobName}
                    onChange={(e) => set('emptyFilter', { ...flow.emptyFilter, jobName: e.target.value })}
                    placeholder="test"
                    block
                  />
                </FormControl>
                <FormControl>
                  <FormControl.Label>and is</FormControl.Label>
                  <Select
                    value={flow.emptyFilter.jobState}
                    onChange={(e) =>
                      set('emptyFilter', {
                        ...flow.emptyFilter,
                        jobState: e.target.value as EmptyFlowFilter['jobState'],
                      })
                    }
                    block
                  >
                    <Select.Option value="skipped">skipped</Select.Option>
                    <Select.Option value="failure">failed</Select.Option>
                    <Select.Option value="success">succeeded</Select.Option>
                    <Select.Option value="in_progress">in progress</Select.Option>
                  </Select>
                </FormControl>
              </>
            )}
          </div>
        )}
            </div>
          </div>
        )}
      </div>

      {browsing && (
        <WorkflowBrowserDialog
          owner={browseOwner}
          repo={browseRepo}
          onSelect={applyPick}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}

/** Opt-in desktop notifications for finished PRs / flow runs. */
function NotificationsSection({
  prefs,
  onChange,
}: {
  prefs: NotificationPrefs;
  onChange: (patch: Partial<NotificationPrefs>) => void;
}) {
  const supported = notificationsSupported();
  const [perm, setPerm] = useState<NotificationPermission>(() => notificationPermission());

  const toggle = async (key: keyof NotificationPrefs, on: boolean) => {
    // Only the opt-in. Turning a notification off is a different question and would cancel this
    // one out in the totals.
    if (on) Telemetry.featureUsed(Feature.NOTIFICATIONS_ENABLED);
    onChange({ [key]: on });
    // Ask for OS permission the moment the user opts in.
    if (on && supported) setPerm(await ensureNotificationPermission());
  };

  const anyOn = prefs.pr || prefs.flow || prefs.autoRerun;
  const { canRerun } = useTokenCapability();

  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb2}>Notifications</Heading>
      <Text as="p" className={styles.fgMutedBody}>
        Show a desktop notification when a tracked item finishes. Uses your browser's notification
        permission; nothing leaves this browser.
      </Text>
      {!supported && (
        <Flash variant="warning" className={styles.mb3}>This browser doesn’t support notifications.</Flash>
      )}
      {supported && anyOn && perm === 'denied' && (
        <Flash variant="warning" className={styles.mb3}>
          Notifications are blocked for this site — enable them in your browser’s site settings.
        </Flash>
      )}
      <FormControl className={styles.mb2} disabled={!supported}>
        <Checkbox checked={prefs.pr} onChange={(e) => void toggle('pr', e.target.checked)} />
        <FormControl.Label>Notify when a PR’s checks finish</FormControl.Label>
      </FormControl>
      <FormControl className={styles.mb2} disabled={!supported}>
        <Checkbox checked={prefs.flow} onChange={(e) => void toggle('flow', e.target.checked)} />
        <FormControl.Label>Notify when a flow run finishes</FormControl.Label>
      </FormControl>
      {/* Only meaningful where auto-rerun can actually run. */}
      {canRerun && (
        <FormControl disabled={!supported}>
          <Checkbox
            checked={prefs.autoRerun}
            onChange={(e) => void toggle('autoRerun', e.target.checked)}
          />
          <FormControl.Label>Notify when failed jobs are re-run automatically</FormControl.Label>
          <FormControl.Caption>
            Also tells you when a re-run was refused, so a silent failure can’t go unnoticed.
          </FormControl.Caption>
        </FormControl>
      )}
    </div>
  );
}

/** Desktop auto-update toggle. Hidden in the browser; disabled where unsupported. */
function UpdatesSection({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    autoUpdateSupported().then((ok) => active && setSupported(ok));
    return () => {
      active = false;
    };
  }, []);

  if (!isDesktop()) return null; // auto-update is a desktop-app feature only

  const canUpdate = supported === true;
  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb2}>Updates</Heading>
      <Text as="p" className={styles.fgMutedBody}>
        Automatically download and install new versions from GitHub releases.
      </Text>
      {!canUpdate && (
        <Flash variant="warning" className={styles.mb3}>
          Auto-update isn’t available in this environment (a dev run or a <code>.deb</code> install).
          Use the AppImage / installer build to enable it.
        </Flash>
      )}
      <FormControl disabled={!canUpdate}>
        <Checkbox checked={canUpdate && enabled} onChange={(e) => onChange(e.target.checked)} />
        <FormControl.Label>Automatically install updates</FormControl.Label>
        <FormControl.Caption>Downloads in the background and restarts to apply.</FormControl.Caption>
      </FormControl>
    </div>
  );
}

/**
 * Auto-rerun of failed jobs — the only setting in the app that arms a write, so it
 * is hidden outright when the token can't do it, with the reason spelled out
 * (a section that simply isn't there is confusing).
 */
function AutoRerunSection({
  upstream,
  settings,
  onChange,
}: {
  upstream: MonitorConfig['upstream'];
  settings: PrAutoRerunConfig;
  onChange: (patch: Partial<PrAutoRerunConfig>) => void;
}) {
  const capability = useTokenCapability();

  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb1}>
        Auto-rerun failed jobs
      </Heading>
      <Text as="p" className={styles.fgMutedBody}>
        When a workflow below finishes badly on a pull request that has{' '}
        <strong>auto-merge enabled</strong>, Job Monitor asks GitHub to re-run its failed
        jobs. This is the only thing the app changes on GitHub, and it costs CI minutes —
        it stays off until you list at least one workflow.
      </Text>

      {!capability.canRerun ? (
        <Flash variant="warning" className={styles.body}>
          This token can’t re-run jobs, so auto-rerun is unavailable:{' '}
          {capabilityReadout(capability).text}. Add a classic token with the{' '}
          <code>repo</code> scope on <strong>Token &amp; login</strong>, for a repository you
          have write access to.
        </Flash>
      ) : (
        <>
          <FormControl className={styles.mb3}>
            <Checkbox
              checked={settings.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            <FormControl.Label>Re-run failed jobs automatically</FormControl.Label>
            <FormControl.Caption>
              Only for pull requests waiting on auto-merge. Never for cancelled runs, and
              never for runs waiting on a human approval.
            </FormControl.Caption>
          </FormControl>

          {/*
            Laid out by hand rather than with FormControl: the field is a custom
            component, which FormControl doesn't recognise as its input and so
            renders the caption after it instead of above.
          */}
          <div className={styles.mb3}>
            <Text as="label" className={styles.blockBold}>
              Workflows
            </Text>
            <Text as="p" className={styles.fgMutedSmall}>
              Exact file names. A run is only re-run when its workflow file is listed here.
            </Text>
            <WorkflowFilesField
              owner={upstream.owner}
              repo={upstream.repo}
              value={settings.workflowFiles}
              onChange={(next) => onChange({ workflowFiles: next })}
            />
          </div>

          <div
            className={styles.grid2}
          >
            <FormControl>
              <FormControl.Label>Max attempts</FormControl.Label>
              <TextInput
                type="number"
                min={1}
                max={20}
                value={settings.maxAttempts}
                onChange={(e) => onChange({ maxAttempts: Number(e.target.value) || 1 })}
                block
                className={styles.maxWidth}
              />
              <FormControl.Caption>
                Counts GitHub’s own attempt number, so it survives restarts. 1 means never
                retry.
              </FormControl.Caption>
            </FormControl>

            <FormControl>
              <FormControl.Label>Ignore runs older than (hours)</FormControl.Label>
              <TextInput
                type="number"
                min={1}
                max={720}
                value={settings.maxRunAgeHours}
                onChange={(e) => onChange({ maxRunAgeHours: Number(e.target.value) || 1 })}
                block
                className={styles.maxWidth}
              />
              <FormControl.Caption>
                GitHub itself refuses re-runs after 30 days (720 h).
              </FormControl.Caption>
            </FormControl>
          </div>

          {/*
            The control is wide so its caption reads across the page; the field itself is
            capped separately. A caption pinned to the width of a two-digit number box
            wraps into a column of five lines and stops being read.
          */}
          <FormControl className={styles.mt3_2}>
            <FormControl.Label>Allow the same failure this many times</FormControl.Label>
            <TextInput
              type="number"
              min={0}
              max={20}
              value={settings.maxIdenticalFailures}
              onChange={(e) => onChange({ maxIdenticalFailures: Number(e.target.value) || 0 })}
              block
              className={styles.maxWidth}
            />
            <FormControl.Caption>
              Compares the failing tests and steps between attempts. Once the <em>same</em> failure
              has come back this many times in a row, the break is real and retrying only wastes
              CI. A different failure in between starts the count over. <strong>0</strong> switches
              this off and retries up to the attempt limit.
            </FormControl.Caption>
          </FormControl>
        </>
      )}
    </div>
  );
}

/**
 * The manual arm-auto-merge action. No on/off switch — the button appears whenever the
 * token can write, and a click is its own authority. Only the strategy is a choice, and it
 * has to be one the repository allows, or GitHub refuses the request outright.
 */
function AutoMergeSection({
  settings,
  onChange,
}: {
  settings: AutoMergeConfig;
  onChange: (patch: Partial<AutoMergeConfig>) => void;
}) {
  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb1}>
        Auto-merge
      </Heading>
      <Text as="p" className={styles.fgMutedBody}>
        Each open pull request gets a <strong>merge</strong> button that clears its description
        and lets GitHub merge it when the checks pass. It confirms first, and shows you the
        description it is about to delete — that text cannot be recovered afterwards.
      </Text>
      <FormControl className={styles.maxWidth2}>
        <FormControl.Label>Merge strategy</FormControl.Label>
        <Select
          className={styles.maxWidth3}
          value={settings.mergeMethod}
          onChange={(e) =>
            onChange({ mergeMethod: e.target.value as AutoMergeConfig['mergeMethod'] })
          }
        >
          <Select.Option value="squash">Squash and merge</Select.Option>
          <Select.Option value="merge">Create a merge commit</Select.Option>
          <Select.Option value="rebase">Rebase and merge</Select.Option>
        </Select>
        <FormControl.Caption>
          Must be a strategy the repository allows, or GitHub refuses to enable it.
        </FormControl.Caption>
      </FormControl>
    </div>
  );
}

/**
 * The Feature branches tab.
 *
 * Lives under PR automation rather than in a tab of its own: everything it switches on is
 * a pull request that opens and merges itself, which is what this page section is for.
 */
function FeatureBranchesSection({
  settings,
  onChange,
}: {
  settings: FeatureBranchesConfig;
  onChange: (patch: Partial<FeatureBranchesConfig>) => void;
}) {
  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb1}>
        Feature branches
      </Heading>
      <Text as="p" className={styles.fgMutedBody}>
        For long-lived branches shared between your fork and the upstream. Adds a tab that
        shows where each branch's merges have got to, and three actions: bring the default
        branch into a feature branch, take a feature branch into the default branch, and pull
        the upstream's copy of a branch down into your fork. Off by default — most
        repositories have no such branches.
      </Text>

      <FormControl className={styles.mb3}>
        <Checkbox
          checked={settings.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <FormControl.Label>Show a Feature branches tab</FormControl.Label>
        <FormControl.Caption>
          Nothing is polled or written while this is off.
        </FormControl.Caption>
      </FormControl>

      {settings.enabled && (
        // The control is wide so the caption can be read; the input is capped separately,
        // because a branch prefix is short and a text box the width of the page invites
        // nobody to type one.
        <FormControl className={styles.maxWidth4}>
          <FormControl.Label>Branch prefix</FormControl.Label>
          <TextInput
            value={settings.prefix}
            onChange={(e) => onChange({ prefix: e.target.value })}
            block
            className={styles.maxWidth3}
          />
          <FormControl.Caption>
            A branch counts when it starts with this <em>and</em> exists in both repositories.
            Keep the trailing slash: <code>feature</code> would also match{' '}
            <code>features-old</code>.
          </FormControl.Caption>
        </FormControl>
      )}
    </div>
  );
}

/** How many recently-merged PRs to keep an eye on. */
function MergedPrsSection({
  settings,
  onChange,
}: {
  settings: MergedPrsConfig;
  onChange: (patch: Partial<MergedPrsConfig>) => void;
}) {
  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb1}>
        Merged pull requests
      </Heading>
      <Text as="p" className={styles.fgMutedBody}>
        Keep recently-merged PRs in view so a failure that landed anyway is still
        reviewable. Their checks are already finished, so each is fetched once and then
        left alone.
      </Text>
      <FormControl className={styles.maxWidth5}>
        <FormControl.Label>How many to track</FormControl.Label>
        <TextInput
          type="number"
          min={0}
          max={50}
          value={settings.count}
          onChange={(e) => onChange({ count: Number(e.target.value) || 0 })}
          block
          className={styles.maxWidth}
        />
        <FormControl.Caption>0 switches merged PRs off entirely.</FormControl.Caption>
      </FormControl>
    </div>
  );
}

/** Per-task model, effort and optional prompt override. */
function AiTaskFields({
  title,
  blurb,
  settings,
  onChange,
}: {
  title: string;
  blurb: string;
  settings: AiTaskConfig;
  onChange: (patch: Partial<AiTaskConfig>) => void;
}) {
  return (
    <div
      className={styles.roundedP3}
    >
      <Heading as="h3" className={styles.bodyMb1}>
        {title}
      </Heading>
      <Text as="p" className={styles.fgMutedSmall2}>
        {blurb}
      </Text>
      <div className={styles.flexGap3_3}>
        <FormControl className={styles.minWidth}>
          <FormControl.Label>Model</FormControl.Label>
          <Select
            value={settings.model}
            onChange={(e) => onChange({ model: e.target.value as AiTaskConfig['model'] })}
          >
            {AI_MODELS.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
        <FormControl className={styles.minWidth}>
          <FormControl.Label>Reasoning effort</FormControl.Label>
          <Select
            value={settings.effort}
            onChange={(e) => onChange({ effort: e.target.value as AiTaskConfig['effort'] })}
          >
            {AI_EFFORTS.map((v) => (
              <Select.Option key={v} value={v}>
                {v}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
      </div>
      {/*
        Capped below the card's width: this is prose, and a line running the full width of a
        wide window is harder to read than one that doesn't. The page is wide so the
        multi-column rows have room, not so the paragraphs do.
      */}
      <FormControl className={styles.maxWidth6}>
        <FormControl.Label>Custom prompt</FormControl.Label>
        <Textarea
          rows={4}
          resize="vertical"
          block
          placeholder="Leave blank to use the built-in prompt."
          value={settings.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
        <FormControl.Caption>
          Replaces the built-in wording. The verified facts, the failing tests and the log are
          still appended, and the required output sections are still asked for — so an override
          can’t produce a reply the app fails to read.
        </FormControl.Caption>
      </FormControl>
    </div>
  );
}

/**
 * "Is the AI integration actually going to work?", answered on demand.
 *
 * The app already probes for the CLIs once per mount and quietly hides the feature when
 * they are missing — which is the right default, but it leaves someone who *expected* the
 * buttons with nothing to look at. This says which tool is missing and what to do about it.
 *
 * It reports presence, not health: `claude --version` succeeding does not prove it can reach
 * the API. If the tools are found and analyses still fail, the answer is in the diagnostics
 * log below, and the panel says so rather than implying a clean bill of health.
 */
function CheckAiIntegration() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ClaudeToolStatus | null>(null);

  if (!claudeBridgeAvailable()) {
    return (
      <Flash className={styles.mb3Body}>
        The AI features need the desktop app — a browser has no way to run your local CLIs.
      </Flash>
    );
  }

  const check = async () => {
    setChecking(true);
    try {
      setResult(await probeClaudeTools());
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={styles.mb4}>
      <Button
        leadingVisual={checking ? undefined : ChecklistIcon}
        disabled={checking}
        onClick={() => void check()}
      >
        {checking ? (
          <>
            <Spinner size="small" className={styles.mr1} />
            Checking…
          </>
        ) : (
          'Check AI integration'
        )}
      </Button>

      {result && (
        <div
          className={styles.mt3Rounded}
        >
          <CheckRow
            state={result.claude ? 'ok' : 'bad'}
            label="claude"
            detail={
              result.claudeVersion ??
              'Not found on PATH. Install the Claude Code CLI, then reopen the app.'
            }
            note="Required — every AI feature runs through it."
          />
          <CheckRow
            state={result.gh ? 'ok' : 'warn'}
            label="gh"
            detail={
              result.ghVersion?.split('\n')[0] ??
              'Not found on PATH. Install the GitHub CLI to enable the wider log.'
            }
            note="Optional — without it, analyses use the log Job Monitor fetched itself."
          />
          <CheckRow
            state={!result.gh ? 'skip' : result.ghAuthenticated ? 'ok' : 'warn'}
            label="gh auth"
            detail={
              !result.gh
                ? 'Skipped — gh is not installed.'
                : result.ghAuthenticated
                  ? 'Signed in.'
                  : 'Not signed in. Run `gh auth login` in a terminal.'
            }
            note="Needed for the whole-run log and for “Who broke it”."
          />

          <div className={styles.px3Py2}>
            {result.claude
              ? 'This checks that the tools are installed, not that they work — if an analysis still fails, the diagnostics log below says why.'
              : 'Without claude, the AI controls stay hidden however this page is configured.'}
          </div>
        </div>
      )}
    </div>
  );
}

/** One line of the check: state, what was checked, what was found, why it matters. */
function CheckRow({
  state,
  label,
  detail,
  note,
}: {
  state: 'ok' | 'warn' | 'bad' | 'skip';
  label: string;
  detail: string;
  note: string;
}) {
  const icon =
    state === 'ok' ? CheckCircleFillIcon : state === 'bad' ? XCircleFillIcon : AlertFillIcon;
  const colour =
    state === 'ok'
      ? 'success.fg'
      : state === 'bad'
        ? 'danger.fg'
        : state === 'warn'
          ? 'attention.fg'
          : 'fg.subtle';

  return (
    <div
      className={styles.flexGap2_3}
    >
      <Icon icon={icon} size={16} className={styles.checkIcon} style={{ color: colour }} />
      <div className={styles.minWidth2}>
        <Text className={styles.monoBody}>{label}</Text>
        <Text as="div" className={styles.smallFgDefault}>
          {detail}
        </Text>
        <Text as="div" className={styles.smallFgMuted}>
          {note}
        </Text>
      </div>
    </div>
  );
}

/**
 * Where the diagnostics file lives, and how to get at it.
 *
 * Shown rather than merely written, because a log nobody can find is no better than no log
 * — and the usual reason to want it is to hand it to someone else after something went
 * wrong. The heading and the description do not wait on the path lookup: this owns a tab
 * now, and a tab that renders nothing at all reads as a broken one.
 */
function DiagnosticsSection({
  settings,
  onChange,
}: {
  settings: DiagnosticsConfig;
  onChange: (patch: Partial<DiagnosticsConfig>) => void;
}) {
  const [paths, setPaths] = useState<{ file: string; dir: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void diagnosticsLogPath().then((p) => live && setPaths(p));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb1}>
        Diagnostics
      </Heading>
      <Text as="p" className={styles.fgMutedBody}>
        The desktop app keeps a record of what it did — every analysis, the commands it ran, how each
        one ended, every auto-rerun decision including the ones that chose not to fire, and any
        request that failed. One JSON object per line, capped at 5 MB with one previous file kept. It
        holds sizes and outcomes, never your token and never the contents of a log.
      </Text>

      <FormControl className={styles.mb3}>
        <Checkbox
          checked={settings.showLogTab}
          onChange={(e) => onChange({ showLogTab: e.target.checked })}
        />
        <FormControl.Label>Read the log in a Diagnostics tab</FormControl.Label>
        <FormControl.Caption>
          Adds a <strong>Diagnostics</strong> tab to the main navigation that follows the log live,
          filtered by scope and searchable — instead of opening the file yourself. The log is written
          either way; this only decides whether there is a tab for reading it.
        </FormControl.Caption>
      </FormControl>

      {settings.showLogTab && (
        <div
          className={styles.gridSpaced}
        >
          <FormControl>
            <FormControl.Label>Tail to read (KB)</FormControl.Label>
            <TextInput
              type="number"
              min={16}
              max={5120}
              value={settings.tailKB}
              onChange={(e) => onChange({ tailKB: Number(e.target.value) })}
              block
              className={styles.maxWidth}
            />
            <FormControl.Caption>
              How much of the end of the file to load. The newest records are the point; raise it to
              reach further back.
            </FormControl.Caption>
          </FormControl>
          <FormControl>
            <FormControl.Label>Live refresh (seconds)</FormControl.Label>
            <TextInput
              type="number"
              min={1}
              max={60}
              value={settings.followSeconds}
              onChange={(e) => onChange({ followSeconds: Number(e.target.value) })}
              block
              className={styles.maxWidth}
            />
            <FormControl.Caption>
              How often the tab re-reads the file while <strong>Live</strong> is on. A local read, so
              this costs no GitHub quota.
            </FormControl.Caption>
          </FormControl>
        </div>
      )}
      {paths ? (
        <>
          <pre
            className={styles.m0Mb2}
          >
            {paths.file}
          </pre>
          <div className={styles.flexGap2_4}>
            <Button
              leadingVisual={CopyIcon}
              onClick={() => {
                void navigator.clipboard?.writeText(paths.file);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied' : 'Copy path'}
            </Button>
            <Button onClick={() => void revealDiagnosticsLog()}>Open folder</Button>
          </div>
        </>
      ) : (
        <Text as="p" className={styles.fgMutedBody2}>
          Locating the log file…
        </Text>
      )}
      {/* The file is written either way; this is only for watching it happen live. */}
      <Text as="p" className={styles.fgMutedSmall3}>
        To follow the same lines as they happen, open DevTools and filter the console by a scope —
        <Text as="span" className={styles.mono}> [auto-rerun]</Text>,
        <Text as="span" className={styles.mono}> [api]</Text>,
        <Text as="span" className={styles.mono}> [claude]</Text>. Console output is off by
        default in an installed build; turn it on with
        <Text as="span" className={styles.mono}> jobMonitorDebug.enable()</Text>.
      </Text>
    </div>
  );
}

/**
 * Local AI integration. One switch for the whole thing, because this is the only feature
 * that sends anything outside GitHub.
 */
function AiSection({
  settings,
  onChange,
}: {
  settings: AiConfig;
  onChange: (patch: Partial<AiConfig>) => void;
}) {
  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb1}>
        AI integration
      </Heading>
      <Text as="p" className={styles.fgMutedBody}>
        Runs the <code>claude</code> CLI already installed on this machine to explain a failure
        and to rewrite its log. Desktop app only. This is the one thing Job Monitor sends
        anywhere other than <code>api.github.com</code>, and it only ever runs when you click —
        never in the background. Your GitHub token is never passed to it.
      </Text>

      <CheckAiIntegration />

      <FormControl className={styles.mb3}>
        <Checkbox
          checked={settings.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <FormControl.Label>Enable AI integration</FormControl.Label>
        <FormControl.Caption>
          Off hides every AI control — the analysis buttons and the Claude log view — whether or
          not <code>claude</code> is installed.
        </FormControl.Caption>
      </FormControl>

      {settings.enabled && (
        <>
          <FormControl className={styles.mb4_2}>
            <FormControl.Label>Additional instructions</FormControl.Label>
            <Textarea
              rows={3}
              resize="vertical"
              block
              placeholder="e.g. Our Windows integration tests are known to be flaky — say so rather than blaming the diff."
              value={settings.extraInstructions}
              onChange={(e) => onChange({ extraInstructions: e.target.value })}
            />
            <FormControl.Caption>
              Added to every request, for standing context the model can’t work out for itself.
              Additive, so unlike a custom prompt it can’t break anything.
            </FormControl.Caption>
          </FormControl>

          <AiTaskFields
            title="Quick read"
            blurb="A one-minute answer to “what failed”, from the log already fetched. One turn, no tools — so it wants a fast model, not a thorough one."
            settings={settings.quick}
            onChange={(patch) => onChange({ quick: { ...settings.quick, ...patch } })}
          />
          <AiTaskFields
            title="Deep analysis"
            blurb="Answers “why”. Downloads the run’s artifacts, reads the workflow file and the PR diff, then reasons across them — the one task that earns a stronger model."
            settings={settings.deep}
            onChange={(patch) => onChange({ deep: { ...settings.deep, ...patch } })}
          />
          <AiTaskFields
            title="Readable log"
            blurb="Rewrites the log: decisive lines first, noise cut, a short note where a line needs one. Mechanical work on a large input, so speed matters more than depth."
            settings={settings.log}
            onChange={(patch) => onChange({ log: { ...settings.log, ...patch } })}
          />
          <AiTaskFields
            title="Pull request write-up"
            blurb="Writes the title and description for a pull request shipping a feature branch, from its commit subjects and changed files. One turn on material it is handed, and you get to edit the result before anything is published."
            settings={settings.pr}
            onChange={(patch) => onChange({ pr: { ...settings.pr, ...patch } })}
          />
          <AiTaskFields
            title="Who broke it"
            blurb="Reads the branch’s run history and the diffs between runs to name the commit and its author. Judgement across many small facts, so it earns a strong model — but breadth rather than depth, so medium effort."
            settings={settings.blame}
            onChange={(patch) => onChange({ blame: { ...settings.blame, ...patch } })}
          />
        </>
      )}
    </div>
  );
}

/** How the Failures tab builds its Markdown bug reports. */
function FailureReportsSection({
  settings,
  onChange,
}: {
  settings: FailureReportsConfig;
  onChange: (patch: Partial<FailureReportsConfig>) => void;
}) {
  return (
    <div className={styles.roundedP4}>
      <Heading as="h2" className={styles.titleMb1}>
        Failure reports
      </Heading>
      <Text as="p" className={styles.fgMutedBody}>
        The <strong>Failures</strong> tab writes a Markdown report per failing job, ready to
        paste into Teams or a GitHub issue.
      </Text>

      <FormControl className={styles.mb3}>
        <Checkbox
          checked={settings.prefetchAnnotations}
          onChange={(e) => onChange({ prefetchAnnotations: e.target.checked })}
        />
        <FormControl.Label>Load test names as failures appear</FormControl.Label>
        <FormControl.Caption>
          One extra request per failing job, so the list names the broken tests without you
          opening anything. Switch off to fetch them only when you open a report.
        </FormControl.Caption>
      </FormControl>

      <div
        className={styles.grid2}
      >
        <FormControl>
          <FormControl.Label>Log lines to include</FormControl.Label>
          <TextInput
            type="number"
            min={0}
            max={500}
            value={settings.logTailLines}
            onChange={(e) => onChange({ logTailLines: Number(e.target.value) || 0 })}
            block
            className={styles.maxWidth}
          />
          <FormControl.Caption>
            Tail of the failing step’s log. 0 leaves the log out.
          </FormControl.Caption>
        </FormControl>

        <FormControl>
          <FormControl.Label>Default format</FormControl.Label>
          <Select
            className={styles.maxWidth3}
            value={settings.format}
            onChange={(e) => onChange({ format: e.target.value as FailureReportsConfig['format'] })}
            block
          >
            <Select.Option value="github">GitHub issue</Select.Option>
            <Select.Option value="teams">Teams message</Select.Option>
          </Select>
          <FormControl.Caption>
            Teams can’t render collapsible blocks, so its log is laid out flat.
          </FormControl.Caption>
        </FormControl>
      </div>
    </div>
  );
}

/**
 * What changed about the flows, recorded once per save.
 *
 * Deliberately not on `updateFlow`: that fires on every keystroke in every field, so counting
 * there would report a number closer to "characters typed" than to "flows edited" and would
 * swamp every other feature in the batch.
 *
 * Creation and deletion are already recorded at their own buttons, so an edit here means a flow
 * that existed before and is not the same afterwards. The two configuration options are recorded
 * by their *state* rather than by the toggle that set them — what is worth knowing is how many
 * installations run a pattern flow at all, not how often somebody flipped the switch.
 */
function recordFlowEdits(before: readonly Flow[], after: readonly Flow[]): void {
  const previous = new Map(before.map((f) => [f.id, f]));
  for (const flow of after) {
    const was = previous.get(flow.id);
    if (was && JSON.stringify(was) !== JSON.stringify(flow)) Telemetry.featureUsed(Feature.FLOW_EDITED);
    if (flow.match.pattern.trim()) Telemetry.featureUsed(Feature.FLOW_MATCH_REGEX_USED);
    if (flow.emptyFilter.enabled) Telemetry.featureUsed(Feature.FLOW_EMPTY_FILTER_USED);
  }
}

export function SettingsPage() {
  const { config, setConfig } = useConfig();
  const [draft, setDraft] = useState<MonitorConfig>(() => clone(config));
  const [errors, setErrors] = useState<string[]>([]);
  const [savedMsg, setSavedMsg] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);
  const [tab, setTab] = useState<
    | 'repo'
    | 'polling'
    | 'flows'
    | 'token'
    | 'prauto'
    | 'ai'
    | 'notifications'
    | 'diagnostics'
    | 'updates'
  >('token');

  const exportJson = useMemo(() => JSON.stringify(config, null, 2), [config]);
  // Recorded when the JSON is actually copied, not when it is rendered — rendering happens on
  // every settings open and would drown the real signal.

  const update = (patch: Partial<MonitorConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const updateNested = <K extends keyof MonitorConfig>(key: K, patch: Partial<MonitorConfig[K]>) =>
    setDraft((d) => ({ ...d, [key]: { ...(d[key] as object), ...patch } }));

  const onSave = () => {
    setSavedMsg(false);
    const result = monitorConfigSchema.safeParse(draft);
    if (!result.success) {
      setErrors(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
      return;
    }
    setErrors([]);
    recordFlowEdits(config.flows, result.data.flows);
    setConfig(result.data);
    setDraft(clone(result.data));
    setSavedMsg(true);
  };

  const onImport = () => {
    setJsonErrors([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setJsonErrors([`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`]);
      return;
    }
    const result = safeParseConfig(parsed);
    if (!result.ok) {
      setJsonErrors(result.errors);
      return;
    }
    Telemetry.featureUsed(Feature.CONFIG_IMPORTED);
    setConfig(result.config);
    setDraft(clone(result.config));
    setJsonText('');
    setSavedMsg(true);
  };

  const addFlow = () => {
    Telemetry.featureUsed(Feature.FLOW_CREATED);
    const flow: Flow = {
      id: newFlowId(),
      name: 'New flow',
      workflowFile: '',
      branches: ['main'],
      events: [],
      maxRuns: 5,
      emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: { pattern: '', by: 'name', caseSensitive: false, maxMatches: 12 },
    };
    update({ flows: [...draft.flows, flow] });
  };

  const updateFlow = (index: number, next: Flow) =>
    update({ flows: draft.flows.map((f, i) => (i === index ? next : f)) });
  const removeFlow = (index: number) => {
    Telemetry.featureUsed(Feature.FLOW_DELETED);
    update({ flows: draft.flows.filter((_, i) => i !== index) });
  };

  const draftFooter = (
    <>
      {errors.length > 0 && (
        <Flash variant="danger" className={styles.mb3}>
          <ul className={styles.m0Pl3}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Flash>
      )}
      {savedMsg && <Flash variant="success" className={styles.mb3}>Settings saved.</Flash>}
      <div className={styles.flexGap2_5}>
        <Button variant="primary" onClick={onSave}>Save changes</Button>
        <Button onClick={() => setDraft(clone(config))}>Reset</Button>
      </div>
    </>
  );

  const TABS: Array<[typeof tab, string, typeof ShieldLockIcon]> = [
    ['token', 'Token & login', ShieldLockIcon],
    ['repo', 'Repository', GearIcon],
    ['polling', 'Polling', ClockIcon],
    ['flows', 'Flows', WorkflowIcon],
    ['prauto', 'PR automation', SyncIcon],
    ['ai', 'AI integration', SparkleFillIcon],
    ['notifications', 'Notifications', BellIcon],
  ];
  // Both of these are desktop-only: there is no on-disk log in a browser tab, and no
  // installer to update. An empty tab is worse than an absent one.
  if (isDesktop()) {
    TABS.push(['diagnostics', 'Diagnostics', BugIcon]);
    TABS.push(['updates', 'Updates', DownloadIcon]);
  }

  return (
    <div className={styles.maxWidth7}>
      <div className={styles.mb4}>
        <UnderlineNav aria-label="Settings sections">
          {TABS.map(([key, label, icon]) => (
            <UnderlineNav.Item
              key={key}
              icon={icon}
              aria-current={tab === key ? 'page' : undefined}
              onSelect={(e) => {
                e.preventDefault();
                setTab(key);
              }}
            >
              {label}
            </UnderlineNav.Item>
          ))}
        </UnderlineNav>
      </div>

      {tab === 'token' && <TokenSection />}

      {tab === 'repo' && (
        <>
      <div className={styles.roundedP4}>
        <Heading as="h2" className={styles.titleMb3}>Repository</Heading>
        <div className={styles.flexGap3}>
          <FormControl className={styles.grow3} required>
            <FormControl.Label>Upstream owner</FormControl.Label>
            <TextInput
              value={draft.upstream.owner}
              onChange={(e) => updateNested('upstream', { owner: e.target.value })}
              block
            />
          </FormControl>
          <FormControl className={styles.grow3} required>
            <FormControl.Label>Upstream repo</FormControl.Label>
            <TextInput
              value={draft.upstream.repo}
              onChange={(e) => updateNested('upstream', { repo: e.target.value })}
              placeholder="repo, owner/repo, or a GitHub URL"
              block
            />
            <FormControl.Caption>
              You can paste a full GitHub URL (e.g. https://github.com/owner/repo) — it will be
              parsed on save.
            </FormControl.Caption>
          </FormControl>
        </div>
        <div className={styles.flexGap3_4}>
          <FormControl className={styles.grow3} required>
            <FormControl.Label>Fork owner</FormControl.Label>
            <TextInput
              value={draft.fork.owner}
              onChange={(e) => updateNested('fork', { owner: e.target.value })}
              block
            />
          </FormControl>
          <FormControl className={styles.grow3}>
            <FormControl.Label>Fork repo (optional)</FormControl.Label>
            <TextInput
              value={draft.fork.repo}
              onChange={(e) => updateNested('fork', { repo: e.target.value })}
              placeholder="same as upstream"
              block
            />
            <FormControl.Caption>
              Only needed if you renamed your fork. The feature-branch actions write to it, so
              they need its real name.
            </FormControl.Caption>
          </FormControl>
          <FormControl className={styles.grow3}>
            <FormControl.Label>Branch filter (optional)</FormControl.Label>
            <TextInput
              value={draft.fork.branch ?? ''}
              onChange={(e) => updateNested('fork', { branch: e.target.value || null })}
              placeholder="all branches"
              block
            />
          </FormControl>
          <FormControl className={styles.grow3}>
            <FormControl.Label>PR author (optional)</FormControl.Label>
            <TextInput
              value={draft.prAuthor}
              onChange={(e) => update({ prAuthor: e.target.value })}
              placeholder="defaults to fork owner"
              block
            />
          </FormControl>
        </div>

      </div>

      {draftFooter}
        </>
      )}

      {tab === 'polling' && (
        <>
      <div className={styles.roundedP4}>
        <Heading as="h2" className={styles.titleMb1}>Polling</Heading>
        <Text as="p" className={styles.fgMutedBody}>
          How often each kind of data is refreshed, in seconds.
        </Text>
        <div className={styles.flexGap3}>
          {(
            [
              ['prListSeconds', 'PR list'],
              ['checksSeconds', 'Checks / jobs'],
              ['flowRunsSeconds', 'Flow runs'],
              ['hiddenSeconds', 'Hidden tab'],
            ] as const
          ).map(([key, label]) => (
            <FormControl key={key} className={styles.width2}>
              <FormControl.Label>{label}</FormControl.Label>
              <TextInput
                type="number"
                value={String(draft.polling[key])}
                onChange={(e) =>
                  updateNested('polling', { [key]: Number(e.target.value) || 0 } as never)
                }
                block
              />
            </FormControl>
          ))}
          <FormControl className={styles.width3}>
            <FormControl.Label>Rate-limit warn at</FormControl.Label>
            <TextInput
              type="number"
              value={String(draft.rateLimitWarnAt)}
              onChange={(e) => update({ rateLimitWarnAt: Number(e.target.value) || 0 })}
              block
            />
          </FormControl>
        </div>
      </div>

      {draftFooter}
        </>
      )}

      {tab === 'flows' && (
        <>
      <div className={styles.roundedP4}>
        <div className={styles.flexCenter4}>
          <Heading as="h2" className={styles.title}>Flows</Heading>
          <Button leadingVisual={PlusIcon} onClick={addFlow}>Add flow</Button>
        </div>
        {draft.flows.length === 0 ? (
          <Text className={styles.fgMuted}>
            No flows yet. Add one to monitor workflow runs by branch / event — a single workflow,
            or every workflow matching a regex.
          </Text>
        ) : (
          draft.flows.map((flow, i) => (
            <FlowEditor
              key={flow.id}
              flow={flow}
              upstream={draft.upstream}
              onChange={(next) => updateFlow(i, next)}
              onRemove={() => removeFlow(i)}
            />
          ))
        )}
      </div>

      {draftFooter}

      <div className={styles.roundedP4}>
        <Heading as="h2" className={styles.titleMb2}>Import / export JSON</Heading>
        <Text as="p" className={styles.fgMutedBody3}>
          Current configuration:
        </Text>
        <Textarea
          value={exportJson}
          readOnly
          rows={8}
          className={styles.monoSmall}
          onCopy={() => Telemetry.featureUsed(Feature.CONFIG_EXPORTED)}
        />
        <Heading as="h3" className={styles.bodyMt3}>
          Paste JSON to import
        </Heading>
        {jsonErrors.length > 0 && (
          <Flash variant="danger" className={styles.mb2}>
            <ul className={styles.m0Pl3}>
              {jsonErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Flash>
        )}
        <Textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          rows={8}
          placeholder='{ "upstream": { "owner": "...", "repo": "..." }, ... }'
          className={styles.monoSmall}
        />
        <Button className={styles.mt2} onClick={onImport} disabled={!jsonText.trim()}>
          Import &amp; apply
        </Button>
      </div>
        </>
      )}

      {tab === 'prauto' && (
        <>
          <AutoRerunSection
            upstream={draft.upstream}
            settings={draft.prAutoRerun}
            onChange={(patch) => updateNested('prAutoRerun', patch)}
          />
          <AutoMergeSection
            settings={draft.autoMerge}
            onChange={(patch) => updateNested('autoMerge', patch)}
          />
          <FeatureBranchesSection
            settings={draft.featureBranches}
            onChange={(patch) => updateNested('featureBranches', patch)}
          />
          <MergedPrsSection
            settings={draft.mergedPrs}
            onChange={(patch) => updateNested('mergedPrs', patch)}
          />
          <FailureReportsSection
            settings={draft.failureReports}
            onChange={(patch) => updateNested('failureReports', patch)}
          />
          {draftFooter}
        </>
      )}

      {tab === 'ai' && (
        <>
          <AiSection settings={draft.ai} onChange={(patch) => updateNested('ai', patch)} />
          {draftFooter}
        </>
      )}

      {tab === 'diagnostics' && (
        <>
          <DiagnosticsSection
            settings={draft.diagnostics}
            onChange={(patch) => updateNested('diagnostics', patch)}
          />
          {draftFooter}
        </>
      )}

      {tab === 'notifications' && (
        <>
          <NotificationsSection
            prefs={draft.notifications}
            onChange={(patch) => updateNested('notifications', patch)}
          />
          {draftFooter}
        </>
      )}

      {tab === 'updates' && (
        <>
          <UpdatesSection enabled={draft.autoUpdate} onChange={(v) => update({ autoUpdate: v })} />
          {draftFooter}
        </>
      )}
    </div>
  );
}

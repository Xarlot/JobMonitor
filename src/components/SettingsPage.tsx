import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Flash,
  FormControl,
  Heading,
  IconButton,
  Label,
  Link,
  Octicon,
  Select,
  Text,
  TextInput,
  Textarea,
} from '@primer/react';
import { PlusIcon, ShieldLockIcon, TrashIcon } from '@primer/octicons-react';
import { useConfig } from '../context/ConfigContext';
import { useAuth } from '../context/AuthContext';
import {
  monitorConfigSchema,
  newFlowId,
  safeParseConfig,
  type EmptyFlowFilter,
  type Flow,
  type MonitorConfig,
  type NotificationPrefs,
} from '../storage/configStore';
import {
  ensureNotificationPermission,
  notificationPermission,
  notificationsSupported,
} from '../lib/notifications';
import { isMockMode } from '../mocks/mockMode';

const sectionSx = {
  border: '1px solid',
  borderColor: 'border.default',
  borderRadius: 2,
  p: 4,
  mb: 4,
} as const;

function clone(config: MonitorConfig): MonitorConfig {
  return JSON.parse(JSON.stringify(config)) as MonitorConfig;
}

/** Token credentials: encrypt + store a PAT, or forget an active one. */
function TokenSection() {
  const { status, saveToken, forget, error } = useAuth();
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== passphrase;

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSaved(false);
    if (token.trim().length < 10) {
      setLocalError('That does not look like a valid token.');
      return;
    }
    if (
      passphrase.length < 8 ||
      !/[A-Z]/.test(passphrase) ||
      !/[^A-Za-z0-9]/.test(passphrase)
    ) {
      setLocalError(
        'Use a passphrase of at least 8 characters, including an uppercase letter and a special character.',
      );
      return;
    }
    if (passphrase !== confirm) {
      setLocalError('Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      await saveToken(token.trim(), passphrase);
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
    <Box sx={sectionSx}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Octicon icon={ShieldLockIcon} size={20} sx={{ color: 'accent.fg' }} />
        <Heading as="h2" sx={{ fontSize: 3 }}>GitHub token</Heading>
        {status === 'unlocked' && <Label variant="success">loaded in memory</Label>}
      </Box>
      <Text as="p" sx={{ color: 'fg.muted', fontSize: 1, mb: 3 }}>
        Use a{' '}
        <Link
          href="https://github.com/settings/tokens/new?scopes=repo&description=Job%20Monitor"
          target="_blank"
          rel="noreferrer"
        >
          classic token
        </Link>{' '}
        with the <strong>repo</strong> scope (for a public-only repo, <strong>public_repo</strong>
        {' '}is enough). A read-only fine-grained PAT also works
        for most data but <strong>can’t download Actions logs</strong> (GitHub returns 404), so a
        classic <code>repo</code> token is recommended.
      </Text>

      {isMockMode() ? (
        <Flash variant="warning">Mock mode is active — no real token is used.</Flash>
      ) : (
        <>
          {(localError || error) && (
            <Flash variant="danger" sx={{ mb: 3 }}>{localError ?? error}</Flash>
          )}
          {saved && <Flash variant="success" sx={{ mb: 3 }}>Token encrypted and stored.</Flash>}

          <Box as="form" onSubmit={onSave}>
            <FormControl sx={{ mb: 3 }}>
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
            <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              <FormControl sx={{ mb: 3, flex: 1, minWidth: 200 }}>
                <FormControl.Label>Passphrase</FormControl.Label>
                <TextInput
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  block
                  autoComplete="new-password"
                />
              </FormControl>
              <FormControl sx={{ mb: 3, flex: 1, minWidth: 200 }}>
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
            </Box>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
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
            </Box>
          </Box>
        </>
      )}
    </Box>
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
    <Box>
      <Text as="label" sx={{ display: 'block', fontSize: 1, fontWeight: 'bold', mb: 1 }}>
        Events (optional)
      </Text>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 3, rowGap: 1 }}>
        {options.map((ev) => (
          <FormControl key={ev}>
            <Checkbox
              checked={events.includes(ev)}
              onChange={(e) => toggle(ev, e.target.checked)}
            />
            <FormControl.Label sx={{ fontWeight: 'normal' }}>
              {ev}
              {EVENT_HINTS[ev] && (
                <Text as="span" sx={{ color: 'fg.muted', ml: 1 }}>
                  ({EVENT_HINTS[ev]})
                </Text>
              )}
            </FormControl.Label>
          </FormControl>
        ))}
      </Box>
      <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', mt: 1 }}>
        None selected = any event
      </Text>
    </Box>
  );
}

function FlowEditor({
  flow,
  onChange,
  onRemove,
}: {
  flow: Flow;
  onChange: (next: Flow) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof Flow>(key: K, value: Flow[K]) => onChange({ ...flow, [key]: value });
  const csv = (arr: string[]) => arr.join(', ');
  const parseCsv = (s: string) =>
    s
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, p: 3, mb: 3 }}>
      {/* Header: name, max runs, remove */}
      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-end', mb: 3 }}>
        <FormControl sx={{ flex: 1 }}>
          <FormControl.Label>Name</FormControl.Label>
          <TextInput value={flow.name} onChange={(e) => set('name', e.target.value)} block />
        </FormControl>
        <FormControl sx={{ width: 130 }}>
          <FormControl.Label>Max runs / event</FormControl.Label>
          <TextInput
            type="number"
            value={String(flow.maxRuns)}
            onChange={(e) => set('maxRuns', Math.max(1, Number(e.target.value) || 1))}
            title="Kept per branch × event"
            block
          />
        </FormControl>
        <IconButton
          aria-label="Remove flow"
          icon={TrashIcon}
          variant="danger"
          onClick={onRemove}
          sx={{ mb: 1 }}
        />
      </Box>

      {/* Coordinates: workflow full-width, then owner/repo and branches/events paired */}
      <Box sx={{ display: 'grid', gridTemplateColumns: ['1fr', '1fr 1fr'], columnGap: 3, rowGap: 3 }}>
        <FormControl sx={{ gridColumn: ['auto', '1 / -1'] }}>
          <FormControl.Label>Workflow name, file, or id</FormControl.Label>
          <TextInput
            value={flow.workflowFile}
            onChange={(e) => set('workflowFile', e.target.value)}
            placeholder="ci.yml, CI, or 42"
            block
          />
          <FormControl.Caption>
            Display name, file name (with/without .yml), or numeric id — resolved automatically.
          </FormControl.Caption>
        </FormControl>
        <FormControl>
          <FormControl.Label>Owner (optional)</FormControl.Label>
          <TextInput
            value={flow.owner ?? ''}
            onChange={(e) => set('owner', e.target.value || undefined)}
            placeholder="defaults to upstream"
            block
          />
        </FormControl>
        <FormControl>
          <FormControl.Label>Repo (optional)</FormControl.Label>
          <TextInput
            value={flow.repo ?? ''}
            onChange={(e) => set('repo', e.target.value || undefined)}
            placeholder="defaults to upstream"
            block
          />
        </FormControl>
        <FormControl sx={{ gridColumn: ['auto', '1 / -1'] }}>
          <FormControl.Label>Branches</FormControl.Label>
          <TextInput
            value={csv(flow.branches)}
            onChange={(e) => set('branches', parseCsv(e.target.value))}
            placeholder="main, release/*"
            block
          />
          <FormControl.Caption>Comma-separated</FormControl.Caption>
        </FormControl>
        <Box sx={{ gridColumn: ['auto', '1 / -1'] }}>
          <EventsField events={flow.events} onChange={(next) => set('events', next)} />
        </Box>
      </Box>

      {/* Per-flow empty filter */}
      <Box sx={{ mt: 3, pt: 3, borderTop: '1px solid', borderColor: 'border.muted' }}>
        <FormControl sx={{ mb: flow.emptyFilter.enabled ? 3 : 0 }}>
          <Checkbox
            checked={flow.emptyFilter.enabled}
            onChange={(e) => set('emptyFilter', { ...flow.emptyFilter, enabled: e.target.checked })}
          />
          <FormControl.Label>Hide when empty</FormControl.Label>
        </FormControl>
        {flow.emptyFilter.enabled && (
          <Box sx={{ display: 'grid', gridTemplateColumns: ['1fr', 'repeat(3, 1fr)'], gap: 3 }}>
            <FormControl>
              <FormControl.Label>Empty when</FormControl.Label>
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
          </Box>
        )}
      </Box>
    </Box>
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
    onChange({ [key]: on });
    // Ask for OS permission the moment the user opts in.
    if (on && supported) setPerm(await ensureNotificationPermission());
  };

  const anyOn = prefs.pr || prefs.flow;

  return (
    <Box sx={sectionSx}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 2 }}>Notifications</Heading>
      <Text as="p" sx={{ color: 'fg.muted', fontSize: 1, mb: 3 }}>
        Show a desktop notification when a tracked item finishes. Uses your browser's notification
        permission; nothing leaves this browser.
      </Text>
      {!supported && (
        <Flash variant="warning" sx={{ mb: 3 }}>This browser doesn’t support notifications.</Flash>
      )}
      {supported && anyOn && perm === 'denied' && (
        <Flash variant="warning" sx={{ mb: 3 }}>
          Notifications are blocked for this site — enable them in your browser’s site settings.
        </Flash>
      )}
      <FormControl sx={{ mb: 2 }} disabled={!supported}>
        <Checkbox checked={prefs.pr} onChange={(e) => void toggle('pr', e.target.checked)} />
        <FormControl.Label>Notify when a PR’s checks finish</FormControl.Label>
      </FormControl>
      <FormControl disabled={!supported}>
        <Checkbox checked={prefs.flow} onChange={(e) => void toggle('flow', e.target.checked)} />
        <FormControl.Label>Notify when a flow run finishes</FormControl.Label>
      </FormControl>
    </Box>
  );
}

export function SettingsPage() {
  const { config, setConfig } = useConfig();
  const [draft, setDraft] = useState<MonitorConfig>(() => clone(config));
  const [errors, setErrors] = useState<string[]>([]);
  const [savedMsg, setSavedMsg] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);

  const exportJson = useMemo(() => JSON.stringify(config, null, 2), [config]);

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
    setConfig(result.config);
    setDraft(clone(result.config));
    setJsonText('');
    setSavedMsg(true);
  };

  const addFlow = () => {
    const flow: Flow = {
      id: newFlowId(),
      name: 'New flow',
      workflowFile: '',
      branches: ['main'],
      events: [],
      maxRuns: 5,
      emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
    };
    update({ flows: [...draft.flows, flow] });
  };

  const updateFlow = (index: number, next: Flow) =>
    update({ flows: draft.flows.map((f, i) => (i === index ? next : f)) });
  const removeFlow = (index: number) =>
    update({ flows: draft.flows.filter((_, i) => i !== index) });

  return (
    <Box sx={{ maxWidth: 860 }}>
      <TokenSection />

      <Box sx={sectionSx}>
        <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Repository &amp; polling</Heading>
        {errors.length > 0 && (
          <Flash variant="danger" sx={{ mb: 3 }}>
            <Box as="ul" sx={{ m: 0, pl: 3 }}>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </Box>
          </Flash>
        )}
        {savedMsg && <Flash variant="success" sx={{ mb: 3 }}>Settings saved.</Flash>}

        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          <FormControl sx={{ flex: 1, minWidth: 160 }} required>
            <FormControl.Label>Upstream owner</FormControl.Label>
            <TextInput
              value={draft.upstream.owner}
              onChange={(e) => updateNested('upstream', { owner: e.target.value })}
              block
            />
          </FormControl>
          <FormControl sx={{ flex: 1, minWidth: 160 }} required>
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
        </Box>
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mt: 2 }}>
          <FormControl sx={{ flex: 1, minWidth: 160 }} required>
            <FormControl.Label>Fork owner</FormControl.Label>
            <TextInput
              value={draft.fork.owner}
              onChange={(e) => updateNested('fork', { owner: e.target.value })}
              block
            />
          </FormControl>
          <FormControl sx={{ flex: 1, minWidth: 160 }}>
            <FormControl.Label>Branch filter (optional)</FormControl.Label>
            <TextInput
              value={draft.fork.branch ?? ''}
              onChange={(e) => updateNested('fork', { branch: e.target.value || null })}
              placeholder="all branches"
              block
            />
          </FormControl>
          <FormControl sx={{ flex: 1, minWidth: 160 }}>
            <FormControl.Label>PR author (optional)</FormControl.Label>
            <TextInput
              value={draft.prAuthor}
              onChange={(e) => update({ prAuthor: e.target.value })}
              placeholder="defaults to fork owner"
              block
            />
          </FormControl>
        </Box>

        <Heading as="h3" sx={{ fontSize: 1, mt: 4, mb: 2, color: 'fg.muted' }}>
          Polling intervals (seconds)
        </Heading>
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {(
            [
              ['prListSeconds', 'PR list'],
              ['checksSeconds', 'Checks / jobs'],
              ['flowRunsSeconds', 'Flow runs'],
              ['hiddenSeconds', 'Hidden tab'],
            ] as const
          ).map(([key, label]) => (
            <FormControl key={key} sx={{ width: 140 }}>
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
          <FormControl sx={{ width: 160 }}>
            <FormControl.Label>Rate-limit warn at</FormControl.Label>
            <TextInput
              type="number"
              value={String(draft.rateLimitWarnAt)}
              onChange={(e) => update({ rateLimitWarnAt: Number(e.target.value) || 0 })}
              block
            />
          </FormControl>
        </Box>
      </Box>

      <Box sx={sectionSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
          <Heading as="h2" sx={{ fontSize: 3 }}>Flows</Heading>
          <Button leadingVisual={PlusIcon} onClick={addFlow}>Add flow</Button>
        </Box>
        {draft.flows.length === 0 ? (
          <Text sx={{ color: 'fg.muted' }}>
            No flows yet. Add one to monitor workflow runs by branch / event.
          </Text>
        ) : (
          draft.flows.map((flow, i) => (
            <FlowEditor
              key={flow.id}
              flow={flow}
              onChange={(next) => updateFlow(i, next)}
              onRemove={() => removeFlow(i)}
            />
          ))
        )}
      </Box>

      <NotificationsSection
        prefs={draft.notifications}
        onChange={(patch) => updateNested('notifications', patch)}
      />

      <Box sx={{ display: 'flex', gap: 2, mb: 4 }}>
        <Button variant="primary" onClick={onSave}>Save changes</Button>
        <Button onClick={() => setDraft(clone(config))}>Reset</Button>
      </Box>

      <Box sx={sectionSx}>
        <Heading as="h2" sx={{ fontSize: 3, mb: 2 }}>Import / export JSON</Heading>
        <Text as="p" sx={{ color: 'fg.muted', fontSize: 1, mb: 2 }}>
          Current configuration:
        </Text>
        <Textarea value={exportJson} readOnly rows={8} sx={{ width: '100%', fontFamily: 'mono', fontSize: 0 }} />
        <Heading as="h3" sx={{ fontSize: 1, mt: 3, mb: 2, color: 'fg.muted' }}>
          Paste JSON to import
        </Heading>
        {jsonErrors.length > 0 && (
          <Flash variant="danger" sx={{ mb: 2 }}>
            <Box as="ul" sx={{ m: 0, pl: 3 }}>
              {jsonErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </Box>
          </Flash>
        )}
        <Textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          rows={8}
          placeholder='{ "upstream": { "owner": "...", "repo": "..." }, ... }'
          sx={{ width: '100%', fontFamily: 'mono', fontSize: 0 }}
        />
        <Button sx={{ mt: 2 }} onClick={onImport} disabled={!jsonText.trim()}>
          Import &amp; apply
        </Button>
      </Box>
    </Box>
  );
}

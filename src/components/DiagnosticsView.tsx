/**
 * The app's own diagnostics log, in the app.
 *
 * The file has always been there, but reading it meant leaving Job Monitor, finding a
 * platform-specific path and running `jq` — which is exactly the friction that stops
 * anyone from looking when it would have helped. Since the interesting run is usually the
 * one that just happened, this defaults to following the tail live.
 *
 * Opt-in (Settings → Diagnostics) and desktop-only: a browser tab has no such file, and a
 * window on the app's internals does not belong in everyone's navigation by default.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, FormControl, Heading, IconButton, Label, Select, Text, TextInput, ToggleSwitch, SegmentedControl } from '@primer/react';
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileDirectoryIcon,
  SearchIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { useConfig } from '../context/ConfigContext';
import { usePolling } from '../hooks/usePolling';
import { TelemetryPane } from './TelemetryPane';
import {
  filterRecords,
  formatLogTime,
  isWarning,
  logScopes,
  parseDiagnosticsLog,
  type LogRecord,
} from '../lib/diagnosticsLog';
import {
  diagnosticsLogPath,
  readDiagnosticsLog,
  revealDiagnosticsLog,
  type DiagnosticsLogTail,
} from '../storage/desktopClaude';
import styles from './DiagnosticsView.module.css';
import { Icon } from './Icon';

/** Colour per scope family, matching the console styling in lib/devLog.ts. */
const SCOPE_COLOR: Record<string, string> = {
  api: '#58a6ff',
  'log-cache': '#a371f7',
  claude: '#3fb950',
  'auto-rerun': '#d29922',
  failures: '#f85149',
  desktop: '#8b949e',
};

/**
 * The colour for a scope as written in the file.
 *
 * Records from the renderer arrive prefixed (`renderer:auto-rerun`) because the IPC hop
 * adds it, so the prefix is stripped before matching — otherwise every renderer line,
 * which is most of them, would fall through to the default.
 */
function scopeColor(scope: string): string {
  const bare = scope.startsWith('renderer:') ? scope.slice('renderer:'.length) : scope;
  return SCOPE_COLOR[bare] ?? 'var(--fgColor-muted)';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One row, expandable into its `detail`. */
function LogRow({ record }: { record: LogRecord }) {
  const [open, setOpen] = useState(false);
  const hasDetail = record.detail !== undefined;
  const warning = isWarning(record);
  // The prefix is how devWarn marks a line; the badge says it better than the text does.
  const message = warning ? record.message.slice('WARN:'.length).trim() : record.message;

  return (
    <div
      className={styles.record}
    >
      <div className={styles.flexGap2}>
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          aria-label={hasDetail ? (open ? 'Hide detail' : 'Show detail') : undefined}
          disabled={!hasDetail}
          className={hasDetail ? styles.caretActive : styles.caret}
        >
          {hasDetail && <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size={12} />}
        </button>

        <Text className={styles.monoFgMuted}>
          {formatLogTime(record.at)}
        </Text>

        <Text
          className={styles.scope} style={{ color: scopeColor(record.scope) }}
        >
          {record.scope}
        </Text>

        {warning && (
          <Label variant="attention" className={styles.flexShrink}>
            <AlertIcon size={12} className={styles.mr1} />
            warn
          </Label>
        )}

        <Text className={record.malformed ? styles.messageMalformed : styles.message}>
          {message || <em>unparseable line</em>}
        </Text>
      </div>

      {open && hasDetail && (
        <pre
          className={styles.m0Mt1}
        >
          {JSON.stringify(record.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * Diagnostics has two halves that answer different questions: what the app *did* (the log) and
 * what it is about to *send* (the telemetry queue). They share a tab because they share an
 * audience — someone checking on the app's behaviour — and separating them into two settings
 * pages would bury the second one.
 */
export function DiagnosticsView() {
  const [pane, setPane] = useState<'log' | 'telemetry'>('log');

  return (
    <div>
      <div className={styles.flexGap2_2}>
        <SegmentedControl aria-label="Diagnostics view" size="small">
          <SegmentedControl.Button selected={pane === 'log'} onClick={() => setPane('log')}>
            Log
          </SegmentedControl.Button>
          <SegmentedControl.Button
            selected={pane === 'telemetry'}
            onClick={() => setPane('telemetry')}
          >
            Telemetry
          </SegmentedControl.Button>
        </SegmentedControl>
      </div>
      {pane === 'log' ? <DiagnosticsLogView /> : <TelemetryPane />}
    </div>
  );
}

function DiagnosticsLogView() {
  const { config } = useConfig();
  const { tailKB, followSeconds } = config.diagnostics;

  const [tail, setTail] = useState<DiagnosticsLogTail | null>(null);
  /**
   * Explicit, because "no tail yet" has two meanings with different screens and the first
   * frame is always the ambiguous one: deriving this from `tail === null` flashed "there is
   * no log in a browser" at every desktop user before the first read came back.
   */
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [paths, setPaths] = useState<{ file: string; dir: string } | null>(null);
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void diagnosticsLogPath().then((p) => live && setPaths(p));
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await readDiagnosticsLog(tailKB * 1024);
    if (next) {
      setTail(next);
      setStatus('ready');
    } else {
      // A read that fails once shouldn't blank a screenful of records: stay on what is
      // already shown and only claim unavailability when there was never anything.
      setStatus((prev) => (prev === 'ready' ? prev : 'unavailable'));
    }
  }, [tailKB]);

  const { refresh, isFetching, lastUpdated } = usePolling({
    fn: load,
    intervalMs: followSeconds * 1000,
    enabled: follow,
  });

  // Parsing is the expensive half, so it is keyed to the text and not to the filters —
  // typing in the search box must not re-parse half a megabyte per keystroke.
  const records = useMemo(() => parseDiagnosticsLog(tail?.text ?? ''), [tail?.text]);
  const scopes = useMemo(() => logScopes(records), [records]);
  const shown = useMemo(
    () => filterRecords(records, { scope, query, warningsOnly }),
    [records, scope, query, warningsOnly],
  );

  /**
   * A scope that disappears from the tail must not leave an invisible filter behind:
   * without this, "renderer:claude" selected during an analysis silently empties the view
   * once those records roll off the window.
   */
  useEffect(() => {
    if (scope && records.length > 0 && !scopes.includes(scope)) setScope('');
  }, [scope, scopes, records.length]);

  if (status === 'loading') {
    return (
      <Text as="p" className={styles.fgMuted}>
        Reading the log…
      </Text>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className={styles.maxWidth}>
        <Heading as="h2" className={styles.titleMb2}>
          Diagnostics
        </Heading>
        <Text as="p" className={styles.fgMuted}>
          The diagnostics log is written by the desktop app; there is no such file in a browser
          tab. Open Job Monitor as the installed app to read it here.
        </Text>
      </div>
    );
  }

  return (
    <div>
      <div
        className={styles.flexGap3}
      >
        <FormControl>
          <FormControl.Label>Search</FormControl.Label>
          <TextInput
            leadingVisual={SearchIcon}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="message, run id, PR number…"
            className={styles.width}
          />
        </FormControl>

        <FormControl>
          <FormControl.Label>Scope</FormControl.Label>
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <Select.Option value="">All scopes</Select.Option>
            {scopes.map((s) => (
              <Select.Option key={s} value={s}>
                {s}
              </Select.Option>
            ))}
          </Select>
        </FormControl>

        <div className={styles.flexCenter}>
          <Text className={styles.body} id="warnings-only-label">
            Warnings only
          </Text>
          <ToggleSwitch
            size="small"
            checked={warningsOnly}
            onClick={() => setWarningsOnly((v) => !v)}
            aria-labelledby="warnings-only-label"
          />
        </div>

        <div className={styles.flexCenter}>
          <Text className={styles.body} id="follow-label">
            Live
          </Text>
          <ToggleSwitch
            size="small"
            checked={follow}
            onClick={() => setFollow((v) => !v)}
            aria-labelledby="follow-label"
          />
        </div>

        <div className={styles.flexCenter}>
          <IconButton
            icon={SyncIcon}
            aria-label="Refresh now"
            onClick={() => refresh()}
            disabled={isFetching}
          />
          {paths && (
            <>
              <IconButton
                icon={CopyIcon}
                aria-label={copied ? 'Path copied' : 'Copy log path'}
                onClick={() => {
                  void navigator.clipboard?.writeText(paths.file);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                }}
              />
              <IconButton
                icon={FileDirectoryIcon}
                aria-label="Open log folder"
                onClick={() => void revealDiagnosticsLog()}
              />
            </>
          )}
        </div>
      </div>

      <div
        className={styles.flexGap2_3}
      >
        <Text>
          {shown.length === records.length
            ? `${records.length} record${records.length === 1 ? '' : 's'}`
            : `${shown.length} of ${records.length} records`}
        </Text>
        {tail && (
          <Text>
            · newest first · reading the last {formatBytes(Math.min(tailKB * 1024, tail.size))} of{' '}
            {formatBytes(tail.size)}
            {tail.truncated ? ' (earlier records are in the file, not here)' : ''}
          </Text>
        )}
        {lastUpdated && <Text>· updated {formatLogTime(new Date(lastUpdated).toISOString())}</Text>}
      </div>

      {records.length === 0 ? (
        <Text as="p" className={styles.fgMuted}>
          Nothing logged yet. The file fills up as the app polls, analyses and decides — come back
          after something has happened.
        </Text>
      ) : shown.length === 0 ? (
        <Text as="p" className={styles.fgMuted}>
          No record matches. {warningsOnly ? 'No warnings in this window — ' : ''}
          <Button
            variant="invisible"
            size="small"
            onClick={() => {
              setQuery('');
              setScope('');
              setWarningsOnly(false);
            }}
          >
            clear the filters
          </Button>
        </Text>
      ) : (
        <div
          className={styles.rounded}
        >
          {shown.map((record) => (
            <LogRow key={record.seq} record={record} />
          ))}
        </div>
      )}
    </div>
  );
}

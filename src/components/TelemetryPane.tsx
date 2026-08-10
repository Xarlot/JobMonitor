/**
 * What telemetry is queued on this machine, shown verbatim.
 *
 * **This screen is the other half of "always on, no opt-out".** Collection cannot be turned off,
 * and that is only a defensible position if it comes with the ability to see exactly what is
 * collected. So the records are rendered as they will be sent — the same JSON, not a summary —
 * because a summary is something the reader has to take on trust, and trust is the thing this
 * screen exists to make unnecessary.
 *
 * The queue is plain NDJSON on disk too. This is a convenience, not the only way to look.
 */

import { useCallback, useMemo, useState } from 'react';
import { Button, Label, Link, Text, ToggleSwitch } from '@primer/react';
import { FileDirectoryIcon, PaperAirplaneIcon, SyncIcon } from '@primer/octicons-react';

import { usePolling } from '../hooks/usePolling';
import {
  readTelemetrySpool,
  sendTelemetryNow,
  setTelemetryCollecting,
  type SendNowResult,
  type SpoolRecord,
  type TelemetrySnapshot,
} from '../storage/desktopTelemetry';
import styles from './TelemetryPane.module.css';

const PRIORITY_TONE: Record<string, 'danger' | 'attention' | 'secondary'> = {
  crash: 'danger',
  failure: 'attention',
  usage: 'secondary',
};

const bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const when = (ms: number) => new Date(ms).toLocaleString();

export function TelemetryPane() {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  const load = useCallback(async () => {
    const next = await readTelemetrySpool();
    if (next?.available) {
      setSnapshot(next);
      setStatus('ready');
    } else {
      setStatus((prev) => (prev === 'ready' ? prev : 'unavailable'));
    }
  }, []);

  const { refresh, isFetching } = usePolling({ fn: load, intervalMs: 5000, enabled: true });

  const [busy, setBusy] = useState(false);
  const [sendResult, setSendResult] = useState<SendNowResult | null>(null);

  const toggleCollecting = useCallback(
    async (next: boolean) => {
      setBusy(true);
      await setTelemetryCollecting(next);
      await load();
      setBusy(false);
    },
    [load],
  );

  const sendNow = useCallback(async () => {
    setBusy(true);
    setSendResult(null);
    const result = await sendTelemetryNow();
    setSendResult(result);
    await load();
    setBusy(false);
  }, [load]);

  // Newest first: the interesting record is almost always the one just written.
  const records = useMemo(
    () => [...(snapshot?.records ?? [])].sort((a, b) => b.at - a.at),
    [snapshot?.records],
  );

  if (status === 'loading') {
    return (
      <Text as="p" className={styles.fgMuted}>
        Reading the queue…
      </Text>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className={styles.maxWidth}>
        <Text as="p" className={styles.fgMuted}>
          Telemetry is collected by the desktop app only — this page in a browser tab records
          nothing, stores nothing and sends nothing. Open Job Monitor as the installed app to see
          what is queued.
        </Text>
      </div>
    );
  }

  const stats = snapshot?.stats;
  const meta = snapshot?.meta;

  return (
    <div>
      <div className={styles.mb3}>
        <Text as="p" className={styles.fgMutedBody}>
          Everything below is queued on this machine and has not been sent yet. It is shown exactly
          as it will be transmitted. Full details of what is and is not collected are in{' '}
          <Link href="https://github.com/DevExpress/JavaJobMonitor/blob/master/docs/telemetry.md">
            docs/telemetry.md
          </Link>
          .
        </Text>
      </div>

      {meta && (
        <div
          className={styles.gridGap2}
        >
          <Field label="Installation ID" value={meta.installationId} mono />
          <Field label="App version" value={`${meta.appVersion} · Electron ${meta.electronVersion}`} />
          <Field label="Platform" value={`${meta.platform} ${meta.arch}`} />
          <Field
            label="Collecting"
            value={meta.disabled ? 'disabled (error)' : meta.collecting ? 'yes' : 'no'}
          />
          <Field
            label="Scheduled sending"
            value={meta.sendEnabled ? 'enabled' : 'off (dev build)'}
          />
        </div>
      )}

      {meta?.devBuild && (
        /*
          Development builds only. A packaged build collects unconditionally — that is the product
          decision — and the main process refuses this toggle there, so these controls cannot
          become an opt-out by way of the renderer.
        */
        <div
          className={styles.roundedP3}
        >
          <Text as="div" className={styles.semiboldMb1}>
            Development build
          </Text>
          <Text as="p" className={styles.fgMutedBody2}>
            Collection is off unless you switch it on, and the switch is not remembered — every run
            starts clean, so nothing accumulates between sessions and there is nothing to remember
            to turn back off. Scheduled sending is off here too; use <em>Send now</em> to exercise
            the real publish path on demand.
          </Text>

          <div className={styles.flexCenter}>
            <div className={styles.flexCenter2}>
              <ToggleSwitch
                size="small"
                checked={meta.collecting}
                disabled={busy}
                onClick={() => void toggleCollecting(!meta.collecting)}
                aria-labelledby="collect-label"
              />
              <Text id="collect-label" className={styles.body}>
                Collect telemetry this session
              </Text>
            </div>

            <Button
              size="small"
              leadingVisual={PaperAirplaneIcon}
              onClick={() => void sendNow()}
              disabled={busy}
            >
              Send now
            </Button>

            {sendResult && (
              <Text className={styles.small} style={{ color: sendResult.ok ? 'var(--fgColor-success)' : 'var(--fgColor-danger)' }}>
                {sendResult.ok
                  ? `Published ${sendResult.sent} record${sendResult.sent === 1 ? '' : 's'}.`
                  : `Not sent: ${sendResult.reason ?? 'unknown'}`}
              </Text>
            )}
          </div>
        </div>
      )}

      <div className={styles.flexCenter3}>
        <Button size="small" leadingVisual={SyncIcon} onClick={refresh} disabled={isFetching}>
          Refresh
        </Button>
        {stats && (
          <>
            {Object.entries(stats.files).map(([name, file]) => (
              <Label key={name} variant={PRIORITY_TONE[name] ?? 'secondary'}>
                {name}: {file.records} · {bytes(file.bytes)}
              </Label>
            ))}
            {stats.dropped > 0 && (
              /* Surfaced rather than hidden: a gap in the data should be a number the user can see
                 too, not only something the server infers. */
              <Label variant="attention">{stats.dropped} dropped (queue full or expired)</Label>
            )}
          </>
        )}
        {stats?.dir && (
          <Text className={styles.fgMutedSmall}>
            <FileDirectoryIcon size={14} />
            <code>{stats.dir}</code>
          </Text>
        )}
      </div>

      {records.length === 0 ? (
        <Text as="p" className={styles.fgMuted}>
          Nothing queued. Counters are held in memory and written here every 15 minutes.
        </Text>
      ) : (
        <div className={styles.gridGap2_2}>
          {records.map((record) => (
            <RecordCard key={`${record.at}:${record.kind}`} record={record} />
          ))}
        </div>
      )}

      <Text as="p" className={styles.fgMutedSmall2}>
        Queued records are kept for up to 7 days and published roughly hourly. Nothing here contains
        your GitHub token, repository or branch names, file paths, or exception messages — see{' '}
        <Link href="https://github.com/DevExpress/JavaJobMonitor/blob/master/docs/telemetry.md">
          the documentation
        </Link>{' '}
        for the full field list.
      </Text>
    </div>
  );
}

function RecordCard({ record }: { record: SpoolRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.roundedP2}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={styles.flexCenter4}
      >
        <Label variant={PRIORITY_TONE[record.priority] ?? 'secondary'}>{record.priority}</Label>
        <Text className={styles.bodySemibold}>{record.kind}</Text>
        <Text className={styles.smallFgMuted}>{when(record.at)}</Text>
      </button>
      {open && (
        <pre
          className={styles.mt2Mb0}
        >
          {JSON.stringify(record.body, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.roundedP2_2}>
      <Text as="div" className={styles.smallFgMuted2}>
        {label}
      </Text>
      <Text
        as="div"
        className={mono ? styles.valueMono : styles.value}
      >
        {value}
      </Text>
    </div>
  );
}

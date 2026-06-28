/** Small date/duration formatting helpers (no dependency). */

/** Human-readable byte size: "0 B", "512 B", "1.4 KB", "3.2 MB", "1.1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  // No decimals for plain bytes; one decimal otherwise.
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** Duration between two ISO timestamps as "1h 2m", "3m 4s", "45s". */
export function formatDuration(
  start: string | null,
  end: string | null,
  now: number = Date.now(),
): string {
  if (!start) return '—';
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return '—';
  const endMs = end ? Date.parse(end) : now;
  let secs = Math.max(0, Math.round((endMs - startMs) / 1000));
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Compact relative time like "just now", "5m ago", "2h ago", "3d ago". */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = Math.round((now - ms) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 90) return '1m ago';
  const mins = Math.round(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Absolute local time, e.g. "Jun 26, 14:03". */
export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Seconds until an epoch-seconds reset, clamped at 0; formatted "m:ss". */
export function formatCountdown(resetEpochSec: number | null, now: number = Date.now()): string {
  if (resetEpochSec == null) return '—';
  const secs = Math.max(0, Math.round((resetEpochSec * 1000 - now) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Make a filesystem-safe `.zip` name from an artifact name. */
export function artifactFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'artifact';
  return base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
}

/** Save a Blob to disk by clicking a transient object-URL anchor (works in browser + Electron). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

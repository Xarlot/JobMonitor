import { ghGetBlob } from '../api/githubClient';
import { artifactZipPath } from '../api/endpoints';
import { Operation, Telemetry } from './telemetry';

/**
 * Fetch one artifact's zip.
 *
 * The single download and the bundle both pull artifacts the same way, so the timing lives here
 * rather than at either call site. Measuring it in both would count each bundled artifact under an
 * operation that also means "a person downloaded one thing", and the two are not comparable: a
 * bundle of twelve would look like twelve downloads, and the median would drift towards whatever
 * bundles happen to contain.
 */
export function fetchArtifactZip(owner: string, repo: string, artifactId: number): Promise<Blob> {
  return Telemetry.measure(Operation.GH_ARTIFACT_DOWNLOAD, () =>
    ghGetBlob(artifactZipPath(owner, repo, artifactId)),
  );
}

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

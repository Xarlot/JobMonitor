import { unzipSync, zipSync, type Zippable } from 'fflate';
import { ghGetBlob } from '../api/githubClient';
import { artifactZipPath } from '../api/endpoints';
import type { Artifact } from '../api/types';

/** Folder-safe name derived from an artifact name (no extension, no separators). */
export function artifactFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.zip$/i, '').trim() || 'artifact';
}

export interface BundleProgress {
  done: number;
  total: number;
  current: string;
}

/**
 * Download each artifact's zip, unpack it, and repack everything into a single
 * zip where each artifact's files live under a folder named after the artifact.
 * Expired artifacts are skipped. Returns the combined zip as a Blob.
 */
export async function bundleArtifacts(
  owner: string,
  repo: string,
  artifacts: Artifact[],
  onProgress?: (p: BundleProgress) => void,
): Promise<Blob> {
  const usable = artifacts.filter((a) => !a.expired);
  if (usable.length === 0) throw new Error('No downloadable artifacts (all expired).');

  const entries: Zippable = {};
  const usedFolders = new Set<string>();
  let done = 0;

  for (const a of usable) {
    onProgress?.({ done, total: usable.length, current: a.name });

    const blob = await ghGetBlob(artifactZipPath(owner, repo, a.id));
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Disambiguate duplicate artifact names so folders don't collide.
    let folder = artifactFolderName(a.name);
    for (let n = 2; usedFolders.has(folder); n++) folder = `${artifactFolderName(a.name)}-${n}`;
    usedFolders.add(folder);

    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      // Not a readable zip — keep the raw bytes rather than dropping the artifact.
      files = { [`${a.name}.bin`]: bytes };
    }
    for (const [path, data] of Object.entries(files)) {
      if (path.endsWith('/')) continue; // skip directory entries
      entries[`${folder}/${path}`] = data;
    }

    done += 1;
    onProgress?.({ done, total: usable.length, current: a.name });
  }

  const zipped = zipSync(entries);
  return new Blob([zipped], { type: 'application/zip' });
}

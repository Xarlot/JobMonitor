import { describe, expect, it } from 'vitest';
import { artifactZipPath, runIdFromUrl } from '../api/endpoints';
import { artifactFileName } from '../lib/downloadArtifact';
import { artifactFolderName } from '../lib/artifactBundle';
import { formatBytes } from '../lib/format';

describe('runIdFromUrl', () => {
  it('extracts the run id from job/check URLs', () => {
    expect(runIdFromUrl('https://github.com/o/r/actions/runs/1002/job/5')).toBe(1002);
    expect(runIdFromUrl('https://github.com/o/r/actions/runs/77')).toBe(77);
  });
  it('returns null when absent', () => {
    expect(runIdFromUrl(null)).toBeNull();
    expect(runIdFromUrl(undefined)).toBeNull();
    expect(runIdFromUrl('https://github.com/o/r/pull/1')).toBeNull();
  });
  it("ignores a check-run's generic /runs/{id} html_url (no Actions run id)", () => {
    // Real check-run html_url is the /runs/{check_run_id} page; the Actions run
    // id only lives in details_url. The PR list must read details_url first.
    expect(runIdFromUrl('https://github.com/o/r/runs/4')).toBeNull();
    expect(runIdFromUrl('https://github.com/o/r/actions/runs/1002/job/4')).toBe(1002);
  });
});

describe('artifactZipPath', () => {
  it('builds the zip download path with encoding', () => {
    expect(artifactZipPath('acme', 'rocket', 42)).toBe(
      '/repos/acme/rocket/actions/artifacts/42/zip',
    );
    expect(artifactZipPath('a b', 'r', 1)).toBe('/repos/a%20b/r/actions/artifacts/1/zip');
  });
});

describe('artifactFileName', () => {
  it('appends .zip and sanitizes path separators', () => {
    expect(artifactFileName('test-summary')).toBe('test-summary.zip');
    expect(artifactFileName('build/logs:1')).toBe('build_logs_1.zip');
    expect(artifactFileName('  ')).toBe('artifact.zip');
  });
  it('keeps an existing .zip extension (case-insensitive)', () => {
    expect(artifactFileName('bundle.zip')).toBe('bundle.zip');
    expect(artifactFileName('Bundle.ZIP')).toBe('Bundle.ZIP');
  });
});

describe('artifactFolderName', () => {
  it('strips the .zip extension and path separators', () => {
    expect(artifactFolderName('coverage-report')).toBe('coverage-report');
    expect(artifactFolderName('bundle.zip')).toBe('bundle');
    expect(artifactFolderName('a/b:c')).toBe('a_b_c');
    expect(artifactFolderName('   ')).toBe('artifact');
  });
});

describe('formatBytes', () => {
  it('formats sizes across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(8_734_208)).toBe('8.3 MB');
  });
  it('guards against bad input', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
});

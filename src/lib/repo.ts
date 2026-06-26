/**
 * Normalize owner/repo input so users can paste any of these and get the right
 * `owner` + `repo`:
 *   - "owner/repo"
 *   - "https://github.com/owner/repo" (with or without ".git", trailing path)
 *   - "git@github.com:owner/repo.git"
 *   - separate owner + repo fields
 * The repo field wins if it carries owner/repo info; otherwise the owner field is parsed.
 */

function clean(input: string): string {
  return input
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^github\.com\//i, '')
    .replace(/^\/+/, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

export function normalizeRepoRef(owner: string, repo: string): { owner: string; repo: string } {
  const co = clean(owner ?? '');
  const cr = clean(repo ?? '');

  if (cr.includes('/')) {
    const [a, b] = cr.split('/');
    return { owner: a.trim(), repo: (b ?? '').trim() };
  }
  if (co.includes('/')) {
    const [a, b] = co.split('/');
    return { owner: a.trim(), repo: (b ?? '').trim() };
  }
  return { owner: co, repo: cr };
}

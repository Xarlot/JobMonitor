/**
 * Resolve a user-supplied workflow reference (display name, file name with or
 * without extension, or numeric id) against the repo's workflows list. The
 * GitHub runs API requires the file name *with* extension or the numeric id, so
 * being forgiving here avoids 404s from e.g. "check-pull-request-java".
 */

import type { Workflow } from '../api/types';

export function workflowBasename(path: string): string {
  return path.split('/').pop() ?? path;
}

function stripExt(s: string): string {
  return s.replace(/\.(ya?ml)$/i, '');
}

export function isNumericId(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}

export function hasYamlExt(raw: string): boolean {
  return /\.(ya?ml)$/i.test(raw.trim());
}

export function matchWorkflow(workflows: Workflow[], raw: string): Workflow | undefined {
  const trimmed = raw.trim();
  const t = trimmed.toLowerCase();
  const tNoExt = stripExt(t);
  return workflows.find((w) => {
    const file = workflowBasename(w.path).toLowerCase();
    return (
      String(w.id) === trimmed ||
      file === t ||
      stripExt(file) === tNoExt ||
      w.name.trim().toLowerCase() === t
    );
  });
}

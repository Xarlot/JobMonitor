/**
 * Stack trace sanitization, and the crash fingerprint.
 *
 * Runs in the main process at the moment of persistence, so a raw stack never reaches disk and the
 * renderer structurally cannot ship one anywhere. One implementation, one place.
 *
 * Two jobs that pull in opposite directions:
 *
 *   1. **Remove everything identifying.** Home directories, usernames, absolute paths, tokens.
 *   2. **Keep the trace stable across releases**, or crash grouping is worthless — every release
 *      would produce a brand-new set of fingerprints for the same old bugs.
 *
 * (2) is why the Vite content hash has to be stripped: `index-Ab12Cd.js` becomes a different file
 * name on every build, so an unstripped frame makes each release look like a wave of new crashes.
 *
 * The message is never an input. `error.message` is the likeliest place in any crash report for a
 * path, a URL or a token to appear, and the cheapest way to guarantee it does not leak is for it to
 * have no route into this function at all.
 */

import { createHash } from 'node:crypto';

const MAX_FRAMES = 12;
const FINGERPRINT_FRAMES = 5;
const MAX_STACK_BYTES = 4096;
const MAX_FUNCTION_CHARS = 80;
const MAX_COMPONENTS = 12;

/**
 * Replace machine- and user-identifying strings anywhere in the text.
 *
 * Runs over the whole string before any parsing, because a home directory can appear in places a
 * frame parser would not look — a wrapped message, a `require` stack, a Windows path embedded in an
 * error from a native module.
 */
export function redactAbsolutes(text, ctx = {}) {
  if (!text) return '';
  let out = String(text);

  // Longest first: userData usually sits *inside* home, and replacing home first would leave a
  // half-substituted path like `<home>/.config/Job Monitor`.
  const replacements = [
    [ctx.userData, '<data>'],
    [ctx.home, '<home>'],
  ];
  for (const [value, token] of replacements) {
    if (!value || value.length < 3) continue;
    out = replaceAllPathish(out, value, token);
  }

  // A very short username would match far too much — `al` appears inside `Alt`, `value`, `final`.
  // Over-redaction is the safe direction, but not to the point of destroying the trace.
  if (ctx.username && ctx.username.length >= 3) {
    out = out.replace(new RegExp(escapeRegExp(ctx.username), 'gi'), '<user>');
  }

  return (
    out
      // GitHub tokens. Not hypothetical: this app holds a `repo` PAT in memory, and a token
      // reaching an exception is an entirely ordinary bug.
      .replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, '<token>')
      // Long hex runs — session ids, hashes, anything that might be an identifier.
      .replace(/\b[0-9a-f]{32,}\b/gi, '<hex>')
      .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '<email>')
  );
}

/** Replace a path in both separator conventions and either case (Windows is case-insensitive). */
function replaceAllPathish(text, value, token) {
  const variants = new Set([value, value.replace(/\\/g, '/'), value.replace(/\//g, '\\')]);
  let out = text;
  for (const variant of variants) {
    out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), token);
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize one frame location to something stable and anonymous.
 *
 * The Vite hash strip is the load-bearing rule — see the module header.
 */
export function normalizeLocation(raw) {
  let loc = String(raw).trim();

  // Strip the trailing :line:col, keep them to re-attach.
  let position = '';
  const posMatch = loc.match(/:(\d+):(\d+)$/);
  if (posMatch) {
    position = `:${posMatch[1]}:${posMatch[2]}`;
    loc = loc.slice(0, posMatch.index);
  }

  // Vite dev-server query params (`?t=1699…`, `?import`) change on every reload.
  loc = loc.replace(/[?#].*$/, '');

  // Node internals are already anonymous and are useful as-is.
  if (loc.startsWith('node:')) return loc + position;

  // The packaged app: everything after `app.asar/` is repo-relative and safe.
  const asar = loc.split(/app\.asar[\\/]/)[1];
  if (asar) return `asar:/${asar.replace(/\\/g, '/')}${position}`;

  // The renderer bundle, served over the custom app:// protocol.
  if (loc.startsWith('app://')) {
    const p = loc.replace(/^app:\/\/[^/]*/, '');
    return `app:/${stripContentHash(p).replace(/^\/+/, '')}${position}`;
  }

  // Vite dev server.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(loc)) {
    const p = loc.replace(/^https?:\/\/[^/]*/, '');
    return `dev:${stripContentHash(p)}${position}`;
  }

  // Anything else that is still an absolute path: keep only the last two segments. Enough to
  // identify the file, not enough to say anything about the machine.
  const normalized = loc.replace(/^file:\/\//, '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const tail = segments.slice(-2).join('/');
  return `${stripContentHash(tail)}${position}`;
}

/** `index-Ab12Cd.js` → `index.js`. Matches the chunk names vite.config.ts produces. */
function stripContentHash(p) {
  return p.replace(/-[A-Za-z0-9_-]{6,12}(\.[a-z]+)$/, '$1');
}

/**
 * Sanitize a V8 stack.
 *
 * @param {string} stack Raw `error.stack`.
 * @param {{home?:string,userData?:string,username?:string}} ctx Injected so one test covers all
 *   three platforms' path shapes rather than only the one it happens to run on.
 * @returns {{frames: string[], text: string}}
 */
export function sanitizeStack(stack, ctx = {}) {
  if (!stack) return { frames: [], text: '' };

  const redacted = redactAbsolutes(stack, ctx);
  const lines = redacted.split('\n');

  // Drop line 0 unconditionally. In a V8 stack it is `TypeError: <message>` — never parsed, never
  // kept. The type comes from `error.name`, supplied separately by the caller.
  const frameLines = lines.slice(lines[0] && !/^\s*at\s/.test(lines[0]) ? 1 : 0);

  const frames = [];
  for (const line of frameLines) {
    if (frames.length >= MAX_FRAMES) break;
    const frame = parseFrame(line);
    if (frame) frames.push(frame);
  }

  let text = frames.join('\n');
  if (Buffer.byteLength(text) > MAX_STACK_BYTES) {
    text = Buffer.from(text).subarray(0, MAX_STACK_BYTES).toString('utf8');
    // A multi-byte character cut in half decodes to U+FFFD; drop the partial trailing line rather
    // than ship a mangled one.
    text = text.slice(0, text.lastIndexOf('\n') + 1 || text.length);
  }
  return { frames, text };
}

function parseFrame(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('at ')) return null;
  const body = trimmed.slice(3).trim();

  // `at fn (location)` — the common shape.
  const withName = body.match(/^(.*?)\s+\((.+)\)$/);
  if (withName) {
    const fn = sanitizeFunctionName(withName[1]);
    return `at ${fn} (${normalizeLocation(withName[2])})`;
  }

  // `at location` — a top-level or anonymous frame.
  return `at ${normalizeLocation(body)}`;
}

/**
 * Shapes V8 actually produces for a frame's function name: `foo`, `Foo.bar`, `Object.<anonymous>`,
 * `new Foo`, `async Bar.baz`, `Module._load`.
 */
const FUNCTION_NAME = /^(?:(?:async|new|get|set)\s+)*[A-Za-z_$<][A-Za-z0-9_$.<>]*$/;

/**
 * Accept a function name only if it is *entirely* identifier-shaped, otherwise discard it.
 *
 * Reject rather than clean. The earlier version of this stripped disallowed characters and kept
 * the rest, which sounds equivalent and is not: `fetchRepo("DevExpress/private-repo")` came out as
 * `fetchRepoDevExpressprivaterepo`, so the repository name survived in a form that is unreadable
 * to a human and perfectly greppable by anyone who cared. Filtering characters out of a string
 * does not remove the information in it.
 *
 * The same principle applies to every string field in this system: if it does not already look
 * like what it is supposed to be, throw it away rather than repair it.
 */
function sanitizeFunctionName(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed || !FUNCTION_NAME.test(trimmed)) return '<anonymous>';
  if (looksLikeSecret(trimmed)) return '<anonymous>';
  return trimmed.slice(0, MAX_FUNCTION_CHARS);
}

/**
 * Whether a string that is *shaped* like an identifier is nonetheless probably a secret.
 *
 * Needed because the two categories overlap: `ghp_ABCDEF…` is a perfectly valid JavaScript
 * identifier, so a shape check alone lets a GitHub token through any field that accepts a name.
 */
function looksLikeSecret(text) {
  return (
    /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/.test(text) ||
    /[0-9a-f]{24,}/i.test(text) ||
    /[A-Za-z0-9+/]{40,}={0,2}/.test(text)
  );
}

/**
 * Reduce React's `componentStack` to bare component names.
 *
 * The raw form is `    in FlowRunsGrid (created by FlowsView)`, and in development it can carry a
 * file annotation with an absolute path. Only the identifier survives.
 */
export function sanitizeComponentStack(componentStack, ctx = {}) {
  if (!componentStack) return '';
  const redacted = redactAbsolutes(componentStack, ctx);
  const names = [];
  for (const line of redacted.split('\n')) {
    if (names.length >= MAX_COMPONENTS) break;
    const match = line.trim().match(/^in\s+([A-Za-z][A-Za-z0-9_.]*)/);
    if (match) names.push(match[1]);
  }
  return names.join(' < ');
}

/**
 * A stable identity for "this same crash".
 *
 * Type plus the top few normalized frames. Deeper frames vary with how the code was reached and
 * would split one bug across many fingerprints; the top frames are where it actually broke.
 */
export function fingerprint(exceptionType, frames) {
  const material = [exceptionType, ...frames.slice(0, FINGERPRINT_FRAMES)].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Validate an exception type before it becomes a string field on the wire.
 *
 * `error.name` is normally a class name, but it is writable — `err.name = someUserInput` is legal
 * JavaScript. This is the check that keeps one of the format's five string fields to a shape that
 * cannot carry a sentence, a path or a URL. The receiver applies the same rule independently.
 */
export function sanitizeExceptionType(name) {
  const candidate = String(name ?? '').trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]{0,127}$/.test(candidate)) return 'UnknownError';
  // A shape check alone is not enough here: `ghp_ABCDEF…` satisfies the identifier pattern exactly,
  // because underscores and alphanumerics are all a token contains. Without this second check,
  // `error.name = token` would put a credential straight onto the wire through one of the format's
  // five permitted string fields.
  if (looksLikeSecret(candidate)) return 'UnknownError';
  return candidate;
}

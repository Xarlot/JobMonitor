/**
 * Stack sanitization.
 *
 * Two properties are being defended, and they pull against each other.
 *
 * **Nothing identifying survives.** Tested as a property over a corpus of secrets rather than as a
 * list of examples, because the examples anyone thinks to write are the cases already handled. The
 * interesting failures are the ones nobody pictured — a Windows path in an error from a native
 * module, a username that also happens to be a substring of a function name, a token in a message
 * that got wrapped into a stack.
 *
 * **Fingerprints survive a release.** If they do not, crash grouping is worthless: every release
 * appears as a wave of brand-new crashes and the "new fingerprints since the release" panel — the
 * one that would actually catch a regression — is pure noise.
 */

import { describe, expect, it } from 'vitest';

import {
  fingerprint,
  normalizeLocation,
  redactAbsolutes,
  sanitizeComponentStack,
  sanitizeExceptionType,
  sanitizeStack,
} from '../../electron/telemetry/sanitize.mjs';

const LINUX = {
  home: '/home/maksim',
  userData: '/home/maksim/.config/Job Monitor',
  username: 'maksim',
};
const MACOS = {
  home: '/Users/maksim',
  userData: '/Users/maksim/Library/Application Support/Job Monitor',
  username: 'maksim',
};
const WINDOWS = {
  home: 'C:\\Users\\maksim',
  userData: 'C:\\Users\\maksim\\AppData\\Roaming\\Job Monitor',
  username: 'maksim',
};

describe('location normalization', () => {
  const cases = [
    // The load-bearing one: the Vite content hash changes on every build.
    ['app://bundle/assets/index-Ab12Cd.js:42:13', 'app:/assets/index.js:42:13'],
    ['app://bundle/assets/primer-XyZ789.js:1:1', 'app:/assets/primer.js:1:1'],
    ['file:///opt/JobMonitor/resources/app.asar/electron/main.cjs:10:5', 'asar:/electron/main.cjs:10:5'],
    ['C:\\Program Files\\Job Monitor\\resources\\app.asar\\electron\\runLog.cjs:8:1', 'asar:/electron/runLog.cjs:8:1'],
    ['node:internal/process/task_queues:95:5', 'node:internal/process/task_queues:95:5'],
    ['http://localhost:5173/src/App.tsx?t=1699:4:5', 'dev:/src/App.tsx:4:5'],
    ['/home/maksim/proj/node_modules/react-dom/cjs/react-dom.js:1:2', 'cjs/react-dom.js:1:2'],
  ];

  it.each(cases)('%s → %s', (input, expected) => {
    expect(normalizeLocation(input)).toBe(expected);
  });
});

describe('fingerprint stability', () => {
  const stackWith = (hash) =>
    [
      'TypeError: something went wrong',
      `    at FlowRunsGrid (app://bundle/assets/index-${hash}.js:42:13)`,
      `    at renderWithHooks (app://bundle/assets/react-${hash}.js:7:1)`,
    ].join('\n');

  it('is identical across releases that only changed the chunk hash', () => {
    // The single most important assertion in this file. Without the hash strip, every release
    // renumbers every fingerprint and crash grouping stops working entirely.
    const a = sanitizeStack(stackWith('Ab12Cd'), LINUX);
    const b = sanitizeStack(stackWith('Zz99Yy'), LINUX);

    expect(a.text).toBe(b.text);
    expect(fingerprint('TypeError', a.frames)).toBe(fingerprint('TypeError', b.frames));
  });

  it('differs when the crash is genuinely elsewhere', () => {
    const a = sanitizeStack(stackWith('Ab12Cd'), LINUX);
    const b = sanitizeStack(
      ['TypeError: x', '    at FailuresView (app://bundle/assets/index-Ab12Cd.js:9:1)'].join('\n'),
      LINUX,
    );
    expect(fingerprint('TypeError', a.frames)).not.toBe(fingerprint('TypeError', b.frames));
  });

  it('differs when the exception type differs', () => {
    const { frames } = sanitizeStack(stackWith('Ab12Cd'), LINUX);
    expect(fingerprint('TypeError', frames)).not.toBe(fingerprint('RangeError', frames));
  });

  it('ignores frames below the fingerprint depth', () => {
    // Deep frames vary with how the code was reached and would split one bug across many
    // fingerprints.
    const base = ['at A (app:/a.js:1:1)', 'at B (app:/b.js:1:1)', 'at C (app:/c.js:1:1)'];
    const deep = [...base, 'at D (app:/d.js:1:1)', 'at E (app:/e.js:1:1)'];
    const deeper = [...base, 'at D (app:/d.js:1:1)', 'at E (app:/e.js:1:1)', 'at F (app:/f.js:1:1)'];
    expect(fingerprint('Error', deep)).toBe(fingerprint('Error', deeper));
  });
});

describe('nothing identifying survives', () => {
  const platforms = [
    ['linux', LINUX],
    ['macOS', MACOS],
    ['windows', WINDOWS],
  ];

  /** Things that must never appear in output, and a stack that embeds each one. */
  const secrets = (ctx) => [
    ['home directory', ctx.home],
    ['user data directory', ctx.userData],
    ['username', ctx.username],
    ['classic PAT', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['fine-grained PAT', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF'],
    ['email', 'someone@devexpress.com'],
    ['session hex', 'a3f5c9d20e1b47a8f6c3d5e7b9a1c2d4'],
  ];

  describe.each(platforms)('%s', (_name, ctx) => {
    it.each(secrets(ctx))('removes the %s', (_label, secret) => {
      const stack = [
        `Error: failed near ${secret}`,
        `    at doThing (${ctx.home}/proj/src/thing.ts:1:1)`,
        `    at other (${secret}:2:2)`,
        `    at third (${ctx.userData}/cache/${secret}.json:3:3)`,
      ].join('\n');

      const { text } = sanitizeStack(stack, ctx);
      expect(text).not.toContain(secret);
    });

    it('removes a secret regardless of case or path separator', () => {
      // Windows paths arrive in both separator conventions and either case.
      const weird = [
        'Error: x',
        `    at a (${ctx.home.toUpperCase()}/proj/a.js:1:1)`,
        `    at b (${ctx.home.replace(/\//g, '\\')}\\proj\\b.js:2:2)`,
      ].join('\n');

      const { text } = sanitizeStack(weird, ctx);
      expect(text.toLowerCase()).not.toContain(ctx.username.toLowerCase());
    });
  });

  it('never keeps the message line', () => {
    // Line 0 of a V8 stack is `Type: message`, and the message is where a path or token is most
    // likely to appear. It is dropped unconditionally rather than sanitized.
    const stack = [
      'Error: could not open /home/maksim/Documents/quarterly-results.pdf',
      '    at open (app://bundle/assets/index-Ab12Cd.js:1:1)',
    ].join('\n');

    const { text } = sanitizeStack(stack, LINUX);
    expect(text).not.toContain('quarterly-results');
    expect(text).not.toContain('could not open');
    expect(text).toBe('at open (app:/assets/index.js:1:1)');
  });

  it('strips arguments and stray text from a function name', () => {
    const stack = [
      'Error: x',
      '    at fetchRepo("DevExpress/private-repo") (app://bundle/assets/index-Ab12Cd.js:1:1)',
    ].join('\n');

    const { text } = sanitizeStack(stack, LINUX);
    expect(text).not.toContain('private-repo');
    expect(text).not.toContain('DevExpress');
  });

  it('redacts inside arbitrary text, not only in parsed frames', () => {
    expect(redactAbsolutes('opening /home/maksim/secret.txt', LINUX)).not.toContain('maksim');
    expect(redactAbsolutes('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', LINUX)).toContain(
      '<token>',
    );
  });
});

describe('bounds', () => {
  it('keeps at most 12 frames', () => {
    const stack = [
      'Error: x',
      ...Array.from({ length: 50 }, (_, i) => `    at fn${i} (app:/a.js:${i}:1)`),
    ].join('\n');
    expect(sanitizeStack(stack, LINUX).frames).toHaveLength(12);
  });

  it('caps the serialized trace and never leaves a partial line', () => {
    const stack = [
      'Error: x',
      ...Array.from({ length: 12 }, (_, i) => `    at ${'f'.repeat(500)}${i} (app:/a.js:${i}:1)`),
    ].join('\n');

    const { text } = sanitizeStack(stack, LINUX);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    // Every retained line is a whole frame.
    for (const line of text.split('\n').filter(Boolean)) {
      expect(line.startsWith('at ')).toBe(true);
    }
  });

  it('handles an empty or missing stack without throwing', () => {
    // Renderer crashes routinely arrive with no stack at all.
    expect(sanitizeStack(undefined, LINUX)).toEqual({ frames: [], text: '' });
    expect(sanitizeStack('', LINUX)).toEqual({ frames: [], text: '' });
    expect(sanitizeStack('Error: no frames at all', LINUX).frames).toEqual([]);
  });
});

describe('component stack', () => {
  it('reduces to bare component names', () => {
    const raw = [
      '    in FlowRunsGrid (created by FlowsView)',
      '    in div (created by Box)',
      '    in FlowsView (at /home/maksim/proj/src/App.tsx:42)',
    ].join('\n');

    expect(sanitizeComponentStack(raw, LINUX)).toBe('FlowRunsGrid < div < FlowsView');
  });

  it('drops the file annotation dev builds add', () => {
    const raw = '    in FlowsView (at /home/maksim/proj/src/components/FlowsView.tsx:42)';
    expect(sanitizeComponentStack(raw, LINUX)).not.toContain('maksim');
    expect(sanitizeComponentStack(raw, LINUX)).toBe('FlowsView');
  });

  it('returns empty for nothing', () => {
    expect(sanitizeComponentStack(undefined, LINUX)).toBe('');
  });
});

describe('exception type', () => {
  it('accepts real class names', () => {
    for (const name of ['TypeError', 'GitHubApiError', 'DOMException', 'Foo.BarError', '$Weird']) {
      expect(sanitizeExceptionType(name)).toBe(name);
    }
  });

  it('rejects anything that is not class-name shaped', () => {
    // `error.name` is writable, so it is user-controllable in exactly the way one of the wire
    // format's five string fields must not be.
    for (const bad of [
      'could not open /home/maksim/file.pdf',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'https://github.com/DevExpress/private',
      '',
      undefined,
      null,
      123,
      'x'.repeat(200),
    ]) {
      expect(sanitizeExceptionType(bad)).toBe('UnknownError');
    }
  });
});

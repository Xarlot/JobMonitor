import { describe, expect, it } from 'vitest';
import { initRunLog, logEvent, runLogPath } from '../../electron/runLog.cjs';
import {
  claudeVariants,
  createStreamParser,
  describeExit,
  installSkill,
  MAX_REPLY_BYTES,
  TASK_TABLES,
} from '../../electron/claudeBridge.cjs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Read from the project root: under vitest's transform `import.meta.url` isn't a file URL.
const BRIDGE_SOURCE = readFileSync('electron/claudeBridge.cjs', 'utf8');

/** Flag value following `flag` in an argv array, or null. */
function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

describe('per-task budget tables', () => {
  /**
   * Every table is indexed by task name and read without a guard, so a task missing from
   * one of them fails in a way nobody would trace back to a missing key: an undefined
   * timeout reaches `setTimeout(kill, undefined)`, which fires immediately, and the run is
   * reported as "claude timed out after NaNs" having been SIGKILLed on spawn. A missing
   * turn limit is quieter still — `--max-turns undefined` as a literal string.
   */
  it('has an entry for every task in every table', () => {
    const tables = Object.entries(TASK_TABLES);
    const tasks = Object.keys(TASK_TABLES.CLAUDE_MODEL);
    expect(tasks).toContain('pr');
    for (const [name, table] of tables) {
      for (const task of tasks) {
        expect(table[task], `${name} is missing an entry for "${task}"`).toBeDefined();
      }
      // And nothing extra: a table with a task the others don't have is the same bug
      // seen from the other side.
      expect(Object.keys(table).sort()).toEqual([...tasks].sort());
    }
  });

  /**
   * The pull-request write-up summarises material the renderer already fetched. Giving it
   * tools would hand a model shell access to describe a commit list it can already read.
   */
  it('gives the pull-request task one turn and no tools', () => {
    expect(TASK_TABLES.USES_TOOLS.pr).toBe(false);
    expect(TASK_TABLES.MAX_TURNS_BY_TASK.pr).toBe(1);
    expect(claudeVariants('pr')[0].args).not.toContain('--allowedTools');
  });
});

describe('claudeVariants', () => {
  /**
   * The whole reason there are two buttons: a quick read is a single-turn summary of a
   * log we already have, and a deep read goes and investigates. Running both on the
   * same model would make the split pointless — and this is exactly the mapping that
   * quietly disappears when someone refactors the argv builder.
   */
  it('runs the quick read on Sonnet at medium effort', () => {
    const [first] = claudeVariants('quick');
    expect(valueOf(first.args, '--model')).toBe('sonnet');
    expect(valueOf(first.args, '--effort')).toBe('medium');
  });

  it('runs the deep read on Opus at high effort', () => {
    const [first] = claudeVariants('deep');
    expect(valueOf(first.args, '--model')).toBe('opus');
    expect(valueOf(first.args, '--effort')).toBe('high');
  });

  it('keeps the model on every variant that has one, at the task’s own value', () => {
    for (const [task, expected] of [
      ['quick', 'sonnet'],
      ['deep', 'opus'],
      ['log', 'sonnet'],
    ]) {
      for (const v of claudeVariants(task)) {
        const model = valueOf(v.args, '--model');
        if (model !== null) expect(model).toBe(expected);
      }
    }
  });

  /** Only the quick pass may skip tools; the deep pass exists to use them. */
  /**
   * Only the deep pass investigates. Handing tools to a task that is meant to work from
   * the log in front of it invites it to wander off and spend the budget elsewhere.
   */
  it('gives only the deep read a tool allowlist', () => {
    expect(valueOf(claudeVariants('deep')[0].args, '--allowedTools')).toBeTruthy();
    expect(valueOf(claudeVariants('quick')[0].args, '--allowedTools')).toBeNull();
    expect(valueOf(claudeVariants('log')[0].args, '--allowedTools')).toBeNull();
  });

  it('caps the single-turn tasks at one turn', () => {
    expect(valueOf(claudeVariants('quick')[0].args, '--max-turns')).toBe('1');
    expect(valueOf(claudeVariants('log')[0].args, '--max-turns')).toBe('1');
    expect(Number(valueOf(claudeVariants('deep')[0].args, '--max-turns'))).toBeGreaterThan(1);
  });

  /**
   * The rewrite is a transformation, not reasoning: Sonnet at low. Benchmarked — low passed
   * every structural check and was the fastest of the settings tried, and high effort on a
   * one-turn task cost 50% more time for the same answer.
   */
  it('runs the log rewrite on Sonnet at low effort', () => {
    const [first] = claudeVariants('log');
    expect(valueOf(first.args, '--model')).toBe('sonnet');
    expect(valueOf(first.args, '--effort')).toBe('low');
  });

  /**
   * The pairing is the whole reason four tasks exist. Investigating needs the stronger
   * model; the two single-turn tasks do not, and paying for Opus there would buy latency
   * rather than quality.
   */
  it('gives the investigating tasks Opus and the single-turn tasks Sonnet', () => {
    for (const task of ['deep', 'blame']) {
      expect(valueOf(claudeVariants(task)[0].args, '--model')).toBe('opus');
    }
    for (const task of ['quick', 'log']) {
      expect(valueOf(claudeVariants(task)[0].args, '--model')).toBe('sonnet');
    }
  });

  /** Haiku was measured slower than Sonnet *and* wrong on the quick read; never a default. */
  it('never defaults any task to haiku', () => {
    for (const task of ['quick', 'deep', 'log', 'blame']) {
      expect(valueOf(claudeVariants(task)[0].args, '--model')).not.toBe('haiku');
    }
  });

  /** High effort is reserved for the one task that reasons across heterogeneous evidence. */
  it('spends high effort only on the deep analysis', () => {
    expect(valueOf(claudeVariants('deep')[0].args, '--effort')).toBe('high');
    for (const task of ['quick', 'log', 'blame']) {
      expect(valueOf(claudeVariants(task)[0].args, '--effort')).not.toBe('high');
    }
  });

  /**
   * Each fallback must be reachable by *removing* flags, never by adding one: a CLI
   * that rejected a flag will reject it again, so a non-subset retry would just fail
   * the same way and burn the remaining attempts.
   */
  it('makes each variant a strict subset of the one before it', () => {
    for (const task of ['quick', 'deep', 'log']) {
      const variants = claudeVariants(task);
      for (let i = 1; i < variants.length; i += 1) {
        const previous = new Set(variants[i - 1].args);
        for (const arg of variants[i].args) expect(previous.has(arg)).toBe(true);
      }
    }
  });

  /**
   * The effort intent has to survive a CLI that predates --effort, otherwise the
   * fallback silently downgrades a deep analysis to default thinking.
   */
  it('expresses effort through MAX_THINKING_TOKENS once --effort is dropped', () => {
    const [, fallback] = claudeVariants('deep');
    expect(fallback.args).not.toContain('--effort');
    expect(Number(fallback.env.MAX_THINKING_TOKENS)).toBeGreaterThan(0);
    const [, quickFallback] = claudeVariants('quick');
    expect(Number(quickFallback.env.MAX_THINKING_TOKENS)).toBeLessThan(
      Number(fallback.env.MAX_THINKING_TOKENS),
    );
  });

  /** A variant without tools must not let the answer read as if it had investigated. */
  it('marks every toolless variant as tools-unavailable', () => {
    for (const v of claudeVariants('deep')) {
      if (valueOf(v.args, '--allowedTools') === null) expect(v.toolsUnavailable).toBe(true);
    }
  });

  it('ends with a bare -p that any CLI understands', () => {
    const last = claudeVariants('deep').at(-1);
    expect(last.args).toEqual(['-p']);
    expect(last.streaming).toBe(false);
  });
});

/**
 * The refusal path is guarded by source assertions rather than by running `analyze`,
 * which needs a live IPC sender and real child processes. Coarse, but it pins the two
 * decisions that were actually wrong in the field.
 */
describe('empty-log handling', () => {
  /**
   * The bug: a check run whose details link isn't an Actions job has no job log to fetch,
   * so the quick pass refused outright — even though the annotations naming the failing
   * tests were already in the prompt and are what a quick read summarises.
   */
  it('only refuses an empty log when the prompt carries no evidence', () => {
    expect(BRIDGE_SOURCE).toContain('if (!logText && !evidenceInPrompt) {');
  });

  it('reports the no-log case as its own source rather than claiming the app log', () => {
    expect(BRIDGE_SOURCE).toMatch(/logText \? 'app' : 'none'/);
  });

  /** Renderer input is re-validated in the main process; a new field is no exception. */
  it('reads evidenceInPrompt from the payload with a safe default', () => {
    expect(BRIDGE_SOURCE).toMatch(/evidenceInPrompt = false/);
  });
});

describe('createStreamParser', () => {
  /** Collect what the parser emits, in order. */
  function collect() {
    const events = [];
    const parser = createStreamParser((phase, detail) => events.push({ phase, ...detail }));
    return { parser, events };
  }

  function assistant(text) {
    return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
  }

  /**
   * The bug: each assistant text block is a whole message from one turn, and they were
   * concatenated bare. "…for this run." followed by "Root cause is upstream:…" arrived as
   * "…for this run.Root cause is upstream:…" — unreadable, and beyond rescue by a sentence
   * splitter afterwards, because there is no space left for it to find.
   */
  it('separates consecutive text blocks with a newline', () => {
    const { parser, events } = collect();
    parser.push(assistant("I'll start by pulling the real logs."));
    parser.push(assistant('Root cause is upstream: two jobs failed.'));

    const streamed = events
      .filter((e) => typeof e.chunk === 'string')
      .map((e) => e.chunk)
      .join('');
    expect(streamed).toBe(
      "I'll start by pulling the real logs.\nRoot cause is upstream: two jobs failed.",
    );
    expect(streamed).not.toMatch(/logs\.Root/);
  });

  it('gives the same separation to the accumulated final answer', () => {
    const { parser } = collect();
    parser.push(assistant('First.'));
    parser.push(assistant('Second.'));
    expect(parser.finish()).toBe('First.\nSecond.');
  });

  /** No leading newline before the very first block. */
  it('does not prefix the first block', () => {
    const { parser, events } = collect();
    parser.push(assistant('Only one.'));
    expect(events.find((e) => e.chunk)?.chunk).toBe('Only one.');
  });

  /** A block split across two pushes is still one block, not two. */
  it('handles an NDJSON line arriving in pieces', () => {
    const { parser } = collect();
    const line = assistant('Split across pushes.');
    parser.push(line.slice(0, 20));
    parser.push(line.slice(20));
    expect(parser.finish()).toBe('Split across pushes.');
  });

  it('reports tool calls as activity, not as written text', () => {
    const { parser, events } = collect();
    parser.push(
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh run view 1' } }] },
      })}\n`,
    );
    expect(events.some((e) => typeof e.activity === 'string')).toBe(true);
    expect(events.some((e) => typeof e.chunk === 'string')).toBe(false);
  });

  /** The result event is authoritative; deltas are only for the live view. */
  it('prefers the final result event over the accumulated deltas', () => {
    const { parser } = collect();
    parser.push(assistant('draft'));
    parser.push(`${JSON.stringify({ type: 'result', result: 'final answer' })}\n`);
    expect(parser.finish()).toBe('final answer');
  });

  it('survives a non-JSON line without losing the run', () => {
    const { parser } = collect();
    parser.push('Warning: something\n');
    parser.push(assistant('still here'));
    expect(parser.finish()).toBe('still here');
  });
});

describe('model and effort overrides', () => {
  /**
   * Settings reach here through IPC, so they are re-checked rather than trusted. An
   * unrecognised value either wastes a whole run or silently drops to the CLI default —
   * both worse than the task's own known-good pairing.
   */
  it('accepts a model and effort from the allowed set', () => {
    const [first] = claudeVariants('quick', { model: 'haiku', effort: 'low' });
    expect(valueOf(first.args, '--model')).toBe('haiku');
    expect(valueOf(first.args, '--effort')).toBe('low');
  });

  it('falls back to the task default for a model outside the set', () => {
    const [first] = claudeVariants('deep', { model: 'gpt-4', effort: 'high' });
    expect(valueOf(first.args, '--model')).toBe('opus');
  });

  it('falls back to the task default for an unknown effort', () => {
    const [first] = claudeVariants('deep', { model: 'opus', effort: 'ludicrous' });
    expect(valueOf(first.args, '--effort')).toBe('high');
  });

  it('ignores non-string junk', () => {
    const [first] = claudeVariants('quick', { model: { toString: () => 'opus' }, effort: 7 });
    expect(valueOf(first.args, '--model')).toBe('sonnet');
    expect(valueOf(first.args, '--effort')).toBe('medium');
  });

  it('keeps the task defaults when nothing is passed', () => {
    const [first] = claudeVariants('deep');
    expect(valueOf(first.args, '--model')).toBe('opus');
    expect(valueOf(first.args, '--effort')).toBe('high');
  });

  /** The override has to survive into the fallback variants too, not just the first. */
  it('carries an overridden model through every variant that has one', () => {
    for (const v of claudeVariants('deep', { model: 'haiku' })) {
      const model = valueOf(v.args, '--model');
      if (model !== null) expect(model).toBe('haiku');
    }
  });
});

describe('installSkill', () => {
  /**
   * How the triage procedure reaches the model at all: `claude` discovers skills from
   * `.claude/skills` under its working directory, and the bridge runs each analysis in a
   * throwaway scratch directory. Get the path wrong and the skill silently never loads —
   * the analysis still returns something, just without the procedure.
   */
  it('writes the skill where the CLI looks for it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      expect(installSkill(dir)).toBe(true);
      const written = readFileSync(join(dir, '.claude', 'skills', 'failure-triage', 'SKILL.md'), 'utf8');
      expect(written).toMatch(/name: failure-triage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Best-effort: a failed install is reported, not thrown, so the run still happens. */
  it('reports a failure instead of throwing', () => {
    // A path *through* a regular file: mkdir fails with ENOTDIR, deterministically and
    // without depending on filesystem permissions.
    const dir = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      const asFile = join(dir, 'not-a-directory');
      writeFileSync(asFile, 'x');
      const result = installSkill(join(asFile, 'scratch'));
      expect(result).not.toBe(true);
      expect(typeof result).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('how a run that ends badly is reported', () => {
  function collect() {
    const events = [];
    const parser = createStreamParser((phase, detail) => events.push({ phase, ...detail }));
    return { parser, events };
  }

  /**
   * The failure this exists for. `claude` exits non-zero with **empty stderr** when it hits
   * the turn limit — the reason is only ever in the final `result` event. Without reading
   * it the bridge can report nothing but "exited with code 1", which tells nobody what to
   * change; it was reported from a real run looking exactly like that.
   */
  it('captures the reason from the result event', () => {
    const { parser } = collect();
    parser.push(
      `${JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 24 })}\n`,
    );
    expect(parser.outcome()).toEqual({ subtype: 'error_max_turns', isError: true, numTurns: 24 });
  });

  /** Nothing to report before the run ends. */
  it('has no outcome until the result arrives', () => {
    const { parser } = collect();
    parser.push(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })}\n`,
    );
    expect(parser.outcome()).toBeNull();
  });

  /**
   * An investigation that spent twenty tool calls before running out of turns has written
   * something worth keeping — discarding it throws away everything it cost.
   */
  it('keeps the text written before the limit was hit', () => {
    const { parser } = collect();
    parser.push(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '### Verdict' }] } })}\n`,
    );
    parser.push(`${JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })}\n`);
    expect(parser.finish()).toContain('### Verdict');
  });

  it('still prefers the authoritative result text on a clean finish', () => {
    const { parser } = collect();
    parser.push(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } })}\n`,
    );
    parser.push(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'final' })}\n`);
    expect(parser.finish()).toBe('final');
    expect(parser.outcome()?.isError).toBe(false);
  });

  /** Blame fetches a diff per candidate commit, so it needs far more room than the others. */
  it('gives blame a much larger turn budget than the deep pass', () => {
    const turns = (task) => Number(valueOf(claudeVariants(task)[0].args, '--max-turns'));
    expect(turns('blame')).toBeGreaterThan(turns('deep'));
    expect(turns('blame')).toBeGreaterThanOrEqual(40);
  });

  /** The bridge must keep a partial answer rather than turning it into an error. */
  it('returns a partial answer with a reason instead of failing', () => {
    expect(BRIDGE_SOURCE).toMatch(/if \(answer\.trim\(\) \|\| sessionId\) \{/);
    expect(BRIDGE_SOURCE).toContain('incompleteReason: reason');
    expect(BRIDGE_SOURCE).toMatch(/error_max_turns/);
  });
});

describe('output size limits', () => {
  /**
   * The bug behind "claude exited with code 1" with nothing else to say. One cap was
   * applied to the raw `stream-json` output, which carries every tool call *and every tool
   * result* — measured at ~126x the size of the answer inside it. A real investigation
   * blew past it, the reader stopped forwarding, and since the `result` event comes last,
   * the run's own reason for stopping was precisely what got dropped.
   */
  it('caps the raw stream far above the reply, and only for the streaming variants', () => {
    const source = readFileSync('electron/claudeBridge.cjs', 'utf8');
    expect(source).toMatch(/maxBytes: variant\.streaming \? MAX_STREAM_BYTES : MAX_REPLY_BYTES/);
    const stream = /const MAX_STREAM_BYTES = (\d+) \* 1024 \* 1024/.exec(source);
    expect(Number(stream?.[1]) * 1024 * 1024).toBeGreaterThan(MAX_REPLY_BYTES * 50);
  });

  /** The answer is still bounded — the limit just moved to where it belongs. */
  it('stops growing the answer past the reply cap', () => {
    const parser = createStreamParser(() => {});
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 8; i += 1) {
      parser.push(
        `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: chunk }] } })}\n`,
      );
    }
    expect(parser.textTruncated()).toBe(true);
    expect(parser.finish().length).toBeLessThan(MAX_REPLY_BYTES * 2);
  });

  it('does not flag truncation for an ordinary answer', () => {
    const parser = createStreamParser(() => {});
    parser.push(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'short' }] } })}\n`,
    );
    expect(parser.textTruncated()).toBe(false);
  });
});

describe('describeExit', () => {
  /**
   * Truncation has to win: when the stream was cut the `result` event never arrived, so
   * every other branch falls through to the fallback and reports the exit code — which is
   * the unhelpful message this whole change exists to remove.
   */
  it('reports truncation ahead of everything else', () => {
    expect(describeExit(null, 'claude exited with code 1', { streamTruncated: true })).toMatch(
      /too large to follow/i,
    );
    expect(
      describeExit({ subtype: 'error_max_turns', numTurns: 24 }, 'x', { streamTruncated: true }),
    ).toMatch(/too large to follow/i);
  });

  it('names the turn limit and how many it used', () => {
    expect(describeExit({ subtype: 'error_max_turns', numTurns: 24 }, 'x')).toBe(
      'it ran out of turns after 24',
    );
  });

  it('copes with a turn-limit exit that carries no count', () => {
    expect(describeExit({ subtype: 'error_max_turns' }, 'x')).toBe('it ran out of turns');
  });

  it('distinguishes an answer that outgrew the app from a truncated stream', () => {
    expect(describeExit(null, 'x', { textTruncated: true })).toMatch(/answer grew past/i);
  });

  /** Only when nothing else is known does the raw message get through. */
  it('falls back to the process error, then to saying it does not know', () => {
    expect(describeExit(null, 'claude was not found on PATH')).toBe('claude was not found on PATH');
    expect(describeExit(null, '')).toMatch(/without saying why/i);
  });
});

describe('the diagnostics log', () => {
  /** Read the file back the way a person (or a later session) would. */
  function readRecords(file) {
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function withLog(run) {
    const dir = mkdtempSync(join(tmpdir(), 'runlog-test-'));
    try {
      const file = initRunLog(dir);
      return run(file, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The whole point: a run that already happened has to be reconstructable afterwards. The
   * console cannot do that — it belongs to whoever had DevTools open at the time, which for
   * the failures that matter is nobody.
   */
  it('writes one parseable JSON object per line', () => {
    withLog((file) => {
      logEvent('claude', 'spawn: claude -p', { requestId: 'r1', attempt: 1 });
      logEvent('claude', 'tool: $ gh run list', { requestId: 'r1', n: 1 });

      const records = readRecords(file);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ scope: 'claude', message: 'spawn: claude -p' });
      expect(records[0].detail).toEqual({ requestId: 'r1', attempt: 1 });
    });
  });

  /** A timestamp on every line is what makes two runs separable after the fact. */
  it('timestamps every record', () => {
    withLog((file) => {
      logEvent('app', 'started');
      expect(Number.isNaN(Date.parse(readRecords(file)[0].at))).toBe(false);
    });
  });

  /**
   * A record whose detail cannot serialise must still arrive, and must keep the same shape
   * as the rest — a reader that has to handle two shapes breaks on the line it most wanted.
   */
  it('survives an unserialisable detail without losing the line', () => {
    withLog((file) => {
      const cyclic = {};
      cyclic.self = cyclic;
      expect(() => logEvent('app', 'cyclic', cyclic)).not.toThrow();

      const [record] = readRecords(file);
      expect(record.message).toBe('cyclic');
      expect(typeof record.detail).toBe('object');
    });
  });

  it('reports the file it is writing to, so the UI can show it', () => {
    withLog((file) => {
      expect(runLogPath()).toBe(file);
      expect(file.endsWith('.ndjson')).toBe(true);
    });
  });

  /** Bounded on disk: diagnostics must not become the largest thing the app owns. */
  it('rotates once the file passes its cap', () => {
    withLog((file) => {
      writeFileSync(file, 'x'.repeat(6 * 1024 * 1024));
      initRunLog(join(file, '..'));
      logEvent('app', 'after rotate');

      expect(existsSync(`${file}.1`)).toBe(true);
      const records = readRecords(file);
      expect(records.at(-1).message).toBe('after rotate');
      // The rotated-away bulk is gone from the live file.
      expect(readFileSync(file, 'utf8').length).toBeLessThan(1024);
    });
  });
});

describe('resuming an unfinished run', () => {
  /**
   * The case this exists for: a blame run on a large repository spent twenty minutes and
   * thirty tool calls, found the cause, and was killed by the wall clock before it could
   * write the answer. Starting again pays for all of that a second time.
   */
  it('passes the session id to --resume', () => {
    const args = claudeVariants('blame', {
      resumeSessionId: 'ef755100-1727-4261-b6e3-c37d8bffbbf1',
    })[0].args;
    expect(valueOf(args, '--resume')).toBe('ef755100-1727-4261-b6e3-c37d8bffbbf1');
  });

  it('adds no resume flag to an ordinary run', () => {
    expect(claudeVariants('blame')[0].args).not.toContain('--resume');
  });

  /**
   * A fallback must not silently restart a run that was being continued. Only the true
   * last resort — bare `-p`, the one thing every CLI version accepts — drops it.
   */
  it('keeps the session across the fallback variants', () => {
    const id = `${'a'.repeat(8)}-1234-1234-1234-123456789012`;
    const variants = claudeVariants('deep', { resumeSessionId: id });
    for (const v of variants.slice(0, -1)) expect(v.args).toContain('--resume');
    expect(variants.at(-1).args).toEqual(['-p']);
  });

  /** It becomes a command-line argument, so it is shape-checked like everything else. */
  it('rejects a session id that is not a uuid', () => {
    expect(BRIDGE_SOURCE).toMatch(/\[0-9a-fA-F-\]\{36\}/);
    expect(BRIDGE_SOURCE).toContain("error: 'Invalid session id.'");
  });

  /**
   * `claude --resume` finds a session by the directory it ran in — verified against the
   * real CLI, where resuming from a different cwd reports "No conversation found". So the
   * scratch directory has to be derived from the analysis, not from mkdtemp, and has to
   * survive a run that left something to continue.
   */
  it('uses a scratch directory derived from the analysis, and keeps it when resumable', () => {
    expect(BRIDGE_SOURCE).toMatch(/scratchKey\(owner, repo, runId, depth\)/);
    expect(BRIDGE_SOURCE).toMatch(/keepScratch = resumable && Boolean\(sessionId\)/);
    // The removal lives in runClaudeTask, which owns the directory it was given.
    expect(BRIDGE_SOURCE).toMatch(/if \(!keepScratch\) \{\s*try \{\s*fs\.rmSync\(scratchDir/);
  });

  /**
   * Keeping the directory is only useful to a caller that can find it again. `compose`
   * builds a random path and never accepts a session id, so an unfinished one would leave a
   * temp directory nothing can reach — or sweep, since the sweep is "the next run of the
   * same analysis" and there is no same-ness to a uuid.
   */
  it('only keeps the directory for a caller that can resume into it', () => {
    const composeBody = /async function compose\(sender, payload\) \{[\s\S]*?\n\}/.exec(
      BRIDGE_SOURCE,
    )?.[0];
    expect(composeBody).toBeTruthy();
    expect(composeBody).toMatch(/resumable: false/);
    expect(composeBody).toMatch(/job-monitor-compose-\$\{crypto\.randomUUID\(\)\}/);
    // And analyze, whose path *is* derivable, keeps the default.
    const analyzeBody = /async function analyze\(sender, payload\) \{[\s\S]*?\n\}/.exec(
      BRIDGE_SOURCE,
    )?.[0];
    expect(analyzeBody).not.toMatch(/resumable:/);
  });

  /** Two attempts at the same analysis must land in the same place. */
  it('derives the same directory for the same analysis and different ones otherwise', () => {
    const key = /function scratchKey\(([^)]*)\)/.exec(BRIDGE_SOURCE);
    expect(key?.[1]).toBe('owner, repo, runId, depth');
  });
});

'use strict';

/**
 * Desktop-only bridge to the developer's local `gh` and `claude` CLIs.
 *
 * Used to triage a failed CI job: `gh` fetches the full failed-step log (far more
 * than the browser's log tail), `claude` turns it into a problem statement and a
 * suggested fix. Both must already be installed and authenticated by the user — this
 * never handles credentials, and deliberately does not pass the app's GitHub token to
 * `gh`, which has its own auth.
 *
 * Security posture, since this runs commands on the user's machine on behalf of the
 * renderer:
 *  - `execFile`/`spawn` with an argv array and no shell, so nothing in an argument can
 *    ever be interpreted as a command.
 *  - Every value the renderer supplies is re-validated *here* against a strict
 *    pattern; the renderer is treated as untrusted regardless of it being our own code.
 *  - Fixed argv shapes. The renderer chooses *data*, never flags or executables.
 *  - Timeouts and output caps on everything, so a hung or runaway CLI can't wedge the
 *    app or exhaust memory.
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { failureTriageSkill, flowBlameSkill } = require('./skills.cjs');
const { logEvent } = require('./runLog.cjs');

/**
 * Skills installed for each task.
 *
 * Per-task rather than all-of-them: a skill the model cannot use is a distraction it has to
 * read past, and the two answer different questions from different evidence — triage looks
 * inside one run, blame reads a branch's run history.
 */
const SKILLS_BY_TASK = {
  deep: [failureTriageSkill],
  blame: [flowBlameSkill],
};
const path = require('node:path');
const crypto = require('node:crypto');

/** Owner/repo segments as GitHub allows them. */
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const PROBE_TIMEOUT_MS = 5_000;
/**
 * `gh run view --log-failed` on a large repository is a blob-storage download of a whole
 * run's failed steps, which is minutes of work rather than seconds. A minute was starving
 * it — and a log that never arrives costs the entire analysis, not just the fetch.
 */
const GH_TIMEOUT_MS = 20 * 60_000;
/**
 * Longer than a single completion because the run is agentic: it greps a log, may
 * download and unzip artifacts, and reads a few files before answering.
 */
const CLAUDE_TIMEOUT_MS = 25 * 60_000;
/** Bounds an agentic run's cost and duration. */
const CLAUDE_MAX_TURNS = 24;

/**
 * The quick pass is time-boxed for real, not just asked to hurry: no tools, one turn,
 * and a hard timeout a little over the minute the prompt promises, so it cannot quietly
 * turn into a three-minute investigation.
 */
const QUICK_TIMEOUT_MS = 90_000;
const QUICK_MAX_TURNS = 1;

/**
 * Model and reasoning effort per depth.
 *
 * The quick read is a single-turn summary of a log that has already been fetched —
 * Sonnet at medium effort answers it in seconds, which is the point. The deep read
 * fetches artifacts, reads the workflow and reasons across them, so it gets Opus at
 * high effort. Aliases rather than pinned ids, so the CLI resolves whatever its
 * current Sonnet/Opus is instead of us hardcoding a model that gets retired.
 */
/**
 * Model and effort per task, chosen by measurement rather than by feel.
 *
 * Benchmarked on a realistic failing log, same prompt, one turn each:
 *
 * | task  | setting        | time  | outcome                                   |
 * |-------|----------------|-------|-------------------------------------------|
 * | quick | sonnet/low     | 7.0s  | named the test and quoted the assertion   |
 * | quick | sonnet/medium  | 7.3s  | same                                      |
 * | quick | sonnet/high    | 10.9s | same, 50% slower for nothing              |
 * | quick | haiku/medium   | 10.1s | **missed the test name**, and slower      |
 * | log   | sonnet/low     | 7.8s  | verbatim text, fences, headings, restraint|
 * | log   | sonnet/medium  | 8.4s  | same                                      |
 * | log   | haiku/low      | 8.8s  | same, but slower than Sonnet              |
 *
 * What that settles:
 *
 * - **Haiku is not the cheap option here.** It was slower than Sonnet on both tasks and got
 *   the quick read wrong. It is not offered as a default for either.
 * - **High effort buys nothing on a one-turn task** — 50% slower, same answer.
 * - **`log` drops to low.** It is a transformation with objectively checkable output, and
 *   low passed every structural check while being the fastest.
 * - **`quick` stays at medium.** Measurement could not separate low from medium on a clean
 *   log, and the 0.3s difference is noise — but the task turns on a judgement (which line is
 *   decisive; code or infrastructure) that only gets hard on messy logs, which is exactly
 *   what a single sample cannot test. Medium is the conservative side of a free choice.
 *
 * The two investigating tasks are not benchmarkable this way — they run for minutes against
 * a live repository — so they are set from what the real runs show. `deep` reasons across
 * heterogeneous evidence and gets Opus at high. `blame` weighs many small facts and has to
 * calibrate a likelihood, which Opus at medium has done well in practice; raising it would
 * slow a task that already strains its wall clock.
 */
const CLAUDE_MODEL = { quick: 'sonnet', deep: 'opus', log: 'sonnet', blame: 'opus', pr: 'sonnet' };
const CLAUDE_EFFORT = {
  quick: 'medium',
  deep: 'high',
  log: 'low',
  blame: 'medium',
  pr: 'medium',
};

/**
 * What a renderer-supplied model/effort may be.
 *
 * Closed lists, checked here rather than trusted from settings. These values become
 * `--model` and `--effort` arguments; `shell: false` means there is no injection to worry
 * about, but an unrecognised value either wastes a whole run or silently drops to the CLI
 * default, and both are worse than falling back to the task's own known-good pairing.
 */
const ALLOWED_MODELS = new Set(['sonnet', 'opus', 'haiku']);
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/**
 * Per-task budgets. `log` is a mechanical rewrite of a large input, so it wants a long
 * output and time to produce it, but no more reasoning than Sonnet at medium gives.
 */
/**
 * Per-task wall clock.
 *
 * Raised after a real blame run on a large repository was killed at ten minutes having
 * already found the cause — thirty-odd tool calls deep, each a network round trip. A
 * timeout that stops a run mid-answer costs the whole run, so these are generous; the
 * budget that actually protects against a runaway is the turn limit, which is bounded and
 * cheap to reason about.
 */
const TIMEOUT_BY_TASK = {
  quick: QUICK_TIMEOUT_MS,
  log: 5 * 60_000,
  deep: CLAUDE_TIMEOUT_MS,
  blame: 40 * 60_000,
  // Summarising a commit list that is already in the prompt. If this is still going after
  // ninety seconds something is wrong, and the caller has a template to fall back on.
  pr: 90_000,
};
const MAX_TURNS_BY_TASK = {
  quick: QUICK_MAX_TURNS,
  log: 1,
  deep: CLAUDE_MAX_TURNS,
  // Blame fetches the run list, then a diff per candidate commit, then often the flake
  // evidence across several branches — each its own turn. 24 ran out on a real repo before
  // it could finish, which is a wasted Opus run rather than a slow one.
  blame: 48,
  pr: 1,
};
/** The two investigating tasks get tools; the rest work from what they are handed. */
const USES_TOOLS = { quick: false, log: false, deep: true, blame: true, pr: false };

/** Thinking budgets used only as the fallback when --effort isn't understood. */
const THINKING_TOKENS = { medium: '10000', high: '31999' };

/**
 * The argv variants to try, most capable first. Each is a strict subset of its
 * predecessor, so a CLI that rejects a flag still gets everything below it.
 *
 * `--effort` is newer than the rest; when it isn't recognised the same intent is
 * expressed through `MAX_THINKING_TOKENS`, which older CLIs do read. (An unrecognised
 * effort *value* only warns and falls back to the default, so only a missing flag needs
 * handling here.) `--model` is dropped last, since losing it means the depth stops
 * meaning anything.
 */
/**
 * Write the triage skill where the CLI will find it: `.claude/skills/<name>/SKILL.md`
 * under the run's working directory.
 *
 * Returns `true`, or the reason it failed. Best-effort by design — the brief still carries
 * the contract and the facts, so a failed install means a less methodical analysis rather
 * than none.
 */
/**
 * A short, stable directory name for one failure's analyses.
 *
 * Not the requestId, which is new on every call — the point is that a second attempt at the
 * *same* analysis lands in the same directory and can therefore resume.
 */
function scratchKey(owner, repo, runId, depth) {
  return crypto
    .createHash('sha1')
    .update(`${owner}/${repo}/${runId}/${depth}`)
    .digest('hex')
    .slice(0, 16);
}

function installSkill(scratchDir, skill = failureTriageSkill) {
  try {
    const dir = path.join(scratchDir, '.claude', 'skills', skill.SKILL_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.SKILL_MARKDOWN, 'utf8');
    return true;
  } catch (e) {
    return e.message;
  }
}

function claudeVariants(task, overrides = {}) {
  const modelName = ALLOWED_MODELS.has(overrides.model) ? overrides.model : CLAUDE_MODEL[task];
  const effort = ALLOWED_EFFORTS.has(overrides.effort) ? overrides.effort : CLAUDE_EFFORT[task];
  const model = ['--model', modelName];
  // Resuming carries the whole prior conversation, so the run picks up with everything it
  // had already established rather than paying for it again.
  const resume = overrides.resumeSessionId ? ['--resume', String(overrides.resumeSessionId)] : [];
  const stream = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--max-turns',
    String(MAX_TURNS_BY_TASK[task]),
    // A task that doesn't investigate gets no tool allowlist at all, so there is nothing
    // for it to wander into — a stronger guarantee than passing an empty one.
    ...(USES_TOOLS[task] ? ['--allowedTools', ALLOWED_TOOLS] : []),
    ...resume,
  ];
  return [
    { args: [...stream, ...model, '--effort', effort], streaming: true },
    {
      args: [...stream, ...model],
      streaming: true,
      env: { MAX_THINKING_TOKENS: THINKING_TOKENS[effort] },
    },
    // Tools and streaming are gone by here, so say so: the dialog tells the user the
    // answer wasn't investigated rather than letting it read as if it had been. The resume
    // stays on, though — dropping it would silently restart a run that was being continued,
    // which is the opposite of what a fallback should do.
    { args: ['-p', ...model, ...resume], streaming: false, toolsUnavailable: true },
    // True last resort: only what every version of the CLI has ever accepted.
    { args: ['-p'], streaming: false, toolsUnavailable: true },
  ];
}

/**
 * What `claude` is allowed to do, and nothing more.
 *
 * Read-only by construction: file reads and searches inside its own scratch directory,
 * plus the handful of commands needed to pull evidence out of GitHub. `Bash` is scoped
 * per command rather than granted wholesale — the alternative is handing a model
 * unrestricted shell on the developer's machine, which no amount of prompt wording
 * makes acceptable. Note there is no `Write`, `Edit`, `git push`, or bare `Bash`.
 */
const ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(gh run view:*)',
  // Blame reads run *history*, not one run — without this the skill's very first command
  // is denied and it falls back to guessing.
  'Bash(gh run list:*)',
  'Bash(gh run download:*)',
  'Bash(gh api:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
  'Bash(unzip:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(base64:*)',
  // The triage procedure ships as a skill (see failureTriageSkill.cjs), so invoking one
  // has to be allowed — without this the model can see it and not use it.
  'Skill',
].join(',');
/** Plenty for a failed-step log; anything larger is noise we'd trim off anyway. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_REPLY_BYTES = 256 * 1024;
/**
 * Ceiling on the raw `stream-json` output, which is a different quantity entirely.
 *
 * The NDJSON stream carries every tool call **and every tool result** — a `gh api compare`
 * or a downloaded artifact listing is echoed into it whole. A real investigation blows past
 * 256KB of stream long before its *answer* gets anywhere near that, and the old shared cap
 * silently stopped feeding the parser at that point. The `result` event arrives last, so
 * the run's own reason for stopping was exactly what got dropped — leaving nothing to
 * report but "exited with code 1".
 *
 * The answer is still capped, in the parser, where the limit belongs.
 */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

/**
 * Children of in-flight requests, so the renderer can cancel one. Keyed by the
 * request id it supplied; a long `claude` call with no way out is a bad experience,
 * and a killed child is exactly what "Stop" has to mean.
 */
const running = new Map();

function run(command, args, options = {}) {
  const { timeoutMs, maxBytes, stdin, onChunk, register, env } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (e) {
      resolve({ ok: false, error: `${command} could not be started: ${e.message}` });
      return;
    }
    if (register) register(child);

    let out = '';
    let err = '';
    let truncated = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `${command} timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (out.length >= maxBytes) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf8');
      out += text;
      if (onChunk) onChunk(text, out.length);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 8192) err += chunk.toString('utf8');
    });

    child.on('error', (e) => {
      // ENOENT here is the common case: the CLI isn't installed or isn't on PATH.
      finish({
        ok: false,
        error: e.code === 'ENOENT' ? `${command} was not found on PATH` : e.message,
      });
    });

    child.on('close', (code, signal) => {
      if (code === 0) finish({ ok: true, stdout: out, truncated });
      else if (signal) finish({ ok: false, cancelled: true, error: `${command} was stopped` });
      else {
        finish({
          ok: false,
          truncated,
          error: err.trim() || `${command} exited with code ${code}`,
        });
      }
    });

    if (stdin !== undefined) {
      child.stdin.on('error', () => {
        /* the child may exit before we finish writing; the close handler reports it */
      });
      child.stdin.end(stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/** Is a CLI present? Resolves to its version line, or null. */
function version(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, shell: false, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim().split('\n')[0] ?? ''),
    );
  });
}

/**
 * What's available locally. The renderer uses this to decide whether to offer the
 * feature at all, so it reports each piece separately — "claude is there but gh isn't
 * signed in" is a different message from "neither is installed".
 */
async function probe() {
  const [ghVersion, claudeVersion] = await Promise.all([
    version('gh', ['--version']),
    version('claude', ['--version']),
  ]);
  let ghAuthenticated = false;
  if (ghVersion) {
    // `gh auth status` exits non-zero when not logged in, which is the whole signal.
    const status = await run('gh', ['auth', 'status'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 16 * 1024,
    });
    ghAuthenticated = status.ok;
  }
  return {
    gh: Boolean(ghVersion),
    ghVersion,
    ghAuthenticated,
    claude: Boolean(claudeVersion),
    claudeVersion,
  };
}

/**
 * Fetch the failed-step log for a run, then hand it plus the caller's prompt to
 * `claude` and return its reply.
 *
 * The prompt arrives on stdin rather than as an argument: it embeds a log that can run
 * to tens of kilobytes, which would risk the platform's argument-length limit.
 */
async function analyze(sender, payload) {
  const {
    owner,
    repo,
    runId,
    prompt,
    requestId,
    fallbackLog = '',
    depth = 'deep',
    evidenceInPrompt = false,
    model,
    effort,
    resumeSessionId,
  } = payload ?? {};

  // Re-validated here, not trusted from the renderer.
  if (!NAME_RE.test(String(owner ?? '')) || !NAME_RE.test(String(repo ?? ''))) {
    return { ok: false, error: 'Invalid repository.' };
  }
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return { ok: false, error: 'Invalid run id.' };
  }
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 500_000) {
    return { ok: false, error: 'Invalid prompt.' };
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(requestId)) {
    return { ok: false, error: 'Invalid request id.' };
  }
  if (typeof fallbackLog !== 'string' || fallbackLog.length > 500_000) {
    return { ok: false, error: 'Invalid fallback log.' };
  }
  if (depth !== 'quick' && depth !== 'deep' && depth !== 'log' && depth !== 'blame') {
    return { ok: false, error: 'Invalid depth.' };
  }
  // A session id becomes a command-line argument, so it is shape-checked like everything
  // else that crosses this boundary.
  if (resumeSessionId !== undefined && !/^[0-9a-fA-F-]{36}$/.test(String(resumeSessionId))) {
    return { ok: false, error: 'Invalid session id.' };
  }

  // Phase events, so the dialog can show where the time is going rather than an
  // undifferentiated spinner. Guarded: the window may close mid-request.
  const emit = (phase, detail = {}) => {
    try {
      if (!sender.isDestroyed()) sender.send('claude:progress', { requestId, phase, ...detail });
    } catch {
      /* window gone */
    }
  };

  // Diagnostics for the renderer's DevTools console. Separate from `emit` because these
  // are for whoever is debugging, not for the dialog: exact argv, exit codes, stderr.
  // Without them, everything the main process does is visible only in the terminal that
  // launched the app — which nobody has when the interesting run already happened.
  const log = (message, detail) => {
    // Two destinations on purpose: the console for whoever is watching now, the file for
    // whoever reads it afterwards — which is nearly always when it matters.
    logEvent('claude', message, { requestId, depth, ...(detail ?? {}) });
    try {
      if (!sender.isDestroyed()) sender.send('claude:log', { requestId, message, detail });
    } catch {
      /* window gone */
    }
  };
  const track = (child) => {
    const existing = running.get(requestId);
    running.set(requestId, existing ? [...existing, child] : [child]);
  };

  try {
    // Only the deep pass calls gh; the others work from the log the renderer supplies,
    // because spending 10–20 seconds downloading a whole run's log would eat the budget
    // they are meant to fit inside.
    const usesGh = USES_TOOLS[depth];
    log(`analyze: depth=${depth} ${owner}/${repo} run=${runId}`, {
      promptChars: prompt.length,
      fallbackLogChars: fallbackLog.length,
      evidenceInPrompt,
    });
    emit('fetching-log');
    const ghLog = usesGh
      ? await fetchLog({ owner, repo, runId, track, emit })
      : { ok: false, error: `skipped for the ${depth} pass` };
    if (ghLog.cancelled) return { ok: false, cancelled: true, error: 'Stopped.' };

    // Fall back to the log the app itself fetched through the GitHub API. `gh` gives
    // the whole run's failed steps and is preferred, but it is not worth failing the
    // feature over when a perfectly good per-job log is already in hand.
    const logText = ghLog.ok && ghLog.stdout.trim() ? ghLog.stdout : fallbackLog;
    const source = ghLog.ok && ghLog.stdout.trim() ? 'gh' : logText ? 'app' : 'none';
    log(`log source: ${source} (${logText.length} chars)`, {
      ghOk: ghLog.ok,
      ghError: ghLog.error,
      truncated: Boolean(ghLog.truncated),
    });

    // An empty log is only fatal when the prompt has nothing else to go on. The
    // annotations it may already carry name the failing tests with file, line and
    // message — enough for a summary, and the only evidence available at all for a check
    // run that isn't a plain Actions job and therefore has no job log to fetch.
    if (!logText && !evidenceInPrompt) {
      // The quick pass never ran gh, so `ghLog.error` is its own "skipped" marker rather
      // than a real failure — reporting it would blame gh for something it wasn't asked
      // to do. Point at what the user can actually act on instead.
      if (!usesGh) {
        return {
          ok: false,
          error:
            'The job’s log couldn’t be read, so there is nothing to work from. Try Deep analysis, which fetches the log itself.',
        };
      }
      return {
        ok: false,
        error: ghLog.ok
          ? 'No log was available for this run.'
          : `Could not read the log. ${ghLog.error}`,
      };
    }

    // The caller's prompt ends with a log placeholder line; append the log.
    const full = `${prompt}\n${logText}`;
    emit('analysing', {
      logBytes: logText.length,
      logTruncated: Boolean(ghLog.truncated),
      logSource: source,
    });

    // A scratch directory to be the run's cwd, so anything it downloads (artifact
    // zips, extracted reports) lands somewhere disposable rather than in the user's
    // files.
    // Stable per failure and task, not random. `claude --resume` looks a session up by the
    // directory it ran in, so a resumed run must land in the same place — a fresh mkdtemp
    // would make every session unreachable the moment it was needed.
    const scratch = path.join(
      os.tmpdir(),
      `job-monitor-triage-${scratchKey(owner, repo, runId, depth)}`,
    );

    // The caller's prompt ends with a log placeholder line; the log was appended above.
    const outcome = await runClaudeTask({
      task: depth,
      prompt: full,
      requestId,
      scratchDir: scratch,
      model,
      effort,
      resumeSessionId,
      emit,
      log,
      track,
    });

    if (!outcome.ok) return outcome;
    return {
      ok: true,
      reply: outcome.answer,
      logTruncated: Boolean(ghLog.truncated),
      logSource: source,
      incompleteReason: outcome.incompleteReason,
      sessionId: outcome.sessionId,
    };
  } finally {
    running.delete(requestId);
  }
}

/**
 * Spawn `claude` for one task and return what it wrote.
 *
 * The half of a request that has nothing to do with what is being asked: the scratch
 * directory, the skills, the stream parser, the flag-fallback ladder, and the reading of
 * an early exit. Extracted when a second kind of request appeared — a hand-rolled second
 * spawn path would have quietly lost the fallback ladder (so an older CLI would fail
 * instead of degrading), the cancellation registry, and the diagnostics that are the only
 * record of what the CLI actually did.
 *
 * Answers `{ ok: true, answer }` or `{ ok: false, error }`; it never throws, because it is
 * called from IPC handlers that must not.
 */
async function runClaudeTask({
  task,
  prompt,
  requestId,
  scratchDir,
  model,
  effort,
  resumeSessionId,
  /**
   * Whether an unfinished run's directory is worth keeping so `--resume` can find it.
   *
   * Only true for a caller that can actually resume: `claude --resume` looks a session up
   * by the directory it ran in, so keeping one is useful precisely when the directory is
   * *derivable again* from the request. A caller whose scratch path is random has no way
   * back to it, and keeping it would leak a temp directory per unfinished run.
   */
  resumable = true,
  emit,
  log,
  track,
}) {
  /** Set when the run leaves a resumable session behind that this caller can return to. */
  let keepScratch = false;
  try {
    fs.mkdirSync(scratchDir, { recursive: true });

    // `claude` discovers skills from `.claude/skills` under its working directory, and the
    // scratch dir is that directory — so writing it here is how the procedure reaches the
    // model. Only the investigating tasks can use one: the rest have one turn and no tools.
    //
    // Best-effort. If this fails the brief still carries the contract and the facts, so
    // the analysis degrades to a less methodical one rather than failing outright.
    for (const skill of SKILLS_BY_TASK[task] ?? []) {
      const installed = installSkill(scratchDir, skill);
      if (installed !== true) log(`could not install the ${skill.SKILL_NAME} skill: ${installed}`);
    }

    let toolCallCount = 0;
    const parser = createStreamParser((phase, detail) => {
      if (detail && typeof detail.activity === 'string') {
        toolCallCount += 1;
        logEvent('claude', `tool: ${detail.activity}`, { requestId, depth: task, n: toolCallCount });
      }
      emit(phase, detail);
    });
    const baseOptions = {
      timeoutMs: TIMEOUT_BY_TASK[task],
      // Set per variant below: the streaming ones are distilled by the parser, so the raw
      // cap is only a memory guard; for a plain `-p` run stdout *is* the reply.
      maxBytes: MAX_REPLY_BYTES,
      stdin: prompt,
      register: track,
      cwd: scratchDir,
    };

    // Each variant is a strict subset of the one before it, and a rejected flag fails
    // in milliseconds, so walking down the list costs almost nothing. The point is that
    // a CLI too old for one flag still gets the model — matching the depth to the model
    // is the whole reason the two buttons exist.
    let reply = null;
    let answer = '';
    let attempt = 0;
    for (const variant of claudeVariants(task, { model, effort, resumeSessionId })) {
      attempt += 1;
      if (variant.toolsUnavailable) emit('analysing', { toolsUnavailable: true });
      log(`spawn: claude ${variant.args.join(' ')}`, { env: variant.env, attempt });
      const startedAt = Date.now();
      reply = await run('claude', variant.args, {
        ...baseOptions,
        maxBytes: variant.streaming ? MAX_STREAM_BYTES : MAX_REPLY_BYTES,
        env: variant.env,
        onChunk: variant.streaming
          ? (text) => parser.push(text)
          : (text) => emit('analysing', { chunk: text }),
      });
      answer = variant.streaming ? parser.finish() : reply.ok ? reply.stdout : '';
      // The post-mortem set. Every question asked of a failed run so far has been one of
      // these: how long, how big, how did it end, and how many turns did it get through.
      log(`claude ${reply.ok ? 'ok' : 'failed'}: ${answer.length} chars of answer`, {
        ms: Date.now() - startedAt,
        answerChars: answer.length,
        streamTruncated: Boolean(reply.truncated),
        answerTruncated: variant.streaming ? parser.textTruncated() : false,
        outcome: variant.streaming ? parser.outcome() : null,
        toolCalls: toolCallCount,
        error: reply.error,
        cancelled: reply.cancelled,
      });
      if (reply.ok || reply.cancelled || !looksLikeBadFlag(reply.error)) break;
      log(`retrying without the flag it rejected: ${reply.error}`);
    }

    if (!reply.ok) {
      if (reply.cancelled) return { ok: false, cancelled: true, error: 'Stopped.' };

      const reason = describeExit(parser.outcome(), reply.error, {
        streamTruncated: Boolean(reply.truncated),
        textTruncated: parser.textTruncated(),
      });

      // Keep what it managed to write. An investigation that spent twenty tool calls and
      // produced a partial verdict before hitting the turn limit is worth far more than an
      // error message — throwing it away also throws away everything it cost.
      const sessionId = parser.sessionId();
      keepScratch = resumable && Boolean(sessionId);
      if (answer.trim() || sessionId) {
        log(`claude ended early (${reason}) with ${answer.length} chars`, {
          sessionId: Boolean(sessionId),
          keptScratch: keepScratch,
        });
        return {
          ok: true,
          answer,
          incompleteReason: reason,
          // Only handed back to a caller that can use it: resuming needs the directory the
          // run happened in, and that is gone for everyone else.
          sessionId: resumable ? (sessionId ?? undefined) : undefined,
        };
      }
      return { ok: false, error: `claude: ${reason}` };
    }

    emit('done');
    return { ok: true, answer: answer || reply.stdout };
  } finally {
    // Kept when the run ended with something to continue from: deleting it would throw
    // away the session along with the directory, turning "continue" into "start again".
    // Swept on the next completed run of the same failure, and by the OS in any case.
    if (!keepScratch) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing over */
      }
    }
  }
}

/**
 * A human reason for a non-zero exit.
 *
 * The stream's `result` event is the authority; `stderr` is usually empty for the failures
 * that matter, and "exited with code 1" tells nobody what to change.
 */
function describeExit(outcome, fallback, flags = {}) {
  // Truncation is checked first: when the stream was cut short the `result` event never
  // arrived, so `outcome` is null and every other branch would report the useless
  // fallback rather than the thing that actually happened.
  if (flags.streamTruncated) return 'its output grew too large to follow to the end';
  if (flags.textTruncated) return 'its answer grew past the size this app will hold';
  switch (outcome?.subtype) {
    case 'error_max_turns':
      // `num_turns` is what it used, not the ceiling, so it is reported as such.
      return outcome.numTurns
        ? `it ran out of turns after ${outcome.numTurns}`
        : 'it ran out of turns';
    case 'error_during_execution':
      return 'it hit an error partway through';
    default:
      return fallback || 'it exited without saying why';
  }
}

/** One-line label for a tool call, for the activity feed. */
function describeToolUse(block) {
  const input = block.input ?? {};
  const clip = (text, max = 120) =>
    String(text ?? '').length > max ? `${String(text).slice(0, max)}…` : String(text ?? '');
  switch (block.name) {
    case 'Bash':
      return `$ ${clip(input.command)}`;
    case 'Read':
      return `read ${clip(input.file_path, 80)}`;
    case 'Grep':
      return `grep ${clip(input.pattern, 60)}${input.path ? ` in ${clip(input.path, 40)}` : ''}`;
    case 'Glob':
      return `glob ${clip(input.pattern, 60)}`;
    default:
      return clip(block.name, 40);
  }
}

/**
 * Consume the CLI's `stream-json` output.
 *
 * An agentic run produces nothing on stdout until the very end in `text` mode, which
 * would leave the dialog blank for minutes. The NDJSON stream instead reports each
 * assistant message and tool call as it happens, so the window can show what Claude is
 * doing and what it is writing. Returns the final answer text.
 */
function createStreamParser(emit) {
  let buffer = '';
  let text = '';
  /** The final `result` event, which is the only place a failure reason appears. */
  let outcome = null;
  let textTruncated = false;
  /** The CLI's session id, which is what `--resume` takes. Present on every event. */
  let sessionId = null;

  const handle = (event) => {
    if (typeof event.session_id === 'string' && event.session_id) sessionId = event.session_id;
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text && text.length < MAX_REPLY_BYTES) {
          // Blocks must not fuse. Each one is a complete message from a single turn, so
          // with no separator "…for this run." and "Root cause is upstream:…" arrive as
          // "…for this run.Root cause is upstream:…" — unreadable, and not even splittable
          // afterwards, since there is no space for a sentence splitter to find.
          //
          // Safe *here* only because these are whole blocks. The non-streaming fallback
          // emits raw stdout, which splits at arbitrary byte boundaries, and inserting
          // newlines there would break words.
          const piece = text ? `\n${block.text}` : block.text;
          text += piece;
          if (text.length >= MAX_REPLY_BYTES) textTruncated = true;
          emit('analysing', { chunk: piece });
        } else if (block.type === 'tool_use') {
          emit('analysing', { activity: describeToolUse(block) });
        }
      }
    } else if (event.type === 'result') {
      // Authoritative final text; prefer it over the accumulated deltas.
      if (typeof event.result === 'string' && event.result.trim()) text = event.result;
      outcome = {
        subtype: event.subtype ?? null,
        isError: Boolean(event.is_error),
        numTurns: typeof event.num_turns === 'number' ? event.num_turns : null,
      };
    }
  };

  return {
    /**
     * Why the run ended, when it ended badly.
     *
     * `claude` exits non-zero with **empty stderr** when it hits the turn limit — the
     * reason is only ever in this event. Without reading it the bridge could report
     * nothing but "exited with code 1", which says nothing about what to change.
     */
    outcome() {
      return outcome;
    },
    /** True when the answer itself outgrew {@link MAX_REPLY_BYTES}. */
    textTruncated() {
      return textTruncated;
    },
    /** What to hand `--resume` to pick this conversation up where it stopped. */
    sessionId() {
      return sessionId;
    },
    push(part) {
      buffer += part;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handle(JSON.parse(trimmed));
        } catch {
          // A non-JSON line (a warning, say) is not worth aborting the run over.
        }
      }
    },
    finish() {
      if (buffer.trim()) {
        try {
          handle(JSON.parse(buffer.trim()));
        } catch {
          /* ignore a trailing partial line */
        }
      }
      return text;
    },
  };
}

/** Heuristic: did the CLI reject our flags rather than fail at the task? */
function looksLikeBadFlag(error) {
  return /unknown option|unrecognized|unknown argument|invalid option|--allowedTools|--max-turns|--model|--effort/i.test(
    String(error ?? ''),
  );
}

/**
 * Read the run's failed-step log with `gh`, working around a failure mode of the tool
 * itself.
 *
 * `gh run view --log-failed` aborts on larger logs with
 * `stream error: stream ID 1; CANCEL; received from peer` — Go's HTTP/2 client giving
 * up on the log download. `GODEBUG=http2client=0` drops `gh` to HTTP/1.1, which is the
 * documented way out; the retry covers the case where it is simply flaky.
 *
 * Returns `{ ok: false }` rather than throwing, because the caller has a usable
 * fallback and this is not fatal.
 */
/**
 * The whole run's failed-step log, for the viewer rather than for a model.
 *
 * Two logs exist and they are not the same thing: the app can fetch **one job's** log
 * through the GitHub API (fast, no `gh` needed, and already cached for any failure whose
 * report has been opened), while `gh run view --log-failed` returns **every failed step of
 * the run** — which is what you need when the job you are looking at is an aggregator and
 * the real failure is upstream. Neither replaces the other, so both are offered.
 *
 * Exposed separately from `analyze` so the viewer can show it without spending a model
 * call, and so a slow download blocks nothing else.
 */
async function runLog(payload) {
  const { owner, repo, runId } = payload ?? {};
  if (!NAME_RE.test(String(owner ?? '')) || !NAME_RE.test(String(repo ?? ''))) {
    return { ok: false, error: 'Invalid repository.' };
  }
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return { ok: false, error: 'Invalid run id.' };
  }

  const result = await fetchLog({ owner, repo, runId, track: null, emit: () => {} });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, text: result.stdout, truncated: Boolean(result.truncated) };
}

async function fetchLog({ owner, repo, runId, track, emit }) {
  const args = ['run', 'view', String(runId), '--log-failed', '--repo', `${owner}/${repo}`];
  const options = {
    timeoutMs: GH_TIMEOUT_MS,
    maxBytes: MAX_LOG_BYTES,
    register: track,
    onChunk: (_text, total) => emit('fetching-log', { bytes: total }),
  };

  // First attempt over HTTP/1.1: the stream error is common enough on real logs that
  // paying for a doomed HTTP/2 attempt first would just add latency.
  let result = await run('gh', args, { ...options, env: { GODEBUG: 'http2client=0' } });
  if (result.ok || result.cancelled) return result;

  emit('fetching-log', { retrying: true, bytes: 0 });
  result = await run('gh', args, { ...options, env: { GODEBUG: 'http2client=0' } });
  return result;
}

/**
 * Write a pull request's title and description from material the renderer supplies.
 *
 * A separate channel rather than another `depth` on {@link analyze}, because analyze is
 * built around a workflow run: it requires a positive run id, fetches a log, refuses when
 * there isn't one, and appends that log to the prompt. None of that applies to summarising
 * a commit list, and faking a run id to get past it would also poison the scratch key that
 * `--resume` depends on.
 *
 * No tools, one turn, and a fresh empty working directory — the model is summarising text
 * it was handed, so it needs neither the network nor the filesystem, and starting it
 * somewhere empty keeps it from picking up a CLAUDE.md belonging to some real project.
 */
async function compose(sender, payload) {
  const { prompt, requestId, task = 'pr', model, effort } = payload ?? {};

  // Re-validated here, not trusted from the renderer.
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 500_000) {
    return { ok: false, error: 'Invalid prompt.' };
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(requestId)) {
    return { ok: false, error: 'Invalid request id.' };
  }
  // A closed set, checked rather than trusted: `task` indexes the per-task budget tables,
  // and an unrecognised key would read `undefined` out of all of them — which reaches
  // `setTimeout(kill, undefined)` and kills the child the instant it spawns.
  if (task !== 'pr') return { ok: false, error: 'Invalid task.' };

  const emit = (phase, detail = {}) => {
    try {
      if (!sender.isDestroyed()) sender.send('claude:progress', { requestId, phase, ...detail });
    } catch {
      /* window gone */
    }
  };
  const log = (message, detail) => {
    logEvent('claude', message, { requestId, depth: task, ...(detail ?? {}) });
    try {
      if (!sender.isDestroyed()) sender.send('claude:log', { requestId, message, detail });
    } catch {
      /* window gone */
    }
  };
  const track = (child) => {
    const existing = running.get(requestId);
    running.set(requestId, existing ? [...existing, child] : [child]);
  };

  // Random, unlike the analysis scratch key: there is no session to resume, so nothing
  // needs to find this directory again, and two composes in flight must not share one.
  const scratchDir = path.join(os.tmpdir(), `job-monitor-compose-${crypto.randomUUID()}`);

  try {
    log(`compose: task=${task}`, { promptChars: prompt.length });
    emit('analysing', { logBytes: 0 });
    const outcome = await runClaudeTask({
      task,
      prompt,
      requestId,
      scratchDir,
      model,
      effort,
      // Deliberately absent: a one-shot composition has nothing to continue, and not
      // accepting a session id removes an argv surface entirely.
      resumeSessionId: undefined,
      // And so the scratch directory is always removed. Keeping one is only useful when
      // `--resume` could find it again, and the path above is random by design — every
      // early-exiting compose would otherwise leave a directory nothing can reach or sweep.
      resumable: false,
      emit,
      log,
      track,
    });
    if (!outcome.ok) return outcome;
    return { ok: true, reply: outcome.answer, incompleteReason: outcome.incompleteReason };
  } finally {
    running.delete(requestId);
  }
}

/** Kill whatever is still running for a request. */
function cancel(requestId) {
  const children = running.get(requestId);
  if (!children) return false;
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  running.delete(requestId);
  return true;
}

function registerClaudeIpc(ipcMain) {
  ipcMain.handle('claude:probe', () => probe());
  ipcMain.handle('claude:runLog', (_e, payload) => runLog(payload));
  ipcMain.handle('claude:analyze', (e, payload) => analyze(e.sender, payload));
  ipcMain.handle('claude:compose', (e, payload) => compose(e.sender, payload));
  ipcMain.handle('claude:cancel', (_e, requestId) =>
    typeof requestId === 'string' ? cancel(requestId) : false,
  );
}

// claudeVariants is exported for the unit test: the model-per-depth mapping is the
// kind of thing that silently regresses into "everything runs on the default model".
// claudeVariants and createStreamParser are exported for the unit tests: the
// model-per-depth mapping and the block separation both regress silently.
module.exports = {
  registerClaudeIpc,
  claudeVariants,
  createStreamParser,
  installSkill,
  describeExit,
  SKILLS_BY_TASK,
  MAX_REPLY_BYTES,
  // The per-task budget tables, exported so a test can assert every task appears in every
  // one of them. A missing entry fails in a way nobody would diagnose from the symptom:
  // an undefined timeout reaches `setTimeout(kill, undefined)` and kills the child on
  // spawn, reported as "claude timed out after NaNs".
  TASK_TABLES: { CLAUDE_MODEL, CLAUDE_EFFORT, TIMEOUT_BY_TASK, MAX_TURNS_BY_TASK, USES_TOOLS },
};

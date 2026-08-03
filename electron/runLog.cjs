/**
 * A durable, machine-readable record of what the app did.
 *
 * **Why a file and not the console.** The DevTools console is fine while you are watching,
 * but the interesting run is always the one that already happened — and by then the console
 * is gone, or belongs to a packaged build nobody had open. Every diagnosis in this project
 * so far has needed the same things after the fact: the exact argv, how big the stream got,
 * which tool calls ran, and how the process ended. Those now land on disk.
 *
 * **NDJSON, one object per line.** Greppable with plain tools, parseable without a reader,
 * and append-only so a crash mid-write costs one line rather than the file. Every record
 * carries `at`, `scope` and — for anything belonging to an analysis — the `requestId`, so a
 * whole run can be reconstructed with a single filter.
 *
 * **Written synchronously.** A buffered stream loses whatever had not flushed when the
 * process dies, and the lines just before a crash are precisely the ones worth having. The
 * cost is a handful of small appends per analysis, which is nothing against that.
 *
 * **What is deliberately not written.** No GitHub token (it never reaches this process),
 * and no log *contents* — only sizes. A CI log can hold anything a build printed, and a
 * diagnostics file that quietly accumulates it is a liability, not an aid.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Two files of 5MB: enough to cover several days of use, bounded on disk. */
const MAX_BYTES = 5 * 1024 * 1024;

let logDir = null;
let logPath = null;
/** Never let logging break the thing it is logging — one warning, then stay quiet. */
let disabled = false;

/**
 * @param {string} dir Directory to write into; created if missing.
 */
function initRunLog(dir) {
  logDir = dir;
  logPath = path.join(dir, 'job-monitor.ndjson');
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded();
    disabled = false;
  } catch {
    disabled = true;
  }
  return logPath;
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(logPath).size < MAX_BYTES) return;
  } catch {
    return; // no file yet
  }
  try {
    // One generation back. Keeping more would mean deciding which to delete under the same
    // cap; one previous file has been enough to cover "it happened a moment ago".
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* a failed rotate must not stop logging */
  }
}

/** Absolute path of the current log file, for the UI to show. */
function runLogPath() {
  return logPath;
}

function runLogDir() {
  return logDir;
}

/**
 * Append one record.
 *
 * @param {string} scope Coarse area — `claude`, `gh`, `renderer`, `app`.
 * @param {string} message Short human sentence; the detail goes in `detail`.
 * @param {object} [detail] Anything JSON-serialisable. Keep it to facts, not log text.
 */
function logEvent(scope, message, detail) {
  if (disabled || !logPath) return;
  try {
    const record = { at: new Date().toISOString(), scope, message };
    if (detail !== undefined) record.detail = detail;
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // A value that won't serialise (a cycle, a BigInt) must not take the run down with it.
    // `detail` stays an object here: a reader that has to handle two shapes for the same
    // field is a reader that breaks on the line it most wanted to see.
    try {
      fs.appendFileSync(
        logPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          scope,
          message,
          detail: { unserialisable: true },
        })}\n`,
      );
    } catch {
      // The directory went away, or the disk is full. Stop trying rather than throwing on
      // every subsequent call.
      disabled = true;
    }
  }
}

module.exports = { initRunLog, logEvent, runLogPath, runLogDir };

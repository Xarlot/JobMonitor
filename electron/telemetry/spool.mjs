/**
 * The local telemetry queue: bounded, durable, priority-ordered NDJSON.
 *
 * **Why not SQLite, which the architecture called for.** The real volume is one record per 15
 * minutes at roughly 1.2 KB — about 800 KB across the full 7-day window. At that size SQLite's
 * advantages are all inapplicable: indexed lookup, when the only query is "everything, oldest
 * first"; multi-writer transactions, when there is one writer; partial reads of a large table, when
 * the table is under a megabyte. What it *would* cost is real — `node:sqlite` is a Stability-1.1
 * API sitting underneath a durable file that has to stay readable across auto-update restarts, and
 * `better-sqlite3` would turn a currently rebuild-free three-OS packaging matrix into a native
 * toolchain problem. The architecture's *policy* — bounded, 7 days, priority eviction, crashes
 * survive — is what mattered, and none of it needed a database.
 *
 * The format and the mechanics follow `electron/runLog.cjs`, which solved the same problem for the
 * diagnostics log: NDJSON so a reader needs no library and a mid-write crash costs one line rather
 * than the file; synchronous appends because the records written just before a crash are precisely
 * the ones worth having; and a `disabled` latch so that logging can never break the thing it logs.
 *
 * Three files rather than one, split by priority. A single file would mean either scanning it to
 * find crash records or evicting them in arrival order — and "a flood of ordinary usage pushes out
 * the crash report" is the one outcome this queue exists to prevent.
 */

import fs from 'node:fs';
import path from 'node:path';

import { now } from './clock.mjs';

/** Priority names, highest first. Also the file names and the send order. */
export const PRIORITIES = ['crash', 'failure', 'usage'];

const DEFAULT_CAPS = { crash: 1024 * 1024, failure: 1024 * 1024, usage: 2 * 1024 * 1024 };
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CRASH_FLOOR = 20;

/** Record format version. Bumped only if the *envelope* changes, not the body. */
const RECORD_VERSION = 1;

export function createSpool(options) {
  const {
    dir,
    caps = DEFAULT_CAPS,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    crashFloor = DEFAULT_CRASH_FLOOR,
    onWarn = () => {},
  } = options;

  /** One warning, then stay quiet — a broken spool must never become a broken app. */
  let disabled = false;

  /**
   * Records evicted since the last successful send. Carried in the next batch so that a gap in the
   * server-side data arrives as a number rather than as silence — "we dropped 340 records" is a
   * fact you can act on; a chart that reads low for unknown reasons is not.
   */
  let dropped = 0;

  const fileFor = (priority) => path.join(dir, `${priority}.ndjson`);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    disabled = true;
    onWarn('spool: could not create directory', { message: String(err?.message ?? err) });
  }

  /** Parse a file into records, discarding lines that do not parse. */
  function read(priority) {
    if (disabled) return [];
    let text;
    try {
      text = fs.readFileSync(fileFor(priority), 'utf8');
    } catch {
      return []; // no file yet is the normal first-run case, not an error
    }
    const records = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        // A record from a future version degrades to "skip this one" rather than "reject the
        // file" — the same forward-compatibility discipline src/lib/diagnosticsLog.ts uses.
        if (record && typeof record.at === 'number' && record.v === RECORD_VERSION) {
          records.push(record);
        }
      } catch {
        // A torn final line from a crash mid-append. Expected, not exceptional.
      }
    }
    return records;
  }

  function write(priority, records) {
    if (disabled) return;
    const body = records.map((r) => JSON.stringify(r)).join('\n');
    const file = fileFor(priority);
    const tmp = `${file}.tmp`;
    try {
      // Write-then-rename. A rename is atomic on all three platforms, so a crash during compaction
      // leaves either the old file or the new one — never a half-written queue.
      fs.writeFileSync(tmp, body ? `${body}\n` : '');
      fs.renameSync(tmp, file);
    } catch (err) {
      disabled = true;
      onWarn('spool: write failed', { message: String(err?.message ?? err) });
    }
  }

  /**
   * Apply retention. Age first, across every priority, then per-file size caps.
   *
   * Returns the number of records removed so the caller can account for them.
   */
  function evict() {
    let removed = 0;
    const cutoff = now() - maxAgeMs;

    for (const priority of PRIORITIES) {
      const records = read(priority);
      if (records.length === 0) continue;

      // 1. Age. The cap that actually binds in practice.
      let kept = records.filter((r) => r.at >= cutoff);
      removed += records.length - kept.length;

      // 2. Size. Drop from the head — oldest first — until the file fits.
      const cap = caps[priority];
      while (kept.length > 0 && Buffer.byteLength(serialize(kept)) > cap) {
        // Crashes get a floor. Below it, stop evicting and accept the file is over its cap: the
        // alternative is that a burst of crashes silently deletes the evidence of the earlier
        // crashes that probably caused it.
        if (priority === 'crash' && kept.length <= crashFloor) break;
        kept.shift();
        removed++;
      }

      if (kept.length !== records.length) write(priority, kept);
    }

    dropped += removed;
    return removed;
  }

  function serialize(records) {
    return records.map((r) => JSON.stringify(r)).join('\n');
  }

  return {
    /**
     * Append one record.
     *
     * Synchronous by design — see the module header. The cost is a few small appends per hour,
     * which is nothing against losing the last thing that happened before a crash.
     */
    append(priority, kind, body) {
      if (disabled) return false;
      if (!PRIORITIES.includes(priority)) throw new Error(`spool: unknown priority ${priority}`);

      const record = { v: RECORD_VERSION, p: PRIORITIES.indexOf(priority), at: now(), kind, body };
      try {
        fs.appendFileSync(fileFor(priority), `${JSON.stringify(record)}\n`);
      } catch (err) {
        disabled = true;
        onWarn('spool: append failed', { message: String(err?.message ?? err) });
        return false;
      }

      // Enforce caps after the write rather than before it. Checking first would mean the record
      // that overflows the cap is the one thrown away, which is backwards: the newest record is the
      // most valuable, and during an incident it is the only one anybody wants.
      const size = statSize(fileFor(priority));
      if (size > caps[priority]) evict();
      return true;
    },

    /** Every record, in send order: crashes first, then failures, then usage; oldest first. */
    readAll() {
      const out = [];
      for (const priority of PRIORITIES) {
        for (const record of read(priority)) out.push({ ...record, priority });
      }
      return out;
    },

    /**
     * Remove records that have been durably accepted elsewhere.
     *
     * Keyed on the record's own identity rather than a count, because a concurrent append between
     * the read and the ack would otherwise silently delete a record that was never sent.
     */
    ack(records) {
      const byPriority = new Map(PRIORITIES.map((p) => [p, new Set()]));
      for (const r of records) byPriority.get(r.priority)?.add(`${r.at}:${r.kind}`);

      for (const priority of PRIORITIES) {
        const acked = byPriority.get(priority);
        if (!acked || acked.size === 0) continue;
        const kept = read(priority).filter((r) => !acked.has(`${r.at}:${r.kind}`));
        write(priority, kept);
      }
    },

    evict,

    /** Records evicted since the last `clearDropped`. Rides along in the next batch. */
    droppedCount() {
      return dropped;
    },

    clearDropped() {
      dropped = 0;
    },

    /** Sizes on disk, for the Diagnostics pane. */
    stats() {
      const perFile = {};
      for (const priority of PRIORITIES) {
        perFile[priority] = { bytes: statSize(fileFor(priority)), records: read(priority).length };
      }
      return { dir, disabled, dropped, files: perFile };
    },

    isDisabled() {
      return disabled;
    },
  };
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

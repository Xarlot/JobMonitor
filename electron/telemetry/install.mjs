/**
 * Installation identity, and the clean-shutdown sentinel.
 *
 * The installation id is 16 bytes of `crypto.randomBytes` and nothing else. It is deliberately not
 * derived from a username, hostname, MAC address, machine GUID, CPU serial, GitHub account or any
 * other stable property of the machine or the person — not because deriving one would be harder,
 * but because a derived id is reversible, and an id that can be traced back to a person is not
 * anonymous telemetry regardless of what the documentation says about it.
 *
 * It identifies an installation. Reinstalling produces a new one, two accounts on one machine
 * produce two, and that is the correct behaviour rather than a limitation to work around.
 */

import fs from 'node:fs';
import path from 'node:path';

import { now } from './clock.mjs';
import { randomHex } from './random.mjs';
import { ID_BYTES } from './constants.mjs';

const INSTALL_FILE = 'install.json';
const SESSION_FILE = 'session.json';
const FILE_VERSION = 1;

/**
 * Read the installation id, creating one on first run.
 *
 * Mode 0600 because there is no reason for anything but this app to read it. That is a small
 * gesture — the file sits in the user's own data directory — but it costs nothing and it makes the
 * intent legible to anyone who goes looking.
 */
export function loadInstallationId(dir, onWarn = () => {}) {
  const file = path.join(dir, INSTALL_FILE);

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.v === FILE_VERSION && /^[0-9a-f]{32}$/.test(parsed.id ?? '')) {
      return parsed.id;
    }
    onWarn('install: id file unusable, regenerating', {});
  } catch {
    // First run, or the file was removed. Both are ordinary.
  }

  const id = randomHex(ID_BYTES);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: FILE_VERSION, id, createdAt: now() }), {
      mode: 0o600,
    });
  } catch (err) {
    // A non-persistable id still works for this session; it just means the next launch looks like
    // a new installation. Better than refusing to record anything.
    onWarn('install: could not persist id', { message: String(err?.message ?? err) });
  }
  return id;
}

/**
 * Mark a session as running.
 *
 * The sentinel is the whole mechanism for detecting crashes that killed the process too fast to
 * write anything — a hard kill, an OOM, a power loss. Written at start, deleted on clean exit; if
 * it is still there at the next launch, the previous session did not end cleanly. Two file
 * operations for a class of failure that is otherwise completely invisible.
 */
export function markSessionStart(dir) {
  try {
    fs.writeFileSync(
      path.join(dir, SESSION_FILE),
      JSON.stringify({ v: FILE_VERSION, startedAt: now() }),
    );
  } catch {
    // Losing the sentinel costs one signal, never the session.
  }
}

/** Delete the sentinel. Called on the normal shutdown path. */
export function markSessionEnd(dir) {
  try {
    fs.rmSync(path.join(dir, SESSION_FILE), { force: true });
  } catch {
    /* nothing to do — the next launch will report an unclean exit, which is a false positive we
       accept over the alternative of failing the quit */
  }
}

/**
 * Consume a sentinel left behind by a previous session.
 *
 * Returns the previous session's start time if it ended uncleanly, otherwise `null`. Consuming it
 * — deleting on read — matters: leaving it would report the same unclean exit on every subsequent
 * launch forever.
 */
export function takeUncleanExit(dir) {
  const file = path.join(dir, SESSION_FILE);
  let startedAt = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.v === FILE_VERSION && typeof parsed.startedAt === 'number') {
      startedAt = parsed.startedAt;
    } else {
      startedAt = now();
    }
  } catch {
    return null; // clean exit last time, or first run
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* if it cannot be removed the next launch double-counts one unclean exit; acceptable */
  }
  return startedAt;
}

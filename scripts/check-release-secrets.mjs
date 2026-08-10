/**
 * Are the three build credentials in place, and did they reach the bundle?
 *
 * A release build with them unset **does not fail**. `assertConfigured` makes the app aggregate
 * locally and refuse to publish, which is the right behaviour for a contributor's checkout and the
 * reason there is no fallback to a shared key — but for a release it produces installers that send
 * nothing, and the only symptom is a dashboard that stays empty. That is a bad failure to discover
 * a week later, so this turns it into a failed build.
 *
 * Two modes, because "are they set" has two useful meanings:
 *
 *   --env      the three values are present in this environment (or `.env.telemetry`). Cheap, and
 *              what CI wants *before* spending ten minutes building installers.
 *   --bundle   the built `electron/telemetry.bundle.cjs` actually carries them. Stronger: it is the
 *              only check that catches the substitution itself going wrong, which the presence of
 *              an environment variable says nothing about.
 *   --remote   the secrets exist on the GitHub repository, via `gh`. Answers "did I remember to add
 *              them" without printing anything — `gh` lists names, never values.
 *
 * With no flags it runs --env and --bundle if a bundle exists.
 *
 * None of these three is confidential: all of them ship inside every installer. The one real secret
 * — the receiver's private key — belongs only on the ingest server and is deliberately not here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'electron', 'telemetry.bundle.cjs');
const ENV_FILE = join(ROOT, '.env.telemetry');

const NAMES = ['TELEMETRY_ABLY_KEY', 'TELEMETRY_RECEIVER_PUBKEY', 'TELEMETRY_DEPLOYMENT_ID'];

/** Shapes, not values. A key of the wrong shape is a paste error, and it fails at publish time. */
const SHAPE = {
  // Ably: `appId.keyId:secret`. Checked because a key pasted without its secret half looks
  // plausible and is refused only when the first batch tries to publish.
  TELEMETRY_ABLY_KEY: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+:[A-Za-z0-9+/=_-]+$/,
  TELEMETRY_RECEIVER_PUBKEY: /^[0-9a-f]{64}$/,
  TELEMETRY_DEPLOYMENT_ID: /^[0-9a-f]{32}$/,
};

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

/** The same fallback the build uses: the environment first, then `.env.telemetry`. */
function readValues() {
  const fromFile = {};
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match && NAMES.includes(match[1])) {
        fromFile[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return Object.fromEntries(NAMES.map((n) => [n, process.env[n] || fromFile[n] || '']));
}

function checkEnv(values) {
  for (const name of NAMES) {
    const value = values[name];
    if (!value) {
      fail(`${name} is empty — the build would produce installers that never publish.`);
      continue;
    }
    if (!SHAPE[name].test(value)) {
      // Length only. Printing the value would put a credential in a CI log, and the shape is the
      // part that is wrong anyway.
      fail(`${name} does not look right (${value.length} characters). Check for a partial paste.`);
    }
  }
  if (values.TELEMETRY_RECEIVER_PUBKEY && /^0+$/.test(values.TELEMETRY_RECEIVER_PUBKEY)) {
    fail('TELEMETRY_RECEIVER_PUBKEY is all zeros — that is the unset placeholder, not a key.');
  }
}

function checkBundle(values) {
  if (!existsSync(BUNDLE)) {
    fail(`${BUNDLE} is missing — run \`npm run build\` first.`);
    return;
  }
  const bundle = readFileSync(BUNDLE, 'utf8');

  /*
   * Two checks, and the second is the one that means something.
   *
   * `define` substitutes these as string *literals* at build time — nothing on a user's machine
   * will have set them — so the substitution having happened is what makes a build able to publish.
   *
   * Looked for **in quotes**, not anywhere in the file. A bare substring search passes on any value
   * that happens to occur naturally: a deployment id of 32 `f` characters is present in this bundle
   * already, as part of some unrelated constant, so that check reported success for a credential
   * that had never been substituted at all. Requiring the quotes ties the match to a string literal,
   * which is what a substitution produces.
   */
  if (/process\.env\.TELEMETRY_/.test(bundle)) {
    fail(
      'The bundle still reads process.env.TELEMETRY_* at runtime — the build-time substitution did ' +
        'not run, so the values cannot reach a user\'s machine whatever is set here.',
    );
  }
  for (const name of NAMES) {
    const value = values[name];
    if (!value) continue;
    if (!bundle.includes(`"${value}"`) && !bundle.includes(`'${value}'`)) {
      fail(`${name} is set but was not substituted into the bundle — the build did not receive it.`);
    }
  }
}

function checkRemote() {
  let listed;
  try {
    listed = execFileSync('gh', ['secret', 'list', '--json', 'name'], { encoding: 'utf8' });
  } catch {
    fail('Could not ask GitHub for the secret list. Is `gh` installed and authenticated?');
    return;
  }
  const present = new Set(JSON.parse(listed).map((s) => s.name));
  for (const name of NAMES) {
    if (!present.has(name)) fail(`${name} is not set on the repository.`);
  }
  notes.push(
    'Existence only: `gh` never returns a secret value, so this cannot tell a correct credential ' +
      'from a wrong one. `--bundle` on a real build is what checks that.',
  );
}

const args = process.argv.slice(2);
const want = (flag) => args.includes(flag);
const values = readValues();

if (want('--remote')) checkRemote();
if (want('--env') || !args.length) checkEnv(values);
if (want('--bundle') || (!args.length && existsSync(BUNDLE))) checkBundle(values);

if (!args.length && !existsSync(BUNDLE)) {
  notes.push('No bundle yet, so only the values were checked. Run `npm run build`, then re-run.');
}

for (const note of notes) console.log(`note: ${note}`);

if (failures.length > 0) {
  console.error('\nRelease credentials are not ready:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nSet TELEMETRY_ABLY_KEY, TELEMETRY_RECEIVER_PUBKEY and TELEMETRY_DEPLOYMENT_ID as\n' +
      'repository secrets (or in .env.telemetry locally). See .env.telemetry.example.\n',
  );
  process.exit(1);
}

console.log('Release credentials are in place.');

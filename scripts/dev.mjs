#!/usr/bin/env node
/**
 * One development entry point for a repository that holds three applications.
 *
 * The trap this removes: `npm run dev` used to mean the Job Monitor client at the repository root
 * and the telemetry server inside `server/telemetry-receiver`, and the root one wins wherever you
 * happen to be standing. Reaching for the server and getting Vite is a mistake everyone makes once,
 * and nothing about the output says why.
 *
 *   npm run dev                      Job Monitor client (Vite) — unchanged default
 *   npm run dev -- --server          Telemetry receiver + dashboard (Next.js)
 *   npm run dev -- --server --seed   Fill the local database with generated telemetry
 *   npm run dev -- --server --ingest Read Ably history once and print the outcome
 *   npm run dev -- --server --publish Publish a test batch through the real client code
 *   npm run dev -- --server --reset  Delete the local database
 *
 * Anything unrecognised is passed through, so `npm run dev -- --server --port 3010` works.
 */

import { spawn } from 'node:child_process';

const RECEIVER = '@jobmonitor/telemetry-receiver';

/** Server actions, in the order they are checked. Each maps to a script in the receiver package. */
const ACTIONS = [
  ['--seed', 'dev:seed', 'fill the local database with generated telemetry'],
  ['--ingest', 'dev:ingest', 'read Ably history once and print the outcome'],
  ['--publish', 'dev:publish', 'publish a test batch through the real client code'],
  ['--reset', 'dev:reset', 'delete the local database'],
];

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  usage();
  process.exit(0);
}

const server = argv.includes('--server') || argv.includes('-s');
const rest = argv.filter((a) => a !== '--server' && a !== '-s' && a !== '--client' && a !== '-c');

if (!server) {
  // The default is unchanged on purpose: `npm run dev` has meant the client for the life of this
  // repository, and quietly repurposing it would be worse than the ambiguity it replaces.
  run('npx', ['vite', ...rest]);
} else {
  const action = ACTIONS.find(([flag]) => rest.includes(flag));
  const script = action ? action[1] : 'dev';
  const passthrough = action ? [] : rest;
  run('npm', ['run', script, '-w', RECEIVER, ...(passthrough.length ? ['--', ...passthrough] : [])]);
}

function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  // Forward the signal rather than dying first, so Ctrl-C reaches Vite or Next and they clean up.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    // Preserve the child's fate: a wrapper that always exits 0 makes a failing dev server look
    // fine to anything scripting around it.
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function usage() {
  const pad = (s) => s.padEnd(34);
  console.log(`
This repository holds three applications. This chooses which one to run.

  ${pad('npm run dev')}Job Monitor client (Vite)
  ${pad('npm run dev -- --server')}Telemetry receiver + dashboard (Next.js)
`);
  for (const [flag, , description] of ACTIONS) {
    console.log(`  ${pad(`npm run dev -- --server ${flag}`)}${description}`);
  }
  console.log(`
Unrecognised arguments are passed through:

  npm run dev -- --server --port 3010
  npm run dev -- --port 5180

The desktop client is separate: npm run electron:dev
`);
}

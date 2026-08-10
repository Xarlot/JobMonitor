import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Load `.env.local` the way `next dev` does.
 *
 * Vitest does not, and these scripts read their credentials from `process.env` — so the publish
 * script skipped itself with "needs TELEMETRY_ABLY_KEY … in .env.local" while those values were
 * sitting in `.env.local`, which is a message that sends you looking in the one place you have
 * already been.
 *
 * Existing variables win, so `TELEMETRY_DB=… npm run dev:ingest` still overrides the file.
 */
function loadEnvLocal(): void {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvLocal();

/**
 * Runner for the development tools in `scripts/`.
 *
 * They are not tests and must never be collected by `npm test` — seeding a database or publishing
 * to the real Ably channel during a test run would be an unpleasant surprise. Hence a separate
 * config with its own `include`, rather than a flag on the main one.
 *
 * Vitest is used as the TypeScript runner because it is already here and resolves the workspace
 * package and extensionless imports without adding a second toolchain for the sake of three files.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.ts'],
    // These print their results; the default capture would swallow them.
    disableConsoleIntercept: true,
    // Publishing and paging through history are network-bound.
    testTimeout: 300_000,
  },
});

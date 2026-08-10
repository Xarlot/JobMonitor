import { defineConfig } from 'vitest/config';

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

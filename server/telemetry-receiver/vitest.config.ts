import { defineConfig } from 'vitest/config';

/**
 * Node only. The receiver has no browser half — the dashboard is server-rendered, so even the
 * pages run in Node.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

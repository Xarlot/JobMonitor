import { defineConfig } from 'vitest/config';

/**
 * Two projects running the same suite.
 *
 * The client encrypts in Electron's main process and the receiver decrypts in Node, and the same
 * schema code is also reachable from the renderer bundle. A crypto or codec divergence between
 * those environments would not fail loudly — it would look like a fraction of batches quietly
 * failing to decrypt, which is indistinguishable on a dashboard from people not using the app.
 * Running the suite twice is the cheapest way to make that a red test instead.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
});

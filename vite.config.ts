import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const appVersion: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;

/**
 * Content-Security-Policy for the app.
 *
 * Production: locked down. The token is only ever sent to api.github.com, so
 * connect-src is restricted to it. styled-components (used by @primer/react v36)
 * injects <style> tags at runtime, hence style-src needs 'unsafe-inline'.
 *
 * Dev: Vite's HMR needs inline/eval scripts and a websocket connection, so we
 * relax script-src and connect-src for `vite serve` only.
 */
function buildCsp(isDev: boolean): string {
  // api.github.com for the API; *.blob.core.windows.net + *.actions.githubusercontent.com
  // are where Actions job logs are redirected (CORS-enabled signed URLs).
  const logHosts = 'https://*.blob.core.windows.net https://*.actions.githubusercontent.com';
  const connectSrc = isDev
    ? `'self' https://api.github.com ${logHosts} ws://localhost:* http://localhost:*`
    : `'self' https://api.github.com ${logHosts}`;
  const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'";
  return [
    "default-src 'self'",
    `connect-src ${connectSrc}`,
    "img-src 'self' https://avatars.githubusercontent.com https://*.githubusercontent.com data:",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // Note: `frame-ancestors` is ignored in a <meta> CSP — set it as an HTTP
    // response header in production (see README).
  ].join('; ');
}

function cspPlugin(isDev: boolean): Plugin {
  return {
    name: 'job-monitor-csp',
    transformIndexHtml(html) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(isDev)}">`;
      return html.replace('<!-- %CSP% -->', meta);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // Relative base for production so the build works under a GitHub Pages subpath
  // (https://<user>.github.io/<repo>/); '/' in dev for clean HMR URLs.
  base: command === 'serve' ? '/' : './',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), cspPlugin(command === 'serve')],
  build: {
    rolldownOptions: {
      output: {
        /**
         * Split the dependencies out of the app bundle.
         *
         * Not for the sake of a smaller download — the whole thing is ~290 KB gzipped
         * either way — but for **caching**. In one chunk, a one-line change to a component
         * invalidates React, Primer and styled-components along with it, so every release
         * re-downloads all of them. They change a few times a year; this app changes weekly.
         *
         * Grouped by how they version rather than by size: Primer and styled-components
         * move together (Primer v36 renders through styled-components), and the two
         * single-purpose libraries are separated because each is used by exactly one part
         * of the app and neither changes.
         */
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // The icon set is its own package and its own release cadence, and it is large
            // enough to be worth not re-downloading with the component library.
            { name: 'octicons', test: /node_modules[\\/]@primer[\\/]octicons-react[\\/]/ },
            // styled-components v5 is effectively frozen, so it is worth its own chunk
            // rather than being invalidated whenever Primer moves.
            {
              name: 'styled',
              test: /node_modules[\\/](styled-components|@styled-system|@emotion)[\\/]/,
            },
            { name: 'primer', test: /node_modules[\\/]@primer[\\/]/ },
            { name: 'table', test: /node_modules[\\/]@tanstack[\\/]/ },
            { name: 'zip', test: /node_modules[\\/]fflate[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}));

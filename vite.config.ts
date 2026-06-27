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
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}));

import type { NextConfig } from 'next';

const config: NextConfig = {
  /**
   * Standalone output: Next.js emits a self-contained server with only the modules it actually
   * uses. Without it the container would carry the entire workspace `node_modules` — including
   * Electron's ~100 MB binary, which belongs to the desktop client and has no business here.
   */
  output: 'standalone',

  // The workspace root, so tracing follows the symlinked schema package rather than stopping at
  // this directory and silently omitting it.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,

  /**
   * `node:sqlite` and `ably` stay external.
   *
   * Bundling either is wrong for a different reason: `node:sqlite` is a builtin that cannot be
   * bundled at all, and Ably's Node distribution is CommonJS that reaches for builtins by bare
   * name — bundling it produced a file that threw on import when we tried exactly that in the
   * desktop client.
   */
  serverExternalPackages: ['ably'],

};

export default config;

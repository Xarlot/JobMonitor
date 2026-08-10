import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

/**
 * Build-time credentials.
 *
 * These have to be *baked in*, not read from the environment at runtime: the app runs on users'
 * machines, where nothing will have set them. So they are substituted into the bundle here, the
 * same way `__APP_VERSION__` is substituted in vite.config.ts.
 *
 * Sources, in order: the real environment (CI secrets), then a gitignored `.env.telemetry` for
 * local builds. Never a committed file — `.env.telemetry.example` documents the shape and carries
 * no values.
 *
 * A build with no credentials is not an error. It produces an app that records locally and refuses
 * to publish (see `assertConfigured`), which is exactly right for a contributor's checkout.
 */
function telemetryEnv(): Record<string, string> {
  const keys = ['TELEMETRY_ABLY_KEY', 'TELEMETRY_RECEIVER_PUBKEY', 'TELEMETRY_DEPLOYMENT_ID'];
  const fromFile: Record<string, string> = {};

  try {
    for (const line of readFileSync('.env.telemetry', 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (match && keys.includes(match[1])) fromFile[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // Absent is the normal case for a fresh checkout.
  }

  const defines: Record<string, string> = {};
  for (const key of keys) {
    defines[`process.env.${key}`] = JSON.stringify(process.env[key] ?? fromFile[key] ?? '');
  }
  return defines;
}

/**
 * Bundles the main-process telemetry into a single self-contained `electron/telemetry.bundle.cjs`.
 *
 * **Why a bundle at all.** `electron-builder.yml` packs exactly `dist/**`, `electron/**` and
 * `package.json`. The telemetry code imports `@jobmonitor/telemetry-schema`, which is a workspace
 * package written in TypeScript — so it is neither runnable by Node as-is nor covered by that
 * `files:` list. Pre-bundling puts one plain `.cjs` file under `electron/`, which the existing
 * list already ships. `electron-builder.yml` needs no change, and packaging does not depend on
 * electron-builder's implicit `node_modules` handling being what we assumed.
 *
 * **Why Vite rather than esbuild.** Vite is already a dependency; esbuild is not (Vite 8 uses
 * rolldown). Adding a second bundler to produce one file would be a new dependency, a new lockfile
 * entry and a new thing to keep in step, for no capability this does not already have.
 *
 * The output is deliberately unminified. It ships inside the app, it is read by anyone auditing
 * what the telemetry actually does, and the size difference is a few tens of kilobytes against an
 * Electron binary.
 */
export default defineConfig({
  define: telemetryEnv(),
  resolve: {
    /**
     * Resolve the `node` export condition.
     *
     * Vite's library mode defaults to browser conditions, and this bundle runs in Electron's main
     * process — Node. Without this, `ably` resolves to `build/ably.js` (its browser distribution)
     * instead of `build/ably-node.js`, which it warns about at runtime: *"this distribution of Ably
     * is intended for browsers. On nodejs, please use the 'ably' package on npm."*
     *
     * It happens to publish successfully either way, which is precisely what makes it worth pinning
     * down: the browser build reaches the network through XHR/fetch shims rather than Node's HTTP
     * stack, so the parts that would differ are connection reuse, proxy handling and TLS — none of
     * which fail in a quick test and all of which matter on a user's machine.
     */
    conditions: ['node', 'module', 'import', 'default'],
  },
  build: {
    outDir: 'electron',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'electron/telemetry/index.mjs',
      /**
       * CJS output, even though the sources are ESM.
       *
       * `electron/main.cjs` is CommonJS, so a CJS bundle is loaded with a plain synchronous
       * `require` — no dynamic `import()`, no window during startup where telemetry exists but is
       * not yet loaded, and no ESM/CJS interop layer. That last point is not theoretical: Ably's
       * Node distribution is CJS and requires builtins like `events`, and bundling it into an ESM
       * output produces a file that throws on import because `require` does not exist there.
       */
      formats: ['cjs'],
      fileName: () => 'telemetry.bundle.cjs',
    },
    rollupOptions: {
      /**
       * Node builtins and Electron itself stay external — they exist in the runtime and bundling
       * them would be both impossible and wrong.
       *
       * The bare names matter as much as the `node:`-prefixed ones. Ably's Node distribution
       * requires `module`, `http`, `tls` and friends without the prefix, and a `/^node:/` pattern
       * alone silently leaves them to Vite's browser-externals shim — which replaces them with a
       * stub that throws on first use. That failure surfaces at *import* time, so the symptom is
       * the entire telemetry bundle failing to load rather than anything resembling a missing
       * module.
       */
      external: [/^node:/, 'electron', ...builtinModules],
    },
  },
});

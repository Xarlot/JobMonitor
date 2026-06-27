/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When '1', the app uses in-memory mock fixtures instead of api.github.com. */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** App version, injected at build time from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;

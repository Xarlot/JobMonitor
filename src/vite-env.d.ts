/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When '1', the app uses in-memory mock fixtures instead of api.github.com. */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

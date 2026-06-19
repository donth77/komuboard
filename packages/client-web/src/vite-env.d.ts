/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ws/http host of the Coboard worker, e.g. "127.0.0.1:8787" (dev) or "coboard-worker.<acct>.workers.dev". */
  readonly VITE_WORKER_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

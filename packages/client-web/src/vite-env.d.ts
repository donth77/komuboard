/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ws/http host of the Komuboard worker, e.g. "127.0.0.1:8787" (dev) or "komuboard-worker.<acct>.workers.dev". */
  readonly VITE_WORKER_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

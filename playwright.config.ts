import { defineConfig, devices } from "@playwright/test";

/**
 * M0 e2e: boots the full local dev stack (`pnpm dev` = wrangler worker + vite web)
 * and asserts the SPA shell renders and the WebSocket echo round-trips through a
 * hibernation-enabled Durable Object.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  // Boot the worker AND the web client; Playwright waits for both to be ready
  // (the worker via its /health endpoint) before running tests — no boot race.
  webServer: [
    {
      command: "pnpm --filter @komuboard/worker dev",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WRANGLER_SEND_METRICS: "false" },
    },
    {
      command: "pnpm --filter @komuboard/client-web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

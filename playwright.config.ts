import { defineConfig } from "@playwright/test";

/**
 * Cue end-to-end tests.
 *
 * - One worker: every test shares one Supabase database and the "one active
 *   session per user" rules, so the suite is deliberately serial.
 * - A real production build of apps/web is started on a dedicated port.
 * - The Anthropic API is replaced by a fake server on :3199 (see
 *   tests/e2e/helpers/fake-anthropic.ts, started in global-setup). The web
 *   server never sees a real Anthropic credential.
 * - Needs the local Supabase stack: `pnpm stack:start` (writes apps/web/.env.local).
 */
const WEB_PORT = 3100;
const FAKE_ANTHROPIC_PORT = 3199;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The expiry test really waits out the 15 s matching window.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `pnpm --filter @cue/web build && pnpm --filter @cue/web exec next start -p ${WEB_PORT}`,
    url: `http://127.0.0.1:${WEB_PORT}/`,
    // Reusing is convenient locally, but make sure whatever is on this port
    // was started with the env below (dummy Anthropic key, fake base URL).
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Never use a real Anthropic credential from the shell.
      ANTHROPIC_API_KEY: "e2e-dummy-key",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_ANTHROPIC_PORT}`,
      // Short model timeout so the "hang" test is quick.
      WINGMAN_TIMEOUT_MS: "3000",
    },
  },
});

import { defineConfig, devices } from "@playwright/test";

const configuredPort = Number(process.env.CODEX_PAD_E2E_PORT);
const e2ePort = Number.isInteger(configuredPort) && configuredPort >= 1_024 && configuredPort <= 65_535
  ? configuredPort
  : 30_000 + (process.pid % 25_000);
if (configuredPort !== e2ePort) process.env.CODEX_PAD_E2E_PORT = String(e2ePort);
const localBrowser = process.env.CODEX_PAD_E2E_USE_SYSTEM_CHROME === "1"
  ? { channel: "chrome" as const }
  : {};

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: process.env.CODEX_PAD_CAPTURE_SCREENSHOTS === "1"
    ? "screenshots.spec.ts"
    : ["accessibility.spec.ts", "codex-pad.spec.ts", "pwa-offline.spec.ts", "review-iteration.spec.ts"],
  fullyParallel: false,
  // Keep service-worker/WebSocket startup bounded across the Chromium and
  // WebKit responsive matrices on the same deterministic local fixture.
  workers: 3,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `CODEX_PAD_FIXTURE_PORT=${e2ePort} npm run fixture:web`,
    port: e2ePort,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "iPad landscape",
      use: {
        ...devices["iPad Pro 11 landscape"],
        browserName: "chromium",
        ...localBrowser,
      },
    },
    {
      name: "iPad portrait",
      use: {
        ...devices["iPad Pro 11"],
        browserName: "chromium",
        ...localBrowser,
      },
    },
    {
      name: "iPhone",
      use: {
        ...devices["iPhone 15 Pro"],
        browserName: "chromium",
        ...localBrowser,
      },
    },
    {
      name: "WebKit iPad landscape",
      use: {
        ...devices["iPad Pro 11 landscape"],
        browserName: "webkit",
        // WebKit does not expose service-worker-owned requests to Playwright's
        // page routing. Chromium owns the explicit offline/service-worker
        // matrix; WebKit remains the Safari-like UI and pointer matrix.
        serviceWorkers: "block",
      },
    },
    {
      name: "WebKit iPad portrait",
      use: {
        ...devices["iPad Pro 11"],
        browserName: "webkit",
        serviceWorkers: "block",
      },
    },
    {
      name: "WebKit iPhone",
      use: {
        ...devices["iPhone 15 Pro"],
        browserName: "webkit",
        serviceWorkers: "block",
      },
    },
  ],
});

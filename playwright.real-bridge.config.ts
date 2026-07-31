import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: "real-bridge.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "real bridge · iPad landscape",
      use: { ...devices["iPad Pro 11 landscape"], browserName: "chromium" },
    },
    {
      name: "real bridge · iPad portrait",
      use: { ...devices["iPad Pro 11"], browserName: "chromium" },
    },
    {
      name: "real bridge · iPhone",
      use: { ...devices["iPhone 15 Pro"], browserName: "chromium" },
    },
    {
      name: "real bridge · WebKit iPad landscape",
      use: { ...devices["iPad Pro 11 landscape"], browserName: "webkit", serviceWorkers: "block" },
    },
    {
      name: "real bridge · WebKit iPad portrait",
      use: { ...devices["iPad Pro 11"], browserName: "webkit", serviceWorkers: "block" },
    },
    {
      name: "real bridge · WebKit iPhone",
      use: { ...devices["iPhone 15 Pro"], browserName: "webkit", serviceWorkers: "block" },
    },
  ],
});

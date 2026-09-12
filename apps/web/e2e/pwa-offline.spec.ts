import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const RECOVERY_SCREENSHOT_OUTPUT = process.env.CODEX_PAD_CONNECTION_SCREENSHOT_OUTPUT?.trim();

function screenshotSuffix(projectName: string): string {
  if (projectName === "iPad landscape") return "";
  if (projectName === "iPad portrait") return "-portrait";
  if (projectName === "iPhone") return "-phone";
  return `-${projectName.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
}

test("keeps a static Nerva connection hint when the application script cannot start", async ({ page }) => {
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Connecting to your Mac…" })).toBeVisible();
  await expect(page.getByText(/verify that Tailscale is connected on both/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Try opening Nerva again" })).toBeVisible();
});

test("keeps the installed touch shell consultable and mutation-safe offline", async ({ browserName, context, page }) => {
  test.skip(browserName === "webkit", "Playwright WebKit cannot route service-worker-owned requests; Chromium covers the production offline shell.");
  let commandRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/command") commandRequests += 1;
  });

  await page.goto("/pair?nonce=fixture-pairing-code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error("The production service worker did not activate");
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("The production service worker did not control the page")), 10_000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  });

  const initialAssets = await page.evaluate(() => [
    ...Array.from(document.scripts, (script) => script.getAttribute("src")),
    ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), (link) => link.getAttribute("href")),
  ].filter((value): value is string => value?.startsWith("/assets/") ?? false));
  expect(initialAssets.length).toBeGreaterThan(0);

  const cacheCoverage = await page.evaluate(async (assets) => {
    const names = await caches.keys();
    const stores = await Promise.all(names.map((name) => caches.open(name)));
    const contains = async (url: string) => (await Promise.all(stores.map((cache) => cache.match(url)))).some(Boolean);
    return {
      root: await contains("/"),
      assets: await Promise.all(assets.map(contains)),
      snapshotApi: await contains("/api/snapshot"),
    };
  }, initialAssets);
  expect(cacheCoverage.root).toBe(true);
  expect(cacheCoverage.assets).toEqual(initialAssets.map(() => true));
  expect(cacheCoverage.snapshotApi).toBe(false);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
    await expect(page.locator(".cp-connection.phase-reconnecting")).toBeVisible();
    await expect(page.locator(".offline-strip[role=status]")).toContainText("No command will be queued or replayed.");
    const commandsBeforeTap = commandRequests;
    const currentMac = page.getByRole("button", { name: /Open current Mac session/ });
    await expect(currentMac).toBeDisabled();
    await currentMac.evaluate((button: HTMLButtonElement) => button.click());
    expect(commandRequests).toBe(commandsBeforeTap);

    await page.getByRole("button", { name: /Capture Inbox/ }).click();
    await expect(page.getByRole("heading", { name: "Capture Inbox", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /Note Catch a quick idea/ }).click();
    await page.getByLabel("Quick note text").fill("Offline release note");
    await page.getByRole("button", { name: "Save to Inbox" }).click();
    await expect(page.getByRole("heading", { name: "Offline release note" })).toBeVisible();
    await page.getByRole("button", { name: "Open Nerva Home" }).click();
    await page.getByRole("button", { name: /Capture Inbox/ }).click();
    await expect(page.getByRole("heading", { name: "Offline release note" })).toBeVisible();
    await page.getByRole("button", { name: "Open Nerva Home" }).click();
    expect(commandRequests).toBe(commandsBeforeTap);
  } finally {
    await context.setOffline(false);
  }

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".cp-connection.phase-online")).toBeVisible();
  expect(commandRequests).toBe(0);
});

test("replaces an empty offline launch with an actionable private-link recovery screen", async ({ browserName, context, page }, testInfo) => {
  test.skip(browserName === "webkit", "Chromium owns the service-worker offline launch matrix.");

  await page.goto("/pair?nonce=fixture-pairing-code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error("The production service worker did not activate");
    await new Promise<void>((resolveDelete, reject) => {
      const request = indexedDB.deleteDatabase("codex-pad-display-cache");
      request.onsuccess = () => resolveDelete();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Display cache deletion was blocked"));
    });
  });

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Can’t reach your Mac." })).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/Tailscale being disconnected is the most common cause/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeInViewport();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"))
      .toEqual([]);

    if (RECOVERY_SCREENSHOT_OUTPUT) {
      await mkdir(RECOVERY_SCREENSHOT_OUTPUT, { recursive: true });
      await page.screenshot({
        path: resolve(RECOVERY_SCREENSHOT_OUTPUT, `connection-recovery${screenshotSuffix(testInfo.project.name)}.png`),
        animations: "disabled",
        scale: "css",
      });
    }

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(/private link is still unavailable/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open Capture Inbox", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Capture Inbox", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Session", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /Note Catch a quick idea/ }).click();
    await page.getByLabel("Quick note text").fill("A local idea while the Mac is unreachable");
    await page.getByRole("button", { name: "Save to Inbox" }).click();
    await expect(page.locator(".cp-capture-card.kind-note")).toContainText("A local idea while the Mac is unreachable");
    await page.getByRole("button", { name: "Open Nerva Home" }).click();
    await expect(page.getByRole("heading", { name: "Can’t reach your Mac." })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible({ timeout: 12_000 });
});

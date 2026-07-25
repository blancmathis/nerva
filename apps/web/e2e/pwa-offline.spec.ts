import { expect, test } from "@playwright/test";

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
    await expect(page.getByText("Mac offline is okay")).toBeVisible();
    await page.getByRole("button", { name: /Note Catch a quick idea/ }).click();
    await page.getByLabel("Quick note text").fill("Offline field note");
    await page.getByRole("button", { name: "Save to Inbox" }).click();
    await expect(page.getByRole("heading", { name: "Offline field note" })).toBeVisible();
    expect(commandRequests).toBe(commandsBeforeTap);
  } finally {
    await context.setOffline(false);
  }

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".cp-connection.phase-online")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Offline field note" })).toBeVisible();
  expect(commandRequests).toBe(0);
});

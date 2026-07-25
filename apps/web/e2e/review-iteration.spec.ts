import { expect, test, type Route } from "@playwright/test";
import { resolve } from "node:path";

import { THREADS, fixtureCapabilities, fixtureSessions } from "./fixture-data";
import { MockBridge } from "./mock-bridge";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test.use({ serviceWorkers: "block" });

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
}

async function seedBridgeBearer(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const request = indexedDB.open("codex-pad-origin-auth", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("device-credential")) {
          request.result.createObjectStore("device-credential");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("device-credential", "readwrite");
    transaction.objectStore("device-credential").put({ version: 1, bearerToken: "f".repeat(43) }, "current");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
}

async function readBridgeBearer(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(async () => {
    const request = indexedDB.open("codex-pad-origin-auth", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("device-credential", "readonly");
    const read = transaction.objectStore("device-credential").get("current");
    const stored = await new Promise<unknown>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    database.close();
    if (typeof stored !== "object" || stored === null) return null;
    const bearerToken = (stored as { bearerToken?: unknown }).bearerToken;
    return typeof bearerToken === "string" ? bearerToken : null;
  });
}

test("turns an unread agent update into an explicit manually imported iteration", async ({ page }) => {
  const bridge = new MockBridge();
  await bridge.install(page);

  const capabilities = fixtureCapabilities();
  await page.route("**/api/capabilities", (route) => fulfillJson(route, {
    ...capabilities,
    data: {
      ...capabilities.data,
      siteCapture: { available: true, reason: null },
    },
  }));

  const sessions = fixtureSessions({
    bridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
    sequence: 73,
    selectedIndex: 0,
  });
  const researchPreviewAssociation = {
    associationId: "research_preview",
    threadId: THREADS[2].id,
    projectId: null,
    name: "Research preview",
    origin: "https://preview.example.test",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_001,
    capabilities: {
      state: "available",
      canCaptureFrames: true,
      canSendReview: true,
      supportsInlinePng: true,
      supportsUploadRefs: false,
      maxFrames: 12,
      maxFrameBytes: 8 * 1024 * 1024,
      maxTotalBytes: 24 * 1024 * 1024,
      reason: null,
    },
    interactionModes: {
      selected: "none",
      direct: {
        status: "unavailable",
        reason: "same-host-storage-boundary",
        detail: "Live preview requires a separately verified browser storage boundary.",
      },
      remoteBrowser: {
        status: "unavailable",
        reason: "thread-tab-mapping-unproven",
        detail: "Exact task-to-tab mapping is not proven in this fixture.",
        association: {
          status: "unavailable",
          reason: "thread-tab-mapping-unproven",
          detail: "Exact task-to-tab mapping is not proven in this fixture.",
        },
      },
    },
  } as const;
  await page.route("**/api/native-sessions", (route) => fulfillJson(route, {
    ...sessions,
    data: {
      ...sessions.data,
      registryGeneration: 1,
      sessions: sessions.data.sessions.filter((session) => session.microSlot !== null).map((session) => session.threadId === THREADS[2].id ? {
        ...session,
        siteAssociations: [researchPreviewAssociation],
        siteAssociation: researchPreviewAssociation,
      } : session),
    },
  }));
  await page.route("**/api/sites?**", (route) => fulfillJson(route, {
    ok: true,
    data: {
      sites: [{
        siteId: researchPreviewAssociation.associationId,
        name: researchPreviewAssociation.name,
        scope: "thread",
        publicOrigin: researchPreviewAssociation.origin,
        createdAt: researchPreviewAssociation.createdAt,
        updatedAt: researchPreviewAssociation.updatedAt,
        association: researchPreviewAssociation,
      }],
    },
  }));
  await page.route("**/api/browser-tabs?**", (route) => fulfillJson(route, {
    ok: true,
    data: { tabs: [], detail: "No open tabs in this fixture." },
  }));

  let embeddedSiteRequests = 0;
  await page.route("https://preview.example.test/**", (route) => {
    embeddedSiteRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Research preview</title><main>Registered preview route</main>",
    });
  });

  const capturePaths: string[] = [];
  await page.route("**/api/sites/research_preview/capture", async (route) => {
    const request = route.request().postDataJSON() as {
      readonly path: string;
      readonly viewport: string;
      readonly scroll: { readonly x: number; readonly y: number };
    };
    capturePaths.push(request.path);
    const after = capturePaths.length > 1;
    await fulfillJson(route, {
      ok: true,
      data: {
        siteId: "research_preview",
        title: after ? "Research preview after" : "Research preview before",
        finalPath: after ? "/dashboard?state=after" : "/dashboard?state=before",
        viewport: request.viewport,
        scroll: request.scroll,
        redirectCount: 0,
        pngBase64: PNG_1X1,
        width: 1_024,
        height: 768,
      },
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Scan the QR on your Mac" })).toBeVisible();
  await seedBridgeBearer(page);
  await expect.poll(() => readBridgeBearer(page)).toHaveLength(43);
  await page.reload();
  await expect.poll(() => readBridgeBearer(page)).toHaveLength(43);
  await expect(page.locator(".cp-connection.phase-online")).toBeVisible();
  await page.getByRole("button", { name: /Open Research queue/ }).click();
  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Review result" }).click();

  await expect(page.getByText("Agent updated — capture or import an after state.")).toBeVisible();
  await expect(page.getByText(/Nothing was captured automatically/)).toBeVisible();
  await expect(page.getByText(/Live preview unavailable on shared host/i)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /open in new tab/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /capture registered route/i })).toHaveCount(0);
  await expect(page.getByLabel(/capture viewport/i)).toHaveCount(0);
  expect(page.frames().some((frame) => frame.url().startsWith("https://preview.example.test/"))).toBe(false);
  expect(embeddedSiteRequests).toBe(0);
  const imageFile = resolve(process.cwd(), "apps/web/public/icons/icon-192.png");
  const importInput = page.locator('.review-add-menu input[type="file"]:not([capture])');
  await importInput.setInputFiles(imageFile);
  await expect(page.getByLabel(/Frame title/)).toHaveValue("icon-192.png");
  await page.getByLabel("Import after image").setInputFiles(imageFile);
  await expect(page.getByRole("heading", { name: "Before / after" })).toBeVisible();
  await page.getByRole("button", { name: "Store after as a new iteration" }).click();
  await expect(page.getByText("3 frames · saved locally")).toBeVisible();
  await expect(page.getByText("icon-192.png · next iteration")).toBeVisible();
  expect(capturePaths).toEqual([]);
});

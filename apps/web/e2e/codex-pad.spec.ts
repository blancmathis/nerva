import { expect, test, type Locator, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";

import { CATALOG_SESSION, INITIAL_BRIDGE_INSTANCE_ID, MockBridge, THREADS } from "./mock-bridge";
import { fixtureSessions } from "./fixture-data";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function openAuthenticatedApp(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge({ authorized: false });
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".cp-connection.phase-online")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
  return bridge;
}

async function drawPenStroke(canvas: Locator): Promise<void> {
  if (await canvas.getAttribute("aria-busy") !== null) {
    await expect(canvas).toHaveAttribute("aria-busy", "false");
  }
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Sketch canvas has no rendered bounds");
  const points = [[.3, .38], [.48, .56], [.68, .42]] as const;
  for (const [index, [x, y]] of points.entries()) {
    await canvas.dispatchEvent(index === 0 ? "pointerdown" : index === points.length - 1 ? "pointerup" : "pointermove", {
      pointerId: 51,
      pointerType: "pen",
      isPrimary: true,
      button: index === 1 ? -1 : 0,
      buttons: index === points.length - 1 ? 0 : 1,
      pressure: index === points.length - 1 ? 0 : .7,
      clientX: box.x + box.width * x,
      clientY: box.y + box.height * y,
    });
    // A physical Pencil delivers events across display frames. Giving WebKit
    // the same cadence prevents a loaded CI worker from coalescing the entire
    // synthetic stroke before React commits its drawing state.
    await canvas.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
  }
}

async function dragSiteCanvas(
  canvas: Locator,
  pointerType: "touch" | "pen",
  points: readonly (readonly [number, number])[],
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Site canvas has no rendered bounds");
  for (const [index, [x, y]] of points.entries()) {
    await canvas.dispatchEvent(index === 0 ? "pointerdown" : index === points.length - 1 ? "pointerup" : "pointermove", {
      pointerId: pointerType === "pen" ? 82 : 81,
      pointerType,
      isPrimary: true,
      button: index === 0 || index === points.length - 1 ? 0 : -1,
      buttons: index === points.length - 1 ? 0 : 1,
      pressure: index === points.length - 1 ? 0 : pointerType === "pen" ? .68 : .55,
      clientX: box.x + box.width * x,
      clientY: box.y + box.height * y,
    });
  }
}

function sessionsForPinnedCount(count: number, sequence: number) {
  const fixture = fixtureSessions({ sequence, selectedIndex: 0 });
  const pinned = fixture.data.sessions.filter((session) => session.microSlot !== null);
  const catalog = fixture.data.sessions.filter((session) => session.microSlot === null);
  const requested = Array.from({ length: count }, (_, index) => {
    const seed = pinned[index % pinned.length]!;
    if (index < pinned.length) return seed;
    return {
      ...seed,
      threadId: `019f7ec2-68eb-7183-bb3a-0e67312a8c${index.toString(16).padStart(2, "0")}`,
      title: `Additional session ${index + 1}`,
      selected: false,
      microSlot: null,
      activityAt: fixture.data.timestamp - (index + 1) * 60_000,
    };
  });
  return {
    ...fixture,
    data: {
      ...fixture.data,
      sequence,
      sessions: [...requested, ...catalog],
    },
  };
}

async function seedHomeLayout(
  page: Page,
  fixture: ReturnType<typeof sessionsForPinnedCount>,
  pinnedCount: number,
): Promise<void> {
  const pinnedThreadIds = fixture.data.sessions
    .slice(0, pinnedCount)
    .map((session) => session.threadId);
  await seedHomeLayoutThreadIds(page, pinnedThreadIds);
}

async function seedHomeLayoutThreadIds(
  page: Page,
  pinnedThreadIds: readonly string[],
): Promise<void> {
  const layout = {
    version: 1,
    mode: "manual",
    pinnedThreadIds,
    manual: { sections: [], looseThreadIds: pinnedThreadIds },
    automaticOrder: ["needs-approval", "error", "working", "waiting", "completed", "idle"],
  };
  await page.evaluate(async (nextLayout) => {
    localStorage.setItem("codex-pad.home-layout.v1", JSON.stringify(nextLayout));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("codex-pad-product-state", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("home")) request.result.createObjectStore("home");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction("home", "readwrite");
        transaction.objectStore("home").put(nextLayout, "layout");
        transaction.oncomplete = () => { request.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, layout);
}

async function showHome(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Your working set." });
  // A restored authenticated app can briefly resume the followed Mac session
  // after reload. Choose Home only after that one-shot transition settles, and
  // retry if the transition lands during the first tap.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!await heading.isVisible()) {
      await page.getByRole("button", { name: "Open Nerva Home" }).click();
    }
    await page.waitForTimeout(350);
    if (await heading.isVisible()) return;
  }
  await expect(heading).toBeVisible();
}

test("pairs with one tap and no code or device-name form", async ({ page }) => {
  const bridge = new MockBridge({ authorized: false });
  await bridge.install(page);
  await page.goto("/pair?nonce=cedar-4821");

  await expect(page.getByRole("heading", { name: /Connect to/ })).toBeVisible();
  await expect(page.locator('input[type="text"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Codex usage" })).toContainText("72% remaining");
  await expect(page.getByRole("complementary", { name: "Codex usage" })).toContainText("Weekly limit");
  const usageBounds = await page.getByRole("complementary", { name: "Codex usage" }).boundingBox();
  const currentMacBounds = await page.getByRole("button", { name: /Open current Mac session/ }).boundingBox();
  expect(usageBounds).not.toBeNull();
  expect(currentMacBounds).not.toBeNull();
  // Fractional viewport scaling can round sibling CSS-grid tracks to adjacent
  // device pixels even though they share the same layout definition.
  expect(Math.abs(usageBounds!.width - currentMacBounds!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(usageBounds!.height - currentMacBounds!.height)).toBeLessThanOrEqual(2);
  expect(usageBounds!.height).toBeLessThanOrEqual(54);
  expect(bridge.pairRequests).toEqual([{ nonce: "cedar-4821", deviceName: expect.stringContaining("Nerva") }]);
});

test("keeps the compact Home chrome separated at every supported viewport", async ({ page }) => {
  await openAuthenticatedApp(page);

  const bounds = await Promise.all([
    page.getByRole("heading", { name: "Your working set." }).boundingBox(),
    page.getByRole("button", { name: "Open Nerva Home" }).boundingBox(),
    page.locator(".cp-topbar__status .cp-connection").boundingBox(),
    page.getByRole("complementary", { name: "Codex usage" }).boundingBox(),
    page.getByRole("button", { name: /Open current Mac session/ }).boundingBox(),
  ]);
  expect(bounds.every((box) => box !== null)).toBe(true);
  const [heading, brand, connection, usage, currentMac] = bounds as Exclude<(typeof bounds)[number], null>[];
  const intersectionArea = (first: typeof heading, second: typeof heading) => (
    Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x))
    * Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y))
  );

  for (const [label, element] of [
    ["brand", brand],
    ["connection light", connection],
    ["usage", usage],
    ["current Mac", currentMac],
  ] as const) {
    expect(intersectionArea(heading, element), `${label} must not overlap the Home heading`).toBe(0);
  }
});

test("keeps the 768-wide iPad header legible and moves diagnostics into Settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iPad landscape", "One intermediate-width geometry proof is sufficient");
  await page.setViewportSize({ width: 768, height: 1_024 });
  await openAuthenticatedApp(page);

  const usage = page.getByRole("complementary", { name: "Codex usage" });
  const currentMac = page.getByRole("button", { name: /Open current Mac session/ });
  const settings = page.getByRole("button", { name: "Open Settings" });
  await expect(usage.locator(".cp-usage-window:visible")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Open System Diagnostics/ })).toHaveCount(0);

  const [usageBounds, currentMacBounds, settingsBounds, usageLineBounds, refreshBounds] = await Promise.all([
    usage.boundingBox(),
    currentMac.boundingBox(),
    settings.boundingBox(),
    usage.locator(".cp-usage-window:visible .cp-usage-window__line").boundingBox(),
    usage.getByRole("button", { name: "Refresh Codex usage" }).boundingBox(),
  ]);
  expect(usageBounds).not.toBeNull();
  expect(currentMacBounds).not.toBeNull();
  expect(settingsBounds).not.toBeNull();
  expect(usageLineBounds).not.toBeNull();
  expect(refreshBounds).not.toBeNull();
  expect(Math.abs(usageBounds!.height - currentMacBounds!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(usageBounds!.height - settingsBounds!.height)).toBeLessThanOrEqual(1);
  expect(usageLineBounds!.x + usageLineBounds!.width).toBeLessThanOrEqual(refreshBounds!.x);
  await settings.click();
  await expect(page.getByRole("button", { name: /Open System Diagnostics/ })).toBeVisible();
});

test("keeps the first Session input reachable in the initial viewport", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();

  const dictation = page.getByRole("button", { name: /^Dictation/ });
  await expect(dictation).toBeVisible();
  const bounds = await dictation.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.y).toBeLessThan(viewport!.height);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
});

test("Capture Inbox stays neutral, persists, and is reused from the exact open Session", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  const commandCount = bridge.commandRequests;

  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Capture Inbox", level: 1 })).toBeVisible();
  await expect(page.getByText("Nothing leaves automatically.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Voice/ })).toHaveCount(0);

  await page.getByRole("button", { name: /Note Catch a quick idea/ }).click();
  await page.getByLabel("Quick note text").fill("Header jump\nReproduce after rotating the iPad.");
  await page.getByRole("button", { name: "Save to Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Header jump" })).toBeVisible();
  await page.getByLabel("Capture photo").setInputFiles({ name: "whiteboard.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1, "base64") });
  await expect(page.getByText("Photo saved locally.")).toBeVisible();
  expect(bridge.commandRequests).toBe(commandCount);

  await page.reload();
  await showHome(page);
  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Capture Inbox", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Header jump" })).toBeVisible();
  await expect(page.locator(".cp-capture-card")).toHaveCount(2);
  expect(bridge.commandRequests).toBe(commandCount);

  await page.getByRole("button", { name: /Delete Photo/ }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete 1 capture?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep captures" }).click();
  await expect(page.locator(".cp-capture-card")).toHaveCount(2);
  await page.getByRole("button", { name: /Delete Photo/ }).click();
  await page.getByRole("button", { name: "Delete from iPad" }).click();
  await expect(page.getByText("1 capture deleted from this iPad.")).toBeVisible();
  await expect(page.locator(".cp-capture-card")).toHaveCount(1);

  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  const commandCountBeforeFirstUse = bridge.commandRequests;
  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByLabel("Using Capture Inbox with Release checklist")).toBeVisible();
  await page.getByRole("button", { name: "Select Header jump" }).click();
  await page.getByRole("button", { name: "Use in session" }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await expect(page.getByLabel(/General instruction/)).toHaveValue(/Reproduce after rotating the iPad/);
  await expect(page.getByRole("button", { name: "Preview atomic send" })).toBeVisible();
  expect(bridge.commandRequests).toBe(commandCountBeforeFirstUse);

  await page.getByRole("button", { name: "Close review" }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await page.getByRole("button", { name: /Open Research queue/ }).click();
  const commandCountBeforeSecondUse = bridge.commandRequests;
  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByLabel("Using Capture Inbox with Research queue")).toBeVisible();
  await page.getByRole("button", { name: "Select Header jump" }).click();
  await page.getByRole("button", { name: "Use in session" }).click();
  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
  await expect(page.getByLabel(/General instruction/)).toHaveValue(/Reproduce after rotating the iPad/);
  expect(bridge.commandRequests).toBe(commandCountBeforeSecondUse);
});

test("Capture Inbox keeps a Pencil sketch without choosing a session", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  const commandCount = bridge.commandRequests;
  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await page.getByRole("button", { name: /Sketch Pencil-ready canvas/ }).click();
  await expect(page.getByRole("dialog", { name: "Draw now. Use later." })).toBeVisible();
  const canvas = page.getByRole("img", { name: /Frame annotation canvas/ });
  await drawPenStroke(canvas);
  await page.getByRole("button", { name: "Keep in Inbox" }).click();
  await expect(page.getByRole("dialog", { name: "Draw now. Use later." })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Sketch saved locally.")).toBeVisible();
  await expect(page.locator(".cp-capture-card.kind-sketch")).toHaveCount(1);
  await expect(page.getByText("Available in every Session")).toBeVisible();
  expect(bridge.commandRequests).toBe(commandCount);
});

test("opens one exact pinned session on both surfaces", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  expect(bridge.pinnedThreadIds).toHaveLength(6);
  await expect(page.locator(".cp-session-card")).toHaveCount(6);
  await page.getByRole("button", { name: /Open Research queue/ }).click();

  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
  await expect(page.locator(".cp-session-workspace .cp-back-button")).toHaveCount(0);
  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("openSession");
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedBridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
    expectedThreadId: THREADS[2].id,
    targetThreadId: THREADS[2].id,
  });
});

test("fills every session card with one continuous luminous key surface", async ({ page }) => {
  await openAuthenticatedApp(page);

  const geometries = await page.locator(".cp-session-card").evaluateAll((cards) => cards.map((card) => {
    const open = card.querySelector<HTMLElement>(".cp-session-card__open");
    if (!open) throw new Error("Session card is missing its primary button");
    const cardBounds = card.getBoundingClientRect();
    const openBounds = open.getBoundingClientRect();
    return {
      leftInset: openBounds.left - cardBounds.left,
      widthDifference: cardBounds.width - openBounds.width,
    };
  }));

  expect(geometries).toHaveLength(6);
  for (const geometry of geometries) {
    expect(geometry.leftInset).toBeLessThanOrEqual(1.1);
    expect(Math.round(geometry.widthDifference)).toBeLessThanOrEqual(2);
  }
});

test("filters every Codex session inside Home and routes the exact session", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: "Show priority sessions" }).click();

  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show priority sessions" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cp-focused-sessions .cp-session-card")).toHaveCount(6);
  await expect(page.locator(".cp-focused-sessions .cp-session-card").first()).toContainText("Approval audit");
  await page.getByRole("button", { name: /Error 1/ }).click();
  await expect(page.locator(".cp-focused-sessions .cp-session-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Open Visual polish/ })).toBeVisible();
  await page.getByRole("button", { name: /Error 1/ }).click();
  await expect(page.locator(".cp-manual-layout .cp-session-card")).toHaveCount(6);

  await page.getByRole("button", { name: /Approval 1/ }).click();
  await page.getByRole("button", { name: /Open Approval audit/ }).click();
  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("openSession");
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedThreadId: THREADS[3].id,
    targetThreadId: THREADS[3].id,
  });
  await expect(page.getByRole("heading", { name: "Approval audit", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  bridge.selectOnMac(1);
  await expect(page.getByRole("heading", { name: "Bridge hardening", level: 1 })).toBeVisible();
});

test("orders pinned attention before other pins and unpinned attention", async ({ page }) => {
  const bridge = new MockBridge({ authorized: false });
  const fixture = fixtureSessions({ sequence: 88, selectedIndex: 0 });
  const withUnpinnedError = {
    ...fixture,
    data: {
      ...fixture.data,
      sessions: fixture.data.sessions.map((session) => {
        if (session.threadId === CATALOG_SESSION.id) {
          return { ...session, nativeStatus: "error", visualStatus: "error" };
        }
        if (session.threadId !== THREADS[0].id && session.threadId !== THREADS[1].id) {
          return { ...session, nativeStatus: "idle", visualStatus: "idle" };
        }
        return session;
      }),
    },
  };
  bridge.setSessionsFixture(withUnpinnedError, [THREADS[0].id, THREADS[1].id]);
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-priority-order");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await showHome(page);

  await page.getByRole("button", { name: "Show priority sessions" }).click();
  const cards = page.locator(".cp-focused-sessions .cp-session-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("Bridge hardening");
  await expect(cards.nth(1)).toContainText("Release checklist");
  await expect(cards.nth(2)).toContainText("Catalog reference");
  await expect(cards.nth(2).getByRole("button", { name: /More actions/ })).toHaveCount(0);
});

test("opens the exact safe destination from a notification deep link", async ({ page }) => {
  await openAuthenticatedApp(page);

  await page.goto(`/?open=session&thread=${THREADS[2].id}`);
  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/$/u);

  await page.goto("/?open=mission");
  await expect(page.getByRole("heading", { name: "Your working set.", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show priority sessions" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/\/$/u);
});

test("does not navigate sessions from page drags and returns Home through the product mark", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Research queue/ }).click();
  const surface = page.locator(".cp-session-workspace");
  await expect(surface).toBeVisible();
  await expect(page.locator(".cp-session-switcher")).toHaveCount(0);

  await surface.dispatchEvent("pointerdown", {
    pointerId: 71,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 720,
    clientY: 430,
  });
  await surface.dispatchEvent("pointermove", {
    pointerId: 71,
    pointerType: "touch",
    isPrimary: true,
    button: -1,
    buttons: 1,
    clientX: 470,
    clientY: 510,
  });
  await surface.dispatchEvent("pointerup", {
    pointerId: 71,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: 470,
    clientY: 510,
  });

  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
  expect(bridge.commands.filter((command) => command.type === "openSession")).toHaveLength(1);
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
});

test("one long press directly reorders a pinned card and never opens a session", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await expect(page.getByRole("button", { name: "New section" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Arrange|Done arranging/ })).toHaveCount(0);
  const research = page.getByRole("button", { name: /Open Research queue/ });
  await research.scrollIntoViewIfNeeded();
  const researchBox = await research.boundingBox();
  if (!researchBox) throw new Error("Research card has no rendered bounds");

  await research.dispatchEvent("pointerdown", {
    pointerId: 72,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: researchBox.x + researchBox.width / 2,
    clientY: researchBox.y + researchBox.height / 2,
  });
  await page.waitForTimeout(460);
  const bridgeCard = page.getByRole("button", { name: /Open Bridge hardening/ });
  const bridgeBox = await bridgeCard.boundingBox();
  if (!bridgeBox) throw new Error("Bridge card has no rendered bounds");
  await research.dispatchEvent("pointermove", {
    pointerId: 72,
    pointerType: "touch",
    isPrimary: true,
    button: -1,
    buttons: 1,
    clientX: bridgeBox.x + bridgeBox.width / 2,
    clientY: bridgeBox.y + bridgeBox.height / 2,
  });
  await research.dispatchEvent("pointerup", {
    pointerId: 72,
    pointerType: "touch",
    isPrimary: true,
    button: -1,
    buttons: 0,
    clientX: bridgeBox.x + bridgeBox.width / 2,
    clientY: bridgeBox.y + bridgeBox.height / 2,
  });

  await expect(page.locator(".cp-direct-sessions .cp-session-card").nth(1)).toHaveAttribute("data-thread-id", THREADS[2].id);
  const commandsAfterDrop = bridge.commands.length;
  await bridgeCard.dispatchEvent("click");
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
  expect(bridge.commands).toHaveLength(commandsAfterDrop);
});

test("lists one Session's Codex Browser pages uniformly, browses one, and switches to focused annotation", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();

  const site = page.getByRole("button", { name: /^Site/ });
  await expect(site).toContainText("Browse open Mac pages");
  await site.click();

  const hub = page.getByRole("main", { name: "Sites" });
  await expect(hub).toContainText("Open pages");
  await expect(hub).toContainText("Component lab");
  await expect(hub).not.toContainText("Linked sites");
  await expect(hub).not.toContainText("Unlinked browser tabs");
  await expect(hub).not.toContainText("Open Review without a site");
  await hub.getByRole("button", { name: "Open Component lab" }).click();

  await expect(page.getByRole("region", { name: "Live site workspace" })).toBeVisible();
  const canvas = page.locator(".cp-browser-site__canvas");
  const liveFrame = page.locator(".cp-browser-site__frame");
  await expect(liveFrame).toBeVisible();
  await expect.poll(() => liveFrame.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.getByLabel("Browse current Mac site")).toBeVisible();
  await expect(page.getByText("Photo / Files", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Camera", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Blank frame", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Filmstrip", { exact: true })).toHaveCount(0);

  // A real scroll drifts sideways and changes speed; it is intentionally not a
  // perfectly vertical synthetic line.
  await dragSiteCanvas(canvas, "touch", [[.53, .72], [.515, .63], [.525, .51], [.49, .39], [.505, .27]]);
  await expect.poll(() => bridge.browserControls.at(-1)?.type).toBe("scroll");
  expect(bridge.browserControls.at(-1)).toMatchObject({ type: "scroll" });

  // Pencil contact freezes the live page and starts ink immediately—there is
  // no separate drawing/import studio between browsing and annotation.
  await dragSiteCanvas(canvas, "pen", [[.30, .38], [.42, .47], [.55, .43], [.68, .50]]);
  const annotationCanvas = page.getByLabel("Annotate current site frame");
  await expect(annotationCanvas).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Pencil only" })).toHaveCount(0);
  await page.getByRole("button", { name: "Browse", exact: true }).click();
  await expect(page.getByLabel("Browse current Mac site")).toBeVisible();

  await page.getByRole("button", { name: "Pencil only" }).click();
  await dragSiteCanvas(canvas, "touch", [[.34, .42], [.44, .49], [.57, .45]]);
  await expect(page.getByLabel("Annotate current site frame")).toBeVisible();
});

test("shows only the Codex Browser pages attached to the exact Session", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: /^Site/ }).click();

  let hub = page.getByRole("main", { name: "Sites" });
  await expect(hub.getByRole("button", { name: "Open Component lab" })).toBeVisible();
  await expect(hub).not.toContainText("Research preview");
  await hub.getByRole("button", { name: "Session" }).click();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();

  await page.getByRole("button", { name: /Open Research queue/ }).click();
  await page.getByRole("button", { name: /^Site/ }).click();
  hub = page.getByRole("main", { name: "Sites" });
  await expect(hub.getByRole("button", { name: "Open Research preview" })).toBeVisible();
  await expect(hub).not.toContainText("Component lab");
});

test("opens a typed address in a proven Codex tab and keeps global favorites", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: /^Site/ }).click();

  const hub = page.getByRole("main", { name: "Sites" });
  const address = hub.getByPlaceholder("Enter a URL or domain");
  await address.fill("example.test/dashboard");
  await hub.getByRole("button", { name: "Add address to favorites" }).click();
  await expect(hub.locator(".cp-favorite-list")).toContainText("example.test");
  await expect.poll(() => bridge.siteFavorites).toHaveLength(1);

  await hub.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByRole("region", { name: "Live site workspace" })).toBeVisible();
  await expect.poll(() => bridge.browserControls.at(-1)).toMatchObject({ type: "navigate", url: "https://example.test/dashboard" });
});

test("records a confirmed touch flow, marks an issue, reviews it, and sends one exact QA report", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: /^Site/ }).click();
  await page.getByRole("main", { name: "Sites" }).getByRole("button", { name: "Open Component lab" }).click();

  await page.getByRole("button", { name: "Record flow" }).click();
  const canvas = page.locator(".cp-browser-site__canvas");
  await dragSiteCanvas(canvas, "touch", [[.58, .73], [.56, .62], [.53, .47], [.50, .31]]);
  await expect.poll(() => bridge.browserControls.at(-1)).toMatchObject({ type: "scroll", recorded: true });
  await expect(page.getByText("1 steps", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Mark issue" }).click();
  await dragSiteCanvas(canvas, "pen", [[.34, .40], [.43, .48], [.55, .46], [.66, .54]]);
  await page.getByPlaceholder("Explain the visible problem").fill("The result panel disappears after the scroll.");
  await page.getByRole("button", { name: "Save & review" }).click();

  await expect(page.getByRole("heading", { name: "Review recording" })).toBeVisible();
  await expect(page.getByText("The result panel disappears after the scroll.")).toBeVisible();
  await page.getByRole("button", { name: "Send to agent" }).click();
  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("sendReview");
  expect(String(bridge.commands.at(-1)?.instruction)).toContain("Nerva Site QA recording (version 1)");
});

test("keeps following Mac after a definitive iPad navigation failure", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  bridge.failNextCommand("Managed app-server reconnect is backing off after a failed attempt");

  await page.getByRole("button", { name: /Open Research queue/ }).click();
  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Command not accepted");

  bridge.selectOnMac(1);
  await expect(page.getByRole("heading", { name: "Bridge hardening", level: 1 })).toBeVisible();
  bridge.selectOnMac(2);
  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
});

test("keeps Home spacious with 0, 1, 6, and 12 pinned sessions in both layouts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iPad landscape", "Density coverage is viewport-independent; responsive projects cover the same Home separately.");
  test.setTimeout(60_000);

  const bridge = new MockBridge({ authorized: false });
  let sequence = 90;
  let sessionsFixture = sessionsForPinnedCount(0, sequence);
  bridge.setSessionsFixture(sessionsFixture, []);
  await bridge.install(page);

  await page.goto("/pair?nonce=fixture-density-code");
  await seedHomeLayout(page, sessionsFixture, 0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  for (const [index, count] of [0, 1, 6, 12].entries()) {
    sequence += 1;
    sessionsFixture = sessionsForPinnedCount(count, sequence);
    bridge.setSessionsFixture(
      sessionsFixture,
      sessionsFixture.data.sessions.slice(0, count).map((session) => session.threadId),
    );
    if (index > 0) {
      await seedHomeLayout(page, sessionsFixture, count);
      await page.reload();
    }
    await showHome(page);
    await expect(page.locator(".cp-session-card")).toHaveCount(count);
    await page.getByRole("button", { name: "Show priority sessions" }).click();
    const priorityCount = count === 0 ? 4 : count === 1 ? 5 : count;
    await expect(page.locator(".cp-session-card")).toHaveCount(priorityCount);
    await page.getByRole("button", { name: "Show priority sessions" }).click();
  }
});

test("preserves pinned identities when a catalog cannot prove deletion", async ({ page }) => {
  const bridge = new MockBridge({ authorized: false });
  const fixture = fixtureSessions({ sequence: 94, selectedIndex: 0 });
  const missingPinned = [
    "019f7ec2-68eb-7183-bb3a-0e67312aff01",
    "019f7ec2-68eb-7183-bb3a-0e67312aff02",
  ];
  bridge.setSessionsFixture(fixture, [THREADS[0].id, ...missingPinned]);
  await bridge.install(page);

  await page.goto("/pair?nonce=fixture-missing-pins-code");
  await seedHomeLayoutThreadIds(page, [THREADS[0].id, ...missingPinned]);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await showHome(page);

  await expect(page.locator(".cp-session-card")).toHaveCount(1);
  await expect(page.getByText("Pinned session", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/temporarily unavailable/)).toHaveCount(0);
  await expect.poll(() => bridge.pinnedThreadIds).toEqual([THREADS[0].id, ...missingPinned]);

  await page.reload();
  await showHome(page);
  await expect(page.locator(".cp-session-card")).toHaveCount(1);
});

test("keeps a pinned card visible through a transient partial catalog", async ({ page }) => {
  const bridge = new MockBridge({ authorized: false });
  const complete = fixtureSessions({ sequence: 95, selectedIndex: 0 });
  bridge.setSessionsFixture(complete, [CATALOG_SESSION.id]);
  await bridge.install(page);

  await page.goto("/pair?nonce=fixture-partial-catalog");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await showHome(page);
  await expect(page.getByRole("button", { name: /Open Catalog reference/ })).toBeVisible();

  bridge.setCatalogFixture({
    ...complete,
    data: { ...complete.data, sequence: 96, sessions: complete.data.sessions.slice(0, 2) },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));

  await expect(page.getByRole("button", { name: /Open Catalog reference/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open Catalog reference/ })).toContainText("Status unavailable");
  expect(bridge.pinnedThreadIds).toEqual([CATALOG_SESSION.id]);
});

test("persists a pin change when the installed app reloads immediately", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Research queue/ }).click();
  await page.getByRole("button", { name: "Unpin from Home" }).click();
  await expect(page.getByRole("button", { name: "Pin to Home" })).toBeVisible();

  await page.reload();
  await showHome(page);

  await expect(page.getByRole("button", { name: /Open Research queue/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Unpinned Sessions/ }).click();
  await expect(page.getByRole("dialog", { name: "Unpinned Sessions" })).toContainText("Research queue");
});

test("replays unsynchronized Model + Reasoning presets after reload instead of losing them", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  bridge.makeNextProductStateSaveFail();
  await page.getByRole("button", { name: "Open Settings" }).click();
  await page.getByRole("button", { name: "Add preset" }).click();
  await page.getByLabel("Model").selectOption("gpt-test-pro");
  await page.getByLabel("Reasoning").selectOption("xhigh");
  await page.getByRole("button", { name: "Add preset" }).click();
  await expect.poll(() => bridge.productStateSaveRequests).toBeGreaterThan(0);
  expect(bridge.modelReasoningPresets).toHaveLength(0);

  await page.reload();
  await showHome(page);
  await expect.poll(() => bridge.modelReasoningPresets).toHaveLength(1);
  await page.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByText("GPT Test Pro", { exact: true })).toBeVisible();
});

test("recovers a locally retained preset list once after the historical empty-list overwrite", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("codex-pad.ui-preferences.v1", JSON.stringify({
      modelReasoningPresets: [{
        id: "retained-pro-high",
        model: "gpt-test-pro",
        reasoning: "high",
        enabled: true,
      }],
    }));
  });
  const bridge = await openAuthenticatedApp(page);

  await expect.poll(() => bridge.modelReasoningPresets).toEqual([{
    id: "retained-pro-high",
    model: "gpt-test-pro",
    reasoning: "high",
    enabled: true,
  }]);
});

test("merges a local layout change with newer presets saved by another client", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  bridge.setExternalModelReasoningPresets([{
    id: "external-pro-high",
    model: "gpt-test-pro",
    reasoning: "high",
    enabled: true,
  }]);
  const savesBeforeChange = bridge.productStateSaveRequests;

  await page.getByRole("button", { name: "New section", exact: true }).click();
  await page.getByPlaceholder("Section name").fill("Synced layout");
  await page.getByRole("button", { name: "Create section" }).click();

  await expect.poll(() => bridge.productStateSaveRequests).toBeGreaterThanOrEqual(savesBeforeChange + 2);
  expect(bridge.modelReasoningPresets).toEqual([{
    id: "external-pro-high",
    model: "gpt-test-pro",
    reasoning: "high",
    enabled: true,
  }]);
});

test("preserves manual cases while using status filters", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: "New section", exact: true }).click();
  await page.getByPlaceholder("Section name").fill("Today");
  await page.getByRole("button", { name: "Create section" }).click();
  await page.getByRole("button", { name: "Add case" }).click();
  await page.getByPlaceholder("Case name").fill("Interface");
  await page.getByRole("button", { name: "Add case" }).click();
  await page.getByRole("button", { name: "More actions for Release checklist" }).click();
  await page.getByLabel("Move Release checklist").selectOption({ label: "Today / Interface" });
  await expect(page.locator(".cp-home-case").filter({ hasText: "Interface" })).toContainText("Release checklist");

  await page.getByRole("button", { name: /Working 1/ }).click();
  await expect(page.locator(".cp-focused-sessions .cp-session-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Open Bridge hardening/ })).toBeVisible();
  await page.getByRole("button", { name: /Working 1/ }).click();
  await expect(page.locator(".cp-home-case").filter({ hasText: "Interface" })).toContainText("Release checklist");
});

test("starts and stops Mac dictation with two deliberate taps", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: /^Dictation/ }).click();
  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("runMicroAction");
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedThreadId: THREADS[0].id,
    expectedKeycapId: "MIC",
    expectedNativeCommandId: "dictation.toggle",
    gesture: "begin",
  });
  const gestureId = bridge.commands.at(-1)?.commandId;
  await expect(page.getByRole("button", { name: /^Stop Dictation/ })).toBeEnabled();

  await page.getByRole("button", { name: /^Stop Dictation/ }).click();
  await expect.poll(() => bridge.commands.length).toBeGreaterThanOrEqual(2);
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedThreadId: THREADS[0].id,
    expectedKeycapId: "MIC",
    expectedNativeCommandId: "dictation.toggle",
    gesture: "end",
    gestureId,
  });
  await expect(page.getByRole("button", { name: /^Dictation/ })).toBeEnabled();
  await expect(page.getByText(/iPad microphone|audio capture/i)).toHaveCount(0);
});

test("submits the current Mac composer from the compact iPad Send prompt control", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  const sendPrompt = page.getByRole("button", { name: "Send prompt", exact: true });
  await expect.poll(async () => (await sendPrompt.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await sendPrompt.click();

  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("runMicroAction");
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedThreadId: THREADS[0].id,
    actionSlot: "ACT12",
    expectedKeycapId: "CODEX",
    expectedNativeCommandId: "composer.submit",
  });
});

test("finishes active Mac dictation before Send prompt submits the composer", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  const commandBaseline = bridge.commands.length;
  await page.getByRole("button", { name: /^Dictation/ }).click();
  await expect.poll(() => bridge.commands.length).toBe(commandBaseline + 1);
  const gestureId = bridge.commands[commandBaseline]?.commandId;

  await page.getByRole("button", { name: "Send prompt", exact: true }).click();

  await expect.poll(() => bridge.commands.length).toBe(commandBaseline + 3);
  expect(bridge.commands[commandBaseline + 1]).toMatchObject({
    expectedThreadId: THREADS[0].id,
    expectedKeycapId: "MIC",
    expectedNativeCommandId: "dictation.toggle",
    gesture: "end",
    gestureId,
  });
  expect(bridge.commands[commandBaseline + 2]).toMatchObject({
    expectedThreadId: THREADS[0].id,
    actionSlot: "ACT12",
    expectedKeycapId: "CODEX",
    expectedNativeCommandId: "composer.submit",
  });
  await expect(page.getByRole("button", { name: /^Dictation/ })).toBeEnabled();
});

test("groups multi-skill providers while keeping singleton skills directly visible", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: /Skills/ }).click();

  const groups = page.locator(".cp-skill-group");
  await expect(groups).toHaveCount(1);
  await expect(groups).toContainText(["OpenAI Templates"]);
  await expect(page.locator(".cp-skill-option--standalone")).toHaveCount(4);
  await expect(page.locator(".cp-skill-option--standalone")).toContainText(["Computer use", "Fix GitHub CI", "Visual review", "OpenAI docs"]);

  await groups.filter({ hasText: "OpenAI Templates" }).locator(".cp-skill-group__header").click();
  await expect(page.locator(".cp-skill-option")).toHaveCount(6);
  await page.getByRole("button", { name: /Project kickoff/ }).click();
  await expect(page.locator(".cp-skill-chips")).toContainText("artifact-template-project-kickoff");
  await expect(groups.filter({ hasText: "OpenAI Templates" }).locator(".cp-skill-group__header")).toContainText("1 selected");
});

test("commits a Pencil stroke when iPadOS ends pointer capture so Send becomes available", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  const canvas = page.getByRole("img", { name: /^Sketch canvas/ });
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Sketch canvas has no rendered bounds");

  await canvas.dispatchEvent("pointerdown", {
    pointerId: 71,
    pointerType: "pen",
    isPrimary: true,
    button: 0,
    buttons: 1,
    pressure: .7,
    clientX: box.x + box.width * .3,
    clientY: box.y + box.height * .4,
  });
  await canvas.dispatchEvent("pointermove", {
    pointerId: 71,
    pointerType: "pen",
    isPrimary: true,
    button: -1,
    buttons: 1,
    pressure: .7,
    clientX: box.x + box.width * .65,
    clientY: box.y + box.height * .55,
  });
  await canvas.dispatchEvent("lostpointercapture", {
    pointerId: 71,
    pointerType: "pen",
    isPrimary: true,
    button: 0,
    buttons: 0,
    pressure: 0,
    clientX: box.x + box.width * .65,
    clientY: box.y + box.height * .55,
  });

  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("pans the infinite board with an imperfect two-finger gesture and exposes area export", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  const canvas = page.getByRole("img", { name: /^Sketch canvas/ });
  await drawPenStroke(canvas);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Sketch canvas has no rendered bounds");
  const touch = async (type: "pointerdown" | "pointermove" | "pointerup", pointerId: number, x: number, y: number) => {
    await canvas.dispatchEvent(type, {
      pointerId,
      pointerType: "touch",
      isPrimary: pointerId === 81,
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" ? 0 : 1,
      pressure: type === "pointerup" ? 0 : 0.5,
      clientX: box.x + box.width * x,
      clientY: box.y + box.height * y,
    });
  };
  await touch("pointerdown", 81, 0.35, 0.42);
  await touch("pointerdown", 82, 0.62, 0.58);
  await touch("pointermove", 81, 0.48, 0.31);
  await touch("pointermove", 82, 0.76, 0.45);
  await expect(page.getByRole("application", { name: /Board minimap/ })).toBeVisible();
  await touch("pointerup", 81, 0.48, 0.31);
  await touch("pointerup", 82, 0.76, 0.45);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("radio", { name: /Select area/ }).click();
  await expect(page.getByLabel("Selected export area. Drag to move.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resize selected area" })).toBeVisible();
});

test("explains a large tiled board without adding mandatory send steps", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    id: `package-node-${index}`,
    label: `Structured architecture block ${index} with exact responsibility`,
    x: index % 2 === 0 ? 20 : 3_720,
    y: 20 + (index % 8) * 100,
    width: 240,
    height: 96,
    shape: "rectangle",
    tone: "blue",
  }));
  bridge.setDiagrams([{
    version: 2,
    diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8bb2",
    threadId: THREADS[0].id,
    revision: 4,
    title: "Coherent package fixture",
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `package-edge-${index}`,
      from: nodes[index]!.id,
      to: node.id,
      label: "cross-region handoff",
      style: "solid",
    })),
    createdAt: 1,
    updatedAt: 2,
    createdBy: "codex",
    lastEditedBy: "ipad",
    sourceLabel: "Playwright agent",
  }]);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText("1 compatibility atlas · Overview detail")).toBeVisible();
  await expect(page.getByText("Inspect package")).toBeVisible();
  await page.getByText("Inspect package").click();
  const packageInspector = page.locator(".drawing-send-sheet__regions");
  await expect(packageInspector).toContainText("Structure index included");
  await expect(packageInspector).toContainText("A1");
  await expect(packageInspector).toContainText("A4");
  await expect(page.getByRole("button", { name: "Prepare & Send" })).toBeVisible();
});

test("round-trips one exact-task agent diagram through structural touch edits and Pencil annotation", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  const agentDiagram = {
    version: 1,
    diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
    threadId: THREADS[0].id,
    revision: 0,
    title: "Agent collaboration loop",
    nodes: [
      { id: "codex", label: "Codex proposes", x: 160, y: 210, width: 280, height: 116, shape: "rectangle", tone: "blue" },
      { id: "nerva", label: "Nerva refines", x: 760, y: 210, width: 280, height: 116, shape: "ellipse", tone: "violet" },
    ],
    edges: [
      { id: "handoff", from: "codex", to: "nerva", label: "structured revision", style: "solid" },
    ],
    createdAt: 1,
    updatedAt: 1,
    createdBy: "codex",
    lastEditedBy: "codex",
    sourceLabel: "Playwright agent",
  };
  bridge.setDiagrams([agentDiagram]);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();

  await expect(page.getByRole("button", { name: "Edit selected diagram block" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Diagram title" })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Diagram synced" })).toContainText("Synced");
  const sketchCanvas = page.getByRole("img", { name: /^Sketch canvas/ });
  const canvasBeforeInspector = await sketchCanvas.boundingBox();
  const diagramDock = await page.locator(".drawing-diagram-dock").boundingBox();
  if (!canvasBeforeInspector || !diagramDock) throw new Error("Diagram canvas and dock need measurable bounds");
  expect(canvasBeforeInspector.y + canvasBeforeInspector.height).toBeLessThanOrEqual(diagramDock.y + 2);
  const firstNode = page.locator(".diagram-node-hitbox").first();
  const box = await firstNode.boundingBox();
  if (!box) throw new Error("Diagram node has no rendered bounds");
  await firstNode.dispatchEvent("pointerdown", {
    pointerId: 301,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: box.x + box.width * .5,
    clientY: box.y + box.height * .5,
  });
  await firstNode.dispatchEvent("pointermove", {
    pointerId: 301,
    pointerType: "touch",
    isPrimary: true,
    button: -1,
    buttons: 1,
    clientX: box.x + box.width * .5 + 38,
    clientY: box.y + box.height * .5 + 21,
  });
  await firstNode.dispatchEvent("pointerup", {
    pointerId: 301,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: box.x + box.width * .5 + 38,
    clientY: box.y + box.height * .5 + 21,
  });
  await expect(page.getByRole("button", { name: "Sync revision" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Selected block" })).toBeVisible();
  const inspector = page.locator(".drawing-diagram-panel");
  const viewport = page.viewportSize();
  if ((viewport?.width ?? 0) <= 700) {
    await expect(page.locator(".drawing-canvas")).toHaveCSS("visibility", "hidden");
  } else {
    const canvasWithInspector = await sketchCanvas.boundingBox();
    const inspectorBounds = await inspector.boundingBox();
    if (!canvasWithInspector || !inspectorBounds) throw new Error("Canvas and inspector need measurable bounds");
    expect(canvasWithInspector.x + canvasWithInspector.width).toBeLessThanOrEqual(inspectorBounds.x + 1);
  }
  await expect(page.getByRole("textbox", { name: "Diagram title" })).toHaveCount(0);
  await page.getByRole("tab", { name: "More" }).click();
  await expect(page.getByRole("textbox", { name: "Diagram title" })).toHaveValue("Agent collaboration loop");

  await page.getByRole("button", { name: "Close inspector and draw" }).click();
  await drawPenStroke(page.getByRole("img", { name: /^Sketch canvas/ }));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Prepare & Send" }).click();

  await expect.poll(
    () => bridge.diagramUpdateRequests,
    { timeout: 15_000, message: "dirty diagram revision should synchronize before image attachment" },
  ).toBe(1);
  await expect.poll(
    () => bridge.commands.at(-1)?.type,
    { timeout: 15_000, message: "combined diagram and Pencil image should attach after PNG preparation" },
  ).toBe("sendSketch");
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toBeHidden();

  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByText("Apple Pencil ready")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Diagram title" })).toHaveCount(0);
});

test("keeps every drawing tool illustration optically centered and unclipped", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  bridge.setDiagrams([{
    version: 1,
    diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba2",
    threadId: THREADS[0].id,
    revision: 0,
    title: "Alignment fixture",
    nodes: [
      { id: "one", label: "One", x: 240, y: 220, width: 280, height: 116, shape: "rectangle", tone: "blue" },
    ],
    edges: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: "codex",
    lastEditedBy: "codex",
    sourceLabel: "Playwright agent",
  }]);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("button", { name: "Draw on top" })).toBeVisible();

  const dockMetrics = await page.locator(".drawing-diagram-dock button").evaluateAll((buttons) => (
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      const icon = button.querySelector(".drawing-icon")?.getBoundingClientRect();
      const label = button.querySelector("span:last-child")?.getBoundingClientRect();
      const pieces = [icon, label].filter((piece): piece is DOMRect => Boolean(piece));
      const left = Math.min(...pieces.map((piece) => piece.left));
      const right = Math.max(...pieces.map((piece) => piece.right));
      const top = Math.min(...pieces.map((piece) => piece.top));
      const bottom = Math.max(...pieces.map((piece) => piece.bottom));
      return {
        name: button.getAttribute("aria-label"),
        width: bounds.width,
        height: bounds.height,
        centerX: (left + right) / 2 - (bounds.left + bounds.width / 2),
        centerY: (top + bottom) / 2 - (bounds.top + bounds.height / 2),
      };
    })
  ));
  for (const metric of dockMetrics) {
    expect(metric.width, `${metric.name} touch width`).toBeGreaterThanOrEqual(44);
    expect(metric.height, `${metric.name} touch height`).toBeGreaterThanOrEqual(44);
    expect(Math.abs(metric.centerX), `${metric.name} horizontal optical center`).toBeLessThanOrEqual(1);
    expect(Math.abs(metric.centerY), `${metric.name} vertical optical center`).toBeLessThanOrEqual(1);
  }

  await page.getByRole("button", { name: "Draw on top" }).click();
  const toolMetrics = await page.locator(".drawing-tool").evaluateAll((buttons) => (
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      const icon = button.querySelector(".drawing-tool__glyph")?.getBoundingClientRect();
      const label = button.querySelector<HTMLElement>(".drawing-tool__label");
      const labelBounds = label?.getBoundingClientRect();
      const pieces = [icon, labelBounds].filter((piece): piece is DOMRect => Boolean(piece));
      const left = Math.min(...pieces.map((piece) => piece.left));
      const right = Math.max(...pieces.map((piece) => piece.right));
      const top = Math.min(...pieces.map((piece) => piece.top));
      const bottom = Math.max(...pieces.map((piece) => piece.bottom));
      return {
        name: button.getAttribute("aria-label"),
        width: bounds.width,
        height: bounds.height,
        centerX: (left + right) / 2 - (bounds.left + bounds.width / 2),
        centerY: (top + bottom) / 2 - (bounds.top + bounds.height / 2),
        labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : true,
      };
    })
  ));
  for (const metric of toolMetrics) {
    expect(metric.width, `${metric.name} touch width`).toBeGreaterThanOrEqual(44);
    expect(metric.height, `${metric.name} touch height`).toBeGreaterThanOrEqual(44);
    expect(Math.abs(metric.centerX), `${metric.name} horizontal optical center`).toBeLessThanOrEqual(1);
    expect(Math.abs(metric.centerY), `${metric.name} vertical optical center`).toBeLessThanOrEqual(1);
    expect(metric.labelClipped, `${metric.name} label clipping`).toBe(false);
  }

  const iconOnlyMetrics = await page.locator([
    ".drawing-studio__close",
    ".drawing-tools__history button",
    ".drawing-zoom button:first-child",
    ".drawing-zoom button:last-child",
  ].join(",")).evaluateAll((buttons) => (
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      const icon = button.querySelector(".drawing-icon")?.getBoundingClientRect();
      return {
        name: button.getAttribute("aria-label"),
        centerX: icon ? icon.left + icon.width / 2 - (bounds.left + bounds.width / 2) : Number.POSITIVE_INFINITY,
        centerY: icon ? icon.top + icon.height / 2 - (bounds.top + bounds.height / 2) : Number.POSITIVE_INFINITY,
      };
    })
  ));
  for (const metric of iconOnlyMetrics) {
    expect(Math.abs(metric.centerX), `${metric.name} horizontal icon center`).toBeLessThanOrEqual(1);
    expect(Math.abs(metric.centerY), `${metric.name} vertical icon center`).toBeLessThanOrEqual(1);
  }
});

test("keeps the visible Pencil stroke when palm rejection cancels the active pointer", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  const canvas = page.getByRole("img", { name: /^Sketch canvas/ });
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Sketch canvas has no rendered bounds");

  await canvas.dispatchEvent("pointerdown", {
    pointerId: 81,
    pointerType: "pen",
    isPrimary: true,
    button: 0,
    buttons: 1,
    pressure: .72,
    clientX: box.x + box.width * .28,
    clientY: box.y + box.height * .38,
  });
  await canvas.dispatchEvent("pointermove", {
    pointerId: 81,
    pointerType: "pen",
    isPrimary: true,
    button: -1,
    buttons: 1,
    pressure: .68,
    clientX: box.x + box.width * .62,
    clientY: box.y + box.height * .54,
  });
  await canvas.dispatchEvent("pointerdown", {
    pointerId: 82,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    pressure: 1,
    width: 48,
    height: 48,
    clientX: box.x + box.width * .12,
    clientY: box.y + box.height * .8,
  });
  await canvas.dispatchEvent("pointercancel", {
    pointerId: 81,
    pointerType: "pen",
    isPrimary: true,
    button: 0,
    buttons: 0,
    pressure: 0,
    clientX: box.x + box.width * .62,
    clientY: box.y + box.height * .54,
  });

  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("returns to the followed Session when the Mac changes task during Draw", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toBeVisible();
  await drawPenStroke(page.getByRole("img", { name: /^Sketch canvas/ }));

  bridge.selectOnMac(1);

  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Bridge hardening", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dictation Tap to start on the Mac" })).toBeVisible();

  bridge.selectOnMac(0);
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toContainText("Draft restored on this iPad");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("follows the current Mac task immediately after leaving Stay mode", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Following Mac" }).click();

  bridge.selectOnMac(1);
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Staying here" }).click();
  await expect(page.getByRole("heading", { name: "Bridge hardening", level: 1 })).toBeVisible();
});

test("keeps local drawing available for a Mac task outside the six native Micro slots", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();

  bridge.selectOutsideNativeSixOnMac(CATALOG_SESSION.id);

  await expect(page.getByRole("heading", { name: "Catalog reference", level: 1 })).toBeVisible();
  await expect(page.getByText("Display only", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draw Start a local canvas" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Photo Camera, Library, or Files" })).toBeEnabled();

  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toBeVisible();
  await drawPenStroke(page.getByRole("img", { name: /^Sketch canvas/ }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByText("Reconnect to the Mac before attaching this image.")).toBeVisible();
});

test("recovers Draw Send and Model + Reasoning without waiting for a native snapshot change", async ({ page }) => {
  const bridge = new MockBridge({ authorized: false });
  bridge.setCapabilitiesAvailable(false);
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-capability-recovery");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();

  const modelSlider = page.getByRole("slider", { name: "Model and reasoning preset" });
  await expect(modelSlider).toBeDisabled();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await drawPenStroke(page.getByRole("img", { name: /^Sketch canvas/ }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

  bridge.setCapabilitiesAvailable(true);

  // Capabilities poll every two seconds. Allow one delayed WebKit turn on a
  // contended CI worker while still proving recovery without a new snapshot.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 6_000 });
  await page.getByRole("button", { name: "Close drawing studio" }).click();
  await expect(modelSlider).toBeEnabled();
  expect(bridge.capabilitiesRequests).toBeGreaterThan(1);
});

test("applies one exact live Model + Reasoning preset", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  const slider = page.getByRole("slider", { name: "Model and reasoning preset" });
  await slider.focus();
  await slider.press("End");
  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("setModelReasoning");
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedThreadId: THREADS[0].id,
    model: "gpt-test-pro",
    effort: "xhigh",
  });
});

test("applies the final touch slider value when Safari reports input after pointerup", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  const slider = page.getByRole("slider", { name: "Model and reasoning preset" });
  await expect(slider).toBeEnabled();

  await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    valueSetter?.call(input, input.max);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect.poll(() => bridge.commands.filter((command) => command.type === "setModelReasoning").length).toBe(1);
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedThreadId: THREADS[0].id,
    model: "gpt-test-pro",
    effort: "xhigh",
  });
});

test("keeps a Pencil drawing globally and reopens an independent working copy", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  const canvas = page.getByRole("img", { name: /^Sketch canvas/ });
  await drawPenStroke(canvas);
  await expect.poll(() => canvas.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.userSelect || style.getPropertyValue("-webkit-user-select");
  })).toBe("none");
  await expect.poll(() => page.locator(".drawing-studio").evaluate((element) => {
    const event = new Event("selectstart", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  await page.getByRole("button", { name: "Keep in Saved Drawings" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toContainText("Kept in Saved Drawings on the Mac");
  await page.getByRole("button", { name: "Close drawing studio" }).click();

  await page.getByRole("button", { name: "Saved Drawings" }).click();
  await expect(page.getByRole("dialog", { name: "Saved Drawings" })).toContainText("Untitled drawing");
  await page.getByRole("button", { name: "Use in current session" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toContainText("independent local working copy");
});

test("keeps cleared marks deleted when Photo imports a new background", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await drawPenStroke(page.getByRole("img", { name: /^Sketch canvas/ }));
  await page.getByRole("button", { name: "Close drawing studio" }).click();

  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toContainText("Draft restored on this iPad");
  await page.getByRole("button", { name: "Clear page…" }).click();
  await page.getByRole("button", { name: "Clear page", exact: true }).click();
  await expect(page.getByText("Apple Pencil ready")).toBeVisible();

  await page.getByRole("button", { name: "Photo / File" }).click();
  await page.locator('.drawing-studio input[type="file"]:not([capture])').first().setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1X1, "base64"),
  });
  await expect(page.getByText("replacement.png added behind your annotations")).toBeVisible();
  await page.getByRole("button", { name: "Close drawing studio" }).click();

  await expect.poll(() => page.evaluate(async (threadId) => {
    const request = indexedDB.open("codex-pad-drawings");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const activeRead = database.transaction("active-boards", "readonly").objectStore("active-boards").get(threadId);
    const active = await new Promise<{ boardId?: string } | undefined>((resolve, reject) => {
      activeRead.onsuccess = () => resolve(activeRead.result as { boardId?: string } | undefined);
      activeRead.onerror = () => reject(activeRead.error);
    });
    if (typeof active?.boardId !== "string") { database.close(); return []; }
    const read = database.transaction("board-elements", "readonly").objectStore("board-elements").index("boardId").getAll(active.boardId);
    const stored = await new Promise<Array<{ json?: string }>>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result as Array<{ json?: string }>);
      read.onerror = () => reject(read.error);
    });
    database.close();
    return stored.map((record) => typeof record.json === "string" ? (JSON.parse(record.json) as { kind?: unknown }).kind : null);
  }, THREADS[0].id)).toEqual(["image"]);
});

test("attaches a drawing to the Mac composer without text even when a skill is armed", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await page.getByRole("button", { name: /Skills/ }).click();
  await page.getByRole("button", { name: /Visual review/ }).click();
  await page.getByRole("button", { name: "Close Skills" }).click();
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await drawPenStroke(page.getByRole("img", { name: /^Sketch canvas/ }));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Prepare & Send" }).click();

  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("sendSketch");
  expect(bridge.commands.at(-1)?.instruction).toBe("");
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toBeHidden();
  await expect.poll(() => page.evaluate(async (threadId) => {
    const request = indexedDB.open("codex-pad-drawings");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("active-boards", "readonly");
    const read = transaction.objectStore("active-boards").get(threadId);
    const stored = await new Promise<unknown>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    database.close();
    return stored ?? null;
  }, THREADS[0].id)).toBeNull();

  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).not.toContainText("Draft restored on this iPad");
  await expect(page.getByText("Apple Pencil ready")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

test("approves only the exact pending request tuple", async ({ page }) => {
  const bridge = await openAuthenticatedApp(page);
  await page.getByRole("button", { name: /Open Approval audit/ }).click();
  await page.getByRole("button", { name: /Approve/ }).click();
  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("respondToApproval");
  expect(bridge.commands.at(-1)).toMatchObject({
    expectedThreadId: THREADS[3].id,
    requestId: 991,
    turnId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb1",
    itemId: "approval-item-a",
    decision: "accept",
  });
});

test("shows real Settings controls and paired device management", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("This iPad", { exact: true })).toBeVisible();
  await expect(page.getByText("Background alerts", { exact: true })).toBeVisible();
  await expect(page.getByText(/Only the moments that matter/)).toBeVisible();
  const systemDiagnostics = page.getByRole("button", { name: /Open System Diagnostics/ });
  await expect(systemDiagnostics).toBeVisible();
  const [diagnosticsButtonBounds, diagnosticsChevronBounds] = await Promise.all([
    systemDiagnostics.boundingBox(),
    systemDiagnostics.locator("svg").boundingBox(),
  ]);
  expect(diagnosticsButtonBounds).not.toBeNull();
  expect(diagnosticsChevronBounds).not.toBeNull();
  expect(diagnosticsButtonBounds!.height).toBeLessThanOrEqual(72);
  expect(diagnosticsChevronBounds!.width).toBeLessThanOrEqual(20);
  expect(diagnosticsChevronBounds!.height).toBeLessThanOrEqual(20);
  await page.getByRole("button", { name: "Add preset" }).click();
  await expect(page.getByLabel("Model")).toContainText("GPT Test");
  await expect(page.getByLabel("Model")).toContainText("GPT Test Pro");
  await expect(page.getByText("Model identifier", { exact: true })).toHaveCount(0);
  await page.getByLabel("Model").selectOption("gpt-test-pro");
  await page.getByLabel("Reasoning").selectOption("xhigh");
  await page.getByRole("button", { name: "Add preset" }).click();
  await expect(page.getByText("GPT Test Pro", { exact: true })).toBeVisible();
  await page.getByLabel("Theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /Saved Drawings/ }).click();
  await expect(page.getByRole("dialog", { name: "Saved Drawings" })).toBeVisible();
});

test("shows privacy-safe live capability proof", async ({ page }) => {
  await openAuthenticatedApp(page);
  await page.getByRole("button", { name: "Open Settings" }).click();
  await page.getByRole("button", { name: /Open System Diagnostics/ }).click();
  const center = page.getByRole("dialog", { name: "System Diagnostics" });
  await expect(center).toBeVisible();
  await expect(center.getByText("Native controls", { exact: true })).toBeVisible();
  await expect(center.getByText("Composer attachment", { exact: true })).toBeVisible();
  await expect(center.getByText("Skills and models", { exact: true })).toBeVisible();
  await expect(center.getByText("Installed schema: current")).toBeVisible();
  await expect(center).not.toContainText("bearerToken");
  await expect(center).not.toContainText(THREADS[0].id);
});

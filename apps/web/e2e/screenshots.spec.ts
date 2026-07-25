import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { MockBridge } from "./mock-bridge";
import { THREADS, fixtureSessions } from "./fixture-data";

const CAPTURE_SCREENSHOTS = process.env.CODEX_PAD_CAPTURE_SCREENSHOTS === "1";
const SCREENSHOT_NOW = Date.parse("2026-07-25T19:00:00.000Z");
const SCREENSHOT_DIAGRAM = {
  version: 1,
  diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
  threadId: THREADS[0].id,
  revision: 0,
  title: "Collaborative agent workflow",
  nodes: [
    { id: "brief", label: "Share the goal", x: 90, y: 150, width: 270, height: 110, shape: "rectangle", tone: "neutral" },
    { id: "codex", label: "Codex drafts the structure", x: 570, y: 120, width: 320, height: 140, shape: "rectangle", tone: "blue" },
    { id: "nerva", label: "Refine with touch and Pencil", x: 1_040, y: 150, width: 300, height: 110, shape: "ellipse", tone: "violet" },
    { id: "continue", label: "Continue from the exact revision", x: 570, y: 570, width: 320, height: 130, shape: "rectangle", tone: "green" },
  ],
  edges: [
    { id: "brief_codex", from: "brief", to: "codex", label: "prompt", style: "solid" },
    { id: "codex_nerva", from: "codex", to: "nerva", label: "publish", style: "solid" },
    { id: "nerva_continue", from: "nerva", to: "continue", label: "sync revision", style: "solid" },
    { id: "continue_codex", from: "continue", to: "codex", label: "continue", style: "dashed" },
  ],
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_000_001,
  createdBy: "codex",
  lastEditedBy: "codex",
  sourceLabel: "Codex",
} as const;

async function resetViewportScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo({ left: 0, top: 0 });
    document.querySelector<HTMLElement>(".cp-app-content")?.scrollTo({ left: 0, top: 0 });
    document.querySelector<HTMLElement>(".drawing-studio")?.scrollTo({ left: 0, top: 0 });
  });
}

async function markCanvas(canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas has no rendered bounds");
  const points = [[0.24, 0.42], [0.38, 0.31], [0.52, 0.58], [0.7, 0.37]] as const;
  for (const [index, [x, y]] of points.entries()) {
    await canvas.dispatchEvent(index === 0 ? "pointerdown" : index === points.length - 1 ? "pointerup" : "pointermove", {
      pointerId: 77,
      pointerType: "pen",
      isPrimary: true,
      button: index === 0 || index === points.length - 1 ? 0 : -1,
      buttons: index === points.length - 1 ? 0 : 1,
      pressure: index === points.length - 1 ? 0 : 0.65,
      clientX: box.x + box.width * x,
      clientY: box.y + box.height * y,
    });
  }
}

function screenshotSuffix(projectName: string): string | null {
  if (projectName === "iPad landscape") return "";
  if (projectName === "iPad portrait") return "-portrait";
  if (projectName === "iPhone") return "-phone";
  return null;
}

async function installScreenshotSite(page: Page): Promise<void> {
  const association = {
    associationId: "release_preview",
    threadId: THREADS[0].id,
    projectId: THREADS[0].projectId,
    name: "Codex Pad preview",
    origin: "https://preview.example.test",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_001,
    capabilities: {
      state: "degraded",
      canCaptureFrames: false,
      canSendReview: true,
      supportsInlinePng: true,
      supportsUploadRefs: false,
      maxFrames: 12,
      maxFrameBytes: 8 * 1024 * 1024,
      maxTotalBytes: 24 * 1024 * 1024,
      reason: "Fixture review uses manual image import.",
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
  const sessions = fixtureSessions({ sequence: 73, selectedIndex: 0 });
  const withAssociation = sessions.data.sessions.map((session) => session.threadId === THREADS[0].id ? {
    ...session,
    siteAssociations: [association],
    siteAssociation: association,
  } : session);
  await page.route("**/api/sessions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...sessions, data: { ...sessions.data, sessions: withAssociation } }),
  }));
  await page.route("**/api/native-sessions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...sessions,
      data: {
        ...sessions.data,
        registryGeneration: 1,
        sessions: withAssociation.filter((session) => session.microSlot !== null),
      },
    }),
  }));
}

test("capture privacy-safe current iPad product screenshots", async ({ page }, testInfo) => {
  test.skip(!CAPTURE_SCREENSHOTS, "Generated only by npm run screenshots");
  const suffix = screenshotSuffix(testInfo.project.name);
  test.skip(suffix === null, "No screenshot naming profile for this project");

  await page.clock.setFixedTime(SCREENSHOT_NOW);
  const output = resolve(process.cwd(), "docs/screenshots");
  await mkdir(output, { recursive: true });
  const bridge = new MockBridge({ authorized: false, fixedNow: SCREENSHOT_NOW });
  bridge.setDiagrams([SCREENSHOT_DIAGRAM]);
  await bridge.install(page);
  await installScreenshotSite(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  await expect(page.getByRole("heading", { name: /Connect to/ })).toBeVisible();
  await page.waitForTimeout(650);
  await page.screenshot({ path: resolve(output, `pairing${suffix}.png`), scale: "css", animations: "disabled" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".cp-connection.phase-online")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();

  await resetViewportScroll(page);
  await page.screenshot({ path: resolve(output, `dashboard${suffix}.png`), scale: "css", animations: "disabled" });

  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Capture Inbox", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Note Catch a quick idea/ }).click();
  await page.getByLabel("Quick note text").fill("Toolbar shifts after rotating the iPad. Keep the current frame and compare it with the corrected layout.");
  await page.getByRole("button", { name: "Save to Inbox" }).click();
  await page.waitForTimeout(400);
  await resetViewportScroll(page);
  await page.screenshot({ path: resolve(output, `capture-inbox${suffix}.png`), scale: "css", animations: "disabled" });
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();

  await page.getByRole("button", { name: "Show priority sessions" }).click();
  await expect(page.getByRole("button", { name: "Show priority sessions" })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(550);
  await resetViewportScroll(page);
  await page.screenshot({ path: resolve(output, `dashboard-priority${suffix}.png`), scale: "css", animations: "disabled" });
  await page.getByRole("button", { name: "Show priority sessions" }).click();

  if (testInfo.project.name === "iPad landscape") {
    await page.getByRole("button", { name: /Open Research queue/ }).click();
    await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Review result" }).click();
    await expect(page.getByLabel("Multimodal review for Research queue")).toBeVisible();
    const dismissReviewCommandStatus = page.getByRole("button", { name: "Dismiss command status" });
    if (await dismissReviewCommandStatus.isVisible()) await dismissReviewCommandStatus.click();
    await resetViewportScroll(page);
    await page.screenshot({ path: resolve(output, "review.png"), scale: "css", animations: "disabled" });
    await page.getByRole("button", { name: "Close review" }).click();
    await page.getByRole("button", { name: "Open Nerva Home" }).click();
    await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
    await page.getByRole("button", { name: /Working 1/ }).click();
    await page.screenshot({ path: resolve(output, "dashboard-working.png"), scale: "css", animations: "disabled" });
    await page.getByRole("button", { name: /Working 1/ }).click();
    await page.getByRole("button", { name: "Open Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await page.waitForTimeout(550);
    await page.screenshot({ path: resolve(output, "settings.png"), scale: "css", animations: "disabled" });
    await page.locator(".cp-settings .cp-back-button").click();
    await page.getByRole("button", { name: "Open Settings" }).click();
    await page.getByLabel("Theme").selectOption("light");
    await page.locator(".cp-settings .cp-back-button").click();
    await page.screenshot({ path: resolve(output, "dashboard-light.png"), scale: "css", animations: "disabled" });
    await page.getByRole("button", { name: "Open Settings" }).click();
    await page.getByLabel("Theme").selectOption("dark");
    await page.locator(".cp-settings .cp-back-button").click();
  }

  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  const dismissCommandStatus = page.getByRole("button", { name: "Dismiss command status" });
  if (await dismissCommandStatus.isVisible()) await dismissCommandStatus.click();
  await resetViewportScroll(page);
  await page.screenshot({ path: resolve(output, `session${suffix}.png`), scale: "css", animations: "disabled" });

  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByText("Release checklist", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Select Toolbar shifts/ }).click();
  await resetViewportScroll(page);
  await page.screenshot({ path: resolve(output, `capture-inbox-session${suffix}.png`), scale: "css", animations: "disabled" });
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();

  if (testInfo.project.name === "iPad landscape") {
    await page.locator(".cp-skill-control > .cp-control-header").click();
    const openAiTemplates = page.locator(".cp-skill-group").filter({ hasText: "OpenAI Templates" });
    await expect(openAiTemplates).toHaveCount(1);
    await openAiTemplates.locator(".cp-skill-group__header").click();
    await page.screenshot({ path: resolve(output, "skills.png"), scale: "css", animations: "disabled" });
    await page.getByRole("button", { name: "Close Skills" }).click();
  }

  await page.getByRole("button", { name: /Site/ }).click();
  const sitesHub = page.getByRole("main", { name: "Sites" });
  await expect(sitesHub).toBeVisible();
  await page.screenshot({ path: resolve(output, `sites${suffix}.png`), scale: "css", animations: "disabled" });
  await sitesHub.getByRole("button", { name: "Open Component lab" }).click();
  await expect(page.getByLabel("Browse current Mac site")).toBeVisible();
  await page.screenshot({ path: resolve(output, `site${suffix}.png`), scale: "css", animations: "disabled" });

  if (testInfo.project.name === "iPad landscape") {
    await page.getByRole("button", { name: "Record flow" }).click();
    await page.getByRole("button", { name: "Mark issue" }).click();
    await markCanvas(page.getByLabel("Annotate current site frame"));
    await page.getByPlaceholder("Explain the visible problem").fill("The result panel disappears after the action.");
    await page.screenshot({ path: resolve(output, "site-qa-issue.png"), scale: "css", animations: "disabled" });
    await page.getByRole("button", { name: "Save & review" }).click();
    await expect(page.getByRole("heading", { name: "Review recording" })).toBeVisible();
    await page.screenshot({ path: resolve(output, "site-qa-review.png"), scale: "css", animations: "disabled" });
    await page.getByRole("button", { name: "Live page" }).click();
  }
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("main", { name: "Sites" }).getByRole("button", { name: "Session" }).click();

  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("button", { name: "Edit selected diagram block" })).toBeVisible();
  await page.getByRole("button", { name: "Draw on top" }).click();
  await markCanvas(page.getByRole("img", { name: /^Sketch canvas/ }));
  await page.getByRole("button", { name: "Edit diagram structure" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toContainText("Saved on this iPad");
  await page.getByRole("button", { name: "Keep in Saved Drawings" }).click();
  await expect(page.getByText("Kept in Saved Drawings on the Mac")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Keep in Saved Drawings" })).toBeEnabled();
  await resetViewportScroll(page);
  await page.screenshot({ path: resolve(output, `drawing${suffix}.png`), scale: "css", animations: "disabled" });
  if (testInfo.project.name === "iPad landscape") {
    await page.getByRole("button", { name: "Edit selected diagram block" }).click();
    await expect(page.getByRole("textbox", { name: "Selected block" })).toBeVisible();
    await page.screenshot({
      path: resolve(output, "drawing-diagram-inspector.png"),
      scale: "css",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Close diagram inspector" }).click();
  }
  await page.getByRole("button", { name: "Close drawing studio" }).click();
  await resetViewportScroll(page);
  await page.getByRole("button", { name: "Saved Drawings" }).click();
  await expect(page.getByRole("dialog", { name: "Saved Drawings" })).toContainText("Untitled drawing");
  await page.waitForTimeout(550);
  await page.screenshot({ path: resolve(output, `saved-drawings${suffix}.png`), scale: "css", animations: "disabled" });
});

test("capture the compact 768-wide iPad Home header", async ({ page }, testInfo) => {
  test.skip(!CAPTURE_SCREENSHOTS, "Generated only by npm run screenshots");
  test.skip(testInfo.project.name !== "iPad landscape", "One intermediate-width proof is sufficient");
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  await page.setViewportSize({ width: 768, height: 1_024 });
  const output = resolve(process.cwd(), "docs/screenshots");
  await mkdir(output, { recursive: true });
  const bridge = new MockBridge({ authorized: false, fixedNow: SCREENSHOT_NOW });
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
  await resetViewportScroll(page);
  await page.screenshot({
    path: resolve(output, "dashboard-compact-ipad.png"),
    scale: "css",
    animations: "disabled",
  });
});

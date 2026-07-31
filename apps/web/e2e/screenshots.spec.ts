import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { MockBridge } from "./mock-bridge";
import { THREADS, fixtureSessions } from "./fixture-data";

const CAPTURE_SCREENSHOTS = process.env.CODEX_PAD_CAPTURE_SCREENSHOTS === "1";
const SCREENSHOT_NOW = Date.parse("2026-07-25T19:00:00.000Z");
const SCREENSHOT_OUTPUT = resolve(
  process.cwd(),
  process.env.CODEX_PAD_SCREENSHOT_OUTPUT?.trim() || "docs/screenshots",
);
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

async function captureVerifiedScreenshot(page: Page, path: string): Promise<void> {
  const png = await page.screenshot({ path, scale: "css", animations: "disabled" });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Screenshot verification requires a fixed viewport");
  if (
    png.length < 24
    || png[0] !== 0x89
    || png.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error(`Screenshot ${path} is not a valid PNG`);
  }
  expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(viewport);

  const stats = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = document.createElement("canvas");
    sample.width = Math.min(48, image.naturalWidth);
    sample.height = Math.min(48, image.naturalHeight);
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Screenshot verification canvas is unavailable");
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let minimumLuminance = 255;
    let maximumLuminance = 0;
    let opaquePixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3]! === 0) continue;
      opaquePixels += 1;
      const luminance = pixels[index]! * 0.2126
        + pixels[index + 1]! * 0.7152
        + pixels[index + 2]! * 0.0722;
      minimumLuminance = Math.min(minimumLuminance, luminance);
      maximumLuminance = Math.max(maximumLuminance, luminance);
    }
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      minimumLuminance,
      maximumLuminance,
      opaquePixels,
    };
  }, png.toString("base64"));

  expect({ width: stats.width, height: stats.height }).toEqual(viewport);
  expect(stats.opaquePixels).toBeGreaterThan(0);
  expect(stats.maximumLuminance).toBeGreaterThan(40);
  expect(stats.maximumLuminance - stats.minimumLuminance).toBeGreaterThan(16);
}

async function hasPersistedDrawingElements(page: Page, threadId: string): Promise<boolean> {
  return page.evaluate(async (targetThreadId) => {
    const request = indexedDB.open("codex-pad-drawings");
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      request.onsuccess = () => resolveDatabase(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const activeRead = database
        .transaction("active-boards", "readonly")
        .objectStore("active-boards")
        .get(targetThreadId);
      const active = await new Promise<{ boardId?: string } | undefined>((resolveActive, reject) => {
        activeRead.onsuccess = () => resolveActive(activeRead.result as { boardId?: string } | undefined);
        activeRead.onerror = () => reject(activeRead.error);
      });
      if (typeof active?.boardId !== "string") return false;
      const countRead = database
        .transaction("board-elements", "readonly")
        .objectStore("board-elements")
        .index("boardId")
        .count(active.boardId);
      const count = await new Promise<number>((resolveCount, reject) => {
        countRead.onsuccess = () => resolveCount(countRead.result);
        countRead.onerror = () => reject(countRead.error);
      });
      return count > 0;
    } finally {
      database.close();
    }
  }, threadId);
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

async function makeScreenshotBrowserFrame(page: Page): Promise<{
  readonly imageBase64: string;
  readonly width: number;
  readonly height: number;
}> {
  return page.evaluate(() => {
    const width = 1_180;
    const height = 760;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot fixture canvas is unavailable");

    function panel(
      x: number,
      y: number,
      panelWidth: number,
      panelHeight: number,
      radius: number,
      fill: string,
      stroke = "#e1e5ed",
    ) {
      context.beginPath();
      context.roundRect(x, y, panelWidth, panelHeight, radius);
      context.fillStyle = fill;
      context.fill();
      context.strokeStyle = stroke;
      context.lineWidth = 1;
      context.stroke();
    }

    function text(value: string, x: number, y: number, size: number, color: string, weight = 500) {
      context.fillStyle = color;
      context.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`;
      context.fillText(value, x, y);
    }

    context.fillStyle = "#f4f6fa";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, 72);
    context.strokeStyle = "#e3e7ef";
    context.beginPath();
    context.moveTo(0, 71.5);
    context.lineTo(width, 71.5);
    context.stroke();

    const logoGradient = context.createLinearGradient(24, 18, 62, 56);
    logoGradient.addColorStop(0, "#2668ff");
    logoGradient.addColorStop(1, "#74a7ff");
    panel(24, 17, 40, 40, 12, logoGradient, "#568aff");
    context.fillStyle = "rgba(255,255,255,.94)";
    context.fillRect(36, 29, 7, 7);
    context.fillRect(47, 29, 7, 7);
    context.fillRect(36, 40, 7, 7);
    context.fillRect(47, 40, 7, 7);
    text("Component Lab", 78, 43, 18, "#151b2b", 700);
    text("Overview", 276, 42, 13, "#7a8292", 550);
    text("Components", 370, 42, 13, "#2768f5", 650);
    text("QA flows", 478, 42, 13, "#7a8292", 550);
    panel(1_070, 18, 84, 38, 12, "#f1f4f9");
    text("Preview", 1_088, 43, 12, "#394154", 650);

    panel(24, 96, 220, 640, 20, "#ffffff");
    text("WORKSPACE", 46, 128, 10, "#9aa2b2", 700);
    const navigation = ["Dashboard", "Components", "Tokens", "Flows", "Accessibility"];
    navigation.forEach((item, index) => {
      const y = 150 + index * 54;
      if (item === "Components") panel(38, y, 192, 42, 12, "#edf3ff", "#dbe7ff");
      context.fillStyle = item === "Components" ? "#2768f5" : "#a6adba";
      context.beginPath();
      context.arc(56, y + 21, 5, 0, Math.PI * 2);
      context.fill();
      text(item, 72, y + 26, 13, item === "Components" ? "#1c54c8" : "#5f6879", item === "Components" ? 650 : 550);
    });
    panel(38, 638, 192, 76, 14, "#f7f9fc");
    text("Viewport", 54, 663, 10, "#929aaa", 650);
    text("1180 × 760", 54, 688, 15, "#293247", 700);

    text("Checkout components", 276, 125, 28, "#151b2b", 730);
    text("Review the responsive payment flow before publishing.", 276, 151, 13, "#7a8292", 500);
    panel(986, 102, 168, 46, 14, "#2768f5", "#2768f5");
    text("Publish preview", 1_010, 131, 13, "#ffffff", 700);

    panel(276, 178, 550, 540, 20, "#ffffff");
    text("Payment summary card", 300, 211, 17, "#1b2335", 700);
    text("LIVE PREVIEW", 690, 209, 10, "#2f70f7", 700);
    panel(300, 232, 502, 286, 18, "#eef2f8", "#e5e9f1");
    const previewGradient = context.createLinearGradient(334, 262, 768, 468);
    previewGradient.addColorStop(0, "#182237");
    previewGradient.addColorStop(1, "#0e1422");
    panel(334, 262, 434, 218, 22, previewGradient, "#26344e");
    text("PRO WORKSPACE", 362, 298, 10, "#7da8ff", 700);
    text("Ship the complete flow", 362, 334, 24, "#ffffff", 720);
    text("Unlimited preview reviews and shared QA evidence.", 362, 360, 12, "#aeb9cc", 500);
    text("€24", 362, 414, 30, "#ffffff", 730);
    text("/ month", 424, 413, 12, "#8f9bb0", 550);
    panel(598, 394, 142, 48, 14, "#3978ff", "#5b91ff");
    text("Choose plan", 624, 424, 13, "#ffffff", 700);
    text("Variants", 300, 554, 11, "#8b93a3", 650);
    ["Default", "Compact", "Annual"].forEach((item, index) => {
      const x = 300 + index * 158;
      panel(x, 572, 142, 54, 14, index === 0 ? "#edf3ff" : "#f8f9fc", index === 0 ? "#bcd1ff" : "#e5e8ef");
      text(item, x + 16, 604, 12, index === 0 ? "#245fd2" : "#626b7c", index === 0 ? 700 : 600);
    });
    panel(300, 650, 502, 44, 12, "#f8fafc");
    context.fillStyle = "#38bd88";
    context.beginPath();
    context.arc(320, 672, 5, 0, Math.PI * 2);
    context.fill();
    text("Contrast and touch targets pass", 334, 677, 12, "#566074", 600);

    panel(850, 178, 304, 344, 20, "#ffffff");
    text("Inspector", 874, 211, 17, "#1b2335", 700);
    text("CARD STYLE", 874, 247, 10, "#929aaa", 700);
    text("Surface", 874, 278, 12, "#646d7e", 600);
    panel(874, 290, 256, 46, 12, "#f6f8fb");
    text("Midnight", 890, 319, 13, "#283146", 650);
    text("Radius", 874, 370, 12, "#646d7e", 600);
    context.fillStyle = "#dce2ec";
    context.fillRect(874, 394, 256, 5);
    context.fillStyle = "#3476ff";
    context.fillRect(874, 394, 164, 5);
    context.beginPath();
    context.arc(1_038, 396.5, 9, 0, Math.PI * 2);
    context.fill();
    text("22 px", 1_086, 401, 11, "#70798a", 650);
    text("Content", 874, 442, 12, "#646d7e", 600);
    panel(874, 454, 256, 44, 12, "#f6f8fb");
    text("Pro workspace", 890, 482, 12, "#283146", 600);

    panel(850, 542, 304, 176, 20, "#edf4ff", "#cfe0ff");
    context.fillStyle = "#3476ff";
    context.beginPath();
    context.arc(878, 574, 7, 0, Math.PI * 2);
    context.fill();
    text("Ready for review", 896, 580, 15, "#1c54c8", 700);
    text("Open this page on iPad to inspect", 874, 615, 12, "#5d6f8e", 550);
    text("the real responsive result and mark", 874, 638, 12, "#5d6f8e", 550);
    text("any visual issue directly.", 874, 661, 12, "#5d6f8e", 550);
    text("3 checks passed", 874, 692, 11, "#31715b", 650);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    return { imageBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), width, height };
  });
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
  const output = SCREENSHOT_OUTPUT;
  await mkdir(output, { recursive: true });
  const bridge = new MockBridge({ authorized: false, fixedNow: SCREENSHOT_NOW });
  bridge.setBrowserFrameFixture(await makeScreenshotBrowserFrame(page));
  bridge.setDiagrams([SCREENSHOT_DIAGRAM]);
  await bridge.install(page);
  await installScreenshotSite(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  await expect(page.getByRole("heading", { name: /Connect to/ })).toBeVisible();
  await page.waitForTimeout(650);
  await captureVerifiedScreenshot(page, resolve(output, `pairing${suffix}.png`));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".cp-connection.phase-online")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();

  await resetViewportScroll(page);
  await captureVerifiedScreenshot(page, resolve(output, `dashboard${suffix}.png`));

  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Capture Inbox", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Note Catch a quick idea/ }).click();
  await page.getByLabel("Quick note text").fill("Toolbar shifts after rotating the iPad. Keep the current frame and compare it with the corrected layout.");
  await page.getByRole("button", { name: "Save to Inbox" }).click();
  await page.waitForTimeout(400);
  await resetViewportScroll(page);
  await captureVerifiedScreenshot(page, resolve(output, `capture-inbox${suffix}.png`));
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();

  await page.getByRole("button", { name: "Show priority sessions" }).click();
  await expect(page.getByRole("button", { name: "Show priority sessions" })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(550);
  await resetViewportScroll(page);
  await captureVerifiedScreenshot(page, resolve(output, `dashboard-priority${suffix}.png`));
  await page.getByRole("button", { name: "Show priority sessions" }).click();

  if (testInfo.project.name === "iPad landscape") {
    await page.getByRole("button", { name: /Open Research queue/ }).click();
    await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Review result" }).click();
    await expect(page.getByLabel("Multimodal review for Research queue")).toBeVisible();
    const dismissReviewCommandStatus = page.getByRole("button", { name: "Dismiss command status" });
    if (await dismissReviewCommandStatus.isVisible()) await dismissReviewCommandStatus.click();
    await resetViewportScroll(page);
    await captureVerifiedScreenshot(page, resolve(output, "review.png"));
    await page.getByRole("button", { name: "Close review" }).click();
    await page.getByRole("button", { name: "Open Nerva Home" }).click();
    await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
    await page.getByRole("button", { name: /Working 1/ }).click();
    await captureVerifiedScreenshot(page, resolve(output, "dashboard-working.png"));
    await page.getByRole("button", { name: /Working 1/ }).click();
    await page.getByRole("button", { name: "Open Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await page.waitForTimeout(550);
    await captureVerifiedScreenshot(page, resolve(output, "settings.png"));
    await page.locator(".cp-settings .cp-back-button").click();
    await page.getByRole("button", { name: "Open Settings" }).click();
    await page.getByLabel("Theme").selectOption("light");
    await page.locator(".cp-settings .cp-back-button").click();
    await captureVerifiedScreenshot(page, resolve(output, "dashboard-light.png"));
    await page.getByRole("button", { name: "Open Settings" }).click();
    await page.getByLabel("Theme").selectOption("dark");
    await page.locator(".cp-settings .cp-back-button").click();
  }

  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  const dismissCommandStatus = page.getByRole("button", { name: "Dismiss command status" });
  if (await dismissCommandStatus.isVisible()) await dismissCommandStatus.click();
  await resetViewportScroll(page);
  await captureVerifiedScreenshot(page, resolve(output, `session${suffix}.png`));

  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByText("Release checklist", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Select Toolbar shifts/ }).click();
  await resetViewportScroll(page);
  await captureVerifiedScreenshot(page, resolve(output, `capture-inbox-session${suffix}.png`));
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();

  if (testInfo.project.name === "iPad landscape") {
    await page.locator(".cp-skill-control > .cp-control-header").click();
    const openAiTemplates = page.locator(".cp-skill-group").filter({ hasText: "OpenAI Templates" });
    await expect(openAiTemplates).toHaveCount(1);
    await openAiTemplates.locator(".cp-skill-group__header").click();
    await captureVerifiedScreenshot(page, resolve(output, "skills.png"));
    await page.getByRole("button", { name: "Close Skills" }).click();
  }

  await page.getByRole("button", { name: /Site/ }).click();
  const sitesHub = page.getByRole("main", { name: "Sites" });
  await expect(sitesHub).toBeVisible();
  await captureVerifiedScreenshot(page, resolve(output, `sites${suffix}.png`));
  await sitesHub.getByRole("button", { name: "Open Component lab" }).click();
  const siteCanvas = page.getByLabel("Browse current Mac site");
  const siteFrame = page.locator(".cp-browser-site__frame");
  await expect(siteCanvas).toBeVisible();
  await expect(siteFrame).toBeVisible();
  await expect.poll(() => siteFrame.evaluate((image: HTMLImageElement) => ({
    complete: image.complete,
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))).toEqual({ complete: true, width: 1_180, height: 760 });
  await expect(page.locator(".cp-browser-site__busy")).toHaveCount(0);
  const luminanceRange = await siteFrame.evaluate((image: HTMLImageElement) => {
    const sample = document.createElement("canvas");
    sample.width = 32;
    sample.height = 20;
    const context = sample.getContext("2d");
    if (!context) return 0;
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let minimum = 255;
    let maximum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = pixels[index]! * 0.2126 + pixels[index + 1]! * 0.7152 + pixels[index + 2]! * 0.0722;
      minimum = Math.min(minimum, luminance);
      maximum = Math.max(maximum, luminance);
    }
    return maximum - minimum;
  });
  expect(luminanceRange).toBeGreaterThan(80);
  await captureVerifiedScreenshot(page, resolve(output, `site${suffix}.png`));

  if (testInfo.project.name === "iPad landscape") {
    await page.getByRole("button", { name: "Record flow" }).click();
    await page.getByRole("button", { name: "Mark issue" }).click();
    await markCanvas(page.getByLabel("Annotate current site frame"));
    await page.getByPlaceholder("Explain the visible problem").fill("The result panel disappears after the action.");
    await captureVerifiedScreenshot(page, resolve(output, "site-qa-issue.png"));
    await page.getByRole("button", { name: "Save & review" }).click();
    await expect(page.getByRole("heading", { name: "Review recording" })).toBeVisible();
    await captureVerifiedScreenshot(page, resolve(output, "site-qa-review.png"));
    await page.getByRole("button", { name: "Live page" }).click();
  }
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("main", { name: "Sites" }).getByRole("button", { name: "Session" }).click();

  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("button", { name: "Edit selected diagram block" })).toBeVisible();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await markCanvas(page.getByRole("img", { name: /^Sketch canvas/ }));
  await page.getByRole("button", { name: "Select and move board content" }).click();
  await expect.poll(() => hasPersistedDrawingElements(page, THREADS[0].id)).toBe(true);
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).not.toContainText("Saved on this iPad");
  await page.getByRole("button", { name: "Keep in Saved Drawings" }).click();
  await expect(page.getByText("Kept in Saved Drawings on the Mac")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Keep in Saved Drawings" })).toBeEnabled();
  await resetViewportScroll(page);
  await captureVerifiedScreenshot(page, resolve(output, `drawing${suffix}.png`));
  if (testInfo.project.name === "iPad landscape") {
    await page.getByRole("button", { name: "Edit selected diagram block" }).click();
    await expect(page.getByRole("textbox", { name: "Selected block" })).toBeVisible();
    await captureVerifiedScreenshot(page, resolve(output, "drawing-diagram-inspector.png"));
    await page.getByRole("button", { name: "Close diagram inspector" }).click();
  }
  await page.getByRole("button", { name: "Close drawing studio" }).click();
  await resetViewportScroll(page);
  await page.getByRole("button", { name: "Saved Drawings" }).click();
  await expect(page.getByRole("dialog", { name: "Saved Drawings" })).toContainText("Untitled drawing");
  await page.waitForTimeout(550);
  await captureVerifiedScreenshot(page, resolve(output, `saved-drawings${suffix}.png`));
});

test("capture the compact 768-wide iPad Home header", async ({ page }, testInfo) => {
  test.skip(!CAPTURE_SCREENSHOTS, "Generated only by npm run screenshots");
  test.skip(testInfo.project.name !== "iPad landscape", "One intermediate-width proof is sufficient");
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  await page.setViewportSize({ width: 768, height: 1_024 });
  const output = SCREENSHOT_OUTPUT;
  await mkdir(output, { recursive: true });
  const bridge = new MockBridge({ authorized: false, fixedNow: SCREENSHOT_NOW });
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
  await resetViewportScroll(page);
  await captureVerifiedScreenshot(page, resolve(output, "dashboard-compact-ipad.png"));
});

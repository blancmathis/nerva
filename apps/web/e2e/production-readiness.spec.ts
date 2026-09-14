import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { MockBridge, THREADS } from "./mock-bridge";

async function openActivity(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge({ authorized: false });
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  // Use the existing action-readiness budget for the lazy pairing screen,
  // then check its label; do not impose a new five-second cold-start limit.
  await connect.waitFor({ state: "visible" });
  await expect(page.getByRole("heading", { name: "Connect to your Mac", exact: true })).toBeVisible();
  await connect.click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await page.getByRole("button", { name: /Open Conversations/ }).click();
  await page.getByRole("dialog", { name: "Conversations" }).getByRole("button", { name: /^Activity/ }).click();
  await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
  await settleAnimations(page);
  return bridge;
}

async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}

test("Activity exposes touch-sized actions with keyboard navigation and exact-task routing", async ({ page }, testInfo) => {
  const bridge = await openActivity(page);
  const countBefore = bridge.commands.length;
  const activity = page.getByRole("dialog", { name: "Activity" });
  const trigger = activity.getByRole("button", { name: "Actions for Research queue", exact: true });
  await trigger.click();
  const menu = activity.getByRole("menu", { name: "Actions for Research queue" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open conversation" })).toBeFocused();
  expect(bridge.commands).toHaveLength(countBefore);
  for (const button of [trigger, ...await menu.getByRole("menuitem").all()]) {
    const box = await button.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: testInfo.outputPath("activity-actions.png"), animations: "disabled", scale: "css" });
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Unpin from Home" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(activity).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Open conversation" }).click();
  await expect.poll(() => bridge.commands.at(-1)?.type).toBe("openSession");
  expect(bridge.commands.at(-1)).toMatchObject({ expectedThreadId: THREADS[2].id, targetThreadId: THREADS[2].id });
  await expect(page.getByRole("heading", { name: "Research queue", level: 1 })).toBeVisible();
});

test("Activity remains readable and operable in light mode on small and rotated phones", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 568 });
  await openActivity(page);
  const activity = page.getByRole("dialog", { name: "Activity" });
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await settleAnimations(page);
    const trigger = activity.getByRole("button", { name: "Actions for Research queue", exact: true });
    await trigger.scrollIntoViewIfNeeded();
    const box = await trigger.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const metadata = await activity.locator(".cp-activity-row__copy small").first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(metadata).toBeGreaterThanOrEqual(11);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await settleAnimations(page);
  await page.screenshot({ path: testInfo.outputPath("activity-light-phone.png"), animations: "disabled", scale: "css" });
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});


test("Pairing keeps camera permission cancelable without starting another request", async ({ page }) => {
  const bridge = new MockBridge({ authorized: false });
  await bridge.install(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise(() => undefined) },
    });
  });
  await page.goto("/pair");
  await page.getByRole("button", { name: "Scan QR", exact: true }).click();
  await expect(page.getByRole("button", { name: "Starting camera…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Scan QR", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(bridge.commands).toHaveLength(0);
});


test("QA checkpoint cancellation releases pending and active microphones without sending a task command", async ({ page }) => {
  const bridge = new MockBridge({ authorized: false });
  await bridge.install(page);
  await page.addInitScript(() => {
    const pending: ((stream: MediaStream) => void)[] = [];
    const probe = {
      requests: 0, stopped: 0, recordings: 0,
      grant: () => {
        const resolve = pending.shift();
        if (!resolve) throw new Error("No microphone permission request is pending");
        resolve({ getTracks: () => [{ stop: () => { probe.stopped += 1; } }] } as unknown as MediaStream);
      },
    };
    Object.defineProperty(window, "__nervaVoiceProbe", { value: probe });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => {
        probe.requests += 1;
        return new Promise<MediaStream>((resolve) => pending.push(resolve));
      } },
    });
    class FixtureRecorder extends EventTarget {
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; probe.recordings += 1; }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        queueMicrotask(() => {
          const event = new Event("dataavailable");
          Object.defineProperty(event, "data", { value: new Blob(["fixture voice note"]) });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FixtureRecorder });
  });
  const probe = () => page.evaluate(() => {
    const value = (window as unknown as { __nervaVoiceProbe: { requests: number; stopped: number; recordings: number } }).__nervaVoiceProbe;
    return { requests: value.requests, stopped: value.stopped, recordings: value.recordings };
  });
  const grant = () => page.evaluate(() => {
    (window as unknown as { __nervaVoiceProbe: { grant: () => void } }).__nervaVoiceProbe.grant();
  });
  await page.goto("/pair?nonce=fixture-pairing-code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /^Site/ }).click();
  await page.getByRole("main", { name: "Sites" }).getByRole("button", { name: "Open Component lab" }).click();
  await page.getByRole("button", { name: "Record flow", exact: true }).click();
  await page.getByRole("button", { name: "Mark issue", exact: true }).click();
  const issue = page.getByRole("dialog", { name: "Mark what went wrong" });
  const commandCount = bridge.commands.length;
  await issue.getByRole("button", { name: "Explain with voice", exact: true }).click();
  await expect(issue.getByRole("button", { name: "Cancel microphone request", exact: true })).toBeVisible();
  await expect(issue.getByRole("button", { name: "Save & review", exact: true })).toBeDisabled();
  await issue.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(issue).toBeHidden();
  await grant();
  await expect.poll(probe).toEqual({ requests: 1, stopped: 1, recordings: 0 });

  await page.getByRole("button", { name: "Mark issue", exact: true }).click();
  await issue.getByRole("button", { name: "Explain with voice", exact: true }).click();
  await issue.getByRole("button", { name: "Cancel microphone request", exact: true }).click();
  await grant();
  await expect.poll(probe).toEqual({ requests: 2, stopped: 2, recordings: 0 });
  await expect(issue).toBeVisible();
  await issue.getByRole("button", { name: "Explain with voice", exact: true }).click();
  await expect.poll(async () => (await probe()).requests).toBe(3);
  await grant();
  await expect(issue.getByRole("button", { name: "Stop voice note", exact: true })).toBeVisible();
  await issue.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(issue).toBeHidden();
  await expect.poll(probe).toEqual({ requests: 3, stopped: 3, recordings: 1 });
  expect(bridge.commands).toHaveLength(commandCount);
});

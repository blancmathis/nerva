import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { MockBridge, THREADS } from "./mock-bridge";

async function openActivity(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge({ authorized: false });
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  await expect(page.getByRole("heading", { name: "Connect to your Mac", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
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

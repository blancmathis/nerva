import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { MockBridge } from "./mock-bridge";
import { THREADS } from "./fixture-data";

async function expectNoSeriousAccessibilityViolations(page: Page, surface: string): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      targets: violation.nodes.map((node) => ({
        selector: node.target.join(" "),
        summary: node.failureSummary,
      })),
    }));
  expect(violations, `${surface} has serious or critical accessibility violations`).toEqual([]);
}

async function pairFixture(page: Page): Promise<MockBridge> {
  const bridge = new MockBridge({ authorized: false });
  await bridge.install(page);
  await page.goto("/pair?nonce=fixture-pairing-code");
  await expect(page.getByRole("heading", { name: /Connect to/ })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Pairing");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  return bridge;
}

test("rendered Nerva surfaces have no serious or critical axe violations", async ({ page }) => {
  const bridge = await pairFixture(page);

  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Home");
  await page.getByRole("button", { name: /Unpinned Sessions/ }).click();
  await expectNoSeriousAccessibilityViolations(page, "Unpinned Sessions dialog");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Open Release checklist/ }).click();
  await expect(page.getByRole("heading", { name: "Release checklist", level: 1 })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Session");
  await page.getByRole("button", { name: /Skills/ }).click();
  await expectNoSeriousAccessibilityViolations(page, "Skills dialog");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Capture Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Capture Inbox", level: 1 })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Capture Inbox");
  await page.getByRole("button", { name: "Session", exact: true }).click();

  bridge.setDiagrams([{
    version: 1,
    diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
    threadId: THREADS[0].id,
    revision: 0,
    title: "Accessible collaboration loop",
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
    sourceLabel: "Accessibility fixture",
  }]);
  await page.getByRole("button", { name: "Draw Start a local canvas" }).click();
  await expect(page.getByRole("dialog", { name: "Draw for Codex" })).toBeVisible();
  await page.getByRole("button", { name: "Edit selected diagram block" }).click();
  await expect(page.getByRole("textbox", { name: "Selected block" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Drawing with collaborative diagram");
  await page.getByRole("button", { name: "Close drawing studio" }).click();

  await page.getByRole("button", { name: "Saved Drawings" }).click();
  await expect(page.getByRole("dialog", { name: "Saved Drawings" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Saved Drawings");
  await page.getByRole("button", { name: "Close Saved Drawings" }).click();

  await page.getByRole("button", { name: /Site/ }).click();
  await expect(page.getByRole("main", { name: "Sites" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Sites");
  await page.getByRole("main", { name: "Sites" }).getByRole("button", { name: "Session" }).click();

  const reviewButton = page.getByRole("button", { name: "Review result" });
  if (await reviewButton.isVisible()) {
    await reviewButton.click();
    await expect(page.getByLabel(/Multimodal review/)).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page, "Review");
    await page.getByRole("button", { name: "Close review" }).click();
  }

  await page.getByRole("button", { name: "Open Nerva Home" }).click();
  await page.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page, "Settings");
  await page.getByRole("button", { name: /Open System Diagnostics/ }).click();
  await expectNoSeriousAccessibilityViolations(page, "System Diagnostics dialog");
});

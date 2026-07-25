import type { SendReviewCommand } from "@codex-pad/protocol";
import { describe, expect, it } from "vitest";

import { ReviewValidationError, defaultReviewInstruction } from "./review.js";

const TITLE = "Dashboard empty state";
const URL = "https://preview.example.test/dashboard?state=empty";

function command(instruction: string): SendReviewCommand {
  return {
    type: "sendReview",
    commandId: "73cc8a00-9160-48be-b1df-4efccd58ac22",
    expectedSequence: 12,
    expectedBridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
    expectedThreadId: "019f6de7-44c2-7fe2-9d17-9322c952e626",
    targetThreadId: "019f6de7-44c2-7fe2-9d17-9322c952e626",
    snapshotSeq: 12,
    instruction,
    frames: [{
      frameId: "83cc8a00-9160-48be-b1df-4efccd58ac33",
      index: 0,
      kind: "siteSnapshot",
      image: { kind: "inlinePng", png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
      url: URL,
      title: TITLE,
      viewport: { width: 1_024, height: 768, devicePixelRatio: 2 },
      scroll: { x: 0, y: 0, documentWidth: 1_024, documentHeight: 768 },
    }],
  };
}

function canonicalInstruction(): string {
  return [
    "# Codex Pad multimodal review",
    `F1|title=${JSON.stringify(TITLE)}|url=${JSON.stringify(URL)}|note=${JSON.stringify("Keep this note exact.")}`,
  ].join("\n");
}

describe("defaultReviewInstruction", () => {
  it("returns an exact 8,000-character canonical instruction without appending or slicing", () => {
    const base = canonicalInstruction();
    const exact = `${base}\n${"x".repeat(8_000 - base.length - 1)}`;

    expect(exact).toHaveLength(8_000);
    expect(defaultReviewInstruction(command(exact))).toBe(exact);
  });

  it("fails instead of silently slicing an over-budget instruction", () => {
    const base = canonicalInstruction();
    const overBudget = `${base}\n${"x".repeat(8_001 - base.length - 1)}`;

    expect(() => defaultReviewInstruction(command(overBudget))).toThrowError(ReviewValidationError);
    expect(() => defaultReviewInstruction(command(overBudget))).toThrow(/nothing was truncated/i);
  });

  it.each([
    ["title", `title=${JSON.stringify(TITLE)}`],
    ["URL", `url=${JSON.stringify(URL)}`],
  ])("fails closed when exact %s text is absent", (_label, marker) => {
    const incomplete = canonicalInstruction().replace(marker, "omitted=true");
    expect(() => defaultReviewInstruction(command(incomplete))).toThrow(/omits the exact|omits an exact/i);
  });
});

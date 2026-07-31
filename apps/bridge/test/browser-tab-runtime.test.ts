import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  classifySiteQaActionOutcome,
  normalizeBrowserFrameImage,
  safeSiteQaReceiptEvidence,
  safeSiteQaVisibleUrl,
  sanitizeSiteQaDisplayText,
} from "../src/browser-tab-runtime.js";
import type { SiteQaRecordedAction, SiteQaTargetDescriptor } from "@codex-pad/protocol";

const safeInput = { type: "insertText", text: "Search component library" } satisfies SiteQaRecordedAction;

function target(overrides: Partial<SiteQaTargetDescriptor> = {}): SiteQaTargetDescriptor {
  return {
    kind: "input",
    role: "textbox",
    accessibleName: "Search",
    label: "Search",
    placeholder: "Find components",
    testId: "component-search",
    stableId: "search",
    inputType: "text",
    tagName: "input",
    relativePoint: null,
    viewportPoint: null,
    confidence: "high",
    ambiguityReason: null,
    ...overrides,
  };
}

describe("browser tab frame normalization", () => {
  it("downscales a Retina webview capture to the CSS-pixel viewport for iPad rendering", async () => {
    const retinaJpeg = await sharp({
      create: {
        width: 2_360,
        height: 1_520,
        channels: 3,
        background: { r: 35, g: 112, b: 198 },
      },
    }).jpeg().toBuffer();

    const normalized = await normalizeBrowserFrameImage(retinaJpeg.toString("base64"), {
      width: 1_180,
      height: 760,
      deviceScaleFactor: 2,
    });
    const metadata = await sharp(Buffer.from(normalized.imageBase64, "base64")).metadata();

    expect(normalized.deviceScaleFactor).toBe(1);
    expect(metadata.width).toBe(1_180);
    expect(metadata.height).toBe(760);
  });

  it("keeps a native 1x frame byte-for-byte", async () => {
    const jpeg = await sharp({
      create: {
        width: 320,
        height: 200,
        channels: 3,
        background: { r: 20, g: 24, b: 30 },
      },
    }).jpeg().toBuffer();
    const imageBase64 = jpeg.toString("base64");

    await expect(normalizeBrowserFrameImage(imageBase64, {
      width: 320,
      height: 200,
      deviceScaleFactor: 1,
    })).resolves.toEqual({ imageBase64, deviceScaleFactor: 1 });
  });
});

describe("Site QA privacy evidence", () => {
  it("masks text and uses coordinate-only confidence when no target was resolved", () => {
    expect(safeSiteQaReceiptEvidence(safeInput, { target: null, privacy: "public" })).toEqual({
      target: null,
      input: { mode: "placeholder", value: "{PRIVATE_VALUE_1}" },
      confidence: "coordinate-only",
    });
  });

  it("never preserves literal text for coordinate-only or ambiguous targets", () => {
    const coordinateOnly = safeSiteQaReceiptEvidence(safeInput, {
      target: target({ confidence: "coordinate-only", ambiguityReason: "missing-semantics" }),
      privacy: "public",
    });
    const ambiguous = safeSiteQaReceiptEvidence(safeInput, {
      target: target({ confidence: "high", ambiguityReason: "non-unique" }),
      privacy: "public",
    });

    expect(coordinateOnly.input).toEqual({ mode: "placeholder", value: "{PRIVATE_VALUE_1}" });
    expect(coordinateOnly.confidence).toBe("coordinate-only");
    expect(ambiguous.input).toEqual({ mode: "placeholder", value: "{PRIVATE_VALUE_1}" });
    expect(ambiguous.confidence).not.toBe("high");
    expect(ambiguous.target?.confidence).not.toBe("high");
  });

  it("content-masks secrets even in a high-confidence generic public field", () => {
    for (const text of [
      "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "password: ocean-horse-battery-staple",
      "4111 1111 1111 1111",
      "mathis@example.com",
    ]) {
      const evidence = safeSiteQaReceiptEvidence({ type: "insertText", text }, {
        target: target({ accessibleName: "Notes", label: "Notes", testId: "notes" }),
        privacy: "public",
      });
      expect(evidence.input.mode).toBe("placeholder");
      expect(JSON.stringify(evidence)).not.toContain(text);
    }
  });

  it("keeps an ordinary literal only for an unambiguous public target", () => {
    expect(safeSiteQaReceiptEvidence(safeInput, {
      target: target(),
      privacy: "public",
    }).input).toEqual({ mode: "literal", value: safeInput.text });
    expect(safeSiteQaReceiptEvidence(safeInput, {
      target: target(),
      privacy: "future-unknown-classification",
    }).input).toEqual({ mode: "placeholder", value: "{PRIVATE_VALUE_1}" });
  });

  it("redacts sensitive page and target metadata owned by the runtime", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    expect(sanitizeSiteQaDisplayText(`Deploy ${secret}`)).toBe("Deploy [redacted sensitive text]");

    const evidence = safeSiteQaReceiptEvidence(safeInput, {
      target: target({ accessibleName: `Token ${secret}`, label: null }),
      privacy: "public",
    });
    expect(evidence.target?.accessibleName).toBe("Token [redacted sensitive text]");
    expect(evidence.target?.ambiguityReason).toBe("sensitive-name");
    expect(evidence.confidence).not.toBe("high");
    expect(evidence.input.mode).toBe("placeholder");
  });

  it("removes credentials, query data, fragments, and sensitive path segments from receipt URLs", () => {
    expect(safeSiteQaVisibleUrl(
      "https://user:password@example.test/reset/sk-proj-abcdefghijklmnopqrstuvwxyz1234567890?token=secret#private",
      "https://fallback.test/",
    )).toBe("https://example.test/reset/%5Bredacted%5D");
    expect(safeSiteQaVisibleUrl("not a URL", "also not a URL")).toBe("https://invalid.invalid/");
  });
});

describe("Site QA action receipts", () => {
  const before = { href: "https://example.test/start", title: "Start", scrollX: 0, scrollY: 0 };

  it("confirms only an observable postcondition", () => {
    expect(classifySiteQaActionOutcome(
      { type: "scroll", x: 100, y: 100, deltaX: 0, deltaY: 300 },
      before,
      { ...before, scrollY: 300 },
    )).toBe("confirmed");
    expect(classifySiteQaActionOutcome(
      { type: "key", key: "Enter" },
      before,
      { ...before, href: "https://example.test/result" },
    )).toBe("confirmed");
  });

  it("distinguishes a boundary no-op from an action that was only dispatched", () => {
    expect(classifySiteQaActionOutcome(
      { type: "scroll", x: 100, y: 100, deltaX: 0, deltaY: -300 },
      before,
      before,
    )).toBe("no-visible-change");
    expect(classifySiteQaActionOutcome({ type: "tap", x: 100, y: 100 }, before, before)).toBe("dispatched");
    expect(classifySiteQaActionOutcome({ type: "insertText", text: "hello" }, before, before)).toBe("dispatched");
  });
});

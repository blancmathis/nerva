import { describe, expect, it } from "vitest";
import type { SiteInteractionModes } from "@codex-pad/protocol";

import {
  makeAfterComparison,
  makeIterationFrame,
  makeSiteReviewFrame,
  resolveAllowedSite,
  resolveRegisteredCaptureRoute,
} from "./review-state";
import type { ReviewImage } from "@codex-pad/review";

const INTERACTION_MODES = {
  selected: "none",
  direct: {
    status: "unavailable",
    reason: "same-host-storage-boundary",
    detail: "Live preview requires a separately verified browser storage boundary.",
  },
  remoteBrowser: {
    status: "unavailable",
    reason: "thread-tab-mapping-unproven",
    detail: "Exact task-to-tab mapping has not been proven.",
    association: {
      status: "unavailable",
      reason: "thread-tab-mapping-unproven",
      detail: "Exact task-to-tab mapping has not been proven.",
    },
  },
} as const satisfies SiteInteractionModes;

function image(id: string, blobRef: string): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef },
    metadata: {
      mimeType: "image/png",
      byteLength: 128,
      pixelWidth: 390,
      pixelHeight: 844,
      fileName: `${id}.png`,
      sha256: null,
      capturedAt: 1_000,
    },
  };
}

describe("review frame helpers", () => {
  it("preserves same-URL captures as distinct frame states", () => {
    const first = makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/dashboard", id: "state-one" });
    const second = makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/dashboard", id: "state-two" });
    expect(first.url).toBe(second.url);
    expect(first.id).not.toBe(second.id);
  });

  it("stores an after comparison as a new immutable iteration", () => {
    const before = image("before", "before-ref");
    const after = image("after", "after-ref");
    const captured = makeSiteReviewFrame({
      url: "https://mac.example.ts.net:3000/",
      id: "comparison-frame",
      capturedImage: before,
    });
    const comparison = makeAfterComparison(captured, after);
    expect(comparison.mode).toBe("side-by-side");
    expect(comparison.before?.image.source).toEqual(before.source);
    expect(comparison.before?.image.id).not.toBe(before.id);
    expect(comparison.after?.image).toBe(after);

    const frame = { ...captured, comparison: { ...comparison, mode: "overlay" as const } };
    const iteration = makeIterationFrame(frame, "iteration-two");
    expect(iteration.id).toBe("iteration-two");
    expect(iteration.capturedImage?.source).toEqual(after.source);
    expect(iteration.capturedImage?.id).not.toBe(after.id);
    expect(iteration.comparison.mode).toBe("none");
    expect(frame.comparison.mode).toBe("overlay");
  });

  it("requires an explicit before capture before creating a comparison", () => {
    const frame = makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/" });
    expect(() => makeAfterComparison(frame, image("after", "after-ref"))).toThrow(/captured before image/i);
  });

  it("accepts only an exact non-loopback HTTPS origin", () => {
    expect(resolveAllowedSite({
      url: "https://mac.example.ts.net:3000/dashboard",
      allowedOrigin: "https://mac.example.ts.net:3000",
      captureCapability: "available",
      interactionModes: INTERACTION_MODES,
    })?.pathname).toBe("/dashboard");
    expect(resolveAllowedSite({
      url: "http://127.0.0.1:3000",
      allowedOrigin: "http://127.0.0.1:3000",
      captureCapability: "available",
      interactionModes: INTERACTION_MODES,
    })).toBeNull();
    expect(resolveAllowedSite({
      url: "https://evil.example/dashboard",
      allowedOrigin: "https://mac.example.ts.net:3000",
      captureCapability: "available",
      interactionModes: INTERACTION_MODES,
    })).toBeNull();
    expect(resolveAllowedSite({
      url: "https://user:secret@mac.example.ts.net:3000/dashboard",
      allowedOrigin: "https://mac.example.ts.net:3000",
      captureCapability: "available",
      interactionModes: INTERACTION_MODES,
    })).toBeNull();
    expect(resolveAllowedSite({
      url: "https://mac.example.ts.net:3000/dashboard",
      allowedOrigin: "https://user:secret@mac.example.ts.net:3000",
      captureCapability: "available",
      interactionModes: INTERACTION_MODES,
    })).toBeNull();
  });

  it("offers a registered-route recapture only for a captured same-origin site frame", () => {
    const site = {
      url: "https://mac.example.ts.net:3000/dashboard",
      allowedOrigin: "https://mac.example.ts.net:3000",
      captureCapability: "available" as const,
      interactionModes: INTERACTION_MODES,
    };
    const captured = makeSiteReviewFrame({
      url: "https://mac.example.ts.net:3000/dashboard?state=before",
      capturedImage: image("before", "before-ref"),
    });
    expect(resolveRegisteredCaptureRoute(captured, site)?.pathname).toBe("/dashboard");
    expect(resolveRegisteredCaptureRoute(
      { ...captured, url: "https://other.example.test/dashboard" },
      site,
    )).toBeNull();
    expect(resolveRegisteredCaptureRoute({ ...captured, capturedImage: null }, site)).toBeNull();
  });
});

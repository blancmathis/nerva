import { createScene } from "@codex-pad/drawing";
import { createReviewDraft, reviewDraftReducer, type ReviewFrame, type ReviewImage } from "@codex-pad/review";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeBlankReviewFrame } from "../components/review-state";
import { flattenReviewDrawings } from "./review-render";
import { getReviewBlob } from "./review-store";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

function image(id: string, blobRef: string): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef },
    metadata: {
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 32,
      pixelHeight: 32,
      fileName: `${id}.png`,
      sha256: null,
      capturedAt: 1_000,
    },
  };
}

function drawnFrame(id: string, renderedImage?: ReviewImage): ReviewFrame {
  return {
    ...makeBlankReviewFrame(undefined, id),
    drawing: {
      kind: "scene",
      scene: createScene({ width: 32, height: 32, background: "transparent" }),
      ...(renderedImage ? { renderedImage } : {}),
    },
  };
}

function draftWith(...frames: ReviewFrame[]) {
  let draft = createReviewDraft({ id: "review-render", targetThreadId: THREAD_ID, now: 1_000 });
  for (const [index, frame] of frames.entries()) {
    draft = reviewDraftReducer(draft, { type: "addFrame", frame }, 1_001 + index);
  }
  return draft;
}

describe("review annotation flattening", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("keeps every prepared PNG in memory until all frames render successfully", async () => {
    const first = { image: image("rendered-a", "rendered-ref-a"), blob: new Blob(["one"], { type: "image/png" }) };
    const render = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("second frame failed"));

    await expect(flattenReviewDrawings(
      draftWith(drawnFrame("frame-a"), drawnFrame("frame-b")),
      render,
    )).rejects.toThrow("second frame failed");

    expect(render).toHaveBeenCalledTimes(2);
    await expect(getReviewBlob("rendered-ref-a")).resolves.toBeNull();
  });

  it("returns one atomic write plan after an edited annotation is previewed again", async () => {
    const old = image("rendered-old", "rendered-ref-old");
    const edited = reviewDraftReducer(
      draftWith(drawnFrame("frame-a", old)),
      {
        type: "updateFrame",
        frameId: "frame-a",
        patch: { drawing: { kind: "scene", scene: createScene({ width: 32, height: 32, background: "transparent" }) } },
      },
      2_000,
    );
    const replacement = {
      image: image("rendered-new", "rendered-ref-new"),
      blob: new Blob(["new"], { type: "image/png" }),
    };

    const flattened = await flattenReviewDrawings(edited, vi.fn().mockResolvedValue(replacement));

    expect(flattened.draft.frames[0]?.drawing?.renderedImage?.source).toEqual({
      kind: "blobRef",
      blobRef: "rendered-ref-new",
    });
    expect(flattened.blobWrites).toEqual([{ id: "rendered-ref-new", blob: replacement.blob }]);
    expect(edited.frames[0]?.drawing?.renderedImage).toBeUndefined();
    await expect(getReviewBlob("rendered-ref-new")).resolves.toBeNull();
  });
});

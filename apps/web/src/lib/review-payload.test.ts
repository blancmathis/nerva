import { createScene, createShapeElement } from "@codex-pad/drawing";
import { createReviewDraft, reviewDraftReducer, type ReviewImage } from "@codex-pad/review";
import { describe, expect, it, vi } from "vitest";

import { makePhotoReviewFrame, makeSiteReviewFrame } from "../components/review-state";
import { buildAtomicReviewSend, guardExactReviewTarget } from "./review-payload";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
const COMMAND_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8bb1";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";

function image(id: string, blobRef: string, mimeType: "image/png" | "image/jpeg" = "image/png"): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef },
    metadata: {
      mimeType,
      byteLength: 4,
      pixelWidth: 390,
      pixelHeight: 844,
      fileName: `${id}.${mimeType === "image/jpeg" ? "jpg" : "png"}`,
      sha256: null,
      capturedAt: 1_000,
    },
  };
}

describe("atomic review payload", () => {
  it("fails closed for a different selected thread", () => {
    const draft = createReviewDraft({ id: "review-target", targetThreadId: THREAD_ID, now: 1_000 });
    expect(() => guardExactReviewTarget(draft, OTHER_THREAD_ID)).toThrow("different Codex thread");
  });

  it("fails closed when the native slot key is rebound", async () => {
    const capture = image("site-image", "site-ref");
    let draft = createReviewDraft({ id: "review-rebound", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, { type: "addFrame", frame: makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/", id: "site-frame", capturedImage: capture }) }, 1_001);
    await expect(buildAtomicReviewSend({
      commandId: COMMAND_ID,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:${OTHER_THREAD_ID}`,
      snapshotSeq: 2,
      draft,
      loadBlob: async () => new Blob(["site"], { type: "image/png" }),
    })).rejects.toThrow("native slot");
  });

  it("requires a canonical UUID command identity", async () => {
    const capture = image("site-image", "site-ref");
    let draft = createReviewDraft({ id: "review-command-id", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, { type: "addFrame", frame: makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/", id: "site-frame", capturedImage: capture }) }, 1_001);
    await expect(buildAtomicReviewSend({
      commandId: "review-command-not-a-uuid",
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:${THREAD_ID}`,
      snapshotSeq: 2,
      draft,
      loadBlob: async () => new Blob(["site"], { type: "image/png" }),
    })).rejects.toThrow();
  });

  it("resolves all ordered media before returning one idempotent command", async () => {
    const firstImage = image("site-image", "site-ref");
    const secondImage = image("photo-image", "photo-ref", "image/jpeg");
    let draft = createReviewDraft({ id: "review-atomic", targetThreadId: THREAD_ID, now: 1_000, generalInstruction: "Fix all marked issues." });
    draft = reviewDraftReducer(draft, { type: "addFrame", frame: makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/", id: "site-frame", capturedImage: firstImage }) }, 1_001);
    draft = reviewDraftReducer(draft, { type: "addFrame", frame: makePhotoReviewFrame(secondImage, undefined, "photo-frame") }, 1_002);
    const blobs = new Map([
      ["site-ref", new Blob(["site"], { type: "image/png" })],
      ["photo-ref", new Blob(["photo"], { type: "image/jpeg" })],
    ]);
    const loadBlob = vi.fn(async (ref: string) => blobs.get(ref) ?? null);
    const payload = await buildAtomicReviewSend({
      commandId: COMMAND_ID,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:client-new-thread:${THREAD_ID}`,
      snapshotSeq: 42,
      draft,
      loadBlob,
    });

    expect(payload.commandId).toBe(COMMAND_ID);
    expect(payload.targetThreadId).toBe(THREAD_ID);
    expect(payload.manifest.images.map((item) => item.frameId)).toEqual(["site-frame", "photo-frame"]);
    expect(payload.attachments.map((item) => item.ref)).toEqual(["site-ref", "photo-ref"]);
    expect(loadBlob).toHaveBeenCalledTimes(2);
    expect(payload.manifest.instruction).toContain("Fix all marked issues.");
  });

  it("resolves only the flattened composite for an annotated capture", async () => {
    const source = image("site-source", "site-source-ref");
    const composite = image("site-composite", "site-composite-ref");
    let draft = createReviewDraft({ id: "review-composite", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: {
        ...makeSiteReviewFrame({
          url: "https://mac.example.ts.net:3000/",
          id: "site-frame",
          capturedImage: source,
        }),
        drawing: {
          kind: "scene",
          scene: {
            ...createScene({ width: 390, height: 844 }),
            elements: [createShapeElement({
              id: "annotation-mark",
              shape: "rectangle",
              x: 20,
              y: 30,
              width: 120,
              height: 80,
              strokeColor: "#f97316",
              strokeWidth: 4,
            })],
          },
          renderedImage: composite,
        },
      },
    }, 1_001);
    const loadBlob = vi.fn(async (ref: string) =>
      new Blob([ref], { type: "image/png" }));

    const payload = await buildAtomicReviewSend({
      commandId: COMMAND_ID,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:${THREAD_ID}`,
      snapshotSeq: 42,
      draft,
      loadBlob,
    });

    expect(payload.manifest.images).toMatchObject([
      { label: "[F1:composite]", imageId: "site-composite" },
    ]);
    expect(payload.attachments.map((attachment) => attachment.ref)).toEqual(["site-composite-ref"]);
    expect(loadBlob).toHaveBeenCalledOnce();
    expect(loadBlob).toHaveBeenCalledWith("site-composite-ref");
  });

  it("blocks more than twelve outbound images before resolving bytes", async () => {
    const captured = image("captured", "captured-ref");
    const photos = Array.from({ length: 12 }, (_, index) => image(`extra-${index}`, `extra-ref-${index}`));
    let draft = createReviewDraft({ id: "review-too-many", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: { ...makePhotoReviewFrame(captured, undefined, "photo-frame"), photos },
    }, 1_001);
    const loadBlob = vi.fn(async () => new Blob(["image"], { type: "image/png" }));
    await expect(buildAtomicReviewSend({
      commandId: COMMAND_ID,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:${THREAD_ID}`,
      snapshotSeq: 2,
      draft,
      loadBlob,
    })).rejects.toThrow("more than 12 outbound images");
    expect(loadBlob).not.toHaveBeenCalled();
  });

  it("rejects silent manifest clipping", async () => {
    const capture = image("site-image", "site-ref");
    let draft = createReviewDraft({
      id: "review-clipped",
      targetThreadId: THREAD_ID,
      now: 1_000,
      generalInstruction: "g".repeat(7_900),
    });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/", id: "site-frame", capturedImage: capture }),
    }, 1_001);
    await expect(buildAtomicReviewSend({
      commandId: COMMAND_ID,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:${THREAD_ID}`,
      snapshotSeq: 2,
      draft,
      loadBlob: async () => new Blob(["site"], { type: "image/png" }),
    })).rejects.toThrow("Nothing was clipped");

  });

  it("preflights protocol metadata limits", async () => {
    const capture = image("site-image", "site-ref");
    let draft = createReviewDraft({ id: "review-metadata", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: { ...makeSiteReviewFrame({ url: "https://mac.example.ts.net:3000/", id: "site-frame", capturedImage: capture }), title: "t".repeat(501) },
    }, 1_001);
    const input = {
      commandId: COMMAND_ID,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:${THREAD_ID}`,
      snapshotSeq: 2,
      loadBlob: async () => new Blob(["site"], { type: "image/png" }),
    };
    await expect(buildAtomicReviewSend({ ...input, draft })).rejects.toThrow("500-character");

    const validFrameDraft = reviewDraftReducer(
      createReviewDraft({ id: "review-long-url", targetThreadId: THREAD_ID, now: 1_000 }),
      {
        type: "addFrame",
        frame: makeSiteReviewFrame({
          url: `https://mac.example.ts.net:3000/${"a".repeat(2_050)}`,
          id: "site-frame",
          capturedImage: capture,
        }),
      },
      1_001,
    );
    await expect(buildAtomicReviewSend({ ...input, draft: validFrameDraft })).rejects.toThrow("2048-character");

  });
});

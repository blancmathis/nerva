import { webcrypto } from "node:crypto";

import { createReviewDraft, reviewDraftReducer, type ReviewImage } from "@codex-pad/review";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { makePhotoReviewFrame, makeSiteReviewFrame } from "../components/review-state";
import { jpegBytes } from "../test/image-fixtures";
import {
  prepareReviewImageBlobs,
  reviewCommand,
  preflightReviewImageSizes,
} from "./review-command";
import { buildAtomicReviewSend } from "./review-payload";

const MB = 1024 * 1024;
const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function image(id: string): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef: `blob-${id}` },
    metadata: {
      mimeType: "image/png",
      byteLength: 4,
      pixelWidth: 390,
      pixelHeight: 844,
      fileName: `${id}.png`,
      sha256: null,
      capturedAt: 1_000,
    },
  };
}

describe("preflightReviewImageSizes", () => {
  it("rejects a thirteenth ordered image", () => {
    expect(() => preflightReviewImageSizes(Array.from({ length: 13 }, () => 1))).toThrow(/at most 12/i);
  });

  it("rejects a converted image over eight megabytes", () => {
    expect(() => preflightReviewImageSizes([8 * MB + 1])).toThrow(/8 MB/i);
  });

  it("rejects an atomic payload over twenty-four megabytes", () => {
    expect(() => preflightReviewImageSizes([8 * MB, 8 * MB, 8 * MB, 1])).toThrow(/24 MB/i);
  });
});

describe("review image decode budget", () => {
  it("converts twelve bounded images with at most one live bitmap", async () => {
    let activeBitmaps = 0;
    let maxActiveBitmaps = 0;
    const close = vi.fn(() => {
      activeBitmaps -= 1;
    });
    const decode = vi.fn(async () => {
      activeBitmaps += 1;
      maxActiveBitmaps = Math.max(maxActiveBitmaps, activeBitmaps);
      return { width: 2_000, height: 2_000, close };
    });
    vi.stubGlobal("createImageBitmap", decode);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["png"], { type: "image/png" }));
    });
    const attachments = Array.from({ length: 12 }, () => ({
      blob: new Blob([jpegBytes(2_000, 2_000)], { type: "image/jpeg" }),
      mediaType: "image/jpeg",
    }));

    await expect(prepareReviewImageBlobs(attachments)).resolves.toHaveLength(12);
    expect(decode).toHaveBeenCalledTimes(12);
    expect(close).toHaveBeenCalledTimes(12);
    expect(maxActiveBitmaps).toBe(1);
    expect(activeBitmaps).toBe(0);
  });

  it("rejects twelve individually valid large images before any bitmap decode", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const attachments = Array.from({ length: 12 }, () => ({
      blob: new Blob([jpegBytes(8_000, 4_000)], { type: "image/jpeg" }),
      mediaType: "image/jpeg",
    }));

    await expect(prepareReviewImageBlobs(attachments)).rejects.toThrow(/64 megapixel decode budget/i);
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("reviewCommand image-only transport", () => {
  it("sends only ordered image frame metadata", async () => {
    const first = image("first");
    const annotation = image("annotation");
    const second = image("second");
    let draft = createReviewDraft({ id: "review-image-only", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: {
        ...makeSiteReviewFrame({
          id: "site-frame",
          url: "https://preview.example.test/dashboard",
          title: "Dashboard",
          capturedImage: first,
        }),
        photos: [annotation],
        instruction: "Keep the marked spacing exact.",
      },
    }, 1_001);
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makePhotoReviewFrame(second, undefined, "photo-frame"),
    }, 1_002);
    const pngBytes = Uint8Array.from(atob(PNG_1X1), (character) => character.charCodeAt(0));
    const payload = await buildAtomicReviewSend({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb1",
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      activeThreadId: THREAD_ID,
      targetThreadKey: `local:${THREAD_ID}`,
      snapshotSeq: 42,
      draft,
      loadBlob: async () => new Blob([pngBytes.slice().buffer], { type: "image/png" }),
    });
    const command = await reviewCommand(payload);
    expect(command.expectedBridgeInstanceId).toBe(BRIDGE_INSTANCE_ID);
    expect(command.frames).toHaveLength(3);
    expect(Object.keys(command.frames[0] ?? {}).sort()).toEqual([
      "frameId",
      "image",
      "index",
      "kind",
      "scroll",
      "title",
      "url",
      "viewport",
    ]);
  });
});

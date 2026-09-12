import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewDraft, reviewDraftReducer } from "@codex-pad/review";

import { loadCaptureInboxItem, saveCaptureInboxItem } from "./capture-inbox-store";
import { useCaptureInboxInReview } from "./capture-review";
import * as reviewMedia from "./review-media";
import { getReviewBlob, loadReviewDraft, saveReviewDraft } from "./review-store";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";

describe("Capture Inbox Review preparation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  });

  it("uses a neutral quick note in the chosen Session Review without sending", async () => {
    const note = await saveCaptureInboxItem({ kind: "note", title: "Header jump", text: "Reproduce after rotating the iPad.", now: 1_000 });

    await expect(useCaptureInboxInReview([note.id], THREAD_ID)).resolves.toEqual({
      threadId: THREAD_ID,
      itemCount: 1,
      imageCount: 0,
      noteCount: 1,
    });
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({
      targetThreadId: THREAD_ID,
      generalInstruction: expect.stringContaining("Reproduce after rotating the iPad."),
      frames: [],
    });

    await expect(useCaptureInboxInReview([note.id], OTHER_THREAD_ID)).resolves.toMatchObject({ threadId: OTHER_THREAD_ID });
    await expect(loadReviewDraft(OTHER_THREAD_ID)).resolves.toMatchObject({
      targetThreadId: OTHER_THREAD_ID,
      generalInstruction: expect.stringContaining("Reproduce after rotating the iPad."),
    });
  });

  it("keeps unsupported non-image files in the Inbox instead of dropping them", async () => {
    const document = await saveCaptureInboxItem({
      kind: "file",
      title: "Requirements.pdf",
      blob: new Blob(["pdf"], { type: "application/pdf" }),
      now: 1_000,
    });
    await expect(useCaptureInboxInReview([document.id], THREAD_ID)).rejects.toThrow(/cannot attach them yet/i);
    await expect(loadReviewDraft(THREAD_ID)).resolves.toBeNull();
  });

  it("reports concurrent note imports as a conflict and preserves both notes on retry", async () => {
    const captures = await Promise.all([
      saveCaptureInboxItem({ kind: "note", title: "Alpha", text: "Alpha capture", now: 1_000 }),
      saveCaptureInboxItem({ kind: "note", title: "Beta", text: "Beta capture", now: 2_000 }),
    ]);
    const results = await Promise.allSettled(captures.map((capture) => useCaptureInboxInReview([capture.id], THREAD_ID)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failedIndex = results.findIndex((result) => result.status === "rejected");
    const failed = results[failedIndex];
    expect(failed).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/review changed/i) }) });
    const rejectedCapture = captures[failedIndex]!;
    await expect(loadCaptureInboxItem(rejectedCapture.id)).resolves.not.toBeNull();
    await useCaptureInboxInReview([rejectedCapture.id], THREAD_ID);
    const draft = await loadReviewDraft(THREAD_ID);
    expect(draft?.generalInstruction).toContain("Alpha capture");
    expect(draft?.generalInstruction).toContain("Beta capture");
  });

  it("preserves a Review edited while a capture image is being prepared", async () => {
    const original = createReviewDraft({ id: "review-capture-race", targetThreadId: THREAD_ID, now: 1_000 });
    await saveReviewDraft(original);
    const capture = await saveCaptureInboxItem({ kind: "photo", title: "Photo", blob: new Blob(["image"], { type: "image/png" }), now: 1_000 });
    let markPreparing!: () => void;
    const preparing = new Promise<void>((resolve) => { markPreparing = resolve; });
    let finishPreparation!: (value: Awaited<ReturnType<typeof reviewMedia.prepareReviewImage>>) => void;
    const preparation = new Promise<Awaited<ReturnType<typeof reviewMedia.prepareReviewImage>>>((resolve) => { finishPreparation = resolve; });
    vi.spyOn(reviewMedia, "prepareReviewImage").mockImplementationOnce(() => {
      markPreparing();
      return preparation;
    });
    const importing = useCaptureInboxInReview([capture.id], THREAD_ID);
    await preparing;
    const edited = reviewDraftReducer(original, { type: "setGeneralInstruction", instruction: "Keep the newer Review edit" }, 2_000);
    await saveReviewDraft(edited);
    finishPreparation({
      image: {
        id: "capture-race-image",
        source: { kind: "blobRef", blobRef: "capture-race-blob" },
        metadata: { mimeType: "image/png", byteLength: 5, pixelWidth: 1, pixelHeight: 1, fileName: "photo.png", sha256: null, capturedAt: 1_000 },
      },
      blob: new Blob(["image"], { type: "image/png" }),
    });
    await expect(importing).rejects.toThrow(/review changed/i);
    await expect(loadReviewDraft(THREAD_ID)).resolves.toEqual(edited);
    await expect(getReviewBlob("capture-race-blob")).resolves.toBeNull();
    await expect(loadCaptureInboxItem(capture.id)).resolves.not.toBeNull();
  });
});

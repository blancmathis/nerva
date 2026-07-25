import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { saveCaptureInboxItem } from "./capture-inbox-store";
import { useCaptureInboxInReview } from "./capture-review";
import { loadReviewDraft } from "./review-store";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";

describe("Capture Inbox Review preparation", () => {
  beforeEach(() => {
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
});

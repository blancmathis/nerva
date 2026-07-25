import {
  REVIEW_LIMITS,
  createReviewDraft,
  reviewDraftReducer,
  type ReviewDraft,
  type ReviewFrame,
  type ReviewImage,
} from "@codex-pad/review";

import { makePhotoReviewFrame, reviewId } from "../components/review-state";
import { loadCaptureInboxItem, type CaptureInboxItem } from "./capture-inbox-store";
import { prepareReviewImage } from "./review-media";
import { loadReviewDraft, saveReviewDraftWithBlobChanges, type ReviewBlobWrite } from "./review-store";

export interface CaptureReviewUseResult {
  readonly threadId: string;
  readonly itemCount: number;
  readonly imageCount: number;
  readonly noteCount: number;
}

export function captureCanUseInReview(item: CaptureInboxItem): boolean {
  return item.kind === "note" || Boolean(item.mimeType?.startsWith("image/"));
}

function geometryForImage(image: ReviewImage): Pick<ReviewFrame, "viewport" | "scroll"> {
  const scale = Math.min(1, 16_384 / Math.max(image.metadata.pixelWidth, image.metadata.pixelHeight));
  return {
    viewport: {
      width: Math.max(1, Math.round(image.metadata.pixelWidth * scale)),
      height: Math.max(1, Math.round(image.metadata.pixelHeight * scale)),
      deviceScaleFactor: 1,
    },
    scroll: { x: 0, y: 0 },
  };
}

function pristineBlankFrame(frame: ReviewFrame): boolean {
  return frame.kind === "blank"
    && frame.capturedImage === null
    && frame.drawing === null
    && frame.photos.length === 0
    && frame.instruction.trim().length === 0
    && frame.comparison.before === null
    && frame.comparison.after === null;
}

function noteBlock(item: CaptureInboxItem): string {
  const text = item.text?.trim() ?? "";
  if (!text) return item.title;
  const lines = text.split(/\r?\n/u);
  const first = lines[0]?.trim().replace(/\s+/gu, "") ?? "";
  const title = item.title.trim().replace(/\s+/gu, "");
  const body = first.toLocaleLowerCase() === title.toLocaleLowerCase()
    ? lines.slice(1).join("\n").trim()
    : text;
  return body ? `${item.title}\n${body}` : item.title;
}

function appendNotes(current: string, notes: readonly CaptureInboxItem[]): string {
  if (notes.length === 0) return current;
  const addition = ["Capture Inbox notes", ...notes.map((item) => `• ${noteBlock(item)}`)].join("\n");
  const next = current.trim() ? `${current.trim()}\n\n${addition}` : addition;
  if (next.length > REVIEW_LIMITS.instructionCharacters) {
    throw new Error("These notes would exceed the local Review instruction limit. Use fewer notes at once.");
  }
  return next;
}

export async function useCaptureInboxInReview(
  itemIds: readonly string[],
  threadId: string,
): Promise<CaptureReviewUseResult> {
  const uniqueIds = [...new Set(itemIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) throw new Error("Select at least one capture.");

  const loaded = await Promise.all(uniqueIds.map((id) => loadCaptureInboxItem(id)));
  if (loaded.some((entry) => entry === null)) throw new Error("One selected capture is no longer available.");
  const captures = loaded.map((entry) => entry!);
  const unsupported = captures.filter(({ item }) => !captureCanUseInReview(item));
  if (unsupported.length > 0) {
    throw new Error("Non-image files stay safely in Capture Inbox, but this Codex Review transport cannot attach them yet.");
  }

  const notes = captures.filter(({ item }) => item.kind === "note").map(({ item }) => item);
  const imageCaptures = captures.filter(({ item }) => item.kind !== "note");
  let draft = await loadReviewDraft(threadId) ?? createReviewDraft({
    id: reviewId("review"),
    targetThreadId: threadId,
  });

  const existingFrameIds = new Set(draft.frames.map((frame) => frame.id));
  const pendingImages = imageCaptures.filter(({ item }) => !existingFrameIds.has(`capture-${item.id}`));
  const onlyFrame = draft.frames.length === 1 ? draft.frames[0] ?? null : null;
  const removableBlank = onlyFrame && pristineBlankFrame(onlyFrame) ? onlyFrame : null;
  const futureFrameCount = draft.frames.length - (removableBlank && pendingImages.length > 0 ? 1 : 0) + pendingImages.length;
  if (futureFrameCount > REVIEW_LIMITS.frames) {
    throw new Error(`This Review can hold ${REVIEW_LIMITS.frames} frames. Remove frames or use fewer captures.`);
  }

  const blobWrites: ReviewBlobWrite[] = [];
  const preparedFrames: ReviewFrame[] = [];
  for (const { item, blob } of pendingImages) {
    if (!blob) throw new Error(`${item.title} no longer has local media.`);
    const prepared = await prepareReviewImage(blob, item.fileName ?? `${item.title}.png`);
    const geometry = geometryForImage(prepared.image);
    preparedFrames.push(makePhotoReviewFrame(prepared.image, geometry, `capture-${item.id}`));
    if (prepared.image.source.kind !== "blobRef") throw new Error("The prepared image is not locally addressable.");
    blobWrites.push({ id: prepared.image.source.blobRef, blob: prepared.blob });
  }

  const originalDraft = draft;
  let now = Math.max(Date.now(), draft.updatedAt + 1);
  if (removableBlank && preparedFrames.length > 0) {
    draft = reviewDraftReducer(draft, { type: "deleteFrame", frameId: removableBlank.id }, now++);
  }
  for (const frame of preparedFrames) {
    draft = reviewDraftReducer(draft, { type: "addFrame", frame }, now++);
  }
  const nextInstruction = appendNotes(draft.generalInstruction, notes);
  if (nextInstruction !== draft.generalInstruction) {
    draft = reviewDraftReducer(draft, { type: "setGeneralInstruction", instruction: nextInstruction }, now++);
  }

  if (draft === originalDraft && notes.length === 0) {
    return { threadId, itemCount: uniqueIds.length, imageCount: imageCaptures.length, noteCount: notes.length };
  }
  await saveReviewDraftWithBlobChanges(draft, blobWrites);
  return {
    threadId,
    itemCount: uniqueIds.length,
    imageCount: imageCaptures.length,
    noteCount: notes.length,
  };
}

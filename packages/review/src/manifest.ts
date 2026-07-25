import {
  ReviewDraftSchema,
  type ReviewDraft,
  type ReviewImage,
  type ReviewImageSource,
} from "./schemas.js";
import { REVIEW_SEND_INSTRUCTION_MAX_CHARACTERS } from "./constants.js";
import { assertDraftTarget } from "./target.js";

export interface AtomicReviewImageRef {
  readonly order: number;
  readonly label: string;
  readonly frameId: string;
  readonly imageId: string;
  readonly source: ReviewImageSource;
  readonly mimeType: ReviewImage["metadata"]["mimeType"];
}

export interface AtomicReviewSendManifest {
  readonly version: 1;
  readonly reviewId: string;
  readonly targetThreadId: string;
  /** The sole text input to submit with this atomic review turn. */
  readonly instruction: string;
  /** Image inputs in the exact order in which labels appear in instruction. */
  readonly images: readonly AtomicReviewImageRef[];
}

/** Short ergonomic alias for UI state and bridge request types. */
export type AtomicReviewManifest = AtomicReviewSendManifest;

interface LabeledImage {
  readonly role: string;
  readonly image: ReviewImage;
}

function frameImages(frame: ReviewDraft["frames"][number]): readonly LabeledImage[] {
  const images: LabeledImage[] = [];
  if (frame.drawing?.renderedImage !== undefined) {
    // The rendered drawing is already a flattened composite containing the frame background.
    // Sending the source capture as well would double-count one visual observation and can
    // incorrectly push an otherwise mono review behind the multi-image capability gate.
    images.push({ role: "composite", image: frame.drawing.renderedImage });
  } else if (frame.capturedImage !== null) {
    images.push({ role: "capture", image: frame.capturedImage });
  }
  if (frame.comparison.before !== null) {
    images.push({ role: "before", image: frame.comparison.before.image });
  }
  if (frame.comparison.after !== null) {
    images.push({ role: "after", image: frame.comparison.after.image });
  }
  frame.photos.forEach((image, index) => images.push({ role: `photo-${index + 1}`, image }));
  return images;
}

function encodedText(value: string | null): string {
  return JSON.stringify(value);
}

function frameKindCode(kind: ReviewDraft["frames"][number]["kind"]): string {
  switch (kind) {
    case "site-snapshot":
      return "site";
    case "photo":
      return "photo";
    case "blank":
      return "blank";
  }
}

function formatFrame(
  frame: ReviewDraft["frames"][number],
  frameNumber: number,
  labeledImages: readonly AtomicReviewImageRef[],
): string {
  // Ordinals are the compact text identity. JSON string encoding keeps user text lossless and
  // unambiguous even when it contains newlines or delimiter-looking content.
  const images = labeledImages.length === 0
    ? "none"
    : labeledImages.map((image) => image.label).join(",");
  return [
    `F${frameNumber}`,
    `kind=${frameKindCode(frame.kind)}`,
    `images=${images}`,
    `vp=${frame.viewport.width}x${frame.viewport.height}@${frame.viewport.deviceScaleFactor}`,
    `scroll=${frame.scroll.x},${frame.scroll.y}`,
    `compare=${frame.comparison.mode}`,
    `drawing=${frame.drawing === null ? "none" : frame.drawing.kind}`,
    `title=${encodedText(frame.title)}`,
    `url=${encodedText(frame.url)}`,
    `note=${encodedText(frame.instruction)}`,
  ].join("|");
}

/**
 * Builds one immutable, ordered send envelope. Callers must resolve all refs first and submit
 * `instruction` plus `images` in one app-server turn; partial per-frame sends are not equivalent.
 */
export function createAtomicSendManifest(
  draftInput: ReviewDraft,
  targetThreadId: string = draftInput.targetThreadId,
): AtomicReviewSendManifest {
  const draft = ReviewDraftSchema.parse(draftInput);
  assertDraftTarget(draft, targetThreadId);

  const images: AtomicReviewImageRef[] = [];
  const frameSections: string[] = [];
  draft.frames.forEach((frame, frameIndex) => {
    const frameRefs: AtomicReviewImageRef[] = frameImages(frame).map(({ role, image }) => {
      const ref: AtomicReviewImageRef = {
        order: images.length,
        label: `[F${frameIndex + 1}:${role}]`,
        frameId: frame.id,
        imageId: image.id,
        source: image.source,
        mimeType: image.metadata.mimeType,
      };
      images.push(ref);
      return ref;
    });
    frameSections.push(formatFrame(frame, frameIndex + 1, frameRefs));
  });

  const generalInstruction = draft.generalInstruction.trim().length === 0
    ? "Review the supplied material and act on the observations."
    : draft.generalInstruction;
  const instruction = [
    "# Codex Pad multimodal review",
    "Treat this as one atomic review. Preserve F1..Fn and image-label order.",
    `## General instruction\ninstruction=${encodedText(generalInstruction)}`,
    "## Ordered frames",
    frameSections.length === 0 ? "None." : frameSections.join("\n\n"),
  ].join("\n\n");

  if (instruction.length > REVIEW_SEND_INSTRUCTION_MAX_CHARACTERS) {
    throw new RangeError(
      `Atomic review text is ${instruction.length} characters; the transport limit is ${REVIEW_SEND_INSTRUCTION_MAX_CHARACTERS}. Shorten a URL, title, note, or general instruction. Nothing was clipped.`,
    );
  }

  return Object.freeze({
    version: 1 as const,
    reviewId: draft.id,
    targetThreadId: draft.targetThreadId,
    instruction,
    images: Object.freeze(images.map((image) => Object.freeze(image))),
  });
}

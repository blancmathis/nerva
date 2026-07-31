import {
  ReviewDraftSchema,
  assertDraftTarget,
  createAtomicSendManifest,
  type ReviewDraft,
} from "@codex-pad/review";
import { CommandIdSchema } from "@codex-pad/protocol";

export interface ReviewAttachment {
  readonly ref: string;
  readonly kind: "frame" | "photo";
  readonly frameId: string | null;
  readonly mediaType: string;
  readonly fileName: string;
  readonly size: number;
  readonly blob: Blob;
}

export interface AtomicReviewSend {
  readonly commandId: string;
  readonly expectedBridgeInstanceId: string;
  readonly targetThreadId: string;
  readonly targetThreadKey: string;
  readonly snapshotSeq: number;
  readonly draft: ReviewDraft;
  readonly manifest: ReturnType<typeof createAtomicSendManifest>;
  readonly attachments: readonly ReviewAttachment[];
  /** Frozen before the first attempt so retries keep byte-identical prompt text. */
  readonly instructionSuffix: string;
  readonly skillIds: readonly string[];
}

export interface BuildAtomicReviewSendInput {
  readonly commandId: string;
  readonly expectedBridgeInstanceId: string;
  readonly activeThreadId: string;
  readonly targetThreadKey: string;
  readonly snapshotSeq: number;
  readonly draft: ReviewDraft;
  readonly loadBlob: (ref: string) => Promise<Blob | null>;
  readonly instructionSuffix?: string;
  readonly skillIds?: readonly string[];
}

function normalizeThreadId(value: string): string {
  return value.trim().toLowerCase();
}

function assertManifestTextIntegrity(
  draft: ReviewDraft,
  instruction: string,
): void {
  const general = draft.generalInstruction.trim().length === 0
    ? "Review the supplied material and act on the observations."
    : draft.generalInstruction;
  const requiredMarkers = [
    `instruction=${JSON.stringify(general)}`,
    ...draft.frames.flatMap((frame) => [
      `title=${JSON.stringify(frame.title)}`,
      `url=${JSON.stringify(frame.url)}`,
      `note=${JSON.stringify(frame.instruction)}`,
    ]),
  ];
  if (requiredMarkers.some((marker) => !instruction.includes(marker))) {
    throw new Error("The atomic review manifest omitted exact review text. Nothing was sent.");
  }
}

export function guardExactReviewTarget(draft: ReviewDraft, activeThreadId: string): void {
  try {
    assertDraftTarget(draft, normalizeThreadId(activeThreadId));
  } catch {
    throw new Error("This review belongs to a different Codex thread. Select the original task to send it.");
  }
}

function extension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

function dataUrlBlob(dataUrl: string, mimeType: string): Blob | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

/** Resolve every referenced binary before creating the single, retryable review command. */
export async function buildAtomicReviewSend(input: BuildAtomicReviewSendInput): Promise<AtomicReviewSend> {
  const draft = ReviewDraftSchema.parse(input.draft);
  guardExactReviewTarget(draft, input.activeThreadId);
  const commandId = CommandIdSchema.parse(input.commandId);
  const keyThreadId = input.targetThreadKey.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  )?.[0]?.toLowerCase();
  if (keyThreadId !== draft.targetThreadId) {
    throw new Error("The selected native slot no longer points to this review thread.");
  }
  for (const frame of draft.frames) {
    if ((frame.title?.length ?? 0) > 500) {
      throw new Error(`Frame ${frame.id} title exceeds the 500-character transport limit.`);
    }
    if ((frame.url?.length ?? 0) > 2_048) {
      throw new Error(`Frame ${frame.id} URL exceeds the 2048-character transport limit.`);
    }
    if (frame.viewport.width > 16_384 || frame.viewport.height > 16_384) {
      throw new Error(`Frame ${frame.id} viewport exceeds the 16384-pixel transport limit.`);
    }
    if (frame.scroll.x < 0 || frame.scroll.y < 0) {
      throw new Error(`Frame ${frame.id} has a negative scroll position that cannot be transported.`);
    }
  }
  const manifest = createAtomicSendManifest(draft, input.activeThreadId);
  if (manifest.images.length === 0) {
    throw new Error("Add a screenshot, photo, or annotation before sending this review.");
  }
  if (manifest.images.length > 12) {
    throw new Error("This review has more than 12 outbound images. Remove or merge frames before sending.");
  }
  assertManifestTextIntegrity(draft, manifest.instruction);
  const attachments: ReviewAttachment[] = [];
  for (const image of manifest.images) {
    const ref = image.source.kind === "blobRef" ? image.source.blobRef : image.imageId;
    const blob = image.source.kind === "blobRef"
      ? await input.loadBlob(ref)
      : dataUrlBlob(image.source.dataUrl, image.mimeType);
    if (!blob) throw new Error(`Review image ${image.imageId} is missing from this iPad.`);
    attachments.push({
      ref,
      kind: image.label.includes(":photo-") ? "photo" : "frame",
      frameId: image.frameId,
      mediaType: image.mimeType,
      fileName: `review-${image.order + 1}.${extension(image.mimeType)}`,
      size: blob.size,
      blob,
    });
  }
  return {
    commandId,
    expectedBridgeInstanceId: input.expectedBridgeInstanceId,
    targetThreadId: draft.targetThreadId,
    targetThreadKey: input.targetThreadKey,
    snapshotSeq: input.snapshotSeq,
    draft,
    manifest,
    attachments,
    instructionSuffix: input.instructionSuffix ?? "",
    skillIds: input.skillIds ?? [],
  };
}

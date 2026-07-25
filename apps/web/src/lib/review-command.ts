import {
  MAX_REVIEW_FRAMES,
  MAX_REVIEW_FRAME_BYTES,
  MAX_REVIEW_TOTAL_BYTES,
  SendReviewCommandSchema,
  type ReviewFrame,
  type SendReviewCommand,
} from "@codex-pad/protocol";
import type { AtomicReviewSend } from "../components/ReviewStudio";
import { inspectImageHeader, type SupportedImageFormat } from "./image-header";

export const MAX_REVIEW_AGGREGATE_DECODE_PIXELS = 64_000_000;

async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((png) => png ? resolve(png) : reject(new Error("Review PNG conversion failed.")), "image/png");
  });
}

async function blobToPng(blob: Blob, format: SupportedImageFormat): Promise<Blob> {
  if (format === "png" && blob.size <= MAX_REVIEW_FRAME_BYTES) return blob;
  const bitmap = await createImageBitmap(blob);
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare the review image.");
    let scale = Math.min(1, 16_384 / bitmap.width, 16_384 / bitmap.height);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const png = await canvasPng(canvas);
      if (png.size <= MAX_REVIEW_FRAME_BYTES) return png;
      scale *= 0.72;
    }
    throw new Error("A converted review image is still larger than 8 MB. Crop or resize it before sending.");
  } finally {
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
    bitmap.close();
  }
}

function expectedImageFormat(mediaType: string): SupportedImageFormat {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpeg";
  if (mediaType === "image/webp") return "webp";
  throw new Error("Review transport accepts only normalized PNG, JPEG, or still WebP images.");
}

export async function prepareReviewImageBlobs(
  attachments: readonly { readonly blob: Blob; readonly mediaType: string }[],
): Promise<readonly Blob[]> {
  preflightReviewImageSizes(Array.from({ length: attachments.length }, () => 0));
  let aggregateDecodedPixels = 0n;
  const formats: SupportedImageFormat[] = [];
  for (const attachment of attachments) {
    const header = await inspectImageHeader(
      attachment.blob,
      expectedImageFormat(attachment.mediaType),
    );
    formats.push(header.format);
    aggregateDecodedPixels += header.aggregateDecodedPixels;
    if (aggregateDecodedPixels > BigInt(MAX_REVIEW_AGGREGATE_DECODE_PIXELS)) {
      throw new Error(
        `Review images exceed the ${MAX_REVIEW_AGGREGATE_DECODE_PIXELS / 1_000_000} megapixel decode budget. Remove or resize images before sending.`,
      );
    }
  }

  const converted: Blob[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const png = await blobToPng(attachment.blob, formats[index]!);
    converted.push(png);
    preflightReviewImageSizes(converted.map((value) => value.size));
  }
  return converted;
}

async function base64(blob: Blob): Promise<string> {
  const buffer = typeof blob.arrayBuffer === "function"
    ? await blob.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          if (reader.result instanceof ArrayBuffer) resolve(reader.result);
          else reject(new Error("Review PNG encoding failed."));
        }, { once: true });
        reader.addEventListener("error", () => reject(new Error("Review PNG encoding failed.")), {
          once: true,
        });
        reader.readAsArrayBuffer(blob);
      });
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Stable across a retry so one command ID always has byte-for-byte frame identity. */
async function stableUuid(seed: string): Promise<string> {
  if (!crypto.subtle) throw new Error("Secure hashing is unavailable; the review was not sent.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function preflightReviewImageSizes(sizes: readonly number[]): void {
  if (sizes.length > MAX_REVIEW_FRAMES) {
    throw new Error(`A review can send at most ${MAX_REVIEW_FRAMES} ordered images.`);
  }
  const oversized = sizes.find((size) => size > MAX_REVIEW_FRAME_BYTES);
  if (oversized !== undefined) throw new Error("A converted review image exceeds the 8 MB frame limit.");
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > MAX_REVIEW_TOTAL_BYTES) throw new Error("Review images exceed the 24 MB atomic payload limit.");
}

function assertCanonicalReviewText(payload: AtomicReviewSend): void {
  const general = payload.draft.generalInstruction.trim().length === 0
    ? "Review the supplied material and act on the observations."
    : payload.draft.generalInstruction;
  const markers = [
    `instruction=${JSON.stringify(general)}`,
    ...payload.draft.frames.flatMap((frame) => [
      `title=${JSON.stringify(frame.title)}`,
      `url=${JSON.stringify(frame.url)}`,
      `note=${JSON.stringify(frame.instruction)}`,
    ]),
  ];
  if (markers.some((marker) => !payload.manifest.instruction.includes(marker))) {
    throw new Error("The review command is missing exact title, URL, or note text. Nothing was sent.");
  }
}

export async function reviewCommand(payload: AtomicReviewSend): Promise<SendReviewCommand> {
  const imageAttachments = payload.attachments;
  if (imageAttachments.length !== payload.manifest.images.length || imageAttachments.length === 0) {
    throw new Error("Add at least one captured, imported, or annotated image before sending this review.");
  }
  if (payload.manifest.instruction.trim().length > 8_000) {
    throw new Error("Review instructions exceed the 8,000 character transport limit.");
  }
  assertCanonicalReviewText(payload);

  const convertedPngs = await prepareReviewImageBlobs(imageAttachments);

  const frames: ReviewFrame[] = [];
  for (const [index, imageRef] of payload.manifest.images.entries()) {
    const attachment = imageAttachments[index];
    const draftFrame = payload.draft.frames.find((frame) => frame.id === imageRef.frameId);
    if (!attachment || !draftFrame) throw new Error("The ordered review frame is incomplete.");
    const png = convertedPngs[index];
    if (!png) throw new Error("The ordered review PNG is missing.");
    frames.push({
      frameId: await stableUuid(`${payload.manifest.reviewId}:${imageRef.imageId}:${index}`),
      index,
      kind: draftFrame.kind === "site-snapshot" ? "siteSnapshot" : draftFrame.kind,
      image: { kind: "inlinePng", png: await base64(png) },
      url: draftFrame.kind === "site-snapshot" ? draftFrame.url : null,
      title: draftFrame.title,
      viewport: {
        width: draftFrame.viewport.width,
        height: draftFrame.viewport.height,
        devicePixelRatio: draftFrame.viewport.deviceScaleFactor,
      },
      scroll: {
        x: Math.max(0, draftFrame.scroll.x),
        y: Math.max(0, draftFrame.scroll.y),
        documentWidth: Math.max(draftFrame.viewport.width, draftFrame.viewport.width + Math.max(0, draftFrame.scroll.x)),
        documentHeight: Math.max(draftFrame.viewport.height, draftFrame.viewport.height + Math.max(0, draftFrame.scroll.y)),
      },
    });
  }

  return SendReviewCommandSchema.parse({
    type: "sendReview",
    commandId: payload.commandId,
    expectedBridgeInstanceId: payload.expectedBridgeInstanceId,
    expectedSequence: payload.snapshotSeq,
    expectedThreadId: payload.targetThreadId,
    targetThreadId: payload.targetThreadId,
    snapshotSeq: payload.snapshotSeq,
    instruction: payload.manifest.instruction,
    frames,
  });
}

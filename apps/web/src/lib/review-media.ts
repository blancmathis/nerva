import type { ReviewImage } from "@codex-pad/review";
import { isHeicImage, normalizeHeicToPng } from "./heic-image";
import {
  decodedDimensionsMatchHeader,
  imageExceedsDimensionLimit,
  imageExceedsPixelLimit,
  inspectImageHeader,
  MAX_SAFE_IMAGE_DIMENSION,
  type InspectedImageHeader,
  type SupportedImageFormat,
} from "./image-header";
import { createUuidV4 } from "./uuid";

export const MAX_REVIEW_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_REVIEW_IMAGE_PIXELS = 32_000_000;

const REVIEW_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function makeId(prefix: string): string {
  return `${prefix}-${createUuidV4()}`;
}

async function dimensionsForImage(
  blob: Blob,
  header: InspectedImageHeader,
): Promise<{ width: number; height: number }> {
  const decodeWithImageElement = async (): Promise<{ width: number; height: number }> => {
    if (typeof document === "undefined") throw new Error("Image decoding is unavailable.");
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener(
          "load",
          () => resolve({ width: image.naturalWidth, height: image.naturalHeight }),
          { once: true },
        );
        image.addEventListener("error", () => reject(new Error("The image could not be decoded.")), {
          once: true,
        });
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  let dimensions: { width: number; height: number } | null = null;
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
        let accepting = true;
        const timer = window.setTimeout(() => {
          accepting = false;
          reject(new Error("ImageBitmap decoding timed out."));
        }, 1_500);
        try {
          void createImageBitmap(blob).then((candidate) => {
            if (!accepting) {
              candidate.close();
              return;
            }
            window.clearTimeout(timer);
            resolve(candidate);
          }, (error: unknown) => {
            if (!accepting) return;
            accepting = false;
            window.clearTimeout(timer);
            reject(error instanceof Error ? error : new Error("ImageBitmap decoding failed."));
          });
        } catch (error) {
          accepting = false;
          window.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("ImageBitmap decoding failed."));
        }
      });
      dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
    } catch {
      // Safari/WebKit can expose createImageBitmap while rejecting an image
      // that its ordinary image decoder accepts. Fall through to that native
      // path before rejecting a bounded, header-validated file.
    }
  }
  dimensions ??= await decodeWithImageElement();
  if (!decodedDimensionsMatchHeader(header, dimensions.width, dimensions.height)) {
    throw new Error("The decoded image dimensions do not match its header.");
  }
  return dimensions;
}

async function digestSha256(blob: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export interface PreparedReviewImage {
  readonly image: ReviewImage;
  readonly blob: Blob;
}

export async function prepareReviewImage(file: File | Blob, fileName?: string): Promise<PreparedReviewImage> {
  const originalName = fileName ?? (typeof File !== "undefined" && file instanceof File ? file.name : undefined);
  const heic = isHeicImage(file, originalName);
  if (!heic && !REVIEW_IMAGE_TYPES.has(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, HEIC, or HEIF image.");
  }
  if (file.size <= 0 || file.size > MAX_REVIEW_IMAGE_BYTES) {
    throw new Error("Choose an image smaller than 15 MB.");
  }
  const expectedFormat: SupportedImageFormat = heic
    ? "heif"
    : file.type === "image/png"
      ? "png"
      : file.type === "image/jpeg"
        ? "jpeg"
        : "webp";
  const header = await inspectImageHeader(file, expectedFormat);
  if (imageExceedsDimensionLimit(header)) {
    throw new Error(`Choose an image no wider or taller than ${MAX_SAFE_IMAGE_DIMENSION} pixels.`);
  }
  if (imageExceedsPixelLimit(header, MAX_REVIEW_IMAGE_PIXELS)) {
    throw new Error("Choose an image smaller than 32 megapixels.");
  }
  const normalized = heic
    ? await normalizeHeicToPng(file, originalName, {
      maxBytes: MAX_REVIEW_IMAGE_BYTES,
      maxDimension: MAX_SAFE_IMAGE_DIMENSION,
      maxPixels: MAX_REVIEW_IMAGE_PIXELS,
    })
    : null;
  const preparedBlob = normalized?.blob ?? file;
  const preparedName = normalized?.fileName ?? originalName;
  const dimensions = normalized ?? await dimensionsForImage(preparedBlob, header);
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    imageExceedsDimensionLimit(dimensions) ||
    imageExceedsPixelLimit(dimensions, MAX_REVIEW_IMAGE_PIXELS)
  ) {
    throw new Error("Choose an image smaller than 32 megapixels.");
  }
  const blobRef = makeId("review-image");
  return {
    blob: preparedBlob,
    image: {
      id: makeId("image"),
      source: { kind: "blobRef", blobRef },
      metadata: {
        mimeType: preparedBlob.type as "image/png" | "image/jpeg" | "image/webp",
        byteLength: preparedBlob.size,
        pixelWidth: dimensions.width,
        pixelHeight: dimensions.height,
        fileName: preparedName ?? null,
        sha256: await digestSha256(preparedBlob),
        capturedAt: Date.now(),
      },
    },
  };
}

export function reviewImageBlobRef(image: ReviewImage): string | null {
  return image.source.kind === "blobRef" ? image.source.blobRef : null;
}

export function reviewImageDataUrl(image: ReviewImage): string | null {
  return image.source.kind === "dataUrl" ? image.source.dataUrl : null;
}

export function formatReviewBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

import type { DataUrlImageSource } from "@codex-pad/drawing";
import { isHeicImage, normalizeHeicToPng } from "../lib/heic-image";
import {
  decodedDimensionsMatchHeader,
  imageExceedsDimensionLimit,
  imageExceedsPixelLimit,
  inspectImageHeader,
  MAX_SAFE_IMAGE_DIMENSION,
  type InspectedImageHeader,
  type SupportedImageFormat,
} from "../lib/image-header";

export const MAX_IMPORTED_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMPORTED_IMAGE_PIXELS = 16_000_000;

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface PreparedImage {
  source: DataUrlImageSource;
  width: number;
  height: number;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The selected image could not be read."));
    });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(file);
  });
}

async function readDimensions(
  file: File,
  dataUrl: string,
  header: InspectedImageHeader,
): Promise<{ width: number; height: number }> {
  let dimensions: { width: number; height: number };
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
  } else {
    dimensions = await new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener(
        "load",
        () => resolve({ width: image.naturalWidth, height: image.naturalHeight }),
        { once: true },
      );
      image.addEventListener("error", () => reject(new Error("The selected image is invalid.")), {
        once: true,
      });
      image.src = dataUrl;
    });
  }
  if (!decodedDimensionsMatchHeader(header, dimensions.width, dimensions.height)) {
    throw new Error("The decoded image dimensions do not match its header.");
  }
  return dimensions;
}

async function sha256(file: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return null;
  }
}

export async function prepareImportedImage(file: File): Promise<PreparedImage> {
  const heic = isHeicImage(file, file.name);
  if (!heic && !ACCEPTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, HEIC, or HEIF image.");
  }
  if (file.size <= 0 || file.size > MAX_IMPORTED_IMAGE_BYTES) {
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
  if (imageExceedsPixelLimit(header, MAX_IMPORTED_IMAGE_PIXELS)) {
    throw new Error("Choose an image smaller than 16 megapixels.");
  }

  const normalized = heic
    ? await normalizeHeicToPng(file, file.name, {
      maxBytes: MAX_IMPORTED_IMAGE_BYTES,
      maxDimension: MAX_SAFE_IMAGE_DIMENSION,
      maxPixels: MAX_IMPORTED_IMAGE_PIXELS,
    })
    : null;
  const preparedBlob = normalized?.blob ?? file;
  const preparedName = normalized?.fileName ?? file.name;
  const dataUrl = await readAsDataUrl(preparedBlob);
  const dimensions = normalized ?? await readDimensions(file, dataUrl, header);
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    imageExceedsDimensionLimit(dimensions) ||
    imageExceedsPixelLimit(dimensions, MAX_IMPORTED_IMAGE_PIXELS)
  ) {
    throw new Error("Choose an image smaller than 16 megapixels.");
  }

  return {
    source: {
      kind: "dataUrl",
      dataUrl,
      metadata: {
        mimeType: preparedBlob.type as "image/png" | "image/jpeg" | "image/webp",
        byteLength: preparedBlob.size,
        pixelWidth: dimensions.width,
        pixelHeight: dimensions.height,
        name: preparedName || null,
        sha256: await sha256(preparedBlob),
      },
    },
    ...dimensions,
  };
}

export function fitImageInside(
  image: { width: number; height: number },
  frame: { width: number; height: number },
  coverage = 0.86,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(
    (frame.width * coverage) / image.width,
    (frame.height * coverage) / image.height,
    1,
  );
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (frame.width - width) / 2,
    y: (frame.height - height) / 2,
    width,
    height,
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The preview could not be encoded."));
    });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("The preview could not be encoded.");
  return dataUrl.slice(separator + 1);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

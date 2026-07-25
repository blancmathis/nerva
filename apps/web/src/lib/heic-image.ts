import {
  decodedDimensionsMatchHeader,
  imageExceedsDimensionLimit,
  imageExceedsPixelLimit,
  inspectImageHeader,
} from "./image-header";

export const PHOTO_IMPORT_ACCEPT = "image/*,.heic,.heif";

const HEIC_IMAGE_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

export interface NormalizedHeicImage {
  readonly blob: Blob;
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
}

interface HeicImportLimits {
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly maxPixels: number;
}

interface DecodedHeicImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

function heicFileName(fileName: string | undefined): boolean {
  return /\.(?:heic|heif)$/i.test(fileName?.trim() ?? "");
}

export function isHeicImage(blob: Blob, fileName?: string): boolean {
  return HEIC_IMAGE_TYPES.has(blob.type.toLowerCase()) || heicFileName(fileName);
}

function pngFileName(fileName: string | undefined): string {
  const trimmed = fileName?.trim();
  if (!trimmed) return "photo.png";
  if (heicFileName(trimmed)) return trimmed.replace(/\.(?:heic|heif)$/i, ".png");
  return `${trimmed}.png`;
}

async function decodeWithImageElement(blob: Blob): Promise<DecodedHeicImage> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("Image element decoding is unavailable.");
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.addEventListener("load", () => resolve(candidate), { once: true });
      candidate.addEventListener("error", () => reject(new Error("Image element decoding failed.")), {
        once: true,
      });
      candidate.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => undefined,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeHeic(blob: Blob): Promise<DecodedHeicImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Safari versions that decode HEIC through HTMLImageElement may not expose
      // the same decoder through createImageBitmap, so try that native path too.
    }
  }
  return decodeWithImageElement(blob);
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === "image/png" && blob.size > 0) resolve(blob);
      else reject(new Error("The decoded photo could not be converted to PNG."));
    }, "image/png");
  });
}

/**
 * Uses only decoders already present in the browser, then immediately converts
 * the result to PNG so HEIC bytes never enter a persisted scene or review.
 */
export async function normalizeHeicToPng(
  blob: Blob,
  fileName: string | undefined,
  limits: HeicImportLimits,
): Promise<NormalizedHeicImage> {
  if (!isHeicImage(blob, fileName)) throw new Error("The selected photo is not HEIC or HEIF.");
  if (blob.size <= 0 || blob.size > limits.maxBytes) {
    throw new Error(`Choose an image smaller than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
  }

  const header = await inspectImageHeader(blob, "heif");
  if (imageExceedsDimensionLimit(header, limits.maxDimension)) {
    throw new Error(`Choose an image no wider or taller than ${limits.maxDimension} pixels.`);
  }
  if (imageExceedsPixelLimit(header, limits.maxPixels)) {
    throw new Error(
      `Choose an image smaller than ${Math.round(limits.maxPixels / 1_000_000)} megapixels.`,
    );
  }

  let decoded: DecodedHeicImage;
  try {
    decoded = await decodeHeic(blob);
  } catch {
    throw new Error(
      "This browser cannot decode this HEIC/HEIF photo. Update Safari or export the photo as JPEG or PNG.",
    );
  }

  try {
    const { width, height } = decoded;
    if (
      width <= 0 ||
      height <= 0 ||
      imageExceedsDimensionLimit({ width, height }, limits.maxDimension) ||
      imageExceedsPixelLimit({ width, height }, limits.maxPixels)
    ) {
      throw new Error(
        `Choose an image smaller than ${Math.round(limits.maxPixels / 1_000_000)} megapixels.`,
      );
    }
    if (!decodedDimensionsMatchHeader(header, width, height)) {
      throw new Error("The decoded HEIC/HEIF dimensions do not match its header.");
    }
    if (typeof document === "undefined") {
      throw new Error("HEIC/HEIF conversion is unavailable in this browser.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("HEIC/HEIF conversion is unavailable in this browser.");
    context.drawImage(decoded.source, 0, 0, width, height);
    const png = await canvasToPng(canvas);
    if (png.size > limits.maxBytes) {
      throw new Error(
        `The decoded HEIC/HEIF photo is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB as PNG. Export a smaller JPEG or PNG first.`,
      );
    }
    return { blob: png, fileName: pngFileName(fileName), width, height };
  } finally {
    decoded.close();
  }
}

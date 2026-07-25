import { constants as fsConstants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { BridgeDataPaths } from "./paths.js";
import { ensurePrivateSketchDirectory } from "./runtime-cleanup.js";

export const MAX_SKETCH_BYTES = 8 * 1024 * 1024;
export const MAX_SKETCH_DIMENSION = 8_192;
export const MAX_SKETCH_PIXELS = 16_777_216;
const MAX_NORMALIZE_ATTEMPTS = 6;
const MIN_LEGIBLE_LONG_EDGE = 1_024;
const NORMALIZED_SIZE_TARGET = Math.floor(MAX_SKETCH_BYTES * 0.92);
const MAX_RESIZE_FACTOR = 0.9;

export const sketchRequestSchema = z.object({
  commandId: z.uuid(),
  snapshotSeq: z.number().int().nonnegative(),
  targetThreadId: z.uuid(),
  instruction: z.string().trim().max(8_000),
  pngBase64: z.string().min(12).max(Math.ceil(MAX_SKETCH_BYTES / 3) * 4 + 4),
  scene: z.unknown().optional(),
}).strict();

export type SketchRequest = z.infer<typeof sketchRequestSchema>;

export interface NormalizedSketch {
  path: string;
  pngBase64: string;
  width: number;
  height: number;
  bytes: number;
  cleanup(): Promise<void>;
}

export class SketchValidationError extends Error {
  readonly code = "INVALID_SKETCH";
  constructor(message: string) {
    super(message);
    this.name = "SketchValidationError";
  }
}

function strictBase64(value: string): Buffer {
  const maxEncodedLength = Math.ceil(MAX_SKETCH_BYTES / 3) * 4;
  if (value.length % 4 !== 0 || value.length > maxEncodedLength) {
    throw new SketchValidationError("Sketch image is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SKETCH_BYTES || bytes.toString("base64") !== value) {
    throw new SketchValidationError("Sketch image exceeds the upload limit or is malformed");
  }
  return bytes;
}

function hasPngSignature(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

interface EncodedSketch {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

async function encodeNormalizedSketch(
  bytes: Buffer,
  bounds?: { readonly width: number; readonly height: number },
): Promise<EncodedSketch> {
  let pipeline = sharp(bytes, {
    failOn: "warning",
    limitInputPixels: MAX_SKETCH_PIXELS,
    sequentialRead: true,
  }).rotate();
  if (bounds) {
    pipeline = pipeline.resize({
      width: bounds.width,
      height: bounds.height,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const { data, info } = await pipeline
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function boundedNormalizedSketch(bytes: Buffer): Promise<EncodedSketch> {
  let encoded = await encodeNormalizedSketch(bytes);
  for (let attempt = 1; encoded.data.length > MAX_SKETCH_BYTES; attempt += 1) {
    if (attempt >= MAX_NORMALIZE_ATTEMPTS) {
      throw new SketchValidationError("Normalized sketch exceeds the upload limit at a legible size");
    }
    const currentWidth = encoded.width;
    const currentHeight = encoded.height;
    const currentBytes = encoded.data.length;
    const currentLongEdge = Math.max(currentWidth, currentHeight);
    if (currentLongEdge <= MIN_LEGIBLE_LONG_EDGE) {
      throw new SketchValidationError("Normalized sketch exceeds the upload limit at a legible size");
    }
    const factor = Math.min(
      MAX_RESIZE_FACTOR,
      Math.sqrt(NORMALIZED_SIZE_TARGET / currentBytes),
    );
    const nextLongEdge = Math.max(
      MIN_LEGIBLE_LONG_EDGE,
      Math.floor(currentLongEdge * factor),
    );
    if (nextLongEdge >= currentLongEdge) {
      throw new SketchValidationError("Normalized sketch exceeds the upload limit at a legible size");
    }
    const resizeFactor = nextLongEdge / currentLongEdge;
    // Drop the oversized output before Sharp allocates the next encoded buffer.
    encoded = { data: Buffer.alloc(0), width: currentWidth, height: currentHeight };
    encoded = await encodeNormalizedSketch(bytes, {
      width: Math.max(1, Math.floor(currentWidth * resizeFactor)),
      height: Math.max(1, Math.floor(currentHeight * resizeFactor)),
    });
  }
  return encoded;
}

export async function validateAndNormalizeSketch(
  input: SketchRequest,
  paths: BridgeDataPaths,
): Promise<NormalizedSketch> {
  const bytes = strictBase64(input.pngBase64);
  if (!hasPngSignature(bytes)) throw new SketchValidationError("Sketch must be a PNG image");

  const image = sharp(bytes, {
    failOn: "warning",
    limitInputPixels: MAX_SKETCH_PIXELS,
    sequentialRead: true,
  });
  const metadata = await image.metadata().catch(() => {
    throw new SketchValidationError("Sketch PNG could not be decoded");
  });
  if (
    metadata.format !== "png" ||
    metadata.width === undefined ||
    metadata.height === undefined ||
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > MAX_SKETCH_DIMENSION ||
    metadata.height > MAX_SKETCH_DIMENSION ||
    metadata.width * metadata.height > MAX_SKETCH_PIXELS ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new SketchValidationError("Sketch PNG dimensions are unsupported");
  }

  // Re-encode to discard metadata and ancillary chunks before Codex sees the
  // file. A browser PNG can grow slightly during this normalization, so retry
  // from the original with bounded dimensions instead of creating an image the
  // bridge can never deliver.
  const normalized = await boundedNormalizedSketch(bytes);

  const directory = await ensurePrivateSketchDirectory(paths);
  const path = join(directory, `sketch-${randomBytes(18).toString("hex")}.png`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(normalized.data);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    path,
    pngBase64: normalized.data.toString("base64"),
    width: normalized.width,
    height: normalized.height,
    bytes: normalized.data.length,
    cleanup: () => rm(path, { force: true }),
  };
}

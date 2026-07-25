import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  animatedWebpBytes,
  animatedPngBytes,
  heifBytes,
  heifGridBytes,
  jpegBytes,
  jpegWithLateFrameBytes,
  pngBytes,
  webpLosslessBytes,
} from "../test/image-fixtures";
import { inspectImageHeader, removeHevcEmulationPrevention } from "./image-header";

const MAX_HEADER_INSPECTION_BYTES = 256 * 1024;
const MAX_SCAN_CHUNK_BYTES = 64 * 1024;

class TrackingBlob extends Blob {
  readBytes = 0;
  maxReadBytes = 0;

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const from = start ?? 0;
    const to = end ?? this.size;
    const length = Math.max(0, to - from);
    this.readBytes += length;
    this.maxReadBytes = Math.max(this.maxReadBytes, length);
    return super.slice(start, end, contentType);
  }
}

describe("bounded image header inspection", () => {
  it("removes one HEVC emulation-prevention byte without swallowing real 0x03 data", () => {
    expect(removeHevcEmulationPrevention(Uint8Array.of(0, 0, 3, 3, 0))).toEqual(
      Uint8Array.of(0, 0, 3, 0),
    );
  });

  it.each([
    ["png", pngBytes(640, 480), 640, 480],
    ["jpeg", jpegBytes(1_920, 1_080), 1_920, 1_080],
    ["webp", webpLosslessBytes(800, 600), 800, 600],
    ["heif", heifBytes(3_024, 4_032), 3_024, 4_032],
  ] as const)("reads %s dimensions without a browser decoder", async (format, bytes, width, height) => {
    await expect(inspectImageHeader(new Blob([bytes]), format)).resolves.toMatchObject({
      format,
      width,
      height,
    });
  });

  it("rejects a MIME/header format mismatch", async () => {
    await expect(inspectImageHeader(new Blob([jpegBytes(640, 480)]), "png")).rejects.toThrow(
      /do not match/i,
    );
  });

  it("fails closed on a truncated HEIC/HEIF box", async () => {
    const valid = heifBytes(640, 480);
    const truncated = valid.slice(0, valid.length - 1);
    await expect(inspectImageHeader(new Blob([truncated]), "heif")).rejects.toThrow(/truncated/i);
  });

  it("binds a grid primary item to its descriptor and bounded HEVC tile", async () => {
    await expect(inspectImageHeader(new Blob([heifGridBytes(1_194, 834)]), "heif")).resolves.toMatchObject({
      width: 1_194,
      height: 834,
      decodedDimensions: [{ width: 1_194, height: 834 }],
      safetyDimensions: expect.arrayContaining([
        { width: 1_194, height: 834 },
        { width: 512, height: 512 },
      ]),
    });
  });

  it("rejects a grid descriptor that disagrees with the associated primary ispe", async () => {
    await expect(
      inspectImageHeader(new Blob([heifGridBytes(640, 480, 16_000, 2_000)]), "heif"),
    ).rejects.toThrow(/grid output does not match/i);
  });

  it("rejects animated WebP before inspecting or decoding a nested frame", async () => {
    await expect(
      inspectImageHeader(new Blob([animatedWebpBytes(1, 1, 0x1_00_00_00, 1)]), "webp"),
    ).rejects.toThrow(/animated/i);
  });

  it("rejects APNG animation chunks after a small IHDR canvas", async () => {
    await expect(
      inspectImageHeader(new Blob([animatedPngBytes(0xffff_ffff, 1)]), "png"),
    ).rejects.toThrow(/animated png/i);
  });

  it("skips a large JPEG metadata segment without loading its payload", async () => {
    const metadataLength = 60_000;
    const metadata = new Uint8Array(metadataLength + 2);
    metadata.set([0xff, 0xe1, (metadataLength >>> 8) & 0xff, metadataLength & 0xff]);
    const jpeg = jpegBytes(320, 240);
    const blob = new Blob([jpeg.slice(0, 2), metadata, jpeg.slice(2)]);
    await expect(inspectImageHeader(blob, "jpeg")).resolves.toMatchObject({ width: 320, height: 240 });
  });

  it("skips JPEG marker payloads larger than the aggregate inspection budget", async () => {
    const metadataLength = 60_000;
    const segments = Array.from({ length: 5 }, (_, index) => {
      const metadata = new Uint8Array(metadataLength + 2);
      metadata.set([0xff, 0xe1 + index, (metadataLength >>> 8) & 0xff, metadataLength & 0xff]);
      return metadata;
    });
    const jpeg = jpegBytes(320, 240);
    const blob = new TrackingBlob([jpeg.slice(0, 2), ...segments, jpeg.slice(2)]);

    await expect(inspectImageHeader(blob, "jpeg")).resolves.toMatchObject({ width: 320, height: 240 });
    expect(blob.readBytes).toBeLessThanOrEqual(MAX_HEADER_INSPECTION_BYTES);
  });

  it("accepts a valid camera-sized JPEG with a one-pass bounded entropy buffer", async () => {
    const width = 3_000;
    const height = 3_000;
    const pixels = Buffer.alloc(width * height);
    let state = 0x12345678;
    for (let index = 0; index < pixels.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[index] = state & 255;
    }
    const jpeg = await sharp(pixels, {
      raw: { width, height, channels: 1 },
    }).jpeg({ quality: 75 }).toBuffer();
    const blob = new TrackingBlob([jpeg]);
    expect(blob.size).toBeGreaterThan(MAX_HEADER_INSPECTION_BYTES);

    await expect(inspectImageHeader(blob, "jpeg")).resolves.toMatchObject({ width, height });
    expect(blob.maxReadBytes).toBeLessThanOrEqual(MAX_SCAN_CHUNK_BYTES);
    expect(blob.readBytes).toBeLessThanOrEqual(blob.size + MAX_HEADER_INSPECTION_BYTES);
  }, 30_000);

  it("scans entropy data and rejects a conflicting late JPEG SOF", async () => {
    await expect(
      inspectImageHeader(
        new Blob([
          jpegWithLateFrameBytes(
            { width: 640, height: 480 },
            { width: 20_000, height: 1 },
          ),
        ]),
        "jpeg",
      ),
    ).rejects.toThrow(/ambiguous frame/i);
  });

  it("rejects a same-dimension second JPEG frame with an altered SOF mode", async () => {
    const initial = jpegBytes(640, 480);
    const jpeg = jpegWithLateFrameBytes(
      { width: 640, height: 480 },
      { width: 640, height: 480 },
    );
    jpeg[initial.length - 1] = 0xc2;

    await expect(inspectImageHeader(new Blob([jpeg]), "jpeg")).rejects.toThrow(
      /multiple or ambiguous frame/i,
    );
  });

  it.each([
    ["12-bit precision", 6, 12],
    ["out-of-range sampling", 13, 0x51],
    ["out-of-range quantization table", 14, 4],
  ] as const)("rejects an unsupported JPEG frame invariant: %s", async (_label, offset, value) => {
    const jpeg = jpegBytes(640, 480);
    jpeg[offset] = value;
    await expect(inspectImageHeader(new Blob([jpeg]), "jpeg")).rejects.toThrow(
      /frame (header|components) (is|are) unsupported/i,
    );
  });

  it("streams bounded entropy and still rejects a late JPEG SOF", async () => {
    const blob = new TrackingBlob([
      jpegWithLateFrameBytes(
        { width: 640, height: 480 },
        { width: 20_000, height: 1 },
        MAX_HEADER_INSPECTION_BYTES + 64 * 1024,
      ),
    ]);

    await expect(inspectImageHeader(blob, "jpeg")).rejects.toThrow(/ambiguous frame/i);
    expect(blob.maxReadBytes).toBeLessThanOrEqual(MAX_SCAN_CHUNK_BYTES);
    expect(blob.readBytes).toBeLessThanOrEqual(blob.size + MAX_HEADER_INSPECTION_BYTES);
  });
});

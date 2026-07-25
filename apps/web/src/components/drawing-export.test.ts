import {
  createExportGeometry,
  createImageElement,
  createScene,
  type ImportedImageMetadata,
  type PngExportOptions,
  type Scene,
} from "@codex-pad/drawing";
import { MAX_SKETCH_BYTES } from "@codex-pad/protocol";
import { describe, expect, it, vi } from "vitest";
import { exportSceneToBoundedPng } from "./drawing-export";

const metadata: ImportedImageMetadata = {
  mimeType: "image/jpeg",
  byteLength: 8_000_000,
  pixelWidth: 4_000,
  pixelHeight: 4_000,
  name: "high-entropy-photo.jpg",
  sha256: null,
};

function photoScene() {
  const photo = createImageElement({
    id: "photo",
    x: 0,
    y: 0,
    width: 1_280,
    height: 1_280,
    source: {
      kind: "dataUrl",
      dataUrl: "data:image/jpeg;base64,/9j/2Q==",
      metadata,
    },
    isBackground: true,
  });
  return { ...createScene(), elements: [photo] };
}

const previewOptions: PngExportOptions = {
  background: "scene",
  padding: 36,
  maxWidth: 2_560,
  maxHeight: 2_560,
  pixelRatio: 2,
};

describe("bounded drawing PNG export", () => {
  it("rerenders a high-entropy photo sequentially until the PNG fits the bridge limit", async () => {
    let activeExports = 0;
    let maximumActiveExports = 0;
    const sizes: number[] = [];
    const exporter = vi.fn(async (scene: Scene, options: PngExportOptions) => {
      activeExports += 1;
      maximumActiveExports = Math.max(maximumActiveExports, activeExports);
      await Promise.resolve();
      const { width, height } = createExportGeometry(scene, options);
      // Four effectively incompressible bytes per pixel model a worst-case photo PNG.
      const size = width * height * 4 + 1_024;
      sizes.push(size);
      activeExports -= 1;
      return new Blob([new Uint8Array(size)], { type: "image/png" });
    });

    const result = await exportSceneToBoundedPng(photoScene(), previewOptions, exporter);

    expect(sizes[0]).toBeGreaterThan(MAX_SKETCH_BYTES);
    expect(result.blob.size).toBeLessThanOrEqual(MAX_SKETCH_BYTES);
    expect(result.geometry.width).toBeLessThan(2_560);
    expect(result.geometry.height).toBeLessThan(2_560);
    expect(exporter).toHaveBeenCalledTimes(2);
    expect(maximumActiveExports).toBe(1);
  });

  it("fails before base64 conversion when a legible PNG cannot fit", async () => {
    const exporter = vi.fn(async () =>
      new Blob([new Uint8Array(MAX_SKETCH_BYTES + 1)], { type: "image/png" }));

    await expect(
      exportSceneToBoundedPng(
        photoScene(),
        { ...previewOptions, maxWidth: 1_024, maxHeight: 1_024, pixelRatio: 0.5 },
        exporter,
      ),
    ).rejects.toThrow("exceeds the 8 MB upload limit at a legible size");
    expect(exporter).toHaveBeenCalledOnce();
  });

  it("keeps normalization headroom for a browser PNG just below the protocol cap", async () => {
    const sizes = [MAX_SKETCH_BYTES - 1_024, Math.floor(MAX_SKETCH_BYTES * 0.9)];
    const exporter = vi.fn(async () =>
      new Blob([new Uint8Array(sizes.shift() ?? 1)], { type: "image/png" }));

    const result = await exportSceneToBoundedPng(photoScene(), previewOptions, exporter);

    expect(exporter).toHaveBeenCalledTimes(2);
    expect(result.blob.size).toBeLessThanOrEqual(Math.floor(MAX_SKETCH_BYTES * 0.92));
  });
});

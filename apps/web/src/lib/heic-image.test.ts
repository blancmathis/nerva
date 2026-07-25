import { afterEach, describe, expect, it, vi } from "vitest";

import { heifAuxiliaryGridBytes, heifBytes, heifGridBytes } from "../test/image-fixtures";
import { normalizeHeicToPng } from "./heic-image";

const limits = {
  maxBytes: 15 * 1024 * 1024,
  maxDimension: 16_384,
  maxPixels: 32_000_000,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeHeicToPng bounded header gate", () => {
  it("normalizes a bounded HEIC only after its BMFF dimensions pass", async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 640, height: 480, close }));
    vi.stubGlobal("createImageBitmap", decode);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob(["normalized-png"], { type: type ?? "image/png" }));
    });

    const normalized = await normalizeHeicToPng(
      new Blob([heifBytes(640, 480)], { type: "image/heic" }),
      "photo.heic",
      limits,
    );

    expect(normalized).toMatchObject({ fileName: "photo.png", width: 640, height: 480 });
    expect(decode).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not invoke a decoder for a truncated HEIC/HEIF container", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const truncated = heifBytes(640, 480).slice(0, -1);

    await expect(
      normalizeHeicToPng(
        new Blob([truncated], { type: "image/heic" }),
        "truncated.heic",
        limits,
      ),
    ).rejects.toThrow(/truncated/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("does not invoke a decoder for extreme declared HEIC dimensions", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([heifBytes(20_000, 1)], { type: "image/heic" }),
        "needle.heic",
        limits,
      ),
    ).rejects.toThrow("no wider or taller than 16384 pixels");
    expect(decode).not.toHaveBeenCalled();
  });

  it("does not invoke the Image fallback for an extreme HEIC header", async () => {
    const imageElementDecoder = vi.fn();
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("Image", imageElementDecoder);

    await expect(
      normalizeHeicToPng(
        new Blob([heifBytes(20_000, 1)], { type: "image/heic" }),
        "needle.heic",
        limits,
      ),
    ).rejects.toThrow("no wider or taller than 16384 pixels");
    expect(imageElementDecoder).not.toHaveBeenCalled();
  });

  it("does not invoke a decoder for an ambiguous multi-container HEIC", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const container = heifBytes(640, 480);

    await expect(
      normalizeHeicToPng(
        new Blob([container, container], { type: "image/heic" }),
        "ambiguous.heic",
        limits,
      ),
    ).rejects.toThrow(/ambiguous/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("uses the associated primary ispe instead of a smaller unassociated decoy", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([
          heifBytes(20_000_000, 1, { width: 8_000, height: 4_000 }),
        ], { type: "image/heic" }),
        "decoy.heic",
        limits,
      ),
    ).rejects.toThrow("no wider or taller than 16384 pixels");
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects oversized HEVC SPS dimensions hidden behind a small associated ispe", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([
          heifBytes(640, 480, undefined, { width: 20_000_000, height: 1 }),
        ], { type: "image/heic" }),
        "codec-bomb.heic",
        limits,
      ),
    ).rejects.toThrow(/coded dimensions do not match/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("bounds the coded SPS surface even when conformance cropping is small", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([
          heifBytes(640, 480, undefined, {
            width: 640,
            height: 480,
            codedWidth: 20_000_000,
            codedHeight: 480,
          }),
        ], { type: "image/heic" }),
        "cropped-codec-bomb.heic",
        limits,
      ),
    ).rejects.toThrow("no wider or taller than 16384 pixels");
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects an in-band SPS before a browser decoder can override hvcC", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([
          heifBytes(640, 480, undefined, { width: 640, height: 480, inBandNalType: 33 }),
        ], { type: "image/heic" }),
        "in-band-sps.heic",
        limits,
      ),
    ).rejects.toThrow(/in-band hevc parameter sets/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a hidden oversized grid descriptor before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([heifGridBytes(640, 480, 16_000, 2_000)], { type: "image/heic" }),
        "grid.heic",
        limits,
      ),
    ).rejects.toThrow(/grid output does not match/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("caps HEIF grid tile count before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([
          heifGridBytes(640, 480, 640, 480, { rows: 2, columns: 129 }),
        ], { type: "image/heic" }),
        "too-many-tiles.heic",
        limits,
      ),
    ).rejects.toThrow(/too many tile references|256-tile safety limit/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("caps aggregate HEIF tile pixels before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([
          heifGridBytes(640, 480, 640, 480, {
            rows: 2,
            columns: 2,
            tileWidth: 8_000,
            tileHeight: 4_000,
          }),
        ], { type: "image/heic" }),
        "aggregate-grid.heic",
        limits,
      ),
    ).rejects.toThrow("smaller than 32 megapixels");
    expect(decode).not.toHaveBeenCalled();
  });

  it("validates a hidden auxiliary gain-map grid before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      normalizeHeicToPng(
        new Blob([
          heifAuxiliaryGridBytes(640, 480, 320, 240, 65_535, 400),
        ], { type: "image/heic" }),
        "auxiliary-grid.heic",
        limits,
      ),
    ).rejects.toThrow(/grid output does not match/i);
    expect(decode).not.toHaveBeenCalled();
  });
});

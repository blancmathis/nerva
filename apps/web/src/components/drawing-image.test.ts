import { afterEach, describe, expect, it, vi } from "vitest";
import {
  heifBytes,
  jpegBytes,
  jpegWithLateFrameBytes,
  webpLosslessBytes,
} from "../test/image-fixtures";
import { fitImageInside, formatFileSize, prepareImportedImage } from "./drawing-image";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("drawing image preparation helpers", () => {
  it("fits a photo inside the scene without changing its aspect ratio", () => {
    expect(
      fitImageInside({ width: 4_000, height: 2_000 }, { width: 1_000, height: 800 }, 0.8),
    ).toEqual({ x: 100, y: 200, width: 800, height: 400 });
  });

  it("shows a human-readable PNG size in the send preview", () => {
    expect(formatFileSize(950)).toBe("950 B");
    expect(formatFileSize(4_250)).toBe("4.3 KB");
    expect(formatFileSize(2_250_000)).toBe("2.25 MB");
  });

  it("stores a supported HEIC drawing background as PNG data only", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1_200, height: 900, close })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob(["normalized-png"], { type: type ?? "image/png" }));
    });

    const prepared = await prepareImportedImage(
      new File([heifBytes(1_200, 900)], "drawing.heic", { type: "image/heic" }),
    );

    expect(prepared.source.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(prepared.source.metadata).toMatchObject({
      mimeType: "image/png",
      pixelWidth: 1_200,
      pixelHeight: 900,
      name: "drawing.png",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an oversized compressed WebP before allocating a bitmap or data URL", async () => {
    const decode = vi.fn();
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareImportedImage(
        new File([webpLosslessBytes(10_000, 2_000)], "wide.webp", { type: "image/webp" }),
      ),
    ).rejects.toThrow("smaller than 16 megapixels");
    expect(decode).not.toHaveBeenCalled();
    expect(readAsDataUrl).not.toHaveBeenCalled();
  });

  it("still decodes and stores a bounded WebP", async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 640, height: 480, close }));
    vi.stubGlobal("createImageBitmap", decode);

    const prepared = await prepareImportedImage(
      new File([webpLosslessBytes(640, 480)], "safe.webp", { type: "image/webp" }),
    );
    expect(prepared.source.metadata).toMatchObject({ pixelWidth: 640, pixelHeight: 480 });
    expect(decode).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an extreme JPEG dimension before creating a bitmap or data URL", async () => {
    const imageElementDecoder = vi.fn();
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("Image", imageElementDecoder);

    await expect(
      prepareImportedImage(
        new File([jpegBytes(20_000, 1)], "needle.jpg", { type: "image/jpeg" }),
      ),
    ).rejects.toThrow("no wider or taller than 16384 pixels");
    expect(imageElementDecoder).not.toHaveBeenCalled();
    expect(readAsDataUrl).not.toHaveBeenCalled();
  });

  it("rejects a same-size late JPEG frame before allocating a bitmap or data URL", async () => {
    const initial = jpegBytes(640, 480);
    const bytes = jpegWithLateFrameBytes(
      { width: 640, height: 480 },
      { width: 640, height: 480 },
    );
    bytes[initial.length - 1] = 0xc2;
    const decode = vi.fn();
    const readAsDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL");
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareImportedImage(new File([bytes], "ambiguous.jpg", { type: "image/jpeg" })),
    ).rejects.toThrow(/multiple or ambiguous frame/i);
    expect(decode).not.toHaveBeenCalled();
    expect(readAsDataUrl).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  animatedPngBytes,
  animatedWebpBytes,
  heifBytes,
  jpegBytes,
  jpegWithLateFrameBytes,
  pngBytes,
} from "../test/image-fixtures";
import { prepareReviewImage } from "./review-media";

function installHeicDecoder(width = 3_024, height = 4_032): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width, height, close })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
    callback(new Blob(["normalized-png"], { type: type ?? "image/png" }));
  });
  return { close };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepareReviewImage HEIC imports", () => {
  it("normalizes HEIC bytes to a bounded PNG before creating review metadata", async () => {
    const { close } = installHeicDecoder();
    const prepared = await prepareReviewImage(
      new File([heifBytes(3_024, 4_032)], "IMG_0420.HEIC", { type: "image/heic" }),
    );

    expect(prepared.blob.type).toBe("image/png");
    expect(prepared.image.metadata).toMatchObject({
      mimeType: "image/png",
      byteLength: prepared.blob.size,
      pixelWidth: 3_024,
      pixelHeight: 4_032,
      fileName: "IMG_0420.png",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("recognizes a HEIF filename when iPadOS supplies no MIME type", async () => {
    installHeicDecoder(640, 480);
    const prepared = await prepareReviewImage(new File([heifBytes(640, 480)], "photo.heif"));

    expect(prepared.image.metadata.mimeType).toBe("image/png");
    expect(prepared.image.metadata.fileName).toBe("photo.png");
  });

  it("rejects an oversized HEIC header before invoking either browser decoder", async () => {
    const decode = vi.fn(async () => ({ width: 8_000, height: 5_000, close: vi.fn() }));
    vi.stubGlobal("createImageBitmap", decode);
    const createElement = vi.spyOn(document, "createElement");

    await expect(
      prepareReviewImage(
        new File([heifBytes(8_000, 5_000)], "large.heic", { type: "image/heic" }),
      ),
    ).rejects.toThrow("smaller than 32 megapixels");
    expect(createElement).not.toHaveBeenCalledWith("canvas");
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects an extreme HEIC dimension before invoking either browser decoder", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareReviewImage(
        new File([heifBytes(20_000, 1)], "needle.heic", { type: "image/heic" }),
      ),
    ).rejects.toThrow("no wider or taller than 16384 pixels");
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports a clear browser-support error when neither native decoder accepts HEIC", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("unsupported"))));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:unsupported-heic");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    class RejectingImage {
      naturalWidth = 0;
      naturalHeight = 0;
      private readonly listeners = new Map<string, EventListener>();

      addEventListener(type: string, listener: EventListener): void {
        this.listeners.set(type, listener);
      }

      set src(_value: string) {
        queueMicrotask(() => this.listeners.get("error")?.(new Event("error")));
      }
    }
    vi.stubGlobal("Image", RejectingImage);

    await expect(
      prepareReviewImage(
        new File([heifBytes(640, 480)], "unsupported.heic", { type: "image/heic" }),
      ),
    ).rejects.toThrow(/browser cannot decode this HEIC\/HEIF photo/i);
  });

  it("rejects an oversized JPEG header before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareReviewImage(
        new File([jpegBytes(8_000, 5_000)], "compressed.jpg", { type: "image/jpeg" }),
      ),
    ).rejects.toThrow("smaller than 32 megapixels");
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects an extreme single dimension before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareReviewImage(
        new File([pngBytes(20_000, 1)], "needle.png", { type: "image/png" }),
      ),
    ).rejects.toThrow("no wider or taller than 16384 pixels");
    expect(decode).not.toHaveBeenCalled();
  });

  it("still decodes and accepts a bounded PNG", async () => {
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 640, height: 480, close }));
    vi.stubGlobal("createImageBitmap", decode);

    const prepared = await prepareReviewImage(
      new File([pngBytes(640, 480)], "safe.png", { type: "image/png" }),
    );
    expect(prepared.image.metadata).toMatchObject({ pixelWidth: 640, pixelHeight: 480 });
    expect(decode).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects mismatched magic bytes before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareReviewImage(
        new File([jpegBytes(640, 480)], "spoofed.png", { type: "image/png" }),
      ),
    ).rejects.toThrow(/do not match/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects an animated WebP with an extreme nested frame before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareReviewImage(
        new File(
          [animatedWebpBytes(1, 1, 0x1_00_00_00, 1)],
          "animated.webp",
          { type: "image/webp" },
        ),
      ),
    ).rejects.toThrow(/animated/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects an APNG with an extreme frame before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareReviewImage(
        new File([animatedPngBytes(0xffff_ffff, 1)], "animated.png", { type: "image/png" }),
      ),
    ).rejects.toThrow(/animated png/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a late oversized JPEG frame before createImageBitmap", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(
      prepareReviewImage(
        new File([
          jpegWithLateFrameBytes(
            { width: 640, height: 480 },
            { width: 20_000, height: 1 },
          ),
        ], "late-frame.jpg", { type: "image/jpeg" }),
      ),
    ).rejects.toThrow(/ambiguous frame/i);
    expect(decode).not.toHaveBeenCalled();
  });
});

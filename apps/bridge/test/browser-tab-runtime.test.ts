import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeBrowserFrameImage } from "../src/browser-tab-runtime.js";

describe("browser tab frame normalization", () => {
  it("downscales a Retina webview capture to the CSS-pixel viewport for iPad rendering", async () => {
    const retinaJpeg = await sharp({
      create: {
        width: 2_360,
        height: 1_520,
        channels: 3,
        background: { r: 35, g: 112, b: 198 },
      },
    }).jpeg().toBuffer();

    const normalized = await normalizeBrowserFrameImage(retinaJpeg.toString("base64"), {
      width: 1_180,
      height: 760,
      deviceScaleFactor: 2,
    });
    const metadata = await sharp(Buffer.from(normalized.imageBase64, "base64")).metadata();

    expect(normalized.deviceScaleFactor).toBe(1);
    expect(metadata.width).toBe(1_180);
    expect(metadata.height).toBe(760);
  });

  it("keeps a native 1x frame byte-for-byte", async () => {
    const jpeg = await sharp({
      create: {
        width: 320,
        height: 200,
        channels: 3,
        background: { r: 20, g: 24, b: 30 },
      },
    }).jpeg().toBuffer();
    const imageBase64 = jpeg.toString("base64");

    await expect(normalizeBrowserFrameImage(imageBase64, {
      width: 320,
      height: 200,
      deviceScaleFactor: 1,
    })).resolves.toEqual({ imageBase64, deviceScaleFactor: 1 });
  });
});

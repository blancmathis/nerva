import { describe, expect, it, vi } from "vitest";

import {
  CanvasUnavailableError,
  createImageElement,
  createScene,
  createShapeElement,
  createTextElement,
  exportSceneToPng,
  renderSceneToCanvas,
  type CanvasFactory,
  type CanvasSurface,
  type ImportedImageMetadata,
} from "../src/index.js";

function fakeCanvas() {
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    rect: vi.fn(),
    ellipse: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
  };
  const surface = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: (blob: Blob | null) => void) =>
      callback(new Blob(["png"], { type: "image/png" })),
    ),
  };
  const factory: CanvasFactory = (width, height) => {
    surface.width = width;
    surface.height = height;
    return surface as unknown as CanvasSurface;
  };
  return { context, surface, factory };
}

const metadata: ImportedImageMetadata = {
  mimeType: "image/png",
  byteLength: 10,
  pixelWidth: 10,
  pixelHeight: 10,
  name: null,
  sha256: null,
};

describe("flattened PNG export", () => {
  it("renders shapes, text, imported images, and the requested background", async () => {
    const image = createImageElement({
      id: "image",
      x: 0,
      y: 0,
      width: 80,
      height: 60,
      source: { kind: "blobRef", blobId: "indexed-db-key", metadata },
    });
    const shape = createShapeElement({
      id: "shape",
      shape: "ellipse",
      x: 20,
      y: 20,
      width: 50,
      height: 30,
      strokeColor: "#00f",
      strokeWidth: 2,
    });
    const text = createTextElement({ id: "text", x: 10, y: 70, text: "send", color: "#111", fontSize: 18 });
    const scene = { ...createScene({ background: "dark" }), elements: [image, shape, text] };
    const fake = fakeCanvas();
    const resolver = vi.fn(async () => ({}) as CanvasImageSource);

    const rendered = await renderSceneToCanvas(scene, {
      canvasFactory: fake.factory,
      imageResolver: resolver,
      background: "white",
      padding: 4,
      maxWidth: 300,
      maxHeight: 300,
    });

    expect(resolver).toHaveBeenCalledWith(image.source);
    expect(fake.context.drawImage).toHaveBeenCalled();
    expect(fake.context.ellipse).toHaveBeenCalled();
    expect(fake.context.fillText).toHaveBeenCalledWith("send", 10, 70);
    expect(fake.context.fillRect).toHaveBeenCalledWith(0, 0, rendered.geometry.width, rendered.geometry.height);
  });

  it("returns a PNG blob and bounds its physical canvas", async () => {
    const scene = createScene({ width: 20_000, height: 10_000, background: "transparent" });
    const fake = fakeCanvas();
    const blob = await exportSceneToPng(scene, {
      canvasFactory: fake.factory,
      maxWidth: 512,
      maxHeight: 256,
      padding: 0,
    });

    expect(blob.type).toBe("image/png");
    expect(fake.surface.width).toBeLessThanOrEqual(512);
    expect(fake.surface.height).toBeLessThanOrEqual(256);
    expect(fake.surface).toMatchObject({ width: 1, height: 1 });
  });

  it("keeps geometry usable but fails clearly when Canvas is unavailable", async () => {
    await expect(exportSceneToPng(createScene())).rejects.toBeInstanceOf(CanvasUnavailableError);
  });
});

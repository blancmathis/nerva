import {
  createExportGeometry,
  estimateTextSize,
  getArrowPolygon,
  getStrokePolygon,
  type CropOptions,
  type ExportGeometry,
} from "./geometry.js";
import { DEFAULT_DARK_BACKGROUND, type ImportedImageSource, type Scene, type SceneElement } from "./types.js";

export type CanvasSurface = HTMLCanvasElement | OffscreenCanvas;
export type CanvasFactory = (width: number, height: number) => CanvasSurface;
export type ImageResolver = (source: ImportedImageSource) => Promise<CanvasImageSource>;

export type ExportBackground = "scene" | "transparent" | "white" | "dark";

export interface PngExportOptions extends CropOptions {
  readonly background?: ExportBackground;
  readonly canvasFactory?: CanvasFactory;
  readonly imageResolver?: ImageResolver;
}

export interface RenderedScene {
  readonly canvas: CanvasSurface;
  readonly geometry: ExportGeometry;
}

export class CanvasUnavailableError extends Error {
  public constructor(message = "Canvas rendering is unavailable in this environment") {
    super(message);
    this.name = "CanvasUnavailableError";
  }
}

export class ImageSourceUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImageSourceUnavailableError";
  }
}

function defaultCanvasFactory(width: number, height: number): CanvasSurface {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new CanvasUnavailableError();
}

function canvasContext(canvas: CanvasSurface): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new CanvasUnavailableError("A 2D canvas context could not be created");
  }
  // OffscreenCanvasRenderingContext2D exposes the rendering members used below.
  return context as unknown as CanvasRenderingContext2D;
}

function tracePolygon(context: CanvasRenderingContext2D, polygon: readonly { x: number; y: number }[]): void {
  const first = polygon[0];
  if (first === undefined) {
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of polygon.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.closePath();
}

function withRotation(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  rotation: number,
  draw: () => void,
): void {
  context.save();
  if (rotation !== 0) {
    context.translate(centerX, centerY);
    context.rotate(rotation);
    context.translate(-centerX, -centerY);
  }
  draw();
  context.restore();
}

async function browserImage(source: ImportedImageSource): Promise<CanvasImageSource> {
  if (source.kind === "blobRef") {
    throw new ImageSourceUnavailableError(
      `Image ${source.blobId} is stored by reference; provide imageResolver to flatten it`,
    );
  }
  if (typeof Image === "undefined") {
    throw new ImageSourceUnavailableError("Browser image decoding is unavailable");
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new ImageSourceUnavailableError("The imported image could not be decoded"));
    image.src = source.dataUrl;
  });
}

async function drawElement(
  context: CanvasRenderingContext2D,
  element: SceneElement,
  resolver: ImageResolver,
): Promise<void> {
  context.save();
  context.globalAlpha = element.opacity;
  context.globalCompositeOperation = element.kind === "eraser" ? "destination-out" : "source-over";

  switch (element.kind) {
    case "stroke":
      tracePolygon(context, getStrokePolygon(element));
      context.fillStyle = element.color;
      context.fill();
      break;
    case "eraser":
      tracePolygon(context, getStrokePolygon(element));
      context.globalAlpha = 1;
      context.fillStyle = "#000000";
      context.fill();
      break;
    case "shape":
      if (element.shape === "arrow") {
        tracePolygon(context, getArrowPolygon(element));
        context.fillStyle = element.fillColor ?? element.strokeColor;
        context.fill();
        break;
      }
      withRotation(
        context,
        element.x + element.width / 2,
        element.y + element.height / 2,
        element.rotation,
        () => {
          context.beginPath();
          if (element.shape === "ellipse") {
            context.ellipse(
              element.x + element.width / 2,
              element.y + element.height / 2,
              Math.abs(element.width) / 2,
              Math.abs(element.height) / 2,
              0,
              0,
              Math.PI * 2,
            );
          } else {
            context.rect(element.x, element.y, element.width, element.height);
          }
          if (element.fillColor !== null) {
            context.fillStyle = element.fillColor;
            context.fill();
          }
          context.strokeStyle = element.strokeColor;
          context.lineWidth = element.strokeWidth;
          context.stroke();
        },
      );
      break;
    case "text": {
      const size = estimateTextSize(element);
      withRotation(
        context,
        element.x + size.width / 2,
        element.y + size.height / 2,
        element.rotation,
        () => {
          context.fillStyle = element.color;
          context.font = `${element.fontWeight} ${element.fontSize}px ${element.fontFamily}`;
          context.textBaseline = "top";
          for (const [index, line] of element.text.split("\n").entries()) {
            const y = element.y + index * element.fontSize * element.lineHeight;
            if (element.maxWidth === null) {
              context.fillText(line, element.x, y);
            } else {
              context.fillText(line, element.x, y, element.maxWidth);
            }
          }
        },
      );
      break;
    }
    case "image": {
      const image = await resolver(element.source);
      withRotation(
        context,
        element.x + element.width / 2,
        element.y + element.height / 2,
        element.rotation,
        () => context.drawImage(image, element.x, element.y, element.width, element.height),
      );
      break;
    }
  }

  context.restore();
}

function backgroundColor(scene: Scene, requested: ExportBackground): string | null {
  const mode = requested === "scene" ? scene.background.mode : requested;
  if (mode === "transparent") {
    return null;
  }
  if (mode === "white") {
    return "#ffffff";
  }
  return requested === "scene" ? scene.background.color : DEFAULT_DARK_BACKGROUND;
}

/** Render a flattened scene. Geometry-only APIs remain available when Canvas is absent. */
export async function renderSceneToCanvas(
  scene: Scene,
  options: PngExportOptions = {},
): Promise<RenderedScene> {
  const geometry = createExportGeometry(scene, options);
  const canvas = (options.canvasFactory ?? defaultCanvasFactory)(geometry.width, geometry.height);
  canvas.width = geometry.width;
  canvas.height = geometry.height;
  const context = canvasContext(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.setTransform(
    geometry.scale,
    0,
    0,
    geometry.scale,
    geometry.offsetX,
    geometry.offsetY,
  );
  const resolver = options.imageResolver ?? browserImage;
  for (const element of scene.elements) {
    await drawElement(context, element, resolver);
  }

  const fill = backgroundColor(scene, options.background ?? "scene");
  if (fill !== null) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = fill;
    context.fillRect(0, 0, geometry.width, geometry.height);
    context.restore();
  }
  return { canvas, geometry };
}

async function canvasToPng(canvas: CanvasSurface): Promise<Blob> {
  if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
    return await canvas.convertToBlob({ type: "image/png" });
  }
  if ("toBlob" in canvas && typeof canvas.toBlob === "function") {
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new CanvasUnavailableError("Canvas PNG encoding returned no data"));
        } else {
          resolve(blob);
        }
      }, "image/png");
    });
  }
  throw new CanvasUnavailableError("This canvas implementation cannot encode PNG images");
}

export async function exportSceneToPng(scene: Scene, options: PngExportOptions = {}): Promise<Blob> {
  const { canvas } = await renderSceneToCanvas(scene, options);
  try {
    return await canvasToPng(canvas);
  } finally {
    // Release the backing store before a bounded retry allocates another canvas.
    canvas.width = 1;
    canvas.height = 1;
  }
}

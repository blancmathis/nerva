import {
  ElementSpatialIndex,
  elementsInPaintOrder,
  estimateTextSize,
  getStrokePolygon,
  type Bounds,
  type Scene,
  type SceneElement,
  type ShapeElement,
} from "@codex-pad/drawing";

export interface CanvasMetrics {
  width: number;
  height: number;
  dpr: number;
  fitScale: number;
  offsetX: number;
  offsetY: number;
}

export interface CanvasView {
  zoom: number;
  centerX: number;
  centerY: number;
}

export interface ShapePreview {
  shape: ShapeElement["shape"];
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  size: number;
}

export interface StrokePreview {
  kind: "stroke" | "eraser";
  tool: "pen" | "marker" | "eraser";
  color: string;
  size: number;
  points: Parameters<typeof getStrokePolygon>[0]["points"];
}

export type DrawingPreview = ShapePreview | StrokePreview | null;

const MAX_DECODED_IMAGES = 2;
const imageCache = new Map<string, HTMLImageElement>();
const imagesLoading = new Set<string>();
const spatialIndex = new ElementSpatialIndex([]);

function visibleElements(scene: Scene, metrics: CanvasMetrics, view: CanvasView): readonly SceneElement[] {
  spatialIndex.update(scene.elements);
  const scale = metrics.fitScale * view.zoom;
  const margin = 96 / Math.max(scale, 0.0001);
  const width = metrics.width / scale;
  const height = metrics.height / scale;
  const bounds: Bounds = {
    minX: view.centerX - width / 2 - margin,
    minY: view.centerY - height / 2 - margin,
    maxX: view.centerX + width / 2 + margin,
    maxY: view.centerY + height / 2 + margin,
    width: width + margin * 2,
    height: height + margin * 2,
  };
  return spatialIndex.query(bounds);
}

function cacheImage(source: string, image: HTMLImageElement): void {
  imageCache.delete(source);
  imageCache.set(source, image);
  while (imageCache.size > MAX_DECODED_IMAGES) {
    const oldest = imageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    imageCache.delete(oldest);
  }
}

function pruneImageCache(scene: Scene): void {
  const active = new Set(
    scene.elements.flatMap((element) =>
      element.kind === "image" && element.source.kind === "dataUrl"
        ? [element.source.dataUrl]
        : [],
    ),
  );
  for (const source of imageCache.keys()) {
    if (!active.has(source)) imageCache.delete(source);
  }
}

export function measureCanvas(canvas: HTMLCanvasElement, scene: Scene): CanvasMetrics {
  const bounds = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const fitScale = Math.min(bounds.width / scene.viewport.width, bounds.height / scene.viewport.height);
  return {
    width: bounds.width,
    height: bounds.height,
    dpr,
    fitScale,
    offsetX: (bounds.width - scene.viewport.width * fitScale) / 2,
    offsetY: (bounds.height - scene.viewport.height * fitScale) / 2,
  };
}

export function screenTransform(
  canvas: HTMLCanvasElement,
  scene: Scene,
  view: CanvasView,
): { zoom: number; panX: number; panY: number } {
  const bounds = canvas.getBoundingClientRect();
  const metrics = measureCanvas(canvas, scene);
  return {
    zoom: metrics.fitScale * view.zoom,
    panX: bounds.left + metrics.width / 2 - view.centerX * metrics.fitScale * view.zoom,
    panY: bounds.top + metrics.height / 2 - view.centerY * metrics.fitScale * view.zoom,
  };
}

function drawWorldGrid(
  context: CanvasRenderingContext2D,
  metrics: CanvasMetrics,
  view: CanvasView,
): void {
  const scale = metrics.fitScale * view.zoom;
  const targetSpacing = 48;
  const exponent = Math.floor(Math.log10(targetSpacing / Math.max(scale, 0.0001)));
  const candidates = [1, 2, 5, 10];
  const base = 10 ** exponent;
  const spacing = candidates.map((value) => value * base)
    .find((value) => value * scale >= targetSpacing) ?? 10 * base;
  const left = view.centerX - metrics.width / (2 * scale);
  const top = view.centerY - metrics.height / (2 * scale);
  const right = view.centerX + metrics.width / (2 * scale);
  const bottom = view.centerY + metrics.height / (2 * scale);
  context.save();
  context.strokeStyle = "rgba(91, 107, 119, 0.12)";
  context.lineWidth = 1 / scale;
  context.beginPath();
  for (let x = Math.floor(left / spacing) * spacing; x <= right; x += spacing) {
    context.moveTo(x, top);
    context.lineTo(x, bottom);
  }
  for (let y = Math.floor(top / spacing) * spacing; y <= bottom; y += spacing) {
    context.moveTo(left, y);
    context.lineTo(right, y);
  }
  context.stroke();
  context.restore();
}

function backgroundColor(scene: Scene): string | null {
  if (scene.background.mode === "white") return "#fcfaf4";
  if (scene.background.mode === "dark") return scene.background.color;
  return null;
}

function pathPolygon(
  context: CanvasRenderingContext2D,
  polygon: readonly { x: number; y: number }[],
): void {
  const first = polygon[0];
  if (!first) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 1; index < polygon.length; index += 1) {
    const point = polygon[index];
    if (point) context.lineTo(point.x, point.y);
  }
  context.closePath();
}

function drawArrow(context: CanvasRenderingContext2D, shape: ShapeElement): void {
  const startX = shape.x;
  const startY = shape.y;
  const endX = shape.x + shape.width;
  const endY = shape.y + shape.height;
  const angle = Math.atan2(endY - startY, endX - startX);
  const head = Math.max(14, shape.strokeWidth * 4.5);

  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.moveTo(endX, endY);
  context.lineTo(
    endX - head * Math.cos(angle - Math.PI / 7),
    endY - head * Math.sin(angle - Math.PI / 7),
  );
  context.moveTo(endX, endY);
  context.lineTo(
    endX - head * Math.cos(angle + Math.PI / 7),
    endY - head * Math.sin(angle + Math.PI / 7),
  );
  context.stroke();
}

function drawShape(context: CanvasRenderingContext2D, shape: ShapeElement): void {
  context.save();
  context.globalAlpha = shape.opacity;
  context.strokeStyle = shape.strokeColor;
  context.fillStyle = shape.fillColor ?? "transparent";
  context.lineWidth = shape.strokeWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.setLineDash(shape.shape === "rectangle" ? [0] : []);

  const centerX = shape.x + shape.width / 2;
  const centerY = shape.y + shape.height / 2;
  if (shape.rotation !== 0) {
    context.translate(centerX, centerY);
    context.rotate(shape.rotation);
    context.translate(-centerX, -centerY);
  }
  if (shape.shape === "arrow") drawArrow(context, { ...shape, rotation: 0 });
  else if (shape.shape === "rectangle") {
    if (shape.fillColor) context.fillRect(shape.x, shape.y, shape.width, shape.height);
    context.strokeRect(shape.x, shape.y, shape.width, shape.height);
  } else {
    context.beginPath();
    context.ellipse(centerX, centerY, Math.abs(shape.width / 2), Math.abs(shape.height / 2), 0, 0, Math.PI * 2);
    if (shape.fillColor) context.fill();
    context.stroke();
  }
  context.restore();
}

function drawText(
  context: CanvasRenderingContext2D,
  element: Extract<SceneElement, { kind: "text" }>,
): void {
  context.save();
  context.globalAlpha = element.opacity;
  context.fillStyle = element.color;
  context.font = `${element.fontWeight} ${element.fontSize}px ${element.fontFamily}`;
  context.textBaseline = "top";
  const estimated = estimateTextSize(element);
  if (element.rotation !== 0) {
    const centerX = element.x + estimated.width / 2;
    const centerY = element.y + estimated.height / 2;
    context.translate(centerX, centerY);
    context.rotate(element.rotation);
    context.translate(-centerX, -centerY);
  }
  const lines = element.text.split("\n");
  lines.forEach((line, index) => {
    context.fillText(
      line,
      element.x,
      element.y + index * element.fontSize * element.lineHeight,
      element.maxWidth ?? undefined,
    );
  });
  context.restore();
}

function drawImage(
  context: CanvasRenderingContext2D,
  element: Extract<SceneElement, { kind: "image" }>,
  requestRedraw: () => void,
): void {
  if (element.source.kind !== "dataUrl") return;
  const source = element.source.dataUrl;
  const cached = imageCache.get(source);
  if (cached) {
    cacheImage(source, cached);
    context.save();
    context.globalAlpha = element.opacity;
    if (element.rotation !== 0) {
      const centerX = element.x + element.width / 2;
      const centerY = element.y + element.height / 2;
      context.translate(centerX, centerY);
      context.rotate(element.rotation);
      context.translate(-centerX, -centerY);
    }
    context.drawImage(cached, element.x, element.y, element.width, element.height);
    context.restore();
    return;
  }
  if (imagesLoading.has(source)) return;
  imagesLoading.add(source);
  const image = new Image();
  image.addEventListener(
    "load",
    () => {
      imagesLoading.delete(source);
      cacheImage(source, image);
      requestRedraw();
    },
    { once: true },
  );
  image.addEventListener("error", () => imagesLoading.delete(source), { once: true });
  image.src = source;
}

function drawFreehand(
  context: CanvasRenderingContext2D,
  element: Extract<SceneElement, { kind: "stroke" | "eraser" }>,
  fillBackground: string | null,
): void {
  const polygon = getStrokePolygon(element);
  if (polygon.length === 0) return;
  context.save();
  pathPolygon(context, polygon);
  if (element.kind === "eraser") {
    if (fillBackground) {
      context.fillStyle = fillBackground;
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    } else {
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = "#000";
    }
  } else {
    context.fillStyle = element.color;
    context.globalAlpha = element.opacity;
    context.globalCompositeOperation = element.tool === "marker" ? "multiply" : "source-over";
  }
  context.fill();
  context.restore();
}

export function renderDrawingCanvas(
  canvas: HTMLCanvasElement,
  scene: Scene,
  view: CanvasView,
  preview: DrawingPreview,
  requestRedraw: () => void,
): void {
  pruneImageCache(scene);
  const metrics = measureCanvas(canvas, scene);
  const pixelWidth = Math.max(1, Math.round(metrics.width * metrics.dpr));
  const pixelHeight = Math.max(1, Math.round(metrics.height * metrics.dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return;

  context.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  context.clearRect(0, 0, metrics.width, metrics.height);
  const fill = backgroundColor(scene);
  if (fill) {
    context.fillStyle = fill;
    context.fillRect(0, 0, metrics.width, metrics.height);
  }
  context.save();
  context.translate(
    metrics.width / 2 - view.centerX * metrics.fitScale * view.zoom,
    metrics.height / 2 - view.centerY * metrics.fitScale * view.zoom,
  );
  context.scale(metrics.fitScale * view.zoom, metrics.fitScale * view.zoom);
  drawWorldGrid(context, metrics, view);

  const visible = visibleElements(scene, metrics, view);
  const orderedElements = elementsInPaintOrder(visible);
  for (const element of orderedElements) {
    if (element.kind === "stroke" || element.kind === "eraser") {
      drawFreehand(context, element, fill);
    } else if (element.kind === "shape") {
      drawShape(context, element);
    } else if (element.kind === "text") {
      drawText(context, element);
    } else {
      drawImage(context, element, requestRedraw);
    }
  }

  if (preview) {
    if ("shape" in preview) {
      drawShape(context, {
        kind: "shape",
        id: "preview",
        shape: preview.shape,
        x: preview.x,
        y: preview.y,
        width: preview.width,
        height: preview.height,
        strokeColor: preview.color,
        strokeWidth: preview.size,
        fillColor: null,
        opacity: 0.72,
        rotation: 0,
      });
    } else if (preview.points.length > 0) {
      drawFreehand(
        context,
        preview.kind === "eraser"
          ? {
              kind: "eraser",
              tool: "eraser",
              id: "preview",
              points: preview.points,
              size: preview.size,
              opacity: 1,
              rotation: 0,
            }
          : {
              kind: "stroke",
              tool: preview.tool === "marker" ? "marker" : "pen",
              id: "preview",
              points: preview.points,
              size: preview.size,
              color: preview.color,
              opacity: preview.tool === "marker" ? 0.38 : 1,
              rotation: 0,
            },
        fill,
      );
    }
  }
  context.restore();
}

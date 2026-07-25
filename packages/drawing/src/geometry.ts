import { getStroke } from "perfect-freehand";

import type {
  Bounds,
  EraserElement,
  Point2D,
  Scene,
  SceneElement,
  ShapeElement,
  StrokeElement,
  TextElement,
} from "./types.js";

export const HARD_MAX_EXPORT_DIMENSION = 8_192;
export const HARD_MAX_EXPORT_PIXELS = 32 * 1024 * 1024;

export interface FreehandOptions {
  readonly size: number;
  readonly thinning: number;
  readonly smoothing: number;
  readonly streamline: number;
  readonly simulatePressure: boolean;
  readonly last: boolean;
  readonly start: { readonly cap: boolean };
  readonly end: { readonly cap: boolean };
}

export interface CropOptions {
  readonly padding?: number;
  /** Final physical pixels, clamped to HARD_MAX_EXPORT_DIMENSION. */
  readonly maxWidth?: number;
  /** Final physical pixels, clamped to HARD_MAX_EXPORT_DIMENSION. */
  readonly maxHeight?: number;
  readonly pixelRatio?: number;
  readonly includeErasersInBounds?: boolean;
}

export interface ExportGeometry {
  readonly bounds: Bounds;
  readonly width: number;
  readonly height: number;
  /** Scene units to final physical pixels. */
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly padding: number;
}

export function scenePointToExport(point: Point2D, geometry: ExportGeometry): Point2D {
  return {
    x: point.x * geometry.scale + geometry.offsetX,
    y: point.y * geometry.scale + geometry.offsetY,
  };
}

export function normalizedElementOutline(
  element: SceneElement,
  geometry: ExportGeometry,
): readonly Point2D[] {
  return getElementOutline(element).map((point) => scenePointToExport(point, geometry));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFinitePositive(value: number, label: string, allowZero = false): void {
  const minimum = allowZero ? 0 : Number.EPSILON;
  if (!Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${label} must be ${allowZero ? "non-negative" : "positive"}`);
  }
}

export function freehandOptionsFor(element: StrokeElement | EraserElement): FreehandOptions {
  if (element.kind === "eraser") {
    return {
      size: element.size,
      thinning: 0,
      smoothing: 0.58,
      streamline: 0.4,
      simulatePressure: false,
      last: true,
      start: { cap: true },
      end: { cap: true },
    };
  }

  const isPen = element.points.some((point) => point.pointerType === "pen");
  return {
    size: element.size,
    thinning: element.tool === "marker" ? 0 : 0.68,
    smoothing: element.tool === "marker" ? 0.5 : 0.62,
    streamline: element.tool === "marker" ? 0.36 : 0.48,
    simulatePressure: !isPen,
    last: true,
    start: { cap: true },
    end: { cap: true },
  };
}

function centerOf(points: readonly Point2D[]): Point2D {
  const bounds = boundsFromPoints(points);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

export function rotatePoint(point: Point2D, center: Point2D, radians: number): Point2D {
  if (radians === 0) {
    return { ...point };
  }
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
}

export function getStrokePolygon(element: StrokeElement | EraserElement): readonly Point2D[] {
  const input = element.points.map((point) => [point.x, point.y, point.pressure] as [number, number, number]);
  const polygon = getStroke(input, freehandOptionsFor(element)).map(([x, y]) => ({ x, y }));
  if (element.rotation === 0 || polygon.length === 0) {
    return polygon;
  }
  const center = centerOf(polygon);
  return polygon.map((point) => rotatePoint(point, center, element.rotation));
}

export function getArrowPolygon(element: ShapeElement): readonly Point2D[] {
  const start = { x: element.x, y: element.y };
  const end = { x: element.x + element.width, y: element.y + element.height };
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length < Number.EPSILON) {
    const radius = Math.max(1, element.strokeWidth / 2);
    return [
      { x: start.x - radius, y: start.y - radius },
      { x: start.x + radius, y: start.y - radius },
      { x: start.x + radius, y: start.y + radius },
      { x: start.x - radius, y: start.y + radius },
    ];
  }
  const ux = deltaX / length;
  const uy = deltaY / length;
  const nx = -uy;
  const ny = ux;
  const headLength = Math.min(length * 0.45, Math.max(element.strokeWidth * 4, 12));
  const shaftHalf = Math.max(0.5, element.strokeWidth / 2);
  const headHalf = Math.max(shaftHalf * 2.5, headLength * 0.48);
  const base = { x: end.x - ux * headLength, y: end.y - uy * headLength };
  const polygon = [
    { x: start.x - nx * shaftHalf, y: start.y - ny * shaftHalf },
    { x: base.x - nx * shaftHalf, y: base.y - ny * shaftHalf },
    { x: base.x - nx * headHalf, y: base.y - ny * headHalf },
    end,
    { x: base.x + nx * headHalf, y: base.y + ny * headHalf },
    { x: base.x + nx * shaftHalf, y: base.y + ny * shaftHalf },
    { x: start.x + nx * shaftHalf, y: start.y + ny * shaftHalf },
  ];
  const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return element.rotation === 0
    ? polygon
    : polygon.map((point) => rotatePoint(point, center, element.rotation));
}

function rectanglePolygon(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
  expansion = 0,
): readonly Point2D[] {
  const left = Math.min(x, x + width) - expansion;
  const top = Math.min(y, y + height) - expansion;
  const right = Math.max(x, x + width) + expansion;
  const bottom = Math.max(y, y + height) + expansion;
  const center = { x: x + width / 2, y: y + height / 2 };
  const polygon = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  return rotation === 0 ? polygon : polygon.map((point) => rotatePoint(point, center, rotation));
}

function ellipsePolygon(element: ShapeElement): readonly Point2D[] {
  const center = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
  const radiusX = Math.abs(element.width) / 2 + element.strokeWidth / 2;
  const radiusY = Math.abs(element.height) / 2 + element.strokeWidth / 2;
  return Array.from({ length: 64 }, (_, index) => {
    const angle = (index / 64) * Math.PI * 2;
    const point = {
      x: center.x + Math.cos(angle) * radiusX,
      y: center.y + Math.sin(angle) * radiusY,
    };
    return rotatePoint(point, center, element.rotation);
  });
}

export function estimateTextSize(element: TextElement): { readonly width: number; readonly height: number } {
  const lines = element.text.split("\n");
  const estimatedWidth = Math.max(...lines.map((line) => line.length), 1) * element.fontSize * 0.62;
  return {
    width: Math.max(1, element.maxWidth === null ? estimatedWidth : Math.min(element.maxWidth, estimatedWidth)),
    height: Math.max(1, lines.length * element.fontSize * element.lineHeight),
  };
}

export function getElementOutline(element: SceneElement): readonly Point2D[] {
  switch (element.kind) {
    case "stroke":
    case "eraser":
      return getStrokePolygon(element);
    case "shape":
      if (element.shape === "arrow") {
        return getArrowPolygon(element);
      }
      if (element.shape === "ellipse") {
        return ellipsePolygon(element);
      }
      return rectanglePolygon(
        element.x,
        element.y,
        element.width,
        element.height,
        element.rotation,
        element.strokeWidth / 2,
      );
    case "text": {
      const size = estimateTextSize(element);
      return rectanglePolygon(element.x, element.y, size.width, size.height, element.rotation);
    }
    case "image":
      return rectanglePolygon(element.x, element.y, element.width, element.height, element.rotation);
  }
}

export function boundsFromPoints(points: readonly Point2D[]): Bounds {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function getElementBounds(element: SceneElement): Bounds {
  return boundsFromPoints(getElementOutline(element));
}

export function unionBounds(bounds: readonly Bounds[]): Bounds {
  if (bounds.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  const minX = Math.min(...bounds.map((item) => item.minX));
  const minY = Math.min(...bounds.map((item) => item.minY));
  const maxX = Math.max(...bounds.map((item) => item.maxX));
  const maxY = Math.max(...bounds.map((item) => item.maxY));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function getSceneBounds(
  scene: Scene,
  options: { readonly includeErasers?: boolean } = {},
): Bounds {
  let elements = options.includeErasers
    ? scene.elements
    : scene.elements.filter((element) => element.kind !== "eraser");
  if (elements.length === 0 && scene.elements.length > 0) {
    elements = scene.elements;
  }
  if (elements.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: scene.viewport.width,
      maxY: scene.viewport.height,
      width: scene.viewport.width,
      height: scene.viewport.height,
    };
  }
  return unionBounds(elements.map(getElementBounds));
}

function rounded(value: number): string {
  const normalized = Math.abs(value) < 0.0005 ? 0 : Math.round(value * 1_000) / 1_000;
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(3).replace(/0+$/, "");
}

export function polygonToSvgPath(polygon: readonly Point2D[]): string {
  const first = polygon[0];
  if (first === undefined) {
    return "";
  }
  const commands = [`M ${rounded(first.x)} ${rounded(first.y)}`];
  for (const point of polygon.slice(1)) {
    commands.push(`L ${rounded(point.x)} ${rounded(point.y)}`);
  }
  commands.push("Z");
  return commands.join(" ");
}

export function elementToSvgPath(element: SceneElement): string {
  return polygonToSvgPath(getElementOutline(element));
}

export function createExportGeometry(scene: Scene, options: CropOptions = {}): ExportGeometry {
  const padding = options.padding ?? 16;
  const requestedPixelRatio = options.pixelRatio ?? 1;
  assertFinitePositive(padding, "padding", true);
  assertFinitePositive(requestedPixelRatio, "pixelRatio");
  const requestedMaxWidth = options.maxWidth ?? 4_096;
  const requestedMaxHeight = options.maxHeight ?? 4_096;
  assertFinitePositive(requestedMaxWidth, "maxWidth");
  assertFinitePositive(requestedMaxHeight, "maxHeight");
  const maxWidth = clamp(Math.floor(requestedMaxWidth), 1, HARD_MAX_EXPORT_DIMENSION);
  const maxHeight = clamp(Math.floor(requestedMaxHeight), 1, HARD_MAX_EXPORT_DIMENSION);
  const pixelRatio = clamp(requestedPixelRatio, 0.25, 4);
  const bounds = getSceneBounds(scene, { includeErasers: options.includeErasersInBounds ?? false });
  const rawWidth = Math.max(1, bounds.width + padding * 2);
  const rawHeight = Math.max(1, bounds.height + padding * 2);
  const maxScaleByPixels = Math.sqrt(HARD_MAX_EXPORT_PIXELS / (rawWidth * rawHeight));
  const scale = Math.min(
    pixelRatio,
    maxWidth / rawWidth,
    maxHeight / rawHeight,
    maxScaleByPixels,
  );
  let width = Math.max(1, Math.min(maxWidth, Math.ceil(rawWidth * scale)));
  let height = Math.max(1, Math.min(maxHeight, Math.ceil(rawHeight * scale)));
  if (width * height > HARD_MAX_EXPORT_PIXELS) {
    if (width >= height) {
      width = Math.max(1, Math.floor(HARD_MAX_EXPORT_PIXELS / height));
    } else {
      height = Math.max(1, Math.floor(HARD_MAX_EXPORT_PIXELS / width));
    }
  }
  const boundedScale = Math.min(scale, width / rawWidth, height / rawHeight);
  return {
    bounds,
    width,
    height,
    scale: boundedScale,
    offsetX: (padding - bounds.minX) * boundedScale,
    offsetY: (padding - bounds.minY) * boundedScale,
    padding,
  };
}

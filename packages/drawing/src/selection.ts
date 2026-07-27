import { getElementBounds, getElementOutline } from "./geometry.js";
import type {
  Bounds,
  Point2D,
  Scene,
  SceneElement,
  ScenePoint,
} from "./types.js";

const WORLD_LIMIT = 1_000_000;

function clamp(value: number): number {
  return Math.min(WORLD_LIMIT, Math.max(-WORLD_LIMIT, value));
}

export function boundsIntersect(left: Bounds, right: Bounds): boolean {
  return left.maxX >= right.minX
    && left.minX <= right.maxX
    && left.maxY >= right.minY
    && left.minY <= right.maxY;
}

export function boundsContainPoint(bounds: Bounds, point: Point2D, tolerance = 0): boolean {
  return point.x >= bounds.minX - tolerance
    && point.x <= bounds.maxX + tolerance
    && point.y >= bounds.minY - tolerance
    && point.y <= bounds.maxY + tolerance;
}

function pointInPolygon(point: Point2D, polygon: readonly Point2D[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

export function elementContainsPoint(
  element: SceneElement,
  point: Point2D,
  tolerance = 8,
): boolean {
  if (element.kind === "eraser") return false;
  const bounds = getElementBounds(element);
  if (!boundsContainPoint(bounds, point, tolerance)) return false;
  if (element.kind === "stroke") {
    const radius = Math.max(tolerance, element.size / 2);
    if (element.points.length === 1) {
      const first = element.points[0]!;
      return Math.hypot(point.x - first.x, point.y - first.y) <= radius;
    }
    return element.points.slice(1).some((sample, index) => (
      distanceToSegment(point, element.points[index]!, sample) <= radius
    ));
  }
  const outline = getElementOutline(element);
  return pointInPolygon(point, outline)
    || outline.some((sample, index) => distanceToSegment(point, sample, outline[(index + 1) % outline.length]!) <= tolerance);
}

export function topmostElementAtPoint(
  scene: Scene,
  point: Point2D,
  tolerance = 8,
): SceneElement | null {
  for (let index = scene.elements.length - 1; index >= 0; index -= 1) {
    const element = scene.elements[index]!;
    if (elementContainsPoint(element, point, tolerance)) return element;
  }
  return null;
}

export function elementsIntersectingBounds(scene: Scene, bounds: Bounds): readonly SceneElement[] {
  return scene.elements.filter((element) => element.kind !== "eraser" && boundsIntersect(getElementBounds(element), bounds));
}

/**
 * Erasers are paint-order operations rather than standalone visible objects.
 * Moving an ink element therefore carries the smallest intersecting paint
 * component so erased portions cannot unexpectedly reappear.
 */
export function expandSelectionForErasers(
  scene: Scene,
  selectedIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const expanded = new Set(selectedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < scene.elements.length; index += 1) {
      const element = scene.elements[index]!;
      if (element.kind !== "eraser") continue;
      const eraserBounds = getElementBounds(element);
      const affectsSelectedEarlierElement = scene.elements.slice(0, index).some((candidate) => (
        expanded.has(candidate.id) && boundsIntersect(getElementBounds(candidate), eraserBounds)
      ));
      if (!expanded.has(element.id) && affectsSelectedEarlierElement) {
        expanded.add(element.id);
        changed = true;
      }
      if (!expanded.has(element.id)) continue;
      for (const candidate of scene.elements.slice(0, index)) {
        if (!expanded.has(candidate.id) && boundsIntersect(getElementBounds(candidate), eraserBounds)) {
          expanded.add(candidate.id);
          changed = true;
        }
      }
    }
  }
  return expanded;
}

function transformPoint(
  point: ScenePoint,
  origin: Point2D,
  scaleX: number,
  scaleY: number,
  deltaX: number,
  deltaY: number,
): ScenePoint {
  return {
    ...point,
    x: clamp(origin.x + (point.x - origin.x) * scaleX + deltaX),
    y: clamp(origin.y + (point.y - origin.y) * scaleY + deltaY),
  };
}

export interface ElementTransform {
  readonly origin: Point2D;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
}

export function transformElement(element: SceneElement, transform: ElementTransform): SceneElement {
  const scaleX = transform.scaleX ?? 1;
  const scaleY = transform.scaleY ?? 1;
  const deltaX = transform.deltaX ?? 0;
  const deltaY = transform.deltaY ?? 0;
  const strokeScale = Math.sqrt(Math.abs(scaleX * scaleY));
  const x = (value: number) => clamp(transform.origin.x + (value - transform.origin.x) * scaleX + deltaX);
  const y = (value: number) => clamp(transform.origin.y + (value - transform.origin.y) * scaleY + deltaY);
  switch (element.kind) {
    case "stroke":
    case "eraser":
      return {
        ...element,
        size: Math.max(0.1, element.size * strokeScale),
        points: element.points.map((point) => transformPoint(
          point,
          transform.origin,
          scaleX,
          scaleY,
          deltaX,
          deltaY,
        )),
      };
    case "shape":
      return {
        ...element,
        x: x(element.x),
        y: y(element.y),
        width: element.width * scaleX,
        height: element.height * scaleY,
        strokeWidth: Math.max(0.1, element.strokeWidth * strokeScale),
      };
    case "text":
      return {
        ...element,
        x: x(element.x),
        y: y(element.y),
        fontSize: Math.max(1, element.fontSize * strokeScale),
        maxWidth: element.maxWidth === null ? null : Math.max(1, element.maxWidth * Math.abs(scaleX)),
      };
    case "image":
      return {
        ...element,
        x: x(element.x),
        y: y(element.y),
        width: Math.max(0.1, element.width * Math.abs(scaleX)),
        height: Math.max(0.1, element.height * Math.abs(scaleY)),
      };
  }
}

export function transformElements(
  scene: Scene,
  selectedIds: ReadonlySet<string>,
  transform: ElementTransform,
): readonly SceneElement[] {
  return scene.elements
    .filter((element) => selectedIds.has(element.id))
    .map((element) => transformElement(element, transform));
}

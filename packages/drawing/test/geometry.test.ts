import { describe, expect, it } from "vitest";

import {
  HARD_MAX_EXPORT_DIMENSION,
  HARD_MAX_EXPORT_PIXELS,
  createExportGeometry,
  createScene,
  createShapeElement,
  createStrokeElement,
  createTextElement,
  elementToSvgPath,
  freehandOptionsFor,
  getElementBounds,
  getSceneBounds,
  getStrokePolygon,
  type ScenePoint,
} from "../src/index.js";

function penPoint(x: number, y: number, pressure: number): ScenePoint {
  return { x, y, pressure, tiltX: 0, tiltY: 0, time: x, pointerType: "pen" };
}

describe("freehand geometry", () => {
  it("uses real Apple Pencil pressure and never simulates it for pen samples", () => {
    const light = createStrokeElement({
      id: "light",
      color: "#000",
      size: 30,
      points: [penPoint(0, 0, 0.1), penPoint(50, 0, 0.1), penPoint(100, 0, 0.1)],
    });
    const heavy = createStrokeElement({
      id: "heavy",
      color: "#000",
      size: 30,
      points: [penPoint(0, 0, 1), penPoint(50, 0, 1), penPoint(100, 0, 1)],
    });

    expect(freehandOptionsFor(light).simulatePressure).toBe(false);
    expect(getElementBounds(heavy).height).toBeGreaterThan(getElementBounds(light).height);
  });

  it("generates a deterministic, closed polygon path", () => {
    const stroke = createStrokeElement({
      id: "ink",
      color: "#123",
      size: 7,
      points: [penPoint(2, 3, 0.4), penPoint(20, 18, 0.8), penPoint(42, 25, 0.6)],
    });
    const first = elementToSvgPath(stroke);
    const second = elementToSvgPath(stroke);

    expect(first).toBe(second);
    expect(first).toMatch(/^M /);
    expect(first.endsWith("Z")).toBe(true);
    expect(getStrokePolygon(stroke).length).toBeGreaterThan(4);
  });
});

describe("bounds and cropped export geometry", () => {
  it("accounts for shape stroke width, rotation, and text", () => {
    const rectangle = createShapeElement({
      id: "rectangle",
      shape: "rectangle",
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      strokeColor: "#000",
      strokeWidth: 4,
      rotation: 0,
    });
    expect(getElementBounds(rectangle)).toEqual({
      minX: 8,
      minY: 18,
      maxX: 112,
      maxY: 62,
      width: 104,
      height: 44,
    });

    const rotated = { ...rectangle, rotation: Math.PI / 2 };
    expect(getElementBounds(rotated).width).toBeCloseTo(44);
    expect(getElementBounds(rotated).height).toBeCloseTo(104);

    const text = createTextElement({ id: "label", x: 200, y: 10, text: "note", color: "#000", fontSize: 20 });
    const scene = { ...createScene(), elements: [rectangle, text] };
    expect(getSceneBounds(scene).maxX).toBeGreaterThan(240);
  });

  it("crops with padding and enforces hard dimensions and pixel area", () => {
    const giant = createShapeElement({
      id: "giant",
      shape: "rectangle",
      x: -20_000,
      y: -10_000,
      width: 40_000,
      height: 20_000,
      strokeColor: "#000",
      strokeWidth: 2,
    });
    const scene = { ...createScene(), elements: [giant] };
    const geometry = createExportGeometry(scene, {
      padding: 32,
      maxWidth: 100_000,
      maxHeight: 100_000,
      pixelRatio: 4,
    });

    expect(geometry.width).toBeLessThanOrEqual(HARD_MAX_EXPORT_DIMENSION);
    expect(geometry.height).toBeLessThanOrEqual(HARD_MAX_EXPORT_DIMENSION);
    expect(geometry.width * geometry.height).toBeLessThanOrEqual(HARD_MAX_EXPORT_PIXELS);
    expect(geometry.scale).toBeLessThan(1);
    expect(geometry.offsetX).toBeGreaterThan(0);
    expect(geometry.offsetY).toBeGreaterThan(0);
  });
});

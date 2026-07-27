import { describe, expect, it } from "vitest";

import {
  applySceneOperation,
  createEraserElement,
  createHistory,
  createImageElement,
  createScene,
  createShapeElement,
  createStrokeElement,
  createTextElement,
  deserializeScene,
  historyReducer,
  transformElements,
  topmostElementAtPoint,
  elementsIntersectingBounds,
  expandSelectionForErasers,
  migrateScene,
  sceneEraserOperations,
  sceneStrokes,
  serializeScene,
  type ImportedImageMetadata,
  type ScenePoint,
} from "../src/index.js";

function point(x: number, y: number, pressure = 0.5): ScenePoint {
  return {
    x,
    y,
    pressure,
    tiltX: 12,
    tiltY: -4,
    time: x + y,
    pointerType: "pen",
  };
}

const imageMetadata: ImportedImageMetadata = {
  mimeType: "image/png",
  byteLength: 68,
  pixelWidth: 1,
  pixelHeight: 1,
  name: "reference.png",
  sha256: null,
};

describe("scene serialization", () => {
  it("round-trips every editable element and document setting", () => {
    const scene = {
      ...createScene({
        width: 1_366,
        height: 1_024,
        background: { mode: "dark" as const, color: "#18191f" },
        view: { panX: 22, panY: -10, zoom: 1.75 },
      }),
      elements: [
        createImageElement({
          id: "image",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          isBackground: true,
          source: {
            kind: "dataUrl",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            metadata: imageMetadata,
          },
        }),
        createStrokeElement({
          id: "ink",
          color: "#1456d8",
          size: 8,
          points: [point(10, 10, 0.2), point(80, 50, 0.9)],
        }),
        createEraserElement({ id: "erase", size: 20, points: [point(30, 20)] }),
        createShapeElement({
          id: "shape",
          shape: "ellipse",
          x: 50,
          y: 60,
          width: 120,
          height: 80,
          strokeColor: "#ef7d39",
          strokeWidth: 3,
          fillColor: "#fff0df",
          rotation: 0.2,
        }),
        createTextElement({
          id: "text",
          x: 40,
          y: 160,
          text: "Circle this\nthen send",
          color: "#f8f7f2",
          fontSize: 24,
          fontWeight: "bold",
          maxWidth: 180,
        }),
      ],
    };

    expect(deserializeScene(serializeScene(scene))).toEqual(scene);
  });

  it("migrates unversioned tuple strokes without losing pressure", () => {
    const migrated = migrateScene({
      width: 640,
      height: 480,
      background: "white",
      strokes: [
        { id: "old-ink", color: "#111", width: 6, points: [[1, 2, 0.25], [4, 5, 0.8]] },
      ],
      erasers: [{ id: "old-erase", width: 12, points: [[3, 3, 0.5]] }],
    });

    expect(migrated.version).toBe(2);
    expect(migrated.background.mode).toBe("white");
    expect(sceneStrokes(migrated)[0]?.points.map((item) => item.pressure)).toEqual([0.25, 0.8]);
    expect(sceneEraserOperations(migrated)).toHaveLength(1);
  });

  it("rejects duplicate ids and mismatched embedded-image metadata", () => {
    const stroke = createStrokeElement({ id: "same", color: "#000", size: 2, points: [point(0, 0)] });
    const scene = { ...createScene(), elements: [stroke, stroke] };
    expect(() => serializeScene(scene)).toThrow(/duplicate/);

    expect(() =>
      createImageElement({
        id: "bad-image",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        source: {
          kind: "dataUrl",
          dataUrl: "data:image/jpeg;base64,AAAA",
          metadata: imageMetadata,
        },
      }),
    ).toThrow(/MIME/);
  });
});

describe("history reducer", () => {
  it("undoes and redoes strokes, erasures, and view changes", () => {
    const stroke = createStrokeElement({ id: "ink", color: "#111", size: 4, points: [point(1, 1)] });
    const eraser = createEraserElement({ id: "eraser", size: 16, points: [point(2, 2)] });
    let history = createHistory(createScene());

    history = historyReducer(history, { type: "commit", operation: { type: "add", element: stroke } });
    history = historyReducer(history, { type: "commit", operation: { type: "add", element: eraser } });
    history = historyReducer(history, {
      type: "commit",
      operation: { type: "setView", view: { panX: 10, panY: 20, zoom: 2 } },
    });
    expect(history.present.elements).toHaveLength(2);
    expect(history.present.view.zoom).toBe(2);

    history = historyReducer(history, { type: "undo" });
    expect(history.present.view.zoom).toBe(1);
    history = historyReducer(history, { type: "undo" });
    expect(history.present.elements.map((element) => element.id)).toEqual(["ink"]);
    history = historyReducer(history, { type: "redo" });
    expect(history.present.elements.map((element) => element.id)).toEqual(["ink", "eraser"]);
  });

  it("does not create a history entry for a missing removal", () => {
    const scene = createScene();
    expect(applySceneOperation(scene, { type: "remove", elementId: "missing" })).toBe(scene);
    const history = createHistory(scene);
    expect(
      historyReducer(history, { type: "commit", operation: { type: "remove", elementId: "missing" } }),
    ).toBe(history);
  });

  it("places an imported background behind existing foreground elements", () => {
    const stroke = createStrokeElement({ id: "ink", color: "#000", size: 2, points: [point(1, 1)] });
    const background = createImageElement({
      id: "background",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      isBackground: true,
      source: { kind: "blobRef", blobId: "background-blob", metadata: imageMetadata },
    });
    const withStroke = applySceneOperation(createScene(), { type: "add", element: stroke });
    const scene = applySceneOperation(withStroke, { type: "add", element: background });

    expect(scene.elements.map((element) => element.id)).toEqual(["background", "ink"]);
  });

  it("replaces several elements as one reversible history operation", () => {
    const first = createShapeElement({
      id: "first", shape: "rectangle", x: 10, y: 20, width: 100, height: 60,
      strokeColor: "#111", strokeWidth: 2,
    });
    const second = createTextElement({
      id: "second", x: 40, y: 90, text: "Move together", color: "#111", fontSize: 20,
    });
    const scene = { ...createScene(), elements: [first, second] };
    let history = createHistory(scene);
    const replacements = transformElements(scene, new Set(["first", "second"]), {
      origin: { x: 0, y: 0 }, deltaX: 80, deltaY: -30,
    });
    history = historyReducer(history, {
      type: "commit",
      operation: { type: "replaceElements", elements: replacements },
    });
    expect(history.present.elements).toMatchObject([
      { id: "first", x: 90, y: -10 },
      { id: "second", x: 120, y: 60 },
    ]);
    history = historyReducer(history, { type: "undo" });
    expect(history.present.elements).toEqual(scene.elements);
    history = historyReducer(history, { type: "redo" });
    expect(history.present.elements).toMatchObject([
      { id: "first", x: 90, y: -10 },
      { id: "second", x: 120, y: 60 },
    ]);
  });
});

describe("selection geometry", () => {
  it("selects the topmost visible element and supports a marquee", () => {
    const lower = createShapeElement({
      id: "lower", shape: "rectangle", x: 0, y: 0, width: 100, height: 100,
      strokeColor: "#111", strokeWidth: 2, fillColor: "#fff",
    });
    const upper = createShapeElement({
      id: "upper", shape: "ellipse", x: 20, y: 20, width: 80, height: 80,
      strokeColor: "#00f", strokeWidth: 2, fillColor: "#eef",
    });
    const scene = { ...createScene(), elements: [lower, upper] };
    expect(topmostElementAtPoint(scene, { x: 60, y: 60 })?.id).toBe("upper");
    expect(elementsIntersectingBounds(scene, {
      minX: -10, minY: -10, maxX: 15, maxY: 15, width: 25, height: 25,
    }).map((element) => element.id)).toEqual(["lower"]);
  });

  it("moves an erased ink component without separating its eraser", () => {
    const stroke = createStrokeElement({
      id: "ink", color: "#111", size: 8, points: [point(10, 10), point(100, 10)],
    });
    const eraser = createEraserElement({
      id: "erase", size: 20, points: [point(50, 10), point(60, 10)],
    });
    const unrelated = createStrokeElement({
      id: "other", color: "#111", size: 8, points: [point(300, 300), point(340, 340)],
    });
    const scene = { ...createScene(), elements: [stroke, unrelated, eraser] };
    expect([...expandSelectionForErasers(scene, new Set(["ink"]))]).toEqual(["ink", "erase"]);
  });
});

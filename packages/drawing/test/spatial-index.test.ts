import { describe, expect, it } from "vitest";
import { ElementSpatialIndex, createShapeElement } from "../src/index.js";

describe("ElementSpatialIndex", () => {
  it("returns only intersecting elements while preserving paint order across negative cells", () => {
    const elements = [
      createShapeElement({ id: "left", shape: "rectangle", x: -900, y: -40, width: 120, height: 80, strokeColor: "#000", strokeWidth: 2 }),
      createShapeElement({ id: "center", shape: "ellipse", x: -20, y: -20, width: 40, height: 40, strokeColor: "#000", strokeWidth: 2 }),
      createShapeElement({ id: "right", shape: "rectangle", x: 800, y: 0, width: 100, height: 100, strokeColor: "#000", strokeWidth: 2 }),
    ];
    const index = new ElementSpatialIndex(elements, 256);
    expect(index.query({ minX: -1000, minY: -100, maxX: 100, maxY: 100, width: 1100, height: 200 }).map((item) => item.id))
      .toEqual(["left", "center"]);
  });

  it("updates moved, removed, added, and reordered elements without rebuilding stale results", () => {
    const left = createShapeElement({ id: "left", shape: "rectangle", x: 0, y: 0, width: 40, height: 40, strokeColor: "#000", strokeWidth: 2 });
    const right = createShapeElement({ id: "right", shape: "rectangle", x: 600, y: 0, width: 40, height: 40, strokeColor: "#000", strokeWidth: 2 });
    const index = new ElementSpatialIndex([left, right], 128);
    const query = { minX: -20, minY: -20, maxX: 100, maxY: 100, width: 120, height: 120 };
    expect(index.query(query).map((item) => item.id)).toEqual(["left"]);

    const movedRight = { ...right, x: 20 };
    index.update([movedRight]);
    expect(index.query(query).map((item) => item.id)).toEqual(["right"]);

    index.update([left, movedRight]);
    expect(index.query(query).map((item) => item.id)).toEqual(["left", "right"]);
    index.update([movedRight, left]);
    expect(index.query(query).map((item) => item.id)).toEqual(["right", "left"]);
  });

  it("keeps an enormous element queryable without allocating millions of grid cells", () => {
    const enormous = createShapeElement({ id: "enormous", shape: "rectangle", x: -500_000, y: -500_000, width: 1_000_000, height: 1_000_000, strokeColor: "#000", strokeWidth: 2 });
    const index = new ElementSpatialIndex([enormous], 128);
    expect(index.query({ minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 }).map((item) => item.id))
      .toEqual(["enormous"]);
  });
});

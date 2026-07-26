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
});

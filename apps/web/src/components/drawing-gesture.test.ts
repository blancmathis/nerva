import { describe, expect, it } from "vitest";
import { createGestureAnchor, solvePinchView } from "./drawing-gesture";

describe("pinch focal point", () => {
  it("keeps the scene point beneath the moving finger centroid", () => {
    const anchor = createGestureAnchor(
      { centerX: 500, centerY: 300, distance: 100 },
      { zoom: 1, panX: 0, panY: 0 },
      { zoom: 1, panX: 0, panY: 0 },
    );
    const view = solvePinchView(
      anchor,
      { centerX: 550, centerY: 325, distance: 200 },
      0.5,
      4,
    );

    expect(view).toEqual({ zoom: 2, panX: -450, panY: -275 });
    expect(anchor.sceneX * view.zoom + view.panX).toBe(550);
    expect(anchor.sceneY * view.zoom + view.panY).toBe(325);
  });
});


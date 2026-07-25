import { describe, expect, it } from "vitest";

import {
  LOCAL_VISUAL_DIFF_PIXEL_BUDGET,
  computeLocalVisualDiff,
  localVisualDiffSize,
} from "./local-visual-diff";

describe("local visual diff", () => {
  it("keeps the comparison raster inside its pixel budget without scaling small images up", () => {
    expect(localVisualDiffSize(800, 600)).toEqual({ width: 800, height: 600, sampled: false });

    const bounded = localVisualDiffSize(8_000, 4_000);
    expect(bounded.sampled).toBe(true);
    expect(bounded.width * bounded.height).toBeLessThanOrEqual(LOCAL_VISUAL_DIFF_PIXEL_BUDGET);
    expect(bounded.width / bounded.height).toBeCloseTo(2, 2);
  });

  it("marks only channel changes above the noise threshold and retains a neutral reference", () => {
    const before = Uint8ClampedArray.from([
      100, 100, 100, 255,
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]);
    const after = Uint8ClampedArray.from([
      112, 100, 100, 255,
      10, 20, 80, 255,
      40, 50, 60, 200,
    ]);

    const result = computeLocalVisualDiff(before, after);

    expect(result.changedPixels).toBe(2);
    expect(result.totalPixels).toBe(3);
    expect(result.maximumDelta).toBe(55);
    expect(result.pixels.slice(0, 3)).toEqual(Uint8ClampedArray.from([57, 57, 57]));
    expect(result.pixels[4]).toBe(237);
    expect(result.pixels[8]).toBe(237);
    expect([result.pixels[7], result.pixels[11]]).toEqual([255, 255]);
  });

  it("rejects malformed or differently-sized RGBA rasters", () => {
    expect(() => computeLocalVisualDiff(new Uint8ClampedArray(), new Uint8ClampedArray())).toThrow(/equal non-empty RGBA/i);
    expect(() => computeLocalVisualDiff(new Uint8ClampedArray(4), new Uint8ClampedArray(8))).toThrow(/equal non-empty RGBA/i);
    expect(() => localVisualDiffSize(0, 100)).toThrow(/positive safe integers/i);
  });
});

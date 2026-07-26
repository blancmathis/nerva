import { describe, expect, it } from "vitest";
import { BOARD_TILE_OVERLAP, planBoardTiles } from "../src/index.js";

const bounds = (width: number, height: number, minX = 0, minY = 0) => ({
  minX, minY, maxX: minX + width, maxY: minY + height, width, height,
});

describe("planBoardTiles", () => {
  it("keeps a readable board in one self-identifying map image", () => {
    const plan = planBoardTiles(bounds(2_000, 1_000));
    expect(plan.quality).toBe("good");
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]).toMatchObject({ kind: "overview", regionId: "A1" });
  });

  it("adds a map and caps detail exports at eleven with symmetric overlap", () => {
    const board = bounds(40_000, 20_000, -20_000, -10_000);
    const plan = planBoardTiles(board);
    const details = plan.tiles.filter((tile) => tile.kind === "detail");
    expect(plan.quality).toBe("reduced");
    expect(plan.tiles.length).toBeLessThanOrEqual(12);
    expect(plan.tiles[0]?.kind).toBe("overview");
    expect(details.some((tile) => tile.bounds.minX < 0)).toBe(true);
    expect(details[0]!.bounds.minX).toBe(details[0]!.coreBounds.minX);
    expect(details[0]!.bounds.maxX).toBeGreaterThan(details[0]!.coreBounds.maxX);
    expect(BOARD_TILE_OVERLAP).toBe(0.12);
  });

  it("keeps core regions contiguous while render regions overlap", () => {
    const plan = planBoardTiles(bounds(6_000, 2_000));
    const details = plan.tiles.filter((tile) => tile.kind === "detail");
    const first = details[0]!;
    const right = details.find((tile) => tile.row === first.row && tile.column === first.column + 1)!;
    expect(first.coreBounds.maxX).toBeCloseTo(right.coreBounds.minX);
    expect(first.bounds.maxX).toBeGreaterThan(right.bounds.minX);
    expect(first.neighbors.right).toBe(right.regionId);
    expect(right.neighbors.left).toBe(first.regionId);
  });

  it("moves a seam away from protected text or block bounds when space allows", () => {
    const protectedBlock = bounds(160, 500, 930, 100);
    const plan = planBoardTiles(bounds(3_000, 1_000), 1.5, { protectedBounds: [protectedBlock] });
    const first = plan.tiles.find((tile) => tile.kind === "detail")!;
    expect(first.coreBounds.maxX).not.toBeGreaterThan(protectedBlock.minX);
  });

  it("penalizes structured-link cuts before ordinary ink cuts", () => {
    const plan = planBoardTiles(bounds(3_000, 1_000), 1.5, {
      structuredSegments: [{ start: { x: 930, y: 100 }, end: { x: 1_080, y: 800 } }],
      softBounds: [bounds(220, 500, 900, 150)],
    });
    const first = plan.tiles.find((tile) => tile.kind === "detail")!;
    expect(first.coreBounds.maxX < 930 || first.coreBounds.maxX > 1_080).toBe(true);
  });

  it("reserves detail slots for a package-level structure index", () => {
    const plan = planBoardTiles(bounds(40_000, 20_000), 1.5, { maxDetailTiles: 10 });
    expect(plan.tiles.filter((tile) => tile.kind === "detail").length).toBeLessThanOrEqual(10);
    expect(plan.tiles.length).toBeLessThanOrEqual(11);
  });

  it("keeps region IDs and neighbors deterministic with negative coordinates", () => {
    const plan = planBoardTiles(bounds(8_000, 5_000, -5_000, -3_000));
    const details = plan.tiles.filter((tile) => tile.kind === "detail");
    expect(details.map((tile) => tile.regionId)).toEqual(
      details.map((tile) => `${String.fromCharCode(65 + tile.row)}${tile.column + 1}`),
    );
    for (const tile of details) {
      if (tile.neighbors.right) {
        const neighbor = details.find((candidate) => candidate.regionId === tile.neighbors.right)!;
        expect(neighbor.neighbors.left).toBe(tile.regionId);
      }
    }
  });
});

import type { Bounds, Point2D } from "./types.js";

export const MAX_BOARD_EXPORT_IMAGES = 12;
export const MAX_BOARD_DETAIL_TILES = 11;
export const DETAIL_TILE_PIXELS = 2_048;
export const BOARD_TILE_OVERLAP = 0.12;

export type BoardExportQuality = "good" | "reduced" | "overview-detail";
export type BoardRegionDirection = "up" | "right" | "down" | "left";

export interface BoardCutSegment {
  readonly start: Point2D;
  readonly end: Point2D;
}

export interface BoardTileConstraints {
  /** Blocks, text and photographs that should never be cut when another seam is available. */
  readonly protectedBounds?: readonly Bounds[];
  /** Structured links, which are more expensive to cut than ordinary ink. */
  readonly structuredSegments?: readonly BoardCutSegment[];
  /** Pencil strokes and free-form arrows that should be preserved when practical. */
  readonly softBounds?: readonly Bounds[];
  /** Reserve image slots for a structure index or another package-level view. */
  readonly maxDetailTiles?: number;
}

export interface BoardExportTile {
  readonly index: number;
  readonly kind: "overview" | "detail";
  readonly row: number;
  readonly column: number;
  readonly regionId: string;
  /** Non-overlapping region used for navigation and seam ownership. */
  readonly coreBounds: Bounds;
  /** Rendered crop, expanded around coreBounds to provide registration overlap. */
  readonly bounds: Bounds;
  readonly neighbors: Readonly<Partial<Record<BoardRegionDirection, string>>>;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface BoardTilePlan {
  readonly quality: BoardExportQuality;
  readonly pixelsPerWorldUnit: number;
  readonly columns: number;
  readonly rows: number;
  readonly tiles: readonly BoardExportTile[];
}

interface DetailRegion {
  readonly row: number;
  readonly column: number;
  readonly regionId: string;
  readonly coreBounds: Bounds;
  readonly bounds: Bounds;
}

function makeBounds(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function rowLabel(row: number): string {
  let value = row + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function regionId(row: number, column: number): string {
  return `${rowLabel(row)}${column + 1}`;
}

function cutsBounds(value: number, axis: "x" | "y", bounds: Bounds): boolean {
  return axis === "x"
    ? bounds.minX < value && bounds.maxX > value
    : bounds.minY < value && bounds.maxY > value;
}

function cutsSegment(value: number, axis: "x" | "y", segment: BoardCutSegment): boolean {
  const first = axis === "x" ? segment.start.x : segment.start.y;
  const second = axis === "x" ? segment.end.x : segment.end.y;
  return Math.min(first, second) < value && Math.max(first, second) > value;
}

function candidateCuts(
  nominal: number,
  axis: "x" | "y",
  minimum: number,
  maximum: number,
  tolerance: number,
  constraints: BoardTileConstraints,
): readonly number[] {
  const candidates = [nominal];
  for (let step = 1; step <= 12; step += 1) {
    const offset = tolerance * (step / 12);
    candidates.push(nominal - offset, nominal + offset);
  }
  for (const item of [...(constraints.protectedBounds ?? []), ...(constraints.softBounds ?? [])]) {
    const before = (axis === "x" ? item.minX : item.minY) - 12;
    const after = (axis === "x" ? item.maxX : item.maxY) + 12;
    if (Math.abs(before - nominal) <= tolerance) candidates.push(before);
    if (Math.abs(after - nominal) <= tolerance) candidates.push(after);
  }
  return [...new Set(candidates)]
    .filter((value) => value > minimum && value < maximum)
    .sort((left, right) => left - right);
}

function boundaryScore(
  value: number,
  nominal: number,
  axis: "x" | "y",
  tolerance: number,
  constraints: BoardTileConstraints,
): number {
  const protectedCuts = (constraints.protectedBounds ?? []).filter((item) => cutsBounds(value, axis, item)).length;
  const structuredCuts = (constraints.structuredSegments ?? []).filter((item) => cutsSegment(value, axis, item)).length;
  const softCuts = (constraints.softBounds ?? []).filter((item) => cutsBounds(value, axis, item)).length;
  const drift = tolerance <= 0 ? 0 : Math.abs(value - nominal) / tolerance;
  return protectedCuts * 1_000_000 + structuredCuts * 10_000 + softCuts * 100 + drift * 10;
}

function adjustedBoundary(
  nominal: number,
  axis: "x" | "y",
  minimum: number,
  maximum: number,
  tolerance: number,
  constraints: BoardTileConstraints,
): number {
  const candidates = candidateCuts(nominal, axis, minimum, maximum, tolerance, constraints);
  let best = nominal;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = boundaryScore(candidate, nominal, axis, tolerance, constraints);
    if (score < bestScore || (score === bestScore && Math.abs(candidate - nominal) < Math.abs(best - nominal))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function detailGrid(
  bounds: Bounds,
  columns: number,
  rows: number,
  constraints: BoardTileConstraints,
): readonly DetailRegion[] {
  const nominalWidth = bounds.width / columns;
  const nominalHeight = bounds.height / rows;
  const xCuts = [bounds.minX];
  const yCuts = [bounds.minY];
  for (let column = 1; column < columns; column += 1) {
    xCuts.push(adjustedBoundary(
      bounds.minX + nominalWidth * column,
      "x",
      xCuts.at(-1)! + nominalWidth * 0.55,
      bounds.maxX - nominalWidth * (columns - column) * 0.55,
      nominalWidth * 0.18,
      constraints,
    ));
  }
  for (let row = 1; row < rows; row += 1) {
    yCuts.push(adjustedBoundary(
      bounds.minY + nominalHeight * row,
      "y",
      yCuts.at(-1)! + nominalHeight * 0.55,
      bounds.maxY - nominalHeight * (rows - row) * 0.55,
      nominalHeight * 0.18,
      constraints,
    ));
  }
  xCuts.push(bounds.maxX);
  yCuts.push(bounds.maxY);
  const regions: DetailRegion[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const coreBounds = makeBounds(
        xCuts[column]!,
        yCuts[row]!,
        xCuts[column + 1]!,
        yCuts[row + 1]!,
      );
      const overlapX = coreBounds.width * BOARD_TILE_OVERLAP / 2;
      const overlapY = coreBounds.height * BOARD_TILE_OVERLAP / 2;
      regions.push({
        row,
        column,
        regionId: regionId(row, column),
        coreBounds,
        bounds: makeBounds(
          Math.max(bounds.minX, coreBounds.minX - overlapX),
          Math.max(bounds.minY, coreBounds.minY - overlapY),
          Math.min(bounds.maxX, coreBounds.maxX + overlapX),
          Math.min(bounds.maxY, coreBounds.maxY + overlapY),
        ),
      });
    }
  }
  return regions;
}

function neighborsFor(
  region: DetailRegion,
  columns: number,
  rows: number,
): Readonly<Partial<Record<BoardRegionDirection, string>>> {
  return {
    ...(region.row > 0 ? { up: regionId(region.row - 1, region.column) } : {}),
    ...(region.column + 1 < columns ? { right: regionId(region.row, region.column + 1) } : {}),
    ...(region.row + 1 < rows ? { down: regionId(region.row + 1, region.column) } : {}),
    ...(region.column > 0 ? { left: regionId(region.row, region.column - 1) } : {}),
  };
}

/** Pure geometry planning; rendering happens sequentially in the web client. */
export function planBoardTiles(
  bounds: Bounds,
  preferredPixelsPerWorldUnit = 1.5,
  constraints: BoardTileConstraints = {},
): BoardTilePlan {
  const maxDetailTiles = Math.max(1, Math.min(
    MAX_BOARD_DETAIL_TILES,
    Math.floor(constraints.maxDetailTiles ?? MAX_BOARD_DETAIL_TILES),
  ));
  if (bounds.width <= 0 || bounds.height <= 0) {
    return {
      quality: "good",
      pixelsPerWorldUnit: preferredPixelsPerWorldUnit,
      columns: 1,
      rows: 1,
      tiles: [{
        index: 1,
        kind: "overview",
        row: 0,
        column: 0,
        regionId: "A1",
        coreBounds: bounds,
        bounds,
        neighbors: {},
        pixelWidth: 1,
        pixelHeight: 1,
      }],
    };
  }
  if (bounds.width * preferredPixelsPerWorldUnit <= 4_096 && bounds.height * preferredPixelsPerWorldUnit <= 4_096) {
    return {
      quality: "good",
      pixelsPerWorldUnit: preferredPixelsPerWorldUnit,
      columns: 1,
      rows: 1,
      tiles: [{
        index: 1,
        kind: "overview",
        row: 0,
        column: 0,
        regionId: "A1",
        coreBounds: bounds,
        bounds,
        neighbors: {},
        pixelWidth: Math.max(1, Math.ceil(bounds.width * preferredPixelsPerWorldUnit)),
        pixelHeight: Math.max(1, Math.ceil(bounds.height * preferredPixelsPerWorldUnit)),
      }],
    };
  }

  const idealWorldEdge = DETAIL_TILE_PIXELS / preferredPixelsPerWorldUnit;
  let columns = Math.max(1, Math.ceil(bounds.width / (idealWorldEdge * (1 - BOARD_TILE_OVERLAP))));
  let rows = Math.max(1, Math.ceil(bounds.height / (idealWorldEdge * (1 - BOARD_TILE_OVERLAP))));
  let quality: BoardExportQuality = "good";
  if (columns * rows > maxDetailTiles) {
    quality = "reduced";
    const aspect = bounds.width / bounds.height;
    columns = Math.max(1, Math.min(maxDetailTiles, Math.round(Math.sqrt(maxDetailTiles * aspect))));
    rows = Math.max(1, Math.floor(maxDetailTiles / columns));
    while (columns * rows < maxDetailTiles && bounds.height / rows > bounds.width / columns) rows += 1;
    while (columns * rows > maxDetailTiles) rows -= 1;
  }
  const details = detailGrid(bounds, columns, rows, constraints);
  const pixelsPerWorldUnit = Math.min(
    preferredPixelsPerWorldUnit,
    ...details.map((tile) => Math.min(DETAIL_TILE_PIXELS / tile.bounds.width, DETAIL_TILE_PIXELS / tile.bounds.height)),
  );
  const overviewScale = Math.min(1, 1_600 / bounds.width, 1_600 / bounds.height);
  const tiles: BoardExportTile[] = [{
    index: 1,
    kind: "overview",
    row: 0,
    column: 0,
    regionId: "MAP",
    coreBounds: bounds,
    bounds,
    neighbors: {},
    pixelWidth: Math.max(1, Math.ceil(bounds.width * overviewScale)),
    pixelHeight: Math.max(1, Math.ceil(bounds.height * overviewScale)),
  }];
  details.forEach((tile, index) => tiles.push({
    index: index + 2,
    kind: "detail",
    row: tile.row,
    column: tile.column,
    regionId: tile.regionId,
    coreBounds: tile.coreBounds,
    bounds: tile.bounds,
    neighbors: neighborsFor(tile, columns, rows),
    pixelWidth: Math.max(1, Math.min(DETAIL_TILE_PIXELS, Math.ceil(tile.bounds.width * pixelsPerWorldUnit))),
    pixelHeight: Math.max(1, Math.min(DETAIL_TILE_PIXELS, Math.ceil(tile.bounds.height * pixelsPerWorldUnit))),
  }));
  return { quality, pixelsPerWorldUnit, columns, rows, tiles };
}

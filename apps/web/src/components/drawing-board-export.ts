import {
  BOARD_TILE_OVERLAP,
  getElementBounds,
  getSceneBounds,
  planBoardTiles,
  scenePointToExport,
  type BoardCutSegment,
  type BoardExportQuality,
  type BoardExportTile,
  type BoardTilePlan,
  type Bounds,
  type ExportGeometry,
  type Scene,
} from "@codex-pad/drawing";
import { MAX_SKETCH_BYTES, type DiagramDocument } from "@codex-pad/protocol";
import { exportSceneToBoundedPng } from "./drawing-export";

const MAX_BATCH_BYTES = 24 * 1024 * 1024;
const MAP_SIZE = 2_048;
const MAP_HEADER_HEIGHT = 116;
const DETAIL_HEADER_HEIGHT = 148;
const DETAIL_GUTTER = 18;
const STRUCTURE_INDEX_SIZE = 4_096;
const INLINE_STRUCTURE_LINES = 16;
const PACKAGE_BACKGROUND = "#f3f1eb";
const PACKAGE_PANEL = "#fbfaf6";
const PACKAGE_INK = "#182028";
const PACKAGE_MUTED = "#657078";
const PACKAGE_ACCENT = "#2977f5";
const PACKAGE_GRID = "rgba(41, 119, 245, 0.72)";
const PACKAGE_GRID_FILL = "rgba(41, 119, 245, 0.10)";

export type DrawingExportScope = "board" | "area";

export interface DrawingBoardExportImage {
  readonly fileName: `Nerva Board ${string}.png`;
  readonly blob: Blob;
  readonly kind: "overview" | "detail" | "atlas";
  readonly tileNumber: number;
}

export interface DrawingBoardExportManifest {
  readonly version: 1;
  readonly quality: BoardExportQuality;
  readonly overlap: number;
  readonly tiles: readonly {
    readonly tileNumber: number;
    readonly kind: "overview" | "detail" | "atlas";
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  }[];
}

export interface DrawingBoardExportPackage {
  readonly scope: DrawingExportScope;
  readonly images: readonly DrawingBoardExportImage[];
  readonly manifest: DrawingBoardExportManifest;
}

export interface DrawingBoardExportRegionDescription {
  readonly regionId: string;
  readonly neighbors: readonly string[];
  readonly alignmentMarkers: readonly string[];
  readonly continuations: readonly string[];
}

export interface DrawingBoardExportDescription {
  readonly summary: string;
  readonly quality: BoardExportQuality;
  readonly plannedImageCount: number;
  readonly detailCount: number;
  readonly hasStructureIndex: boolean;
  readonly usesAtlas: boolean;
  readonly regions: readonly DrawingBoardExportRegionDescription[];
}

export interface DrawingBoardExportOptions {
  readonly scene: Scene;
  readonly scope: DrawingExportScope;
  readonly selectedBounds: Bounds | null;
  readonly composerAttachmentMaxImages: 1 | 12;
  readonly boardId: string;
  readonly checkpointId: string;
  readonly diagram: DiagramDocument | null;
}

interface StructuredConnection {
  readonly code: string;
  readonly fromReference: string;
  readonly toReference: string;
  readonly fromRegion: string;
  readonly toRegion: string;
}

interface StructureIndex {
  readonly regionLines: readonly string[];
  readonly connectionLines: readonly string[];
  readonly connections: readonly StructuredConnection[];
}

interface PreparedExportPlan {
  readonly bounds: Bounds;
  readonly plan: BoardTilePlan;
  readonly structure: StructureIndex | null;
  readonly hasStructureIndex: boolean;
}

interface RenderedEntry {
  readonly image: DrawingBoardExportImage;
  readonly bounds: Bounds;
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = Math.max(1, Math.floor(width));
  element.height = Math.max(1, Math.floor(height));
  return element;
}

function png(canvasElement: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvasElement.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("The board image could not be encoded."));
  }, "image/png"));
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") throw new Error("Board export requires browser image decoding.");
  return await createImageBitmap(blob);
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, safeRadius);
}

function shortId(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").slice(0, 6).toUpperCase() || "BOARD";
}

function stableTextHash(value: string): string {
  let hash = 0;
  for (const character of value) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return hash.toString(36).padStart(5, "0").slice(-5).toUpperCase();
}

function compactStableId(value: string, maxLength = 18): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 6)}~${stableTextHash(value)}`;
}

function compactLabel(value: string, maxLength = 24): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function nodeReference(node: DiagramDocument["nodes"][number]): string {
  const id = compactStableId(node.id);
  const label = compactLabel(node.label);
  return id.toLocaleLowerCase() === label.toLocaleLowerCase() ? id : `${id}=${label}`;
}

function packagePrefix(boardId: string, checkpointId: string): string {
  return `${shortId(boardId)}-${shortId(checkpointId)}`;
}

function center(bounds: Bounds): { readonly x: number; readonly y: number } {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function structuredSegments(diagram: DiagramDocument | null): readonly BoardCutSegment[] {
  if (!diagram) return [];
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  return diagram.edges.flatMap((edge): BoardCutSegment[] => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return [];
    return [{
      start: { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      end: { x: to.x + to.width / 2, y: to.y + to.height / 2 },
    }];
  });
}

function constraintsFor(scene: Scene, diagram: DiagramDocument | null, maxDetailTiles = 11) {
  const protectedBounds = scene.elements
    .filter((element) => element.kind === "text" || element.kind === "image"
      || (element.kind === "shape" && element.shape !== "arrow"))
    .map(getElementBounds);
  const softBounds = scene.elements
    .filter((element) => element.kind === "stroke" || element.kind === "eraser"
      || (element.kind === "shape" && element.shape === "arrow"))
    .map(getElementBounds);
  return {
    protectedBounds,
    structuredSegments: structuredSegments(diagram),
    softBounds,
    maxDetailTiles,
  } as const;
}

function regionForPoint(plan: BoardTilePlan, point: { readonly x: number; readonly y: number }): string {
  const details = plan.tiles.filter((tile) => tile.kind === "detail");
  if (details.length === 0) return "A1";
  const containing = details.find((tile) =>
    point.x >= tile.coreBounds.minX
    && point.x <= tile.coreBounds.maxX
    && point.y >= tile.coreBounds.minY
    && point.y <= tile.coreBounds.maxY);
  if (containing) return containing.regionId;
  return details
    .map((tile) => ({ tile, distance: Math.hypot(center(tile.coreBounds).x - point.x, center(tile.coreBounds).y - point.y) }))
    .sort((left, right) => left.distance - right.distance)[0]!.tile.regionId;
}

function structureIndex(diagram: DiagramDocument | null, plan: BoardTilePlan): StructureIndex | null {
  if (!diagram) return null;
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const nodeRegions = new Map<string, string>();
  const regionNodes = new Map<string, string[]>();
  for (const node of diagram.nodes) {
    const region = regionForPoint(plan, { x: node.x + node.width / 2, y: node.y + node.height / 2 });
    nodeRegions.set(node.id, region);
    const labels = regionNodes.get(region) ?? [];
    labels.push(nodeReference(node));
    regionNodes.set(region, labels);
  }
  const connections = diagram.edges.flatMap((edge, index): StructuredConnection[] => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const fromRegion = nodeRegions.get(edge.from);
    const toRegion = nodeRegions.get(edge.to);
    if (!from || !to || !fromRegion || !toRegion || fromRegion === toRegion) return [];
    return [{
      code: `E${String(index + 1).padStart(2, "0")}`,
      fromReference: nodeReference(from),
      toReference: nodeReference(to),
      fromRegion,
      toRegion,
    }];
  });
  const orderedRegionIds = plan.tiles.filter((tile) => tile.kind === "detail").map((tile) => tile.regionId);
  if (orderedRegionIds.length === 0) orderedRegionIds.push("A1");
  return {
    regionLines: orderedRegionIds
      .filter((region) => (regionNodes.get(region)?.length ?? 0) > 0)
      .map((region) => `${region} · ${regionNodes.get(region)!.join(" · ")}`),
    connectionLines: connections.map((connection) =>
      `${connection.code} · ${connection.fromReference} → ${connection.toReference} · ${connection.fromRegion} → ${connection.toRegion}`),
    connections,
  };
}

function structureLineUnits(structure: StructureIndex | null): number {
  if (!structure) return 0;
  return [...structure.regionLines, ...structure.connectionLines]
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 58)), 0);
}

function prepareExportPlan(
  scene: Scene,
  diagram: DiagramDocument | null,
  scope: DrawingExportScope,
  selectedBounds: Bounds | null,
): PreparedExportPlan {
  const bounds = scope === "area" && selectedBounds ? selectedBounds : getSceneBounds(scene);
  let plan = planBoardTiles(bounds, 1.5, constraintsFor(scene, diagram));
  let structure = structureIndex(diagram, plan);
  let hasStructureIndex = structureLineUnits(structure) > INLINE_STRUCTURE_LINES;
  if (hasStructureIndex && plan.tiles.filter((tile) => tile.kind === "detail").length === 11) {
    plan = planBoardTiles(bounds, 1.5, constraintsFor(scene, diagram, 10));
    structure = structureIndex(diagram, plan);
    hasStructureIndex = structureLineUnits(structure) > INLINE_STRUCTURE_LINES;
  }
  return { bounds, plan, structure, hasStructureIndex };
}

function continuationTokens(structure: StructureIndex | null, regionId: string): readonly string[] {
  if (!structure) return [];
  return structure.connections.flatMap((connection): string[] => {
    if (connection.fromRegion === regionId) return [`${connection.code} → ${connection.toRegion}`];
    if (connection.toRegion === regionId) return [`${connection.code} ← ${connection.fromRegion}`];
    return [];
  });
}

function neighborTokens(tile: BoardExportTile): readonly string[] {
  return [
    tile.neighbors.left ? `← ${tile.neighbors.left}` : null,
    tile.neighbors.up ? `↑ ${tile.neighbors.up}` : null,
    tile.neighbors.right ? `→ ${tile.neighbors.right}` : null,
    tile.neighbors.down ? `↓ ${tile.neighbors.down}` : null,
  ].filter((value): value is string => value !== null);
}

function alignmentMarker(regionId: string, neighborId: string): string {
  const [first, second] = [regionId, neighborId].sort((left, right) => left.localeCompare(right));
  return `R-${first}-${second}`;
}

type AlignmentSide = "left" | "up" | "right" | "down";

function alignmentEntries(tile: BoardExportTile): readonly {
  readonly side: AlignmentSide;
  readonly token: string;
}[] {
  return ([
    ["left", tile.neighbors.left],
    ["up", tile.neighbors.up],
    ["right", tile.neighbors.right],
    ["down", tile.neighbors.down],
  ] as const)
    .filter((entry): entry is readonly [AlignmentSide, string] => typeof entry[1] === "string")
    .map(([side, neighborId]) => ({ side, token: alignmentMarker(tile.regionId, neighborId) }));
}

function alignmentTokens(tile: BoardExportTile): readonly string[] {
  return alignmentEntries(tile).map((entry) => entry.token);
}

function alignmentColor(token: string): string {
  let hash = 0;
  for (const character of token) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 68% 42%)`;
}

function drawAlignmentMarkers(
  context: CanvasRenderingContext2D,
  tile: BoardExportTile,
  imageX: number,
  imageY: number,
  imageWidth: number,
  imageHeight: number,
): void {
  context.save();
  for (const entry of alignmentEntries(tile)) {
    const horizontal = entry.side === "up" || entry.side === "down";
    const x = entry.side === "left"
      ? imageX - DETAIL_GUTTER / 2
      : entry.side === "right"
        ? imageX + imageWidth + DETAIL_GUTTER / 2
        : imageX + imageWidth / 2;
    const y = entry.side === "up"
      ? imageY - DETAIL_GUTTER / 2
      : entry.side === "down"
        ? imageY + imageHeight + DETAIL_GUTTER / 2
        : imageY + imageHeight / 2;
    const color = alignmentColor(entry.token);
    context.strokeStyle = color;
    context.fillStyle = PACKAGE_BACKGROUND;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x, y, 7, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.beginPath();
    if (horizontal) {
      context.moveTo(x - 12, y);
      context.lineTo(x + 12, y);
    } else {
      context.moveTo(x, y - 12);
      context.lineTo(x, y + 12);
    }
    context.stroke();
  }
  context.restore();
}

function qualityLabel(quality: BoardExportQuality): string {
  return quality === "good" ? "Good" : quality === "reduced" ? "Reduced" : "Overview detail";
}

export function describeDrawingBoardExport(
  scene: Scene,
  scope: DrawingExportScope,
  selectedBounds: Bounds | null,
  composerAttachmentMaxImages: 1 | 12,
  diagram: DiagramDocument | null,
): DrawingBoardExportDescription {
  const prepared = prepareExportPlan(scene, diagram, scope, selectedBounds);
  const details = prepared.plan.tiles.filter((tile) => tile.kind === "detail");
  const plannedImageCount = prepared.plan.tiles.length + (prepared.hasStructureIndex ? 1 : 0);
  const usesAtlas = composerAttachmentMaxImages === 1 && plannedImageCount > 1;
  const quality: BoardExportQuality = usesAtlas ? "overview-detail" : prepared.plan.quality;
  const structurePart = prepared.hasStructureIndex ? " + structure index" : "";
  const summary = usesAtlas
    ? `1 compatibility atlas · ${qualityLabel(quality)}`
    : details.length === 0
      ? `1 map · ${qualityLabel(quality)}`
      : `1 map + ${details.length} linked detail${details.length === 1 ? "" : "s"}${structurePart} · ${qualityLabel(quality)}`;
  return {
    summary,
    quality,
    plannedImageCount: usesAtlas ? 1 : plannedImageCount,
    detailCount: details.length,
    hasStructureIndex: prepared.hasStructureIndex,
    usesAtlas,
    regions: details.map((tile) => ({
      regionId: tile.regionId,
      neighbors: neighborTokens(tile),
      alignmentMarkers: alignmentTokens(tile),
      continuations: continuationTokens(prepared.structure, tile.regionId),
    })),
  };
}

function drawNavigationGrid(
  context: CanvasRenderingContext2D,
  plan: BoardTilePlan,
  x: number,
  y: number,
  width: number,
  height: number,
  activeRegion: string | null,
): void {
  const details = plan.tiles.filter((tile) => tile.kind === "detail");
  const columns = Math.max(1, plan.columns);
  const rows = Math.max(1, plan.rows);
  const gap = 8;
  const cellWidth = (width - gap * (columns - 1)) / columns;
  const cellHeight = (height - gap * (rows - 1)) / rows;
  const cells = details.length > 0 ? details : [{ row: 0, column: 0, regionId: "A1" }];
  context.save();
  for (const tile of cells) {
    const cellX = x + tile.column * (cellWidth + gap);
    const cellY = y + tile.row * (cellHeight + gap);
    const active = activeRegion === tile.regionId;
    roundedRect(context, cellX, cellY, cellWidth, cellHeight, 12);
    context.fillStyle = active ? PACKAGE_ACCENT : "rgba(41, 119, 245, 0.10)";
    context.fill();
    context.strokeStyle = active ? PACKAGE_ACCENT : "rgba(41, 119, 245, 0.42)";
    context.lineWidth = active ? 4 : 2;
    context.stroke();
    context.fillStyle = active ? "#ffffff" : PACKAGE_INK;
    context.font = `700 ${Math.max(18, Math.min(30, cellHeight * 0.30))}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(tile.regionId, cellX + cellWidth / 2, cellY + cellHeight / 2);
  }
  context.restore();
}

function mapPoint(
  point: { readonly x: number; readonly y: number },
  geometry: ExportGeometry,
  imageScale: number,
  imageX: number,
  imageY: number,
): { readonly x: number; readonly y: number } {
  const projected = scenePointToExport(point, geometry);
  return { x: imageX + projected.x * imageScale, y: imageY + projected.y * imageScale };
}

function drawRegionOverlay(
  context: CanvasRenderingContext2D,
  scene: Scene,
  plan: BoardTilePlan,
  geometry: ExportGeometry,
  imageScale: number,
  imageX: number,
  imageY: number,
): void {
  const details = plan.tiles.filter((tile) => tile.kind === "detail");
  if (details.length === 0) return;
  const occupied = scene.elements
    .filter((element) => element.kind === "text" || element.kind === "image"
      || (element.kind === "shape" && element.shape !== "arrow"))
    .map(getElementBounds)
    .map((bounds) => {
      const start = mapPoint({ x: bounds.minX, y: bounds.minY }, geometry, imageScale, imageX, imageY);
      const end = mapPoint({ x: bounds.maxX, y: bounds.maxY }, geometry, imageScale, imageX, imageY);
      return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
    });
  const labels: { x: number; y: number; width: number; height: number }[] = [];
  context.save();
  for (const tile of details) {
    const start = mapPoint({ x: tile.coreBounds.minX, y: tile.coreBounds.minY }, geometry, imageScale, imageX, imageY);
    const end = mapPoint({ x: tile.coreBounds.maxX, y: tile.coreBounds.maxY }, geometry, imageScale, imageX, imageY);
    const width = Math.max(1, end.x - start.x);
    const height = Math.max(1, end.y - start.y);
    context.fillStyle = PACKAGE_GRID_FILL;
    context.fillRect(start.x, start.y, width, height);
    context.strokeStyle = PACKAGE_GRID;
    context.lineWidth = 4;
    context.setLineDash([14, 10]);
    context.strokeRect(start.x, start.y, width, height);
    context.setLineDash([]);
    const pillWidth = Math.max(56, 26 + tile.regionId.length * 18);
    const pillHeight = 46;
    const candidates = [
      { x: start.x + 10, y: start.y + 10 },
      { x: start.x + width - pillWidth - 10, y: start.y + 10 },
      { x: start.x + 10, y: start.y + height - pillHeight - 10 },
      { x: start.x + width - pillWidth - 10, y: start.y + height - pillHeight - 10 },
      { x: start.x + (width - pillWidth) / 2, y: start.y + 10 },
      { x: start.x + (width - pillWidth) / 2, y: start.y + height - pillHeight - 10 },
    ].map((candidate) => ({
      x: Math.max(start.x + 2, Math.min(candidate.x, start.x + width - pillWidth - 2)),
      y: Math.max(start.y + 2, Math.min(candidate.y, start.y + height - pillHeight - 2)),
      width: pillWidth,
      height: pillHeight,
    }));
    const intersection = (
      left: { x: number; y: number; width: number; height: number },
      right: { x: number; y: number; width: number; height: number },
    ) => Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
      * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
    const selected = candidates
      .map((candidate, order) => ({
        candidate,
        order,
        score: [...occupied, ...labels].reduce((total, item) => total + intersection(candidate, item), 0),
      }))
      .sort((left, right) => left.score - right.score || left.order - right.order)[0]!.candidate;
    labels.push(selected);
    const pillX = selected.x;
    const pillY = selected.y;
    roundedRect(context, pillX, pillY, pillWidth, pillHeight, 15);
    context.fillStyle = PACKAGE_ACCENT;
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "750 27px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(tile.regionId, pillX + pillWidth / 2, pillY + pillHeight / 2);
  }
  context.restore();
}

function wrapLine(context: CanvasRenderingContext2D, value: string, width: number): readonly string[] {
  const words = value.split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && context.measureText(next).width > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function ensurePngBudget(initial: HTMLCanvasElement, minimumLongEdge = 1_024): Promise<Blob> {
  let output = initial;
  let blob = await png(output);
  while (blob.size > MAX_SKETCH_BYTES && Math.max(output.width, output.height) > minimumLongEdge) {
    const scale = 0.82;
    const next = canvas(output.width * scale, output.height * scale);
    const context = next.getContext("2d");
    if (!context) throw new Error("Board export resize canvas is unavailable.");
    context.drawImage(output, 0, 0, next.width, next.height);
    output.width = 1;
    output.height = 1;
    output = next;
    blob = await png(output);
  }
  if (blob.size > MAX_SKETCH_BYTES) throw new Error("The coherent board image still exceeds 8 MiB.");
  return blob;
}

async function renderMap(
  scene: Scene,
  tile: BoardExportTile,
  plan: BoardTilePlan,
  structure: StructureIndex | null,
  boardId: string,
  checkpointId: string,
  diagram: DiagramDocument | null,
): Promise<Blob> {
  const standalone = plan.tiles.length === 1;
  const { blob, geometry } = await exportSceneToBoundedPng(scene, {
    background: "scene",
    bounds: tile.bounds,
    padding: standalone ? 36 : 28,
    maxWidth: standalone ? 4_096 : 1_480,
    maxHeight: standalone ? 4_096 - MAP_HEADER_HEIGHT : 1_520,
    pixelRatio: standalone ? 1.5 : 1,
  });
  const image = await decode(blob);
  try {
    if (standalone) {
      const width = Math.max(960, image.width);
      const output = canvas(width, Math.min(4_096, image.height + MAP_HEADER_HEIGHT));
      const context = output.getContext("2d");
      if (!context) throw new Error("Board map canvas is unavailable.");
      context.fillStyle = PACKAGE_BACKGROUND;
      context.fillRect(0, 0, output.width, output.height);
      context.fillStyle = PACKAGE_INK;
      context.font = "750 30px system-ui, sans-serif";
      context.fillText(`Nerva Board ${shortId(boardId)} · Map`, 36, 48);
      context.fillStyle = PACKAGE_MUTED;
      context.font = "500 20px system-ui, sans-serif";
      const revision = diagram ? ` · Diagram r${diagram.revision}` : "";
      context.fillText(`Complete board · Export ${shortId(checkpointId)}${revision}`, 36, 82);
      context.drawImage(image, (output.width - image.width) / 2, MAP_HEADER_HEIGHT);
      return await ensurePngBudget(output);
    }

    const output = canvas(MAP_SIZE, MAP_SIZE);
    const context = output.getContext("2d");
    if (!context) throw new Error("Board map canvas is unavailable.");
    context.fillStyle = PACKAGE_BACKGROUND;
    context.fillRect(0, 0, output.width, output.height);
    context.fillStyle = PACKAGE_INK;
    context.font = "760 34px system-ui, sans-serif";
    context.fillText(`Nerva Board ${shortId(boardId)} · Map`, 42, 48);
    context.fillStyle = PACKAGE_MUTED;
    context.font = "520 21px system-ui, sans-serif";
    const detailCount = plan.tiles.length - 1;
    context.fillText(`Map + ${detailCount} linked details · 12% overlap · Export ${shortId(checkpointId)}`, 42, 84);

    const mainX = 42;
    const mainY = MAP_HEADER_HEIGHT + 24;
    const mainWidth = 1_470;
    const mainHeight = MAP_SIZE - mainY - 42;
    roundedRect(context, mainX, mainY, mainWidth, mainHeight, 28);
    context.fillStyle = PACKAGE_PANEL;
    context.fill();
    const imageScale = Math.min((mainWidth - 36) / image.width, (mainHeight - 36) / image.height);
    const imageX = mainX + (mainWidth - image.width * imageScale) / 2;
    const imageY = mainY + (mainHeight - image.height * imageScale) / 2;
    context.drawImage(image, imageX, imageY, image.width * imageScale, image.height * imageScale);
    drawRegionOverlay(context, scene, plan, geometry, imageScale, imageX, imageY);

    const sideX = 1_548;
    const sideWidth = MAP_SIZE - sideX - 42;
    context.fillStyle = PACKAGE_MUTED;
    context.font = "700 16px system-ui, sans-serif";
    context.fillText("NAVIGATION", sideX, mainY + 8);
    const navigationHeight = Math.min(420, Math.max(180, 88 * plan.rows));
    drawNavigationGrid(context, plan, sideX, mainY + 30, sideWidth, navigationHeight, null);

    let textY = mainY + 72 + navigationHeight;
    if (diagram) {
      context.fillStyle = PACKAGE_MUTED;
      context.font = "700 16px system-ui, sans-serif";
      context.fillText(`STRUCTURE · DIAGRAM R${diagram.revision}`, sideX, textY);
      textY += 34;
      context.fillStyle = PACKAGE_INK;
      context.font = "600 18px system-ui, sans-serif";
      const lines = [...(structure?.regionLines ?? []), ...(structure?.connectionLines ?? [])].slice(0, INLINE_STRUCTURE_LINES);
      for (const value of lines) {
        for (const line of wrapLine(context, value, sideWidth)) {
          if (textY > MAP_SIZE - 48) break;
          context.fillText(line, sideX, textY);
          textY += 25;
        }
        if (textY > MAP_SIZE - 48) break;
      }
      if (structureLineUnits(structure) > INLINE_STRUCTURE_LINES) {
        context.fillStyle = PACKAGE_ACCENT;
        context.font = "700 18px system-ui, sans-serif";
        context.fillText("See Structure Index", sideX, Math.min(MAP_SIZE - 42, textY + 8));
      }
    }
    return await ensurePngBudget(output);
  } finally {
    image.close();
  }
}

async function renderDetail(
  scene: Scene,
  tile: BoardExportTile,
  plan: BoardTilePlan,
  structure: StructureIndex | null,
  boardId: string,
  checkpointId: string,
  detailNumber: number,
  detailTotal: number,
): Promise<Blob> {
  const { blob } = await exportSceneToBoundedPng(scene, {
    background: "scene",
    bounds: tile.bounds,
    padding: 28,
    maxWidth: Math.min(2_048 - DETAIL_GUTTER * 2, tile.pixelWidth),
    maxHeight: Math.min(2_048 - DETAIL_HEADER_HEIGHT - DETAIL_GUTTER * 2, tile.pixelHeight),
    pixelRatio: 1.5,
  });
  const image = await decode(blob);
  try {
    const width = Math.max(1_024, image.width + DETAIL_GUTTER * 2);
    const output = canvas(
      width,
      Math.min(2_048, image.height + DETAIL_HEADER_HEIGHT + DETAIL_GUTTER * 2),
    );
    const context = output.getContext("2d");
    if (!context) throw new Error("Board detail canvas is unavailable.");
    context.fillStyle = PACKAGE_BACKGROUND;
    context.fillRect(0, 0, output.width, output.height);
    context.fillStyle = PACKAGE_INK;
    context.font = "740 27px system-ui, sans-serif";
    context.fillText(`Detail ${detailNumber}/${detailTotal} · Region ${tile.regionId}`, 28, 38);
    context.fillStyle = PACKAGE_MUTED;
    context.font = "560 17px system-ui, sans-serif";
    const neighbors = neighborTokens(tile).join("  ·  ") || "Complete region";
    context.fillText(`${neighbors} · Board ${shortId(boardId)} · Export ${shortId(checkpointId)}`, 28, 69);
    const continuations = continuationTokens(structure, tile.regionId);
    if (continuations.length > 0) {
      const shown = continuations.slice(0, 5).join("  ·  ");
      const overflow = continuations.length > 5 ? `  ·  +${continuations.length - 5}` : "";
      context.fillStyle = PACKAGE_ACCENT;
      context.font = "700 17px system-ui, sans-serif";
      context.fillText(`Connections: ${shown}${overflow}`, 28, 101);
    } else {
      context.fillStyle = PACKAGE_MUTED;
      context.font = "520 16px system-ui, sans-serif";
      context.fillText("Adjacent details share 12% registration content", 28, 101);
    }
    const registrations = alignmentTokens(tile);
    context.fillStyle = PACKAGE_MUTED;
    context.font = "560 15px system-ui, sans-serif";
    context.fillText(
      `Scale ${plan.pixelsPerWorldUnit.toFixed(2)} px/unit${registrations.length > 0 ? ` · Align ${registrations.join(" · ")}` : ""}`,
      28,
      128,
    );
    const navigatorWidth = Math.min(310, output.width * 0.29);
    const navigatorX = output.width - navigatorWidth - 24;
    context.fillStyle = PACKAGE_BACKGROUND;
    context.fillRect(navigatorX - 12, 12, navigatorWidth + 18, 106);
    drawNavigationGrid(context, plan, navigatorX, 22, navigatorWidth, 88, tile.regionId);
    const imageX = (output.width - image.width) / 2;
    const imageY = DETAIL_HEADER_HEIGHT + DETAIL_GUTTER;
    context.drawImage(image, imageX, imageY);
    drawAlignmentMarkers(context, tile, imageX, imageY, image.width, image.height);
    return await ensurePngBudget(output);
  } finally {
    image.close();
  }
}

function wrappedStructureLines(
  context: CanvasRenderingContext2D,
  structure: StructureIndex,
  width: number,
): readonly string[] {
  return [
    "REGIONS",
    ...structure.regionLines,
    "CROSS-REGION CONNECTIONS",
    ...(structure.connectionLines.length > 0 ? structure.connectionLines : ["None"]),
  ].flatMap((line) => line === "REGIONS" || line === "CROSS-REGION CONNECTIONS"
    ? [line]
    : wrapLine(context, line, width));
}

async function renderStructureIndex(
  diagram: DiagramDocument,
  structure: StructureIndex,
  boardId: string,
  checkpointId: string,
): Promise<Blob> {
  const output = canvas(STRUCTURE_INDEX_SIZE, STRUCTURE_INDEX_SIZE);
  const context = output.getContext("2d");
  if (!context) throw new Error("Board structure index canvas is unavailable.");
  context.fillStyle = PACKAGE_BACKGROUND;
  context.fillRect(0, 0, output.width, output.height);
  context.fillStyle = PACKAGE_INK;
  context.font = "760 60px system-ui, sans-serif";
  context.fillText("Structure Index", 92, 104);
  context.fillStyle = PACKAGE_MUTED;
  context.font = "540 30px system-ui, sans-serif";
  context.fillText(
    `Board ${shortId(boardId)} · Export ${shortId(checkpointId)} · Diagram r${diagram.revision}`,
    92,
    158,
  );
  context.fillText("Each E-code is repeated in the two linked detail headers.", 92, 204);

  let fontSize = 28;
  let lineHeight = 38;
  let columns = 4;
  const availableHeight = STRUCTURE_INDEX_SIZE - 300;
  let columnWidth = (STRUCTURE_INDEX_SIZE - 184) / columns;
  let lines: readonly string[] = [];
  for (;;) {
    context.font = `580 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    columnWidth = (STRUCTURE_INDEX_SIZE - 184) / columns;
    lines = wrappedStructureLines(context, structure, columnWidth - 28);
    if (Math.ceil(lines.length / columns) * lineHeight <= availableHeight) break;
    if (fontSize > 16) {
      fontSize -= 2;
      lineHeight -= 2;
      continue;
    }
    if (columns < 6) {
      columns += 1;
      continue;
    }
    if (fontSize > 14) {
      fontSize -= 2;
      lineHeight = 18;
      continue;
    }
    throw new Error("The structured board index exceeds its readable image budget.");
  }
  const rowsPerColumn = Math.floor(availableHeight / lineHeight);
  context.font = `580 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textBaseline = "top";
  for (const [index, line] of lines.entries()) {
    const column = Math.floor(index / rowsPerColumn);
    if (column >= columns) break;
    const row = index % rowsPerColumn;
    const heading = line === "REGIONS" || line === "CROSS-REGION CONNECTIONS";
    context.fillStyle = heading ? PACKAGE_ACCENT : PACKAGE_INK;
    context.font = `${heading ? 760 : 580} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    context.fillText(line, 92 + column * columnWidth, 268 + row * lineHeight);
  }
  return await ensurePngBudget(output, 2_048);
}

async function atlasFrom(images: readonly DrawingBoardExportImage[]): Promise<Blob> {
  const output = canvas(4_096, 4_096);
  const context = output.getContext("2d");
  if (!context) throw new Error("Board atlas canvas is unavailable.");
  context.fillStyle = "#ebe8e1";
  context.fillRect(0, 0, output.width, output.height);
  const overviewHeight = 1_620;
  const map = await decode(images[0]!.blob);
  try {
    const scale = Math.min((output.width - 80) / map.width, (overviewHeight - 60) / map.height);
    const width = map.width * scale;
    const height = map.height * scale;
    context.drawImage(map, (output.width - width) / 2, 30 + (overviewHeight - 60 - height) / 2, width, height);
  } finally {
    map.close();
  }

  const remaining = images.slice(1);
  if (remaining.length > 0) {
    const columns = remaining.length <= 2 ? remaining.length : remaining.length <= 6 ? 3 : 4;
    const rows = Math.ceil(remaining.length / columns);
    const gridTop = overviewHeight;
    const cellWidth = output.width / columns;
    const cellHeight = (output.height - gridTop) / rows;
    for (const [index, item] of remaining.entries()) {
      const image = await decode(item.blob);
      try {
        const scale = Math.min((cellWidth - 34) / image.width, (cellHeight - 34) / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        const x = (index % columns) * cellWidth + (cellWidth - width) / 2;
        const y = gridTop + Math.floor(index / columns) * cellHeight + (cellHeight - height) / 2;
        context.drawImage(image, x, y, width, height);
      } finally {
        image.close();
      }
    }
  }
  return await ensurePngBudget(output);
}

export async function exportDrawingBoard(options: DrawingBoardExportOptions): Promise<DrawingBoardExportPackage> {
  const {
    scene,
    scope,
    selectedBounds,
    composerAttachmentMaxImages,
    boardId,
    checkpointId,
    diagram,
  } = options;
  const prepared = prepareExportPlan(scene, diagram, scope, selectedBounds);
  const prefix = packagePrefix(boardId, checkpointId);
  const entries: RenderedEntry[] = [];
  const overview = prepared.plan.tiles[0]!;
  entries.push({
    image: {
      fileName: `Nerva Board ${prefix} 01-map.png`,
      blob: await renderMap(scene, overview, prepared.plan, prepared.structure, boardId, checkpointId, diagram),
      kind: "overview",
      tileNumber: 1,
    },
    bounds: overview.bounds,
  });

  let nextNumber = 2;
  if (prepared.hasStructureIndex && prepared.structure && diagram) {
    entries.push({
      image: {
        fileName: `Nerva Board ${prefix} 02-structure-index.png`,
        blob: await renderStructureIndex(diagram, prepared.structure, boardId, checkpointId),
        kind: "overview",
        tileNumber: 2,
      },
      bounds: prepared.bounds,
    });
    nextNumber += 1;
  }

  const details = prepared.plan.tiles.filter((tile) => tile.kind === "detail");
  for (const [detailIndex, tile] of details.entries()) {
    const tileNumber = nextNumber + detailIndex;
    entries.push({
      image: {
        fileName: `Nerva Board ${prefix} ${String(tileNumber).padStart(2, "0")}-${tile.regionId}.png`,
        blob: await renderDetail(
          scene,
          tile,
          prepared.plan,
          prepared.structure,
          boardId,
          checkpointId,
          detailIndex + 1,
          details.length,
        ),
        kind: "detail",
        tileNumber,
      },
      bounds: tile.bounds,
    });
  }

  const batchBytes = entries.reduce((total, item) => total + item.image.blob.size, 0);
  const useAtlas = entries.length > 1 && (composerAttachmentMaxImages === 1 || batchBytes > MAX_BATCH_BYTES);
  const finalEntries: readonly RenderedEntry[] = useAtlas
    ? [{
        image: {
          fileName: `Nerva Board ${prefix} 01-atlas.png`,
          blob: await atlasFrom(entries.map((entry) => entry.image)),
          kind: "atlas",
          tileNumber: 1,
        },
        bounds: prepared.bounds,
      }]
    : entries;
  return {
    scope,
    images: finalEntries.map((entry) => entry.image),
    manifest: {
      version: 1,
      quality: useAtlas ? "overview-detail" : prepared.plan.quality,
      overlap: BOARD_TILE_OVERLAP,
      tiles: finalEntries.map((entry) => ({
        tileNumber: entry.image.tileNumber,
        kind: entry.image.kind,
        minX: entry.bounds.minX,
        minY: entry.bounds.minY,
        maxX: entry.bounds.maxX,
        maxY: entry.bounds.maxY,
      })),
    },
  };
}

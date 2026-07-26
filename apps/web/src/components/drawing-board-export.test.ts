import { createScene, createShapeElement, serializeScene, type Scene } from "@codex-pad/drawing";
import { DiagramDocumentSchema, type DiagramDocument } from "@codex-pad/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeDrawingBoardExport, exportDrawingBoard } from "./drawing-board-export";

const BOARD_ID = "119f7ec2-68eb-4183-ab3a-0e67312a8ba1";
const CHECKPOINT_ID = "219f7ec2-68eb-4183-ab3a-0e67312a8ba2";

function wideScene(): Scene {
  const scene = createScene({ width: 1_440, height: 900, background: "white" });
  return {
    ...scene,
    elements: [
      createShapeElement({
        id: "left",
        shape: "rectangle",
        x: -8_000,
        y: -1_000,
        width: 240,
        height: 120,
        strokeColor: "#111111",
        strokeWidth: 4,
      }),
      createShapeElement({
        id: "right",
        shape: "rectangle",
        x: 12_000,
        y: 4_000,
        width: 240,
        height: 120,
        strokeColor: "#111111",
        strokeWidth: 4,
      }),
    ],
  };
}

function sizedScene(width: number, height: number): Scene {
  const scene = createScene({ width: 1_440, height: 900, background: "white" });
  return {
    ...scene,
    elements: [
      createShapeElement({
        id: "origin",
        shape: "rectangle",
        x: 0,
        y: 0,
        width: 120,
        height: 80,
        strokeColor: "#111111",
        strokeWidth: 2,
      }),
      createShapeElement({
        id: "extent",
        shape: "rectangle",
        x: width - 120,
        y: height - 80,
        width: 120,
        height: 80,
        strokeColor: "#111111",
        strokeWidth: 2,
      }),
    ],
  };
}

function denseDiagramFor(width: number, height: number): DiagramDocument {
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    id: `package-node-${index}`,
    label: `Structured architecture block ${index} with exact responsibility`,
    x: index % 2 === 0 ? 20 : Math.max(20, width - 280),
    y: 20 + (index % 8) * Math.max(1, (height - 160) / 8),
    width: 240,
    height: 96,
    shape: "rectangle" as const,
    tone: "blue" as const,
  }));
  return DiagramDocumentSchema.parse({
    version: 2,
    diagramId: "519f7ec2-68eb-4183-ab3a-0e67312a8ba5",
    threadId: "619f7ec2-68eb-4183-ab3a-0e67312a8ba6",
    revision: 4,
    title: "Package sizing diagram",
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `package-edge-${index}`,
      from: nodes[index]!.id,
      to: node.id,
      label: "cross-region handoff",
      style: "solid" as const,
    })),
    createdAt: 1,
    updatedAt: 2,
    createdBy: "codex",
    lastEditedBy: "ipad",
    sourceLabel: "Test",
  });
}

function denseDiagram(): DiagramDocument {
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    id: `node-${index}`,
    label: `Structured block ${index}`,
    x: index % 2 === 0 ? -7_800 + index * 80 : 10_000 + index * 80,
    y: -800 + (index % 8) * 550,
    width: 220,
    height: 96,
    shape: "rectangle" as const,
    tone: "blue" as const,
  }));
  return DiagramDocumentSchema.parse({
    version: 2,
    diagramId: "319f7ec2-68eb-4183-ab3a-0e67312a8ba3",
    threadId: "419f7ec2-68eb-4183-ab3a-0e67312a8ba4",
    revision: 7,
    title: "Dense linked architecture",
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      from: nodes[index]!.id,
      to: node.id,
      label: `handoff ${index}`,
      style: "solid" as const,
    })),
    createdAt: 1,
    updatedAt: 2,
    createdBy: "codex",
    lastEditedBy: "ipad",
    sourceLabel: "Test",
  });
}

function maximumDiagram(): DiagramDocument {
  const nodes = Array.from({ length: 256 }, (_, index) => ({
    id: `n${index}`,
    label: `${String(index).padStart(3, "0")} ${"Long structured responsibility ".repeat(8)}`.slice(0, 240),
    x: -7_500 + (index % 16) * 1_250,
    y: -800 + Math.floor(index / 16) * 300,
    width: 180,
    height: 72,
    shape: "rectangle" as const,
    tone: "neutral" as const,
  }));
  return DiagramDocumentSchema.parse({
    version: 2,
    diagramId: "719f7ec2-68eb-4183-ab3a-0e67312a8ba7",
    threadId: "819f7ec2-68eb-4183-ab3a-0e67312a8ba8",
    revision: 12,
    title: "Maximum bounded structure",
    nodes,
    edges: Array.from({ length: 512 }, (_, index) => ({
      id: `e${index}`,
      from: nodes[index % nodes.length]!.id,
      to: nodes[(index + 1) % nodes.length]!.id,
      label: "bounded relationship",
      style: "solid" as const,
    })),
    createdAt: 1,
    updatedAt: 2,
    createdBy: "codex",
    lastEditedBy: "ipad",
    sourceLabel: "Test",
  });
}

beforeAll(() => {
  const context = new Proxy(
    { measureText: (value: string) => ({ width: value.length * 10 }) },
    {
      get: (target, property) => property in target
        ? Reflect.get(target, property)
        : vi.fn(),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["png"], { type: "image/png" }));
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("coherent drawing-board packages", () => {
  it("keeps a small board as one self-identifying map", async () => {
    const scene = {
      ...createScene({ background: "white" }),
      elements: [createShapeElement({
        id: "only",
        shape: "rectangle",
        x: 100,
        y: 100,
        width: 300,
        height: 160,
        strokeColor: "#111111",
        strokeWidth: 4,
      })],
    };
    const result = await exportDrawingBoard({
      scene,
      scope: "board",
      selectedBounds: null,
      composerAttachmentMaxImages: 12,
      boardId: BOARD_ID,
      checkpointId: CHECKPOINT_ID,
      diagram: null,
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ kind: "overview", tileNumber: 1 });
    expect(result.images[0]!.fileName).toMatch(/01-map\.png$/u);
    expect(result.manifest.tiles).toHaveLength(1);
  });

  it("describes a tiled batch and a compatibility atlas honestly", () => {
    const scene = wideScene();
    const batch = describeDrawingBoardExport(scene, "board", null, 12, null);
    const atlas = describeDrawingBoardExport(scene, "board", null, 1, null);
    expect(batch.detailCount).toBeGreaterThan(1);
    expect(batch.summary).toMatch(/^1 map \+ \d+ linked details ·/u);
    expect(batch.regions[0]?.regionId).toBe("A1");
    expect(batch.regions.some((region) => region.neighbors.length > 0)).toBe(true);
    const markerCounts = new Map<string, number>();
    for (const region of batch.regions) {
      for (const marker of region.alignmentMarkers) {
        markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
      }
    }
    expect(markerCounts.size).toBeGreaterThan(0);
    expect([...markerCounts.values()].every((count) => count === 2)).toBe(true);
    expect(atlas).toMatchObject({ usesAtlas: true, plannedImageCount: 1, quality: "overview-detail" });
    expect(atlas.summary).toContain("compatibility atlas");
  });

  it("adds a bounded structure index and cross-region continuation codes", async () => {
    const scene = wideScene();
    const diagram = denseDiagram();
    const description = describeDrawingBoardExport(scene, "board", null, 12, diagram);
    expect(description.hasStructureIndex).toBe(true);
    expect(description.plannedImageCount).toBeLessThanOrEqual(12);
    expect(description.regions.some((region) => region.continuations.some((token) => token.startsWith("E")))).toBe(true);

    const before = serializeScene(scene);
    const result = await exportDrawingBoard({
      scene,
      scope: "board",
      selectedBounds: null,
      composerAttachmentMaxImages: 12,
      boardId: BOARD_ID,
      checkpointId: CHECKPOINT_ID,
      diagram,
    });
    expect(result.images.length).toBeLessThanOrEqual(12);
    expect(result.images[0]!.fileName).toMatch(/01-map\.png$/u);
    expect(result.images[1]!.fileName).toMatch(/02-structure-index\.png$/u);
    expect(result.images.slice(2).every((image) => /-A|\d-B|\d-C/u.test(image.fileName))).toBe(true);
    expect(serializeScene(scene)).toBe(before);
  });

  it("plans coherent packages of 2, 6, and 12 ordered images", () => {
    const fixtures = [
      { width: 1_000, height: 600, count: 2 },
      { width: 4_000, height: 1_000, count: 6 },
      { width: 110_000, height: 10_000, count: 12 },
    ];
    for (const fixture of fixtures) {
      const description = describeDrawingBoardExport(
        sizedScene(fixture.width, fixture.height),
        "board",
        null,
        12,
        denseDiagramFor(fixture.width, fixture.height),
      );
      expect(description.plannedImageCount).toBe(fixture.count);
      expect(description.hasStructureIndex).toBe(true);
    }
  });

  it("renders the maximum structured contract without truncating the index", async () => {
    const result = await exportDrawingBoard({
      scene: wideScene(),
      scope: "board",
      selectedBounds: null,
      composerAttachmentMaxImages: 12,
      boardId: BOARD_ID,
      checkpointId: CHECKPOINT_ID,
      diagram: maximumDiagram(),
    });
    expect(result.images.length).toBeLessThanOrEqual(12);
    expect(result.images[0]!.fileName).toMatch(/01-map\.png$/u);
    expect(result.images[1]!.fileName).toMatch(/02-structure-index\.png$/u);
  });
});

import {
  createShapeElement,
  createTextElement,
  type BackgroundMode,
  type Scene,
  type SceneElement,
} from "@codex-pad/drawing";
import {
  DIAGRAM_CANVAS_HEIGHT,
  DIAGRAM_CANVAS_WIDTH,
  DiagramDocumentSchema,
  type DiagramDocument,
  type DiagramEdge,
  type DiagramNode,
  type DiagramNodeTone,
} from "@codex-pad/protocol";

const SEEN_PREFIX = "codex-pad.diagram-seen.v1:";

const LIGHT_TONES: Record<DiagramNodeTone, { fill: string; stroke: string; text: string }> = {
  neutral: { fill: "#f1f0eb", stroke: "#8b918f", text: "#172125" },
  blue: { fill: "#e5edff", stroke: "#2764f4", text: "#17356f" },
  green: { fill: "#e2f4e9", stroke: "#299565", text: "#164c36" },
  amber: { fill: "#fff0d7", stroke: "#d78922", text: "#6d420e" },
  red: { fill: "#ffe7e3", stroke: "#dc574b", text: "#742b25" },
  violet: { fill: "#eee8ff", stroke: "#7c61d8", text: "#3f2d78" },
};

const DARK_TONES: Record<DiagramNodeTone, { fill: string; stroke: string; text: string }> = {
  neutral: { fill: "#2a3135", stroke: "#9da5a5", text: "#f5f1e8" },
  blue: { fill: "#182a50", stroke: "#73a1ff", text: "#e8efff" },
  green: { fill: "#173b2d", stroke: "#64c99a", text: "#e5fff2" },
  amber: { fill: "#49331a", stroke: "#f0ad4e", text: "#fff1d8" },
  red: { fill: "#4a2423", stroke: "#ef8178", text: "#ffebe8" },
  violet: { fill: "#312751", stroke: "#a991f3", text: "#f2edff" },
};

export interface DiagramHistory {
  readonly past: readonly DiagramDocument[];
  readonly present: DiagramDocument | null;
  readonly future: readonly DiagramDocument[];
}

export type DiagramHistoryAction =
  | { readonly type: "reset"; readonly diagram: DiagramDocument | null }
  | { readonly type: "replace"; readonly diagram: DiagramDocument }
  | { readonly type: "commit"; readonly diagram: DiagramDocument }
  | { readonly type: "record"; readonly previous: DiagramDocument }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

export function createDiagramHistory(diagram: DiagramDocument | null = null): DiagramHistory {
  return { past: [], present: diagram, future: [] };
}

export function diagramHistoryReducer(
  history: DiagramHistory,
  action: DiagramHistoryAction,
): DiagramHistory {
  switch (action.type) {
    case "reset":
      return createDiagramHistory(action.diagram);
    case "replace":
      return { ...history, present: action.diagram };
    case "commit":
      if (history.present === null) return createDiagramHistory(action.diagram);
      return {
        past: [...history.past.slice(-49), history.present],
        present: action.diagram,
        future: [],
      };
    case "record":
      return history.present === null
        ? history
        : {
            past: [...history.past.slice(-49), action.previous],
            present: history.present,
            future: [],
          };
    case "undo": {
      const previous = history.past.at(-1);
      if (!previous || history.present === null) return history;
      return {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future].slice(0, 50),
      };
    }
    case "redo": {
      const next = history.future[0];
      if (!next || history.present === null) return history;
      return {
        past: [...history.past.slice(-49), history.present],
        present: next,
        future: history.future.slice(1),
      };
    }
  }
}

function wrapLabel(label: string, width: number): string {
  const maximum = Math.max(10, Math.floor(width / 14));
  const words = label.trim().split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maximum || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4).join("\n");
}

function nodeCenter(node: DiagramNode): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function boundaryPoint(
  node: DiagramNode,
  toward: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const center = nodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return center;
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  const scale = node.shape === "ellipse"
    ? 1 / Math.sqrt((dx * dx) / (halfWidth * halfWidth) + (dy * dy) / (halfHeight * halfHeight))
    : 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale,
  };
}

function diagramEdgeElements(
  diagram: DiagramDocument,
  edge: DiagramEdge,
  background: BackgroundMode,
): readonly SceneElement[] {
  const from = diagram.nodes.find((node) => node.id === edge.from);
  const to = diagram.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return [];
  const fromCenter = nodeCenter(from);
  const toCenter = nodeCenter(to);
  const start = boundaryPoint(from, toCenter);
  const end = boundaryPoint(to, fromCenter);
  const color = background === "dark" ? "#b7c0c7" : "#536068";
  const arrow = createShapeElement({
    id: `diagram:${diagram.diagramId}:edge:${edge.id}`,
    shape: "arrow",
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
    strokeColor: color,
    strokeWidth: edge.style === "dashed" ? 3 : 4,
    opacity: edge.style === "dashed" ? 0.58 : 0.82,
  });
  if (!edge.label) return [arrow];
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  return [
    arrow,
    createTextElement({
      id: `diagram:${diagram.diagramId}:edge-label:${edge.id}`,
      x: midX - Math.min(150, edge.label.length * 5),
      y: midY - 29,
      text: edge.label,
      color,
      fontSize: 18,
      fontWeight: "bold",
      maxWidth: 300,
      opacity: 0.9,
    }),
  ];
}

export function diagramToSceneElements(
  diagramValue: DiagramDocument,
  background: BackgroundMode,
): readonly SceneElement[] {
  const diagram = DiagramDocumentSchema.parse(diagramValue);
  const tones = background === "dark" ? DARK_TONES : LIGHT_TONES;
  const edges = diagram.edges.flatMap((edge) => diagramEdgeElements(diagram, edge, background));
  const nodes = diagram.nodes.flatMap((node): SceneElement[] => {
    const tone = tones[node.tone];
    const lines = wrapLabel(node.label, node.width);
    const lineCount = Math.max(1, lines.split("\n").length);
    const fontSize = Math.max(20, Math.min(30, node.height / Math.max(3.4, lineCount * 1.45)));
    return [
      createShapeElement({
        id: `diagram:${diagram.diagramId}:node:${node.id}`,
        shape: node.shape,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        strokeColor: tone.stroke,
        strokeWidth: 4,
        fillColor: tone.fill,
      }),
      createTextElement({
        id: `diagram:${diagram.diagramId}:node-label:${node.id}`,
        x: node.x + 20,
        y: node.y + Math.max(18, (node.height - lineCount * fontSize * 1.18) / 2),
        text: lines,
        color: tone.text,
        fontSize,
        fontWeight: "bold",
        lineHeight: 1.18,
        maxWidth: node.width - 40,
      }),
    ];
  });
  return [...edges, ...nodes];
}

export function mergeDiagramIntoScene(
  scene: Scene,
  diagram: DiagramDocument | null,
): Scene {
  if (diagram === null) return scene;
  return {
    ...scene,
    elements: [
      ...diagramToSceneElements(diagram, scene.background.mode),
      ...scene.elements,
    ],
  };
}

export function updateDiagramNode(
  diagram: DiagramDocument,
  nodeId: string,
  update: Partial<Omit<DiagramNode, "id">>,
): DiagramDocument {
  return DiagramDocumentSchema.parse({
    ...diagram,
    nodes: diagram.nodes.map((node) => node.id === nodeId
      ? {
          ...node,
          ...update,
          x: Math.min(
            DIAGRAM_CANVAS_WIDTH - (update.width ?? node.width),
            Math.max(0, update.x ?? node.x),
          ),
          y: Math.min(
            DIAGRAM_CANVAS_HEIGHT - (update.height ?? node.height),
            Math.max(0, update.y ?? node.y),
          ),
        }
      : node),
  });
}

export function addDiagramNode(diagram: DiagramDocument, nodeId: string): DiagramDocument {
  const index = diagram.nodes.length;
  const width = 240;
  const height = 104;
  return DiagramDocumentSchema.parse({
    ...diagram,
    nodes: [
      ...diagram.nodes,
      {
        id: nodeId,
        label: "New step",
        x: 100 + (index % 4) * 300,
        y: 120 + Math.floor(index / 4) * 180,
        width,
        height,
        shape: "rectangle",
        tone: "neutral",
      },
    ],
  });
}

export function removeDiagramNode(diagram: DiagramDocument, nodeId: string): DiagramDocument {
  return DiagramDocumentSchema.parse({
    ...diagram,
    nodes: diagram.nodes.filter((node) => node.id !== nodeId),
    edges: diagram.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  });
}

export function addDiagramEdge(
  diagram: DiagramDocument,
  edgeId: string,
  from: string,
  to: string,
): DiagramDocument {
  if (from === to || diagram.edges.some((edge) => edge.from === from && edge.to === to)) {
    return diagram;
  }
  return DiagramDocumentSchema.parse({
    ...diagram,
    edges: [
      ...diagram.edges,
      { id: edgeId, from, to, label: "", style: "solid" },
    ],
  });
}

export function removeDiagramEdge(diagram: DiagramDocument, edgeId: string): DiagramDocument {
  return DiagramDocumentSchema.parse({
    ...diagram,
    edges: diagram.edges.filter((edge) => edge.id !== edgeId),
  });
}

export function autoLayoutDiagram(diagram: DiagramDocument): DiagramDocument {
  const columns = diagram.nodes.length <= 4 ? 2 : 3;
  const cellWidth = DIAGRAM_CANVAS_WIDTH / columns;
  const rows = Math.max(1, Math.ceil(diagram.nodes.length / columns));
  const cellHeight = DIAGRAM_CANVAS_HEIGHT / rows;
  return DiagramDocumentSchema.parse({
    ...diagram,
    nodes: diagram.nodes.map((node, index) => ({
      ...node,
      x: Math.round((index % columns) * cellWidth + (cellWidth - node.width) / 2),
      y: Math.round(Math.floor(index / columns) * cellHeight + (cellHeight - node.height) / 2),
    })),
  });
}

export function readSeenDiagramRevision(
  threadId: string,
): { readonly diagramId: string; readonly revision: number } | null {
  try {
    const raw = localStorage.getItem(`${SEEN_PREFIX}${threadId.toLowerCase()}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.diagramId !== "string"
      || typeof value.revision !== "number"
      || !Number.isInteger(value.revision)
      || value.revision < 0
    ) return null;
    return { diagramId: value.diagramId, revision: value.revision };
  } catch {
    return null;
  }
}

export function markDiagramRevisionSeen(diagram: DiagramDocument): void {
  try {
    localStorage.setItem(
      `${SEEN_PREFIX}${diagram.threadId.toLowerCase()}`,
      JSON.stringify({ diagramId: diagram.diagramId, revision: diagram.revision }),
    );
  } catch {
    // A private-browsing quota failure must never block editing.
  }
}

import { createScene } from "@codex-pad/drawing";
import { DiagramDocumentSchema, type DiagramDocument } from "@codex-pad/protocol";
import { describe, expect, it } from "vitest";

import {
  addDiagramEdge,
  addDiagramNode,
  autoLayoutDiagram,
  createDiagramHistory,
  diagramHistoryReducer,
  diagramToSceneElements,
  mergeDiagramIntoScene,
  removeDiagramNode,
  updateDiagramNode,
} from "./diagram-model";

function diagram(): DiagramDocument {
  return DiagramDocumentSchema.parse({
    version: 1,
    diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
    threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    revision: 0,
    title: "Round trip",
    nodes: [
      {
        id: "codex",
        label: "Codex creates a structured diagram",
        x: 120,
        y: 200,
        width: 280,
        height: 120,
        shape: "rectangle",
        tone: "blue",
      },
      {
        id: "ipad",
        label: "Nerva edits it",
        x: 720,
        y: 200,
        width: 260,
        height: 120,
        shape: "ellipse",
        tone: "violet",
      },
    ],
    edges: [
      { id: "handoff", from: "codex", to: "ipad", label: "exact task", style: "solid" },
    ],
    createdAt: 1,
    updatedAt: 1,
    createdBy: "codex",
    lastEditedBy: "codex",
    sourceLabel: null,
  });
}

describe("diagram model", () => {
  it("renders structured nodes and arrows beneath freehand annotations", () => {
    const source = createScene({ width: 1_440, height: 900 });
    const elements = diagramToSceneElements(diagram(), "white");
    expect(elements.filter((element) => element.kind === "shape")).toHaveLength(3);
    expect(elements.some((element) => element.kind === "text" && element.text.includes("Nerva"))).toBe(true);
    const merged = mergeDiagramIntoScene(source, diagram());
    expect(merged.elements).toEqual(elements);
    expect(source.elements).toEqual([]);
  });

  it("keeps edits bounded and removes dangling edges", () => {
    const moved = updateDiagramNode(diagram(), "ipad", { x: 1_400, y: -20 });
    expect(moved.nodes[1]?.x).toBe(1_400);
    expect(moved.nodes[1]?.y).toBe(-20);
    expect(removeDiagramNode(moved, "ipad").edges).toEqual([]);
  });

  it("supports adding, connecting, laying out, undoing, and redoing", () => {
    const added = addDiagramNode(diagram(), "review");
    const connected = addDiagramEdge(added, "review_link", "ipad", "review");
    const laidOut = autoLayoutDiagram(connected);
    expect(laidOut.nodes).toHaveLength(3);
    expect(laidOut.edges).toHaveLength(2);

    const history = diagramHistoryReducer(createDiagramHistory(diagram()), {
      type: "commit",
      diagram: laidOut,
    });
    const undone = diagramHistoryReducer(history, { type: "undo" });
    expect(undone.present?.nodes).toHaveLength(2);
    expect(diagramHistoryReducer(undone, { type: "redo" }).present?.nodes).toHaveLength(3);
  });
});

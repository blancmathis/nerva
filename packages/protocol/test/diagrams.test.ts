import { describe, expect, it } from "vitest";

import {
  DiagramDocumentSchema,
  DiagramPublishRequestSchema,
} from "../src/index.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

function publishInput() {
  return {
    threadId: THREAD_ID,
    title: "Diagram collaboration",
    nodes: [
      {
        id: "agent",
        label: "Codex",
        x: 120,
        y: 180,
        width: 240,
        height: 112,
        shape: "rectangle",
        tone: "blue",
      },
      {
        id: "ipad",
        label: "Nerva Draw",
        x: 620,
        y: 180,
        width: 260,
        height: 112,
        shape: "ellipse",
        tone: "violet",
      },
    ],
    edges: [
      {
        id: "handoff",
        from: "agent",
        to: "ipad",
        label: "structured revision",
        style: "solid",
      },
    ],
  } as const;
}

describe("Diagram protocol", () => {
  it("accepts a bounded exact-session diagram", () => {
    const parsed = DiagramPublishRequestSchema.parse(publishInput());
    expect(parsed.threadId).toBe(THREAD_ID);
    expect(parsed.edges[0]?.to).toBe("ipad");
  });

  it("requires optimistic revision data as one pair", () => {
    expect(() => DiagramPublishRequestSchema.parse({
      ...publishInput(),
      diagramId: crypto.randomUUID(),
    })).toThrow();
  });

  it("rejects dangling edges and nodes outside the canvas", () => {
    expect(() => DiagramPublishRequestSchema.parse({
      ...publishInput(),
      nodes: publishInput().nodes.map((node) => node.id === "ipad"
        ? { ...node, x: 1_300 }
        : node),
      edges: [{ ...publishInput().edges[0], to: "missing" }],
    })).toThrow();
  });

  it("records provenance and revision on stored documents", () => {
    const document = DiagramDocumentSchema.parse({
      ...publishInput(),
      version: 1,
      diagramId: crypto.randomUUID(),
      revision: 0,
      createdAt: 10,
      updatedAt: 10,
      createdBy: "codex",
      lastEditedBy: "codex",
      sourceLabel: "Agent architecture pass",
    });
    expect(document.createdBy).toBe("codex");
    expect(document.revision).toBe(0);
  });
});

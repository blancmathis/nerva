import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DiagramConflictError,
  DiagramNotFoundError,
  DiagramStore,
} from "../src/diagram-store.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "119f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function diagramInput(threadId = THREAD_ID) {
  return {
    threadId,
    title: "Agent architecture",
    nodes: [
      {
        id: "codex",
        label: "Codex",
        x: 100,
        y: 200,
        width: 220,
        height: 96,
        shape: "rectangle" as const,
        tone: "blue" as const,
      },
      {
        id: "nerva",
        label: "Nerva",
        x: 560,
        y: 200,
        width: 220,
        height: 96,
        shape: "ellipse" as const,
        tone: "violet" as const,
      },
    ],
    edges: [
      {
        id: "round_trip",
        from: "codex",
        to: "nerva",
        label: "diagram",
        style: "solid" as const,
      },
    ],
    sourceLabel: "Codex architecture pass",
  };
}

describe("DiagramStore", () => {
  it("publishes to one exact task and persists iPad revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "nerva-diagrams-"));
    roots.push(root);
    let now = 100;
    const store = new DiagramStore({ directory: join(root, "diagrams"), now: () => now });

    const published = await store.publish(diagramInput());
    expect(published).toMatchObject({
      threadId: THREAD_ID,
      revision: 0,
      createdBy: "codex",
      lastEditedBy: "codex",
    });
    expect(await store.list(OTHER_THREAD_ID)).toEqual([]);

    now = 200;
    const updated = await store.update(published.diagramId, THREAD_ID, {
      expectedRevision: 0,
      title: "Agent architecture revised",
      nodes: published.nodes.map((node) => node.id === "nerva"
        ? { ...node, x: 620, label: "Nerva Draw" }
        : node),
      edges: published.edges,
    });
    expect(updated).toMatchObject({
      revision: 1,
      updatedAt: 200,
      lastEditedBy: "ipad",
      title: "Agent architecture revised",
    });
    expect((await store.get(published.diagramId)).nodes[1]?.label).toBe("Nerva Draw");
  });

  it("fails closed on stale revisions and cross-task updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "nerva-diagrams-"));
    roots.push(root);
    const store = new DiagramStore({ directory: join(root, "diagrams") });
    const published = await store.publish(diagramInput());
    const update = {
      expectedRevision: 9,
      title: published.title,
      nodes: published.nodes,
      edges: published.edges,
    };

    await expect(store.update(published.diagramId, THREAD_ID, update))
      .rejects.toBeInstanceOf(DiagramConflictError);
    await expect(store.update(published.diagramId, OTHER_THREAD_ID, {
      ...update,
      expectedRevision: 0,
    })).rejects.toBeInstanceOf(DiagramNotFoundError);
  });

  it("lets Codex continue the exact structured document", async () => {
    const root = await mkdtemp(join(tmpdir(), "nerva-diagrams-"));
    roots.push(root);
    const store = new DiagramStore({ directory: join(root, "diagrams") });
    const first = await store.publish(diagramInput());
    const continued = await store.publish({
      ...diagramInput(),
      diagramId: first.diagramId,
      expectedRevision: first.revision,
      title: "Codex continuation",
    });
    expect(continued).toMatchObject({
      diagramId: first.diagramId,
      revision: 1,
      lastEditedBy: "codex",
      title: "Codex continuation",
    });
  });
});

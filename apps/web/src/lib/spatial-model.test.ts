import { describe, expect, it } from "vitest";
import type { AgentSlot } from "./model";
import {
  boxIdForThread,
  buildGroupingSuggestions,
  emptySpatialLayout,
  reconcileSpatialLayout,
  spatialLayoutReducer,
  spatialSessionsFromSources,
  type SessionSummary,
  type SpatialLayout,
} from "./spatial-model";

function createBox(layout: SpatialLayout, id: string, name: string, threadIds: readonly string[] = []) {
  return spatialLayoutReducer(layout, {
    type: "create-box",
    box: { id, name, color: "cobalt", size: "standard" },
    threadIds,
  });
}

describe("spatial layout reducer", () => {
  it("creates boxes and moves sessions without changing session identity", () => {
    let layout = reconcileSpatialLayout(emptySpatialLayout(), ["thread-a", "thread-b"]);
    layout = createBox(layout, "focus", "Focus", ["thread-a"]);
    layout = spatialLayoutReducer(layout, {
      type: "move-session",
      threadId: "thread-b",
      targetBoxId: "focus",
      beforeThreadId: "thread-a",
    });

    expect(layout.boxes[0]?.threadIds).toEqual(["thread-b", "thread-a"]);
    expect(layout.unassignedThreadIds).toEqual([]);
    expect(boxIdForThread(layout, "thread-a")).toBe("focus");
    expect(boxIdForThread(layout, "thread-b")).toBe("focus");
  });

  it("returns every session to Unassigned when deleting a box", () => {
    let layout = reconcileSpatialLayout(emptySpatialLayout(), ["thread-a", "thread-b"]);
    layout = createBox(layout, "later", "Later", ["thread-a", "missing-thread"]);
    layout = spatialLayoutReducer(layout, { type: "delete-box", boxId: "later" });

    expect(layout.boxes).toEqual([]);
    expect(layout.unassignedThreadIds).toEqual(["thread-b", "thread-a", "missing-thread"]);
  });

  it("keeps missing assignments and appends genuinely new sessions", () => {
    const saved: SpatialLayout = {
      version: 2,
      boxes: [
        {
          id: "archive",
          name: "Archive",
          color: "slate",
          size: "compact",
          threadIds: ["temporarily-missing"],
        },
      ],
      unassignedThreadIds: ["still-here"],
    };

    const reconciled = reconcileSpatialLayout(saved, ["still-here", "brand-new"]);
    expect(reconciled.boxes[0]?.threadIds).toEqual(["temporarily-missing"]);
    expect(reconciled.unassignedThreadIds).toEqual(["still-here", "brand-new"]);

    const returned = reconcileSpatialLayout(reconciled, [
      "temporarily-missing",
      "still-here",
      "brand-new",
    ]);
    expect(returned.boxes[0]?.threadIds).toEqual(["temporarily-missing"]);
  });

  it("renames, resizes, recolors, and reorders arbitrary boxes", () => {
    let layout = createBox(emptySpatialLayout(), "a", "A");
    layout = createBox(layout, "b", "B");
    layout = spatialLayoutReducer(layout, { type: "rename-box", boxId: "a", name: "Now" });
    layout = spatialLayoutReducer(layout, { type: "recolor-box", boxId: "a", color: "coral" });
    layout = spatialLayoutReducer(layout, { type: "resize-box", boxId: "a", size: "wide" });
    layout = spatialLayoutReducer(layout, { type: "reorder-box", boxId: "a", toIndex: 1 });

    expect(layout.boxes.map((box) => box.id)).toEqual(["b", "a"]);
    expect(layout.boxes[1]).toMatchObject({ name: "Now", color: "coral", size: "wide" });
  });
});

describe("spatial session projection", () => {
  it("enriches a native slot from the all-session source but preserves native identity", () => {
    const slots: AgentSlot[] = [
      {
        slotId: "AG00",
        index: 0,
        title: "Native task",
        threadKey: "thread:019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
        threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
        suffix: "8ba1",
        status: "working",
        selected: true,
        activityLabel: null,
        activityAt: null,
      },
    ];
    const summaries: SessionSummary[] = [
      {
        threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
        title: "Stale list title",
        status: "idle",
        projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I",
        project: "Codex Pad",
        cwd: "/repo/codex-pad",
      },
    ];

    const [session] = spatialSessionsFromSources(slots, summaries);
    expect(session).toMatchObject({
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      title: "Native task",
      status: "working",
      projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I",
      project: "Codex Pad",
      nativeSlotId: "AG00",
      nativeSlotIndex: 0,
    });
  });

  it("suggests project groups without turning them into workflow states", () => {
    const sessions = spatialSessionsFromSources([], [
      { threadId: "one", title: "One", project: "Atlas" },
      { threadId: "two", title: "Two", project: "Atlas" },
      { threadId: "three", title: "Three", cwd: "/work/solo" },
    ]);
    const suggestions = buildGroupingSuggestions(sessions, emptySpatialLayout());
    expect(suggestions).toEqual([
      expect.objectContaining({
        kind: "project",
        boxName: "Atlas",
        threadIds: ["one", "two"],
      }),
    ]);
  });
});

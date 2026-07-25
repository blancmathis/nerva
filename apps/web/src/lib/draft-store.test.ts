import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  deleteDrawingDraft,
  draftKeyForThread,
  loadDrawingDraft,
  makeStoredDrawingDraft,
  saveDrawingDraft,
} from "./draft-store";

const threadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

describe("drawing draft persistence", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: new IDBFactory(),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("uses a stable per-thread key", () => {
    expect(draftKeyForThread(`  ${threadId.toUpperCase()}  `)).toBe(`thread:${threadId}`);
  });

  it("serializes the full editor state without sharing it across tasks", () => {
    expect(
      makeStoredDrawingDraft(threadId, {
        scene: '{"version":1}',
        instruction: "Match this spacing",
        background: "dark",
        pencilOnly: true,
        diagramJson: '{"version":1,"diagramId":"test"}',
        updatedAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toMatchObject({
      key: `thread:${threadId}`,
      threadId,
      scene: '{"version":1}',
      instruction: "Match this spacing",
      background: "dark",
      pencilOnly: true,
      diagramJson: '{"version":1,"diagramId":"test"}',
    });
  });

  it("round-trips and deletes a draft", async () => {
    await saveDrawingDraft(threadId, {
      scene: '{"version":1,"elements":[]}',
      instruction: "Build this",
      background: "white",
      pencilOnly: false,
      diagramJson: '{"version":1,"title":"Agent diagram"}',
    });

    await expect(loadDrawingDraft(threadId)).resolves.toMatchObject({
      threadId,
      instruction: "Build this",
      diagramJson: '{"version":1,"title":"Agent diagram"}',
    });
    await expect(loadDrawingDraft(` ${threadId.toUpperCase()} `)).resolves.toMatchObject({
      threadId,
      instruction: "Build this",
    });
    await deleteDrawingDraft(threadId);
    await expect(loadDrawingDraft(threadId)).resolves.toBeNull();
  });

  it("does not claim a draft was saved when IndexedDB is unavailable", async () => {
    Reflect.deleteProperty(globalThis, "indexedDB");
    await expect(
      saveDrawingDraft(threadId, {
        scene: '{"version":2,"elements":[]}',
        instruction: "Keep this",
        background: "white",
        pencilOnly: true,
      }),
    ).rejects.toThrow("draft was not saved");
  });
});

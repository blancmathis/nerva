import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  deleteDrawingDraft,
  deletePendingDrawingBoardExport,
  checkpointAndFinishDrawingBoard,
  draftKeyForThread,
  loadDrawingDraft,
  loadPendingDrawingBoardExport,
  listDrawingBoards,
  makeStoredDrawingDraft,
  saveDrawingDraft,
  savePendingDrawingBoardExport,
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

  it("checkpoints a sent board, opens the next Draw blank, and keeps the board recoverable", async () => {
    const boardId = "3d35b974-62cc-4db8-9b4e-5a8dc8a4d813";
    await saveDrawingDraft(threadId, {
      boardId,
      scene: '{"version":2,"viewport":{"width":1440,"height":900},"view":{"panX":0,"panY":0,"zoom":1},"background":{"mode":"white","color":"#fff"},"elements":[{"id":"note","kind":"text","x":-100,"y":20,"text":"Hello","color":"#111","fontFamily":"sans-serif","fontSize":24,"fontWeight":"normal","lineHeight":1.2,"maxWidth":null,"opacity":1,"rotation":0}]}',
      instruction: "",
      background: "white",
      pencilOnly: true,
      camera: { centerX: -40, centerY: 80, zoom: 1.4 },
    });
    await checkpointAndFinishDrawingBoard(threadId, {
      checkpointId: "4d35b974-62cc-4db8-9b4e-5a8dc8a4d814",
      createdAt: "2026-07-25T20:00:00.000Z",
      status: "sent",
      scope: "board",
      imageNames: ["Nerva Board 01-detail.png"],
    });
    await expect(loadDrawingDraft(threadId)).resolves.toBeNull();
    await expect(listDrawingBoards(threadId)).resolves.toMatchObject([{
      boardId,
      camera: { centerX: -40, centerY: 80, zoom: 1.4 },
      checkpoints: [{ status: "sent" }],
    }]);
  });

  it("retains the exact PNG batch for an unresolved transfer and clears only the matching identity", async () => {
    const commandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb1";
    await savePendingDrawingBoardExport({
      commandId,
      threadId,
      boardId: "3d35b974-62cc-4db8-9b4e-5a8dc8a4d813",
      checkpointId: "4d35b974-62cc-4db8-9b4e-5a8dc8a4d814",
      targetSnapshotSeq: 73,
      scope: "board",
      images: [{
        fileName: "Nerva Board 01-overview.png",
        blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
        kind: "overview",
        tileNumber: 1,
      }],
      manifest: {
        version: 1,
        quality: "good",
        overlap: 0.1,
        tiles: [{ tileNumber: 1, kind: "overview", minX: -20, minY: 10, maxX: 300, maxY: 220 }],
      },
      createdAt: "2026-07-25T20:00:00.000Z",
    });

    await expect(loadPendingDrawingBoardExport(threadId)).resolves.toMatchObject({
      commandId,
      images: [{ fileName: "Nerva Board 01-overview.png" }],
    });
    await deletePendingDrawingBoardExport(threadId, "019f7ec2-68eb-7183-bb3a-0e67312a8bb2");
    await expect(loadPendingDrawingBoardExport(threadId)).resolves.not.toBeNull();
    await deletePendingDrawingBoardExport(threadId, commandId);
    await expect(loadPendingDrawingBoardExport(threadId)).resolves.toBeNull();
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

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
  captureInboxSummary,
  deleteCaptureInboxItems,
  listCaptureInboxItems,
  loadCaptureInboxItem,
  saveCaptureInboxItem,
} from "./capture-inbox-store";

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => reader.result instanceof ArrayBuffer ? resolve(new Uint8Array(reader.result)) : reject(new Error("Expected bytes")), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

describe("Capture Inbox local persistence", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  });

  it("stores text and media as reusable local captures", async () => {
    const note = await saveCaptureInboxItem({ kind: "note", title: "  Fix header  ", text: "The header jumps.", now: 1_000 });
    const photo = await saveCaptureInboxItem({
      kind: "photo",
      title: "Photo",
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      fileName: "bug.png",
      now: 2_000,
    });

    await expect(listCaptureInboxItems()).resolves.toMatchObject([
      { id: photo.id, byteLength: 3 },
      { id: note.id, text: "The header jumps." },
    ]);
    await expect(captureInboxSummary()).resolves.toEqual({ count: 2, byteLength: 3 });
    const loaded = await loadCaptureInboxItem(photo.id);
    expect(loaded?.blob?.type).toBe("image/png");
    expect([...await blobBytes(loaded!.blob!)]).toEqual([1, 2, 3]);
    expect(Object.keys(photo)).not.toContain("destination");
    expect(Object.keys(photo)).not.toContain("reviewPreparation");
  });

  it("never persists assignment or delivery state", async () => {
    const item = await saveCaptureInboxItem({ kind: "note", title: "Idea", text: "Use a smaller dock.", now: 1_000 });
    const loaded = await loadCaptureInboxItem(item.id);
    expect(Object.keys(loaded?.item ?? {})).not.toContain("destination");
    expect(Object.keys(loaded?.item ?? {})).not.toContain("reviewPreparation");
    expect(Object.keys(loaded?.item ?? {})).not.toContain("pendingSend");
    expect(Object.keys(loaded?.item ?? {})).not.toContain("queued");
  });

  it("migrates old voice records into neutral audio files without deleting bytes", async () => {
    const legacy = indexedDB.open("nerva-capture-inbox", 1);
    await new Promise<void>((resolve, reject) => {
      legacy.addEventListener("upgradeneeded", () => {
        const store = legacy.result.createObjectStore("captures", { keyPath: "id" });
        store.add({
          id: "legacy-voice",
          kind: "voice",
          title: "Voice note · 10:30 AM",
          createdAt: 1_000,
          updatedAt: 2_000,
          fileName: "voice.m4a",
          mimeType: "audio/mp4",
          byteLength: 3,
          durationMs: 4_000,
          text: null,
          destination: { threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1", title: "Old task", assignedAt: 2_000 },
          reviewPreparation: null,
          bytes: new Uint8Array([4, 5, 6]).buffer,
        });
      });
      legacy.addEventListener("success", () => { legacy.result.close(); resolve(); }, { once: true });
      legacy.addEventListener("error", () => reject(legacy.error), { once: true });
    });

    const [migrated] = await listCaptureInboxItems();
    expect(migrated).toMatchObject({ id: "legacy-voice", kind: "file", title: "Audio file · 10:30 AM", byteLength: 3 });
    expect(Object.keys(migrated ?? {})).not.toContain("destination");
    const loaded = await loadCaptureInboxItem("legacy-voice");
    expect([...await blobBytes(loaded!.blob!)]).toEqual([4, 5, 6]);
  });

  it("removes only the selected local originals", async () => {
    const first = await saveCaptureInboxItem({ kind: "note", title: "First", text: "One", now: 1_000 });
    const second = await saveCaptureInboxItem({ kind: "note", title: "Second", text: "Two", now: 2_000 });
    await deleteCaptureInboxItems([first.id]);
    await expect(listCaptureInboxItems()).resolves.toMatchObject([{ id: second.id }]);
  });

  it("rejects oversized local captures before persistence", async () => {
    const oversized = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)], { type: "application/octet-stream" });
    await expect(saveCaptureInboxItem({ kind: "file", title: "Too large", blob: oversized })).rejects.toThrow(/at most 32 MB/i);
    await expect(listCaptureInboxItems()).resolves.toEqual([]);
  });
});

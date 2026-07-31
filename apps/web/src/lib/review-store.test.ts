import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReviewDraft, reviewDraftReducer, type ReviewImage } from "@codex-pad/review";
import { createScene } from "@codex-pad/drawing";

import { makeBlankReviewFrame, makePhotoReviewFrame, makeSiteReviewFrame } from "../components/review-state";
import {
  clearPendingReviewDelivery,
  deleteReviewDraft,
  deleteReviewDraftIfUnchanged,
  getReviewBlob,
  initializeReviewStore,
  loadPendingReviewDelivery,
  loadPendingReviewDeliveryIdentity,
  loadReviewDraft,
  putReviewBlob,
  reviewDraftKey,
  savePendingReviewDelivery,
  saveReviewDraft,
  saveReviewDraftAndDeleteBlobs,
  saveReviewDraftWithBlobChanges,
  sweepReviewOrphanBlobs,
} from "./review-store";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";

function storedImage(id = "stored-image", blobRef = "image-ref"): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef },
    metadata: {
      mimeType: "image/png",
      byteLength: 5,
      pixelWidth: 100,
      pixelHeight: 100,
      fileName: `${id}.png`,
      sha256: null,
      capturedAt: 1_000,
    },
  };
}

async function openReviewDatabase(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("codex-pad-reviews");
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function rewriteBlobCreatedAt(blobRef: string, createdAt: string): Promise<void> {
  const database = await openReviewDatabase();
  try {
    const transaction = database.transaction("blobs", "readwrite");
    const store = transaction.objectStore("blobs");
    const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get(blobRef);
      request.addEventListener("success", () => resolve(request.result as Record<string, unknown>), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    store.put({ ...stored, createdAt });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
  } finally {
    database.close();
  }
}

async function putRawDraft(key: string, draft: unknown): Promise<void> {
  const database = await openReviewDatabase();
  try {
    const transaction = database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put({ key, draft });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
  } finally {
    database.close();
  }
}

async function rawDraft(key: string): Promise<unknown> {
  const database = await openReviewDatabase();
  try {
    const transaction = database.transaction("drafts", "readonly");
    return await new Promise((resolve, reject) => {
      const request = transaction.objectStore("drafts").get(key);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
  } finally {
    database.close();
  }
}

async function seedLegacyVoiceDatabase(): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("codex-pad-reviews", 5);
    request.addEventListener("upgradeneeded", () => {
      const next = request.result;
      next.createObjectStore("drafts", { keyPath: "key" });
      next.createObjectStore("blobs", { keyPath: "id" });
      next.createObjectStore("deliveries", { keyPath: "key" });
      next.createObjectStore("voiceRecordings", { keyPath: "blobRef" });
      next.createObjectStore("voiceChunks", { keyPath: "id" });
      next.createObjectStore("maintenance", { keyPath: "key" });
    }, { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  try {
    const transaction = database.transaction(
      ["drafts", "blobs", "voiceRecordings", "voiceChunks"],
      "readwrite",
    );
    const current = createReviewDraft({ id: "legacy-voice-review", targetThreadId: THREAD_ID, now: 1_000 });
    transaction.objectStore("drafts").put({
      key: reviewDraftKey(THREAD_ID),
      draft: {
        ...current,
        version: 2,
        voiceSegments: [{
          id: "legacy-segment",
          blobRef: "legacy-audio",
          mimeType: "audio/webm",
          durationMs: 1_000,
          timelineOrder: 0,
          startedAt: 1_000,
          anchors: [],
        }],
      },
    });
    transaction.objectStore("blobs").put({
      id: "legacy-audio",
      blob: new Blob(["legacy-audio"], { type: "audio/webm" }),
      createdAt: new Date(1_000).toISOString(),
    });
    transaction.objectStore("blobs").put({
      id: "legacy-image",
      blob: new Blob(["legacy-image"], { type: "image/png" }),
      createdAt: new Date(1_000).toISOString(),
    });
    transaction.objectStore("voiceRecordings").put({
      blobRef: "legacy-audio",
      threadKey: reviewDraftKey(THREAD_ID),
    });
    transaction.objectStore("voiceChunks").put({
      id: "legacy-audio:000000",
      blobRef: "legacy-audio",
      blob: new Blob(["legacy-audio"], { type: "audio/webm" }),
    });
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
  } finally {
    database.close();
  }
}

async function seedEmptyLegacyVoiceDatabase(): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("codex-pad-reviews", 5);
    request.addEventListener("upgradeneeded", () => {
      const next = request.result;
      next.createObjectStore("drafts", { keyPath: "key" });
      next.createObjectStore("blobs", { keyPath: "id" });
      next.createObjectStore("deliveries", { keyPath: "key" });
      next.createObjectStore("voiceRecordings", { keyPath: "blobRef" });
      next.createObjectStore("voiceChunks", { keyPath: "id" });
      next.createObjectStore("maintenance", { keyPath: "key" });
    }, { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  database.close();
}

describe("review IndexedDB persistence", () => {
  const browserBlob = globalThis.Blob;

  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
    Object.defineProperty(globalThis, "Blob", { configurable: true, value: NodeBlob });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "Blob", { configurable: true, value: browserBlob });
  });

  it("keeps one exact-thread draft including distinct frames", async () => {
    let draft = createReviewDraft({ id: "review-persistence", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makeBlankReviewFrame(undefined, "frame-a"),
    }, 1_001);
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makeBlankReviewFrame(undefined, "frame-b"),
    }, 1_002);
    await saveReviewDraft(draft);

    await expect(loadReviewDraft(THREAD_ID.toUpperCase())).resolves.toMatchObject({
      targetThreadId: THREAD_ID,
      frames: [{ id: "frame-a" }, { id: "frame-b" }],
    });
    expect(reviewDraftKey(` ${THREAD_ID.toUpperCase()} `)).toBe(`thread:${THREAD_ID}`);

    await deleteReviewDraft(THREAD_ID);
    await expect(loadReviewDraft(THREAD_ID)).resolves.toBeNull();
  });

  it("round-trips image Blobs without placing bytes in draft JSON", async () => {
    const media = new Blob(["image-bytes"], { type: "image/png" });
    await putReviewBlob("image-ref", media);
    const loaded = await getReviewBlob("image-ref");
    expect(loaded?.type).toBe("image/png");
    await expect(loaded?.text()).resolves.toBe("image-bytes");
  });

  it("fails visibly when local persistence is unavailable", async () => {
    Reflect.deleteProperty(globalThis, "indexedDB");
    const draft = createReviewDraft({ id: "review-offline", targetThreadId: THREAD_ID, now: 1_000 });
    await expect(saveReviewDraft(draft)).rejects.toThrow("IndexedDB is unavailable");
    await expect(putReviewBlob("missing-db", new Blob(["x"], { type: "image/png" })))
      .rejects.toThrow("IndexedDB is unavailable");
  });

  it("rejects audio and arbitrary Blob writes from both persistence paths", async () => {
    await expect(putReviewBlob("audio-ref", new Blob(["audio"], { type: "audio/webm" })))
      .rejects.toThrow(/PNG, JPEG, or WebP/);
    await expect(putReviewBlob("text-ref", new Blob(["text"], { type: "text/plain" })))
      .rejects.toThrow(/PNG, JPEG, or WebP/);

    let draft = createReviewDraft({ id: "review-image-only", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("audio-shaped-image", "audio-ref"), undefined, "image-frame"),
    }, 1_001);
    await expect(saveReviewDraftWithBlobChanges(draft, [{
      id: "audio-ref",
      blob: new Blob(["audio"], { type: "audio/webm" }),
    }])).rejects.toThrow(/PNG, JPEG, or WebP/);
    await expect(getReviewBlob("audio-ref")).resolves.toBeNull();
  });

  it("upgrades legacy voice storage to an image-only database", async () => {
    await seedLegacyVoiceDatabase();

    const loaded = await loadReviewDraft(THREAD_ID);
    expect(loaded).toMatchObject({ id: "legacy-voice-review", frames: [] });
    expect(loaded).not.toHaveProperty("voiceSegments");
    await expect(getReviewBlob("legacy-audio")).resolves.toBeNull();
    await expect(getReviewBlob("legacy-image")).resolves.toHaveProperty("type", "image/png");

    const database = await openReviewDatabase();
    try {
      expect([...database.objectStoreNames]).not.toContain("voiceRecordings");
      expect([...database.objectStoreNames]).not.toContain("voiceChunks");
    } finally {
      database.close();
    }
    const stored = await rawDraft(reviewDraftKey(THREAD_ID)) as { draft: Record<string, unknown> };
    expect(stored.draft).not.toHaveProperty("voiceSegments");
  });

  it("runs the version 6 legacy purge at boot with no selected slot or stored draft", async () => {
    await seedEmptyLegacyVoiceDatabase();

    await initializeReviewStore();
    await initializeReviewStore();

    const database = await openReviewDatabase();
    try {
      expect(database.version).toBe(6);
      expect([...database.objectStoreNames]).not.toContain("voiceRecordings");
      expect([...database.objectStoreNames]).not.toContain("voiceChunks");
      const transaction = database.transaction("drafts", "readonly");
      const count = await new Promise<number>((resolve, reject) => {
        const request = transaction.objectStore("drafts").count();
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      expect(count).toBe(0);
    } finally {
      database.close();
    }
  });

  it("commits frame deletion and image Blob cleanup in one transaction", async () => {
    let draft = createReviewDraft({ id: "review-cleanup", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage(), undefined, "photo-frame"),
    }, 1_001);
    await putReviewBlob("image-ref", new Blob(["image"], { type: "image/png" }));
    await saveReviewDraft(draft);

    const next = reviewDraftReducer(draft, { type: "deleteFrame", frameId: "photo-frame" }, 1_002);
    await saveReviewDraftAndDeleteBlobs(next, ["image-ref"]);
    await expect(getReviewBlob("image-ref")).resolves.toBeNull();
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ frames: [] });
  });

  it("commits new media with its exact draft and rejects unreferenced writes", async () => {
    let draft = createReviewDraft({ id: "review-atomic-media", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("atomic-image", "atomic-ref"), undefined, "atomic-frame"),
    }, 1_001);
    const blob = new Blob(["atomic"], { type: "image/png" });

    await saveReviewDraftWithBlobChanges(draft, [{ id: "atomic-ref", blob }]);

    await expect(getReviewBlob("atomic-ref")).resolves.toHaveProperty("size", blob.size);
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ frames: [{ id: "atomic-frame" }] });
    await expect(saveReviewDraftWithBlobChanges(draft, [{ id: "orphan-ref", blob }]))
      .rejects.toThrow(/not referenced/);
    await expect(getReviewBlob("orphan-ref")).resolves.toBeNull();
  });

  it("reclaims rendered annotations across repeated edit and preview cycles", async () => {
    const scene = createScene({ width: 100, height: 100, background: "transparent" });
    let draft = createReviewDraft({ id: "review-render-cycle", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: {
        ...makeBlankReviewFrame(undefined, "drawn-frame"),
        drawing: { kind: "scene", scene, renderedImage: storedImage("render-old", "render-old-ref") },
      },
    }, 1_001);
    await putReviewBlob("render-old-ref", new Blob(["old"], { type: "image/png" }));
    await saveReviewDraft(draft);

    const edited = reviewDraftReducer(draft, {
      type: "updateFrame",
      frameId: "drawn-frame",
      patch: { drawing: { kind: "scene", scene } },
    }, 1_002);
    await saveReviewDraftAndDeleteBlobs(edited, ["render-old-ref"]);
    await expect(getReviewBlob("render-old-ref")).resolves.toBeNull();

    const previewed = reviewDraftReducer(edited, {
      type: "updateFrame",
      frameId: "drawn-frame",
      patch: { drawing: { kind: "scene", scene, renderedImage: storedImage("render-new", "render-new-ref") } },
    }, 1_003);
    await saveReviewDraftWithBlobChanges(
      previewed,
      [{ id: "render-new-ref", blob: new Blob(["new"], { type: "image/png" }) }],
    );
    await expect(getReviewBlob("render-new-ref")).resolves.not.toBeNull();

    const editedAgain = reviewDraftReducer(previewed, {
      type: "updateFrame",
      frameId: "drawn-frame",
      patch: { drawing: { kind: "scene", scene } },
    }, 1_004);
    await saveReviewDraftAndDeleteBlobs(editedAgain, ["render-new-ref"]);
    await expect(getReviewBlob("render-new-ref")).resolves.toBeNull();
  });

  it("never deletes a Blob still referenced by another exact-thread draft", async () => {
    const sharedBlob = new Blob(["shared"], { type: "image/png" });
    await putReviewBlob("shared-ref", sharedBlob);
    let first = createReviewDraft({ id: "review-first", targetThreadId: THREAD_ID, now: 1_000 });
    first = reviewDraftReducer(first, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("shared-first", "shared-ref"), undefined, "first-frame"),
    }, 1_001);
    let second = createReviewDraft({ id: "review-second", targetThreadId: OTHER_THREAD_ID, now: 1_000 });
    second = reviewDraftReducer(second, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("shared-second", "shared-ref"), undefined, "second-frame"),
    }, 1_001);
    await saveReviewDraft(first);
    await saveReviewDraft(second);

    const withoutShared = reviewDraftReducer(first, { type: "deleteFrame", frameId: "first-frame" }, 1_002);
    await saveReviewDraftAndDeleteBlobs(withoutShared, ["shared-ref"]);
    await expect(getReviewBlob("shared-ref")).resolves.not.toBeNull();

    await deleteReviewDraft(OTHER_THREAD_ID);
    await expect(getReviewBlob("shared-ref")).resolves.toBeNull();
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ frames: [] });
  });

  it("sweeps old orphans with a bounded cursor while preserving referenced media", async () => {
    await putReviewBlob("a-live", new Blob(["live"], { type: "image/png" }));
    await putReviewBlob("b-orphan", new Blob(["orphan-b"], { type: "image/png" }));
    await putReviewBlob("c-orphan", new Blob(["orphan-c"], { type: "image/png" }));
    let draft = createReviewDraft({ id: "review-gc", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("live-image", "a-live"), undefined, "live-frame"),
    }, 1_001);
    await saveReviewDraft(draft);
    const old = new Date(1_000).toISOString();
    await rewriteBlobCreatedAt("a-live", old);
    await rewriteBlobCreatedAt("b-orphan", old);
    await rewriteBlobCreatedAt("c-orphan", old);

    await expect(sweepReviewOrphanBlobs({ now: 10_000, graceMs: 0, scanLimit: 2, deleteLimit: 1 }))
      .resolves.toEqual({ scanned: 2, deleted: 1, blocked: false, cursor: "b-orphan" });
    await expect(getReviewBlob("a-live")).resolves.not.toBeNull();
    await expect(getReviewBlob("b-orphan")).resolves.toBeNull();
    await expect(getReviewBlob("c-orphan")).resolves.not.toBeNull();

    await expect(sweepReviewOrphanBlobs({ now: 10_000, graceMs: 0, scanLimit: 2, deleteLimit: 1 }))
      .resolves.toEqual({ scanned: 1, deleted: 1, blocked: false, cursor: null });
    await expect(getReviewBlob("a-live")).resolves.not.toBeNull();
    await expect(getReviewBlob("c-orphan")).resolves.toBeNull();
  });

  it("rejects credentialed site drafts before storage and drops an invalid persisted record", async () => {
    const invalidFrame = makeSiteReviewFrame({
      id: "credential-frame",
      url: "https://user:secret@preview.example.test/dashboard",
    });
    const invalid = {
      ...createReviewDraft({ id: "review-credentials", targetThreadId: OTHER_THREAD_ID, now: 1_000 }),
      frames: [invalidFrame],
    } as ReturnType<typeof createReviewDraft>;
    await saveReviewDraft(createReviewDraft({ id: "database-init", targetThreadId: THREAD_ID, now: 1_000 }));

    await expect(saveReviewDraft(invalid)).rejects.toThrow(/embedded credentials/);
    await expect(rawDraft(reviewDraftKey(OTHER_THREAD_ID))).resolves.toBeUndefined();

    await putRawDraft(reviewDraftKey(OTHER_THREAD_ID), invalid);
    await expect(loadReviewDraft(OTHER_THREAD_ID)).resolves.toBeNull();
    await expect(rawDraft(reviewDraftKey(OTHER_THREAD_ID))).resolves.toBeUndefined();
  });

  it("persists one pending command identity for an unchanged draft", async () => {
    const commandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb1";
    await savePendingReviewDelivery(THREAD_ID, 1_234, commandId);
    await expect(loadPendingReviewDelivery(THREAD_ID, 1_234)).resolves.toBe(commandId);
    await expect(loadPendingReviewDelivery(THREAD_ID, 1_235)).resolves.toBeNull();
    await expect(clearPendingReviewDelivery(THREAD_ID, 1_234, commandId)).resolves.toBe(true);
    await expect(loadPendingReviewDelivery(THREAD_ID, 1_234)).resolves.toBeNull();
  });

  it("retains the exact bridge authority needed for a byte-identical retry after reload", async () => {
    const commandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb4";
    const authority = {
      expectedBridgeInstanceId: "019f7ec2-68eb-7183-bb3a-0e67312a8bc1",
      targetThreadKey: `thread:${THREAD_ID}`,
      snapshotSeq: 73,
      instructionSuffix: "\n\nUse the following skills for this task: website-qa.",
      skillIds: ["website-qa"],
    };
    await savePendingReviewDelivery(THREAD_ID, 1_240, commandId, authority);

    await expect(loadPendingReviewDeliveryIdentity(THREAD_ID, 1_240)).resolves.toEqual({
      commandId,
      ...authority,
    });
    await expect(loadPendingReviewDeliveryIdentity(THREAD_ID, 1_241)).resolves.toBeNull();
  });

  it("never lets an old acknowledgement clear a newer tab's pending delivery", async () => {
    const oldCommandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb1";
    const newerCommandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb2";
    await savePendingReviewDelivery(THREAD_ID, 1_234, oldCommandId);
    await savePendingReviewDelivery(THREAD_ID, 1_235, newerCommandId);

    await expect(clearPendingReviewDelivery(THREAD_ID, 1_234, oldCommandId)).resolves.toBe(false);
    await expect(loadPendingReviewDelivery(THREAD_ID, 1_235)).resolves.toBe(newerCommandId);
    await expect(clearPendingReviewDelivery(THREAD_ID, 1_235, oldCommandId)).resolves.toBe(false);
    await expect(loadPendingReviewDelivery(THREAD_ID, 1_235)).resolves.toBe(newerCommandId);
    await expect(clearPendingReviewDelivery(THREAD_ID, 1_235, newerCommandId)).resolves.toBe(true);
    await expect(loadPendingReviewDelivery(THREAD_ID, 1_235)).resolves.toBeNull();
  });

  it("clears an explicit local review, its iterations, unshared media, and pending delivery atomically", async () => {
    const commandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb1";
    let draft = createReviewDraft({ id: "review-explicit-clear", targetThreadId: THREAD_ID, now: 2_000 });
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("before-image", "before-ref"), undefined, "before-frame"),
    }, 2_001);
    draft = reviewDraftReducer(draft, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("iteration-image", "iteration-ref"), undefined, "iteration-frame"),
    }, 2_002);
    await putReviewBlob("before-ref", new Blob(["before"], { type: "image/png" }));
    await putReviewBlob("iteration-ref", new Blob(["iteration"], { type: "image/png" }));
    await saveReviewDraft(draft);
    await savePendingReviewDelivery(THREAD_ID, draft.updatedAt, commandId);

    await expect(deleteReviewDraftIfUnchanged({ draft, commandId })).resolves.toBe(true);

    await expect(loadReviewDraft(THREAD_ID)).resolves.toBeNull();
    await expect(getReviewBlob("before-ref")).resolves.toBeNull();
    await expect(getReviewBlob("iteration-ref")).resolves.toBeNull();
    await expect(loadPendingReviewDelivery(THREAD_ID, draft.updatedAt)).resolves.toBeNull();
  });

  it("refuses a stale tab's clear when another tab has replaced the draft and delivery", async () => {
    const oldCommandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb1";
    const newerCommandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb2";
    let original = createReviewDraft({ id: "review-clear-race", targetThreadId: THREAD_ID, now: 3_000 });
    original = reviewDraftReducer(original, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("old-image", "old-ref"), undefined, "old-frame"),
    }, 3_001);
    await putReviewBlob("old-ref", new Blob(["old"], { type: "image/png" }));
    await saveReviewDraft(original);
    await savePendingReviewDelivery(THREAD_ID, original.updatedAt, oldCommandId);

    let newer = reviewDraftReducer(original, {
      type: "addFrame",
      frame: makePhotoReviewFrame(storedImage("new-image", "new-ref"), undefined, "new-frame"),
    }, original.updatedAt + 1);
    await putReviewBlob("new-ref", new Blob(["new"], { type: "image/png" }));
    await saveReviewDraft(newer);
    await savePendingReviewDelivery(THREAD_ID, newer.updatedAt, newerCommandId);

    await expect(deleteReviewDraftIfUnchanged({ draft: original, commandId: oldCommandId })).resolves.toBe(false);
    await expect(loadReviewDraft(THREAD_ID)).resolves.toEqual(newer);
    await expect(getReviewBlob("old-ref")).resolves.not.toBeNull();
    await expect(getReviewBlob("new-ref")).resolves.not.toBeNull();
    await expect(loadPendingReviewDelivery(THREAD_ID, newer.updatedAt)).resolves.toBe(newerCommandId);

    // Even an identical draft cannot be cleared by an old panel while a newer
    // command tuple owns its delivery marker.
    await saveReviewDraft(original);
    await savePendingReviewDelivery(THREAD_ID, original.updatedAt, newerCommandId);
    await expect(deleteReviewDraftIfUnchanged({ draft: original, commandId: oldCommandId })).resolves.toBe(false);
    await expect(loadReviewDraft(THREAD_ID)).resolves.toEqual(original);
    await expect(getReviewBlob("old-ref")).resolves.not.toBeNull();
    await expect(loadPendingReviewDelivery(THREAD_ID, original.updatedAt)).resolves.toBe(newerCommandId);

    // A same-revision conflicting record is also rejected by the normalized
    // full-draft comparison rather than trusting updatedAt alone.
    const conflicting = { ...original, generalInstruction: "Changed in a second tab" };
    await saveReviewDraft(conflicting);
    await savePendingReviewDelivery(THREAD_ID, original.updatedAt, oldCommandId);
    await expect(deleteReviewDraftIfUnchanged({ draft: original, commandId: oldCommandId })).resolves.toBe(false);
    await expect(loadReviewDraft(THREAD_ID)).resolves.toEqual(conflicting);
    await expect(getReviewBlob("old-ref")).resolves.not.toBeNull();
  });

});

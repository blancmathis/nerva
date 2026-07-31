import {
  ReviewDraftSchema,
  migrateReviewDraft,
  type ReviewDraft,
} from "@codex-pad/review";

const DATABASE_NAME = "codex-pad-reviews";
const DATABASE_VERSION = 6;
const DRAFT_STORE = "drafts";
const BLOB_STORE = "blobs";
const DELIVERY_STORE = "deliveries";
const VOICE_RECORDING_STORE = "voiceRecordings";
const VOICE_CHUNK_STORE = "voiceChunks";
const MAINTENANCE_STORE = "maintenance";
const ORPHAN_SWEEP_KEY = "orphan-blob-sweep";

const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ORPHAN_SCAN_LIMIT = 64;
const DEFAULT_ORPHAN_DELETE_LIMIT = 16;
const MAX_ORPHAN_SCAN_LIMIT = 256;
const MAX_ORPHAN_DELETE_LIMIT = 64;
const MAX_ORPHAN_DRAFTS = 128;

export const MAX_REVIEW_BLOB_BYTES = 32 * 1024 * 1024;
const SUPPORTED_REVIEW_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface StoredReviewDraft {
  readonly key: string;
  readonly draft: unknown;
}

interface StoredReviewBlob {
  readonly id: string;
  /** Legacy v6 representation retained for in-place compatibility. */
  readonly blob?: Blob;
  /** Current representation avoids WebKit's unreliable Blob-to-IDB clone path. */
  readonly bytes?: ArrayBuffer;
  readonly mimeType?: string;
  readonly createdAt: string;
}

interface StoredPendingDelivery {
  readonly key: string;
  readonly commandId: string;
  readonly draftUpdatedAt: number;
  readonly expectedBridgeInstanceId?: string;
  readonly targetThreadKey?: string;
  readonly snapshotSeq?: number;
  readonly instructionSuffix?: string;
  readonly skillIds?: readonly string[];
  readonly createdAt: string;
}

export interface PendingReviewDeliveryIdentity {
  readonly commandId: string;
  readonly expectedBridgeInstanceId: string;
  readonly targetThreadKey: string;
  readonly snapshotSeq: number;
  readonly instructionSuffix: string;
  readonly skillIds: readonly string[];
}

interface StoredMaintenanceState {
  readonly key: string;
  readonly cursor: string | null;
  readonly updatedAt: string;
}

export interface ReviewBlobWrite {
  readonly id: string;
  readonly blob: Blob;
}

export interface ReviewBlobSweepOptions {
  readonly now?: number;
  readonly graceMs?: number;
  readonly scanLimit?: number;
  readonly deleteLimit?: number;
}

export interface ReviewBlobSweepResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly blocked: boolean;
  readonly cursor: string | null;
}

export interface ReviewDraftDeletionExpectation {
  readonly draft: ReviewDraft;
  readonly commandId: string;
}

function normalizeThreadId(threadId: string): string {
  const normalized = threadId.trim().toLowerCase();
  if (!normalized) throw new Error("A thread ID is required for a review draft.");
  return normalized;
}

export function reviewDraftKey(threadId: string): string {
  return `thread:${normalizeThreadId(threadId)}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("The IndexedDB transaction failed."));
    }, { once: true });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("The IndexedDB transaction was aborted."));
    }, { once: true });
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have completed or aborted.
  }
}

function isSupportedReviewImageBlob(value: unknown): value is Blob {
  return value instanceof Blob && SUPPORTED_REVIEW_IMAGE_MIME_TYPES.has(value.type.toLowerCase());
}

function storedReviewImageBlob(value: Partial<StoredReviewBlob> | null | undefined): Blob | null {
  if (isSupportedReviewImageBlob(value?.blob) && value.blob.size > 0) return value.blob;
  const bytes = value?.bytes;
  const isArrayBuffer = bytes instanceof ArrayBuffer
    || Object.prototype.toString.call(bytes) === "[object ArrayBuffer]";
  if (
    isArrayBuffer
    && bytes
    && bytes.byteLength > 0
    && typeof value.mimeType === "string"
    && SUPPORTED_REVIEW_IMAGE_MIME_TYPES.has(value.mimeType.toLowerCase())
  ) {
    return new Blob([bytes], { type: value.mimeType.toLowerCase() });
  }
  return null;
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  if (typeof FileReader !== "undefined") {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (reader.result instanceof ArrayBuffer) resolve(reader.result);
        else reject(new Error("Review media could not be read as bytes."));
      }, { once: true });
      reader.addEventListener("error", () => reject(reader.error ?? new Error("Review media could not be read.")), { once: true });
      reader.readAsArrayBuffer(blob);
    });
  }
  throw new Error("Review media byte access is unavailable.");
}

async function storedReviewBlob(id: string, blob: Blob, createdAt = new Date().toISOString()): Promise<StoredReviewBlob> {
  return {
    id,
    bytes: await readBlobBytes(blob),
    mimeType: blob.type.toLowerCase(),
    createdAt,
  };
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(DRAFT_STORE)) {
      database.createObjectStore(DRAFT_STORE, { keyPath: "key" });
    }
    if (!database.objectStoreNames.contains(BLOB_STORE)) {
      database.createObjectStore(BLOB_STORE, { keyPath: "id" });
    }
    if (!database.objectStoreNames.contains(DELIVERY_STORE)) {
      database.createObjectStore(DELIVERY_STORE, { keyPath: "key" });
    }
    // Versions 3-5 briefly persisted PWA microphone recordings. Version 6
    // removes that runtime surface and purges every durable audio artifact.
    if (database.objectStoreNames.contains(VOICE_RECORDING_STORE)) {
      database.deleteObjectStore(VOICE_RECORDING_STORE);
    }
    if (database.objectStoreNames.contains(VOICE_CHUNK_STORE)) {
      database.deleteObjectStore(VOICE_CHUNK_STORE);
    }
    if (!database.objectStoreNames.contains(MAINTENANCE_STORE)) {
      database.createObjectStore(MAINTENANCE_STORE, { keyPath: "key" });
    }

    const upgrade = request.transaction;
    if (!upgrade) return;

    const draftCursor = upgrade.objectStore(DRAFT_STORE).openCursor();
    draftCursor.addEventListener("success", () => {
      const cursor = draftCursor.result;
      if (!cursor) return;
      const stored = cursor.value as Partial<StoredReviewDraft> | null;
      try {
        if (typeof stored?.key !== "string") throw new Error("Invalid review draft key.");
        const draft = migrateReviewDraft(stored.draft);
        if (reviewDraftKey(draft.targetThreadId) !== stored.key) {
          throw new Error("Review draft key does not match its exact thread.");
        }
        cursor.update({ key: stored.key, draft } satisfies StoredReviewDraft);
      } catch {
        cursor.delete();
      }
      cursor.continue();
    });

    const blobCursor = upgrade.objectStore(BLOB_STORE).openCursor();
    blobCursor.addEventListener("success", () => {
      const cursor = blobCursor.result;
      if (!cursor) return;
      const stored = cursor.value as Partial<StoredReviewBlob> | null;
      if (
        typeof stored?.id !== "string"
        || stored.id.trim().length === 0
        || !storedReviewImageBlob(stored)
      ) {
        cursor.delete();
      }
      cursor.continue();
    });
  });
  return requestResult(request);
}

/**
 * Opens and closes the review database so schema migrations and legacy-media
 * purges run at application boot, even before a task is selected.
 */
export async function initializeReviewStore(): Promise<void> {
  const database = await openDatabase();
  database?.close();
}

async function runStore<T>(
  storeName:
    | typeof DRAFT_STORE
    | typeof BLOB_STORE
    | typeof DELIVERY_STORE
    | typeof MAINTENANCE_STORE,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(storeName, mode);
    const result = await requestResult(operation(transaction.objectStore(storeName)));
    await transactionComplete(transaction);
    return result;
  } finally {
    database.close();
  }
}

function normalizeMediaRef(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > 512) throw new Error(`${label} is too long.`);
  return normalized;
}

interface ReferenceCollectionOptions {
  readonly replacement?: ReviewDraft;
  readonly excludeDraftKey?: string;
  readonly draftLimit?: number;
}

/** Return null when any stored record is ambiguous so cleanup fails closed. */
async function collectReferencedBlobRefs(
  transaction: IDBTransaction,
  options: ReferenceCollectionOptions = {},
): Promise<Set<string> | null> {
  const draftStore = transaction.objectStore(DRAFT_STORE);
  const storedDrafts = await requestResult<StoredReviewDraft[]>(
    options.draftLimit === undefined
      ? draftStore.getAll()
      : draftStore.getAll(undefined, options.draftLimit + 1),
  );
  if (options.draftLimit !== undefined && storedDrafts.length > options.draftLimit) return null;

  const refs = new Set<string>();
  const replacementKey = options.replacement
    ? reviewDraftKey(options.replacement.targetThreadId)
    : null;
  let replacementRegistered = false;
  for (const stored of storedDrafts) {
    if (stored.key === options.excludeDraftKey) continue;
    let draft: ReviewDraft;
    if (options.replacement && stored.key === replacementKey) {
      draft = options.replacement;
      replacementRegistered = true;
    } else {
      try {
        draft = migrateReviewDraft(stored.draft);
      } catch {
        return null;
      }
    }
    if (reviewDraftKey(draft.targetThreadId) !== stored.key) return null;
    reviewDraftBlobRefs(draft).forEach((ref) => refs.add(ref));
  }
  if (options.replacement && !replacementRegistered && replacementKey !== options.excludeDraftKey) {
    reviewDraftBlobRefs(options.replacement).forEach((ref) => refs.add(ref));
  }

  return refs;
}

function normalizeBlobWrite(write: ReviewBlobWrite): ReviewBlobWrite {
  const id = normalizeMediaRef(write.id, "A blob reference");
  if (!isSupportedReviewImageBlob(write.blob) || write.blob.size === 0) {
    throw new Error("Review media must be a non-empty PNG, JPEG, or WebP image.");
  }
  if (write.blob.size > MAX_REVIEW_BLOB_BYTES) {
    throw new Error("A single local review media item cannot exceed 32 MiB.");
  }
  return { id, blob: write.blob };
}

async function queueUnreferencedMediaDeletion(
  transaction: IDBTransaction,
  blobRefs: readonly string[],
  options: ReferenceCollectionOptions = {},
): Promise<readonly string[]> {
  const candidates = [...new Set(blobRefs.map((ref) => ref.trim()).filter(Boolean))];
  if (candidates.length === 0) return [];
  const retained = await collectReferencedBlobRefs(transaction, options);
  if (!retained) return [];
  const garbage = candidates.filter((ref) => !retained.has(ref));
  const blobs = transaction.objectStore(BLOB_STORE);
  garbage.forEach((ref) => blobs.delete(ref));
  return garbage;
}

/** Load only a valid draft for the exact requested thread. Invalid or stale records fail closed. */
export async function loadReviewDraft(threadId: string): Promise<ReviewDraft | null> {
  const key = reviewDraftKey(threadId);
  const stored = await runStore<StoredReviewDraft>(DRAFT_STORE, "readonly", (store) =>
    store.get(key),
  );
  if (!stored) return null;
  let draft: ReviewDraft;
  try {
    draft = migrateReviewDraft(stored.draft);
  } catch {
    await runStore<undefined>(DRAFT_STORE, "readwrite", (store) => store.delete(key));
    return null;
  }
  if (draft.targetThreadId.toLowerCase() !== normalizeThreadId(threadId)) {
    await runStore<undefined>(DRAFT_STORE, "readwrite", (store) => store.delete(key));
    return null;
  }
  return draft;
}

export async function saveReviewDraft(draft: ReviewDraft): Promise<void> {
  const parsed = ReviewDraftSchema.parse(draft);
  const result = await runStore<IDBValidKey>(DRAFT_STORE, "readwrite", (store) =>
    store.put({ key: reviewDraftKey(parsed.targetThreadId), draft: parsed } satisfies StoredReviewDraft),
  );
  if (result === null) throw new Error("The review draft was not saved because IndexedDB is unavailable.");
}

function imageBlobRef(image: ReviewDraft["frames"][number]["capturedImage"]): string | null {
  return image?.source.kind === "blobRef" ? image.source.blobRef : null;
}

export function reviewFrameBlobRefs(frame: ReviewDraft["frames"][number]): readonly string[] {
  const refs = new Set<string>();
  const register = (ref: string | null | undefined) => { if (ref) refs.add(ref); };
  register(imageBlobRef(frame.capturedImage));
  frame.photos.forEach((image) => register(imageBlobRef(image)));
  register(imageBlobRef(frame.comparison.before?.image ?? null));
  register(imageBlobRef(frame.comparison.after?.image ?? null));
  register(imageBlobRef(frame.drawing?.renderedImage ?? null));
  if (frame.drawing?.kind === "scene") {
    for (const element of frame.drawing.scene.elements) {
      if (element.kind === "image" && element.source.kind === "blobRef") register(element.source.blobId);
    }
  }
  return [...refs];
}

export function reviewDraftBlobRefs(draft: ReviewDraft): readonly string[] {
  return [...new Set(draft.frames.flatMap((frame) => reviewFrameBlobRefs(frame)))];
}

/**
 * Commit a draft, every newly referenced Blob, and safe reference removal in one
 * transaction. New writes must already be referenced by this exact draft.
 */
export async function saveReviewDraftWithBlobChanges(
  draft: ReviewDraft,
  blobWrites: readonly ReviewBlobWrite[] = [],
  deleteBlobRefs: readonly string[] = [],
): Promise<void> {
  const parsed = ReviewDraftSchema.parse(draft);
  const writes = blobWrites.map(normalizeBlobWrite);
  const nextRefs = new Set(reviewDraftBlobRefs(parsed));
  const writeIds = new Set<string>();
  for (const write of writes) {
    if (writeIds.has(write.id)) throw new Error(`Review media ${write.id} was prepared more than once.`);
    if (!nextRefs.has(write.id)) {
      throw new Error(`Review media ${write.id} is not referenced by the draft being saved.`);
    }
    writeIds.add(write.id);
  }
  const createdAt = new Date().toISOString();
  const storedWrites = await Promise.all(
    writes.map((write) => storedReviewBlob(write.id, write.blob, createdAt)),
  );
  const database = await openDatabase();
  if (!database) throw new Error("The review draft was not saved because IndexedDB is unavailable.");
  const transaction = database.transaction(
    [DRAFT_STORE, BLOB_STORE],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  try {
    const drafts = transaction.objectStore(DRAFT_STORE);
    const blobs = transaction.objectStore(BLOB_STORE);
    drafts.put({
      key: reviewDraftKey(parsed.targetThreadId),
      draft: parsed,
    } satisfies StoredReviewDraft);
    for (const write of storedWrites) {
      blobs.add(write);
    }
    await queueUnreferencedMediaDeletion(transaction, deleteBlobRefs, { replacement: parsed });
    await completion;
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }
}

/** Commit reference removal and draft update in one IndexedDB transaction. */
export async function saveReviewDraftAndDeleteBlobs(
  draft: ReviewDraft,
  blobRefs: readonly string[],
): Promise<void> {
  await saveReviewDraftWithBlobChanges(draft, [], blobRefs);
}

export async function deleteReviewDraft(threadId: string): Promise<void> {
  const draft = await loadReviewDraft(threadId);
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(
    [DRAFT_STORE, BLOB_STORE, DELIVERY_STORE],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  try {
    const threadKey = reviewDraftKey(threadId);
    transaction.objectStore(DRAFT_STORE).delete(threadKey);
    transaction.objectStore(DELIVERY_STORE).delete(threadKey);
    await queueUnreferencedMediaDeletion(transaction, draft ? reviewDraftBlobRefs(draft) : [], {
      excludeDraftKey: threadKey,
    });
    await completion;
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }
}

function exactReviewDraftMatch(current: ReviewDraft, expected: ReviewDraft): boolean {
  return current.id === expected.id
    && current.targetThreadId === expected.targetThreadId
    && current.updatedAt === expected.updatedAt
    && JSON.stringify(current) === JSON.stringify(expected);
}

/**
 * Delete only the exact review represented by a confirmed send panel. The draft
 * and delivery marker are read and compared inside the same transaction as the
 * deletion, so another tab cannot replace either record between the guard and
 * the purge.
 */
export async function deleteReviewDraftIfUnchanged(
  expectation: ReviewDraftDeletionExpectation,
): Promise<boolean> {
  const expected = ReviewDraftSchema.parse(expectation.draft);
  const commandId = normalizeMediaRef(expectation.commandId, "A command ID");
  const threadKey = reviewDraftKey(expected.targetThreadId);
  const database = await openDatabase();
  if (!database) return false;
  const transaction = database.transaction(
    [DRAFT_STORE, BLOB_STORE, DELIVERY_STORE],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  try {
    const drafts = transaction.objectStore(DRAFT_STORE);
    const deliveries = transaction.objectStore(DELIVERY_STORE);
    const [storedDraft, storedDelivery] = await Promise.all([
      requestResult<StoredReviewDraft | undefined>(drafts.get(threadKey)),
      requestResult<StoredPendingDelivery | undefined>(deliveries.get(threadKey)),
    ]);
    let current: ReviewDraft;
    try {
      if (!storedDraft || storedDraft.key !== threadKey) {
        await completion;
        return false;
      }
      current = migrateReviewDraft(storedDraft.draft);
    } catch {
      await completion;
      return false;
    }
    if (!exactReviewDraftMatch(current, expected)) {
      await completion;
      return false;
    }
    if (
      storedDelivery !== undefined
      && (
        storedDelivery.key !== threadKey
        || storedDelivery.draftUpdatedAt !== expected.updatedAt
        || storedDelivery.commandId !== commandId
      )
    ) {
      await completion;
      return false;
    }

    drafts.delete(threadKey);
    deliveries.delete(threadKey);
    await queueUnreferencedMediaDeletion(transaction, reviewDraftBlobRefs(current), {
      excludeDraftKey: threadKey,
    });
    await completion;
    return true;
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }
}

export async function putReviewBlob(id: string, blob: Blob): Promise<void> {
  const normalized = id.trim();
  if (!normalized) throw new Error("A blob reference is required.");
  if (!isSupportedReviewImageBlob(blob) || blob.size === 0) {
    throw new Error("Review media must be a non-empty PNG, JPEG, or WebP image.");
  }
  if (blob.size > MAX_REVIEW_BLOB_BYTES) {
    throw new Error("A single local review media item cannot exceed 32 MiB.");
  }
  const stored = await storedReviewBlob(normalized, blob);
  const result = await runStore<IDBValidKey>(BLOB_STORE, "readwrite", (store) =>
    store.put(stored),
  );
  if (result === null) throw new Error("The review media was not saved because IndexedDB is unavailable.");
}

export async function getReviewBlob(id: string): Promise<Blob | null> {
  const stored = await runStore<StoredReviewBlob>(BLOB_STORE, "readonly", (store) =>
    store.get(id),
  );
  return storedReviewImageBlob(stored);
}

export async function deleteUnreferencedReviewBlobs(blobRefs: readonly string[]): Promise<number> {
  const database = await openDatabase();
  if (!database) return 0;
  const transaction = database.transaction(
    [DRAFT_STORE, BLOB_STORE],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  try {
    const deleted = await queueUnreferencedMediaDeletion(transaction, blobRefs);
    await completion;
    return deleted.length;
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }
}

export async function deleteReviewBlob(id: string): Promise<void> {
  await deleteUnreferencedReviewBlobs([id]);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("A positive sweep limit is required.");
  return Math.min(value, maximum);
}

/**
 * Delete only old, globally unreferenced Blob records. Each pass scans and
 * removes a bounded number of records, then persists its cursor for the next
 * mount. Too many or invalid drafts block deletion rather than guessing.
 */
export async function sweepReviewOrphanBlobs(
  options: ReviewBlobSweepOptions = {},
): Promise<ReviewBlobSweepResult> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  if (!Number.isFinite(now) || now < 0 || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("The orphan sweep time bounds are invalid.");
  }
  const scanLimit = boundedInteger(options.scanLimit, DEFAULT_ORPHAN_SCAN_LIMIT, MAX_ORPHAN_SCAN_LIMIT);
  const deleteLimit = boundedInteger(options.deleteLimit, DEFAULT_ORPHAN_DELETE_LIMIT, MAX_ORPHAN_DELETE_LIMIT);
  const database = await openDatabase();
  if (!database) return { scanned: 0, deleted: 0, blocked: true, cursor: null };
  const transaction = database.transaction(
    [DRAFT_STORE, BLOB_STORE, MAINTENANCE_STORE],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  try {
    const maintenance = transaction.objectStore(MAINTENANCE_STORE);
    const previous = await requestResult<StoredMaintenanceState | undefined>(
      maintenance.get(ORPHAN_SWEEP_KEY),
    );
    const retained = await collectReferencedBlobRefs(transaction, {
      draftLimit: MAX_ORPHAN_DRAFTS,
    });
    if (!retained) {
      await completion;
      return { scanned: 0, deleted: 0, blocked: true, cursor: previous?.cursor ?? null };
    }

    const blobs = transaction.objectStore(BLOB_STORE);
    const startingCursor = typeof previous?.cursor === "string" && previous.cursor.length > 0
      ? previous.cursor
      : null;
    let scanned = 0;
    let deleted = 0;
    let nextCursor: string | null = startingCursor;
    await new Promise<void>((resolve, reject) => {
      const request = blobs.openCursor(
        startingCursor ? IDBKeyRange.lowerBound(startingCursor, true) : undefined,
      );
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) {
          nextCursor = null;
          maintenance.put({
            key: ORPHAN_SWEEP_KEY,
            cursor: null,
            updatedAt: new Date(now).toISOString(),
          } satisfies StoredMaintenanceState);
          resolve();
          return;
        }
        scanned += 1;
        const key = typeof cursor.key === "string" ? cursor.key : null;
        const stored = cursor.value as Partial<StoredReviewBlob> | null;
        const createdAt = typeof stored?.createdAt === "string" ? Date.parse(stored.createdAt) : Number.NaN;
        if (
          key
          && deleted < deleteLimit
          && Number.isFinite(createdAt)
          && createdAt <= now - graceMs
          && !retained.has(key)
        ) {
          cursor.delete();
          deleted += 1;
        }
        if (scanned >= scanLimit) {
          nextCursor = key;
          maintenance.put({
            key: ORPHAN_SWEEP_KEY,
            cursor: nextCursor,
            updatedAt: new Date(now).toISOString(),
          } satisfies StoredMaintenanceState);
          resolve();
          return;
        }
        cursor.continue();
      });
    });
    await completion;
    return { scanned, deleted, blocked: false, cursor: nextCursor };
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }
}

export async function loadPendingReviewDelivery(
  threadId: string,
  draftUpdatedAt: number,
): Promise<string | null> {
  const stored = await runStore<StoredPendingDelivery>(DELIVERY_STORE, "readonly", (store) =>
    store.get(reviewDraftKey(threadId)),
  );
  return stored?.draftUpdatedAt === draftUpdatedAt ? stored.commandId : null;
}

export async function loadPendingReviewDeliveryIdentity(
  threadId: string,
  draftUpdatedAt: number,
): Promise<PendingReviewDeliveryIdentity | null> {
  const stored = await runStore<StoredPendingDelivery>(DELIVERY_STORE, "readonly", (store) =>
    store.get(reviewDraftKey(threadId)),
  );
  if (
    stored?.draftUpdatedAt !== draftUpdatedAt
    || typeof stored.expectedBridgeInstanceId !== "string"
    || stored.expectedBridgeInstanceId.length === 0
    || typeof stored.targetThreadKey !== "string"
    || stored.targetThreadKey.length === 0
    || !Number.isSafeInteger(stored.snapshotSeq)
    || (stored.snapshotSeq ?? -1) < 0
    || typeof stored.instructionSuffix !== "string"
    || !Array.isArray(stored.skillIds)
    || stored.skillIds.some((skillId) => typeof skillId !== "string")
  ) return null;
  return {
    commandId: stored.commandId,
    expectedBridgeInstanceId: stored.expectedBridgeInstanceId,
    targetThreadKey: stored.targetThreadKey,
    snapshotSeq: stored.snapshotSeq!,
    instructionSuffix: stored.instructionSuffix,
    skillIds: stored.skillIds,
  };
}

export async function savePendingReviewDelivery(
  threadId: string,
  draftUpdatedAt: number,
  commandId: string,
  authority?: Omit<PendingReviewDeliveryIdentity, "commandId">,
): Promise<void> {
  const result = await runStore<IDBValidKey>(DELIVERY_STORE, "readwrite", (store) =>
    store.put({
      key: reviewDraftKey(threadId),
      commandId,
      draftUpdatedAt,
      ...(authority ?? {}),
      createdAt: new Date().toISOString(),
    } satisfies StoredPendingDelivery),
  );
  if (result === null) throw new Error("Pending delivery identity could not be saved.");
}

export async function clearPendingReviewDelivery(
  threadId: string,
  draftUpdatedAt: number,
  commandId: string,
): Promise<boolean> {
  const key = reviewDraftKey(threadId);
  const expectedCommandId = normalizeMediaRef(commandId, "A command ID");
  const database = await openDatabase();
  if (!database) return false;
  const transaction = database.transaction(DELIVERY_STORE, "readwrite");
  const completion = transactionComplete(transaction);
  try {
    const store = transaction.objectStore(DELIVERY_STORE);
    const stored = await requestResult<StoredPendingDelivery | undefined>(store.get(key));
    if (
      stored?.key !== key
      || stored.draftUpdatedAt !== draftUpdatedAt
      || stored.commandId !== expectedCommandId
    ) {
      await completion;
      return false;
    }
    store.delete(key);
    await completion;
    return true;
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }
}

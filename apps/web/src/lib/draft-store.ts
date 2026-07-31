const DATABASE_NAME = "codex-pad-drawings";
const STORE_NAME = "drafts";
const BOARD_STORE_NAME = "boards";
const BOARD_ELEMENT_STORE_NAME = "board-elements";
const ACTIVE_BOARD_STORE_NAME = "active-boards";
const PENDING_BOARD_EXPORT_STORE_NAME = "pending-board-exports";
const DATABASE_VERSION = 3;
const DRAFT_VERSION = 1;
const BOARD_VERSION = 2;

export type DrawingBackground = "transparent" | "white" | "dark";

export interface StoredDrawingDraft {
  version: typeof DRAFT_VERSION;
  key: string;
  threadId: string;
  scene: string;
  instruction: string;
  background: DrawingBackground;
  pencilOnly: boolean;
  /** Structured collaborative diagram layer, separate from freehand scene marks. */
  diagramJson: string | null;
  /** True when the restored diagram contains iPad edits not yet accepted by the Mac. */
  diagramDirty?: boolean;
  /** Revision the local edits were based on, used for explicit conflict handling. */
  diagramBaseRevision?: number | null;
  updatedAt: string;
  /** Present for v2 board-backed drafts. */
  boardId?: string;
  /** Present for v2 board-backed drafts. */
  camera?: DrawingBoardCamera;
  /** The recoverable part of a damaged board was opened as a new working copy. */
  recoveryWarning?: string;
}

export interface SaveDrawingDraftInput {
  scene: string;
  instruction: string;
  background: DrawingBackground;
  pencilOnly: boolean;
  diagramJson?: string | null;
  diagramDirty?: boolean;
  diagramBaseRevision?: number | null;
  updatedAt?: string;
  camera?: DrawingBoardCamera;
  boardId?: string;
}

export interface DrawingBoardCamera {
  centerX: number;
  centerY: number;
  zoom: number;
}

export interface DrawingBoardCheckpoint {
  checkpointId: string;
  createdAt: string;
  status: "sent";
  scope: "board" | "area";
  imageNames: readonly string[];
}

export interface StoredDrawingBoard {
  version: typeof BOARD_VERSION;
  boardId: string;
  threadId: string;
  title: string;
  revision: number;
  sceneHeader: string;
  elementIds: readonly string[];
  elementDigests: Readonly<Record<string, string>>;
  instruction: string;
  background: DrawingBackground;
  pencilOnly: boolean;
  diagramJson: string | null;
  diagramDirty?: boolean;
  diagramBaseRevision?: number | null;
  camera: DrawingBoardCamera;
  checkpoints: readonly DrawingBoardCheckpoint[];
  createdAt: string;
  updatedAt: string;
}

interface BoardElementRecord {
  key: string;
  boardId: string;
  elementId: string;
  json: string;
}

interface ActiveBoardRecord {
  threadId: string;
  boardId: string;
}

export interface StoredDrawingBoardExportImage {
  readonly fileName: `Nerva Board ${string}.png`;
  readonly blob: Blob;
  readonly kind: "overview" | "detail" | "atlas";
  readonly tileNumber: number;
}

export interface StoredDrawingBoardExport {
  readonly commandId: string;
  readonly threadId: string;
  readonly boardId: string;
  readonly checkpointId: string;
  readonly targetSnapshotSeq: number;
  readonly scope: "board" | "area";
  readonly images: readonly StoredDrawingBoardExportImage[];
  readonly manifest: {
    readonly version: 1;
    readonly quality: "good" | "reduced" | "overview-detail";
    readonly overlap: number;
    readonly tiles: readonly {
      readonly tileNumber: number;
      readonly kind: "overview" | "detail" | "atlas";
      readonly minX: number;
      readonly minY: number;
      readonly maxX: number;
      readonly maxY: number;
    }[];
  };
  readonly createdAt: string;
}

interface PendingDrawingBoardExportRecord extends Omit<StoredDrawingBoardExport, "images"> {
  readonly images: readonly (Omit<StoredDrawingBoardExportImage, "blob"> & { readonly bytes: ArrayBuffer })[];
}

export function draftKeyForThread(threadId: string): string {
  const normalized = threadId.trim().toLowerCase();
  if (!normalized) throw new Error("A thread ID is required for a drawing draft.");
  return `thread:${normalized}`;
}

export function makeStoredDrawingDraft(
  threadId: string,
  input: SaveDrawingDraftInput,
): StoredDrawingDraft {
  return {
    version: DRAFT_VERSION,
    key: draftKeyForThread(threadId),
    threadId: threadId.trim().toLowerCase(),
    scene: input.scene,
    instruction: input.instruction,
    background: input.background,
    pencilOnly: input.pencilOnly,
    diagramJson: input.diagramJson ?? null,
    diagramDirty: input.diagramDirty ?? false,
    diagramBaseRevision: input.diagramBaseRevision ?? null,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.boardId ? { boardId: input.boardId } : {}),
    ...(input.camera ? { camera: input.camera } : {}),
  };
}

function getIndexedDb(): IDBFactory | null {
  return typeof indexedDB === "undefined" ? null : indexedDB;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("The retained drawing image could not be read."));
    }, { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

async function openDraftDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDb();
  if (!factory) return null;

  const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      database.createObjectStore(STORE_NAME, { keyPath: "key" });
    }
    if (!database.objectStoreNames.contains(BOARD_STORE_NAME)) {
      database.createObjectStore(BOARD_STORE_NAME, { keyPath: "boardId" });
    }
    if (!database.objectStoreNames.contains(BOARD_ELEMENT_STORE_NAME)) {
      const elements = database.createObjectStore(BOARD_ELEMENT_STORE_NAME, { keyPath: "key" });
      elements.createIndex("boardId", "boardId", { unique: false });
    }
    if (!database.objectStoreNames.contains(ACTIVE_BOARD_STORE_NAME)) {
      database.createObjectStore(ACTIVE_BOARD_STORE_NAME, { keyPath: "threadId" });
    }
    if (!database.objectStoreNames.contains(PENDING_BOARD_EXPORT_STORE_NAME)) {
      database.createObjectStore(PENDING_BOARD_EXPORT_STORE_NAME, { keyPath: "threadId" });
    }
  });
  return requestResult(request);
}

function normalizeThreadId(threadId: string): string {
  return threadId.trim().toLowerCase();
}

function newBoardId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `board-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function digest(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function readActiveBoard(database: IDBDatabase, threadId: string): Promise<StoredDrawingBoard | null> {
  const active = await requestResult(database.transaction(ACTIVE_BOARD_STORE_NAME, "readonly").objectStore(ACTIVE_BOARD_STORE_NAME).get(threadId)) as ActiveBoardRecord | undefined;
  if (!active) return null;
  return await requestResult(database.transaction(BOARD_STORE_NAME, "readonly").objectStore(BOARD_STORE_NAME).get(active.boardId)) as StoredDrawingBoard | undefined ?? null;
}

async function hydrateBoard(database: IDBDatabase, board: StoredDrawingBoard): Promise<StoredDrawingDraft> {
  const transaction = database.transaction(BOARD_ELEMENT_STORE_NAME, "readonly");
  const store = transaction.objectStore(BOARD_ELEMENT_STORE_NAME);
  const missingElementIds: string[] = [];
  const elements = (await Promise.all(board.elementIds.map(async (elementId) => {
    const record = await requestResult(store.get(`${board.boardId}:${elementId}`)) as BoardElementRecord | undefined;
    if (!record) {
      missingElementIds.push(elementId);
      return null;
    }
    try {
      return JSON.parse(record.json) as unknown;
    } catch {
      missingElementIds.push(elementId);
      return null;
    }
  }))).filter((element): element is Exclude<typeof element, null> => element !== null);
  const header = JSON.parse(board.sceneHeader) as Record<string, unknown>;
  return {
    version: DRAFT_VERSION,
    key: draftKeyForThread(board.threadId),
    threadId: board.threadId,
    scene: JSON.stringify({ ...header, elements }),
    instruction: board.instruction,
    background: board.background,
    pencilOnly: board.pencilOnly,
    diagramJson: board.diagramJson,
    diagramDirty: board.diagramDirty ?? false,
    diagramBaseRevision: board.diagramBaseRevision ?? null,
    updatedAt: board.updatedAt,
    boardId: board.boardId,
    camera: board.camera,
    ...(missingElementIds.length > 0
      ? { recoveryWarning: `${missingElementIds.length} damaged board element${missingElementIds.length === 1 ? " was" : "s were"} omitted.` }
      : {}),
  };
}

async function readBoard(
  database: IDBDatabase,
  boardId: string,
): Promise<StoredDrawingBoard | null> {
  return await requestResult(
    database.transaction(BOARD_STORE_NAME, "readonly").objectStore(BOARD_STORE_NAME).get(boardId),
  ) as StoredDrawingBoard | undefined ?? null;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const database = await openDraftDatabase();
  if (!database) return null;

  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const result = await requestResult(operation(transaction.objectStore(STORE_NAME)));
    await transactionDone(transaction);
    return result;
  } finally {
    database.close();
  }
}

export async function loadDrawingDraft(
  threadId: string,
): Promise<StoredDrawingDraft | null> {
  const normalizedThreadId = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (database) {
    try {
      const board = await readActiveBoard(database, normalizedThreadId);
      if (board) return await hydrateBoard(database, board);
    } finally {
      database.close();
    }
  }
  const value = await withStore<StoredDrawingDraft>("readonly", (store) =>
    store.get(draftKeyForThread(threadId)),
  );
  if (!value || value.version !== DRAFT_VERSION || value.threadId !== normalizedThreadId) {
    return null;
  }
  return {
    ...value,
    diagramJson: typeof value.diagramJson === "string" ? value.diagramJson : null,
    diagramDirty: value.diagramDirty === true,
    diagramBaseRevision: typeof value.diagramBaseRevision === "number"
      ? value.diagramBaseRevision
      : null,
  };
}

export async function saveDrawingDraft(
  threadId: string,
  input: SaveDrawingDraftInput,
): Promise<StoredDrawingDraft> {
  const normalizedThreadId = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (!database) {
    throw new Error("IndexedDB is unavailable; the drawing draft was not saved.");
  }
  try {
    const active = await readActiveBoard(database, normalizedThreadId);
    const requested = input.boardId ? await readBoard(database, input.boardId) : null;
    if (requested && requested.threadId !== normalizedThreadId) {
      throw new Error("This drawing board does not belong to the exact task.");
    }
    // An explicit board identity is the caller's write authority. In
    // particular, a Saved Drawing opens as a new working copy and must never
    // inherit or overwrite the task's previously active board.
    const current = input.boardId ? requested : active;
    const parsed = JSON.parse(input.scene) as Record<string, unknown>;
    const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
    const sceneHeader = JSON.stringify({ ...parsed, elements: undefined });
    const boardId = input.boardId ?? current?.boardId ?? newBoardId();
    const now = input.updatedAt ?? new Date().toISOString();
    const elementIds: string[] = [];
    const elementDigests: Record<string, string> = {};
    const serializedElements = elements.map((element) => {
      const record = element as { id?: unknown };
      if (typeof record.id !== "string" || !record.id) throw new Error("Drawing elements require stable IDs.");
      const json = JSON.stringify(element);
      elementIds.push(record.id);
      elementDigests[record.id] = digest(json);
      return { id: record.id, json };
    });
    const board: StoredDrawingBoard = {
      version: BOARD_VERSION,
      boardId,
      threadId: normalizedThreadId,
      title: current?.title ?? "Untitled board",
      revision: (current?.revision ?? 0) + 1,
      sceneHeader,
      elementIds,
      elementDigests,
      instruction: input.instruction,
      background: input.background,
      pencilOnly: input.pencilOnly,
      diagramJson: input.diagramJson ?? null,
      diagramDirty: input.diagramDirty ?? false,
      diagramBaseRevision: input.diagramBaseRevision ?? null,
      camera: input.camera ?? current?.camera ?? { centerX: 720, centerY: 450, zoom: 1 },
      checkpoints: current?.checkpoints ?? [],
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const transaction = database.transaction(
      [BOARD_STORE_NAME, BOARD_ELEMENT_STORE_NAME, ACTIVE_BOARD_STORE_NAME],
      "readwrite",
    );
    const elementStore = transaction.objectStore(BOARD_ELEMENT_STORE_NAME);
    for (const element of serializedElements) {
      if (current?.elementDigests[element.id] !== elementDigests[element.id]) {
        elementStore.put({ key: `${boardId}:${element.id}`, boardId, elementId: element.id, json: element.json } satisfies BoardElementRecord);
      }
    }
    for (const removedId of current?.elementIds ?? []) {
      if (!(removedId in elementDigests)) elementStore.delete(`${boardId}:${removedId}`);
    }
    transaction.objectStore(BOARD_STORE_NAME).put(board);
    transaction.objectStore(ACTIVE_BOARD_STORE_NAME).put({ threadId: normalizedThreadId, boardId } satisfies ActiveBoardRecord);
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    return makeStoredDrawingDraft(threadId, input);
  } finally {
    database.close();
  }
}

export async function deleteDrawingDraft(threadId: string): Promise<void> {
  const normalized = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (database) {
    try {
      const current = await readActiveBoard(database, normalized);
      const transaction = database.transaction(
        [STORE_NAME, ACTIVE_BOARD_STORE_NAME, BOARD_STORE_NAME, BOARD_ELEMENT_STORE_NAME],
        "readwrite",
      );
      transaction.objectStore(STORE_NAME).delete(draftKeyForThread(threadId));
      transaction.objectStore(ACTIVE_BOARD_STORE_NAME).delete(normalized);
      if (current && current.checkpoints.length === 0) {
        transaction.objectStore(BOARD_STORE_NAME).delete(current.boardId);
        for (const elementId of current.elementIds) {
          transaction.objectStore(BOARD_ELEMENT_STORE_NAME).delete(`${current.boardId}:${elementId}`);
        }
      }
      await transactionDone(transaction);
    } finally {
      database.close();
    }
    return;
  }
  await withStore<undefined>("readwrite", (store) => store.delete(draftKeyForThread(threadId)));
}

export async function checkpointAndFinishDrawingBoard(
  threadId: string,
  checkpoint: DrawingBoardCheckpoint,
  commandId?: string,
): Promise<void> {
  const normalized = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (!database) throw new Error("IndexedDB is unavailable; the sent board could not be checkpointed.");
  try {
    const transaction = database.transaction(
      [BOARD_STORE_NAME, ACTIVE_BOARD_STORE_NAME, PENDING_BOARD_EXPORT_STORE_NAME],
      "readwrite",
    );
    const boardStore = transaction.objectStore(BOARD_STORE_NAME);
    const activeStore = transaction.objectStore(ACTIVE_BOARD_STORE_NAME);
    const pendingStore = transaction.objectStore(PENDING_BOARD_EXPORT_STORE_NAME);
    const [active, pending, boards] = await Promise.all([
      requestResult(activeStore.get(normalized)) as Promise<ActiveBoardRecord | undefined>,
      requestResult(pendingStore.get(normalized)) as Promise<PendingDrawingBoardExportRecord | undefined>,
      requestResult(boardStore.getAll()) as Promise<StoredDrawingBoard[]>,
    ]);
    if (commandId && pending && pending.commandId !== commandId) {
      transaction.abort();
      throw new Error("The retained drawing export belongs to a different delivery.");
    }
    const boardId = active?.boardId ?? (commandId && pending?.commandId === commandId ? pending.boardId : undefined);
    const current = boardId ? boards.find((board) => board.boardId === boardId && board.threadId === normalized) : undefined;
    const alreadyCheckpointed = boards.some((board) => board.threadId === normalized
      && board.checkpoints.some((candidate) => candidate.checkpointId === checkpoint.checkpointId));
    if (!current && !alreadyCheckpointed) {
      transaction.abort();
      throw new Error("The active drawing board is unavailable.");
    }
    if (current && !current.checkpoints.some((candidate) => candidate.checkpointId === checkpoint.checkpointId)) {
      boardStore.put({
        ...current,
        revision: current.revision + 1,
        checkpoints: [...current.checkpoints, checkpoint],
        updatedAt: checkpoint.createdAt,
      });
    }
    activeStore.delete(normalized);
    if (commandId && (!pending || pending.commandId === commandId)) pendingStore.delete(normalized);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function listDrawingBoards(threadId: string): Promise<readonly StoredDrawingBoard[]> {
  const normalized = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (!database) return [];
  try {
    const all = await requestResult(database.transaction(BOARD_STORE_NAME, "readonly").objectStore(BOARD_STORE_NAME).getAll()) as StoredDrawingBoard[];
    return all.filter((board) => board.threadId === normalized)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } finally {
    database.close();
  }
}

export async function deleteDrawingBoard(threadId: string, boardId: string): Promise<void> {
  const normalized = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (!database) throw new Error("IndexedDB is unavailable.");
  try {
    const transaction = database.transaction(
      [BOARD_STORE_NAME, BOARD_ELEMENT_STORE_NAME, ACTIVE_BOARD_STORE_NAME],
      "readwrite",
    );
    const boardStore = transaction.objectStore(BOARD_STORE_NAME);
    const elementStore = transaction.objectStore(BOARD_ELEMENT_STORE_NAME);
    const activeStore = transaction.objectStore(ACTIVE_BOARD_STORE_NAME);
    const [board, active] = await Promise.all([
      requestResult(boardStore.get(boardId)) as Promise<StoredDrawingBoard | undefined>,
      requestResult(activeStore.get(normalized)) as Promise<ActiveBoardRecord | undefined>,
    ]);
    if (!board || board.threadId !== normalized) {
      transaction.abort();
      throw new Error("This board does not belong to the exact task.");
    }
    if (active?.boardId === boardId) {
      transaction.abort();
      throw new Error("The active board cannot be deleted while it is open.");
    }
    boardStore.delete(boardId);
    for (const elementId of board.elementIds) elementStore.delete(`${boardId}:${elementId}`);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function resumeDrawingBoard(threadId: string, boardId: string): Promise<void> {
  const normalized = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (!database) throw new Error("IndexedDB is unavailable.");
  try {
    const board = await requestResult(database.transaction(BOARD_STORE_NAME, "readonly").objectStore(BOARD_STORE_NAME).get(boardId)) as StoredDrawingBoard | undefined;
    if (!board || board.threadId !== normalized) throw new Error("This board does not belong to the exact task.");
    const transaction = database.transaction(ACTIVE_BOARD_STORE_NAME, "readwrite");
    transaction.objectStore(ACTIVE_BOARD_STORE_NAME).put({ threadId: normalized, boardId } satisfies ActiveBoardRecord);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function saveDrawingBoardCamera(
  threadId: string,
  camera: DrawingBoardCamera,
): Promise<void> {
  const normalized = normalizeThreadId(threadId);
  const database = await openDraftDatabase();
  if (!database) return;
  try {
    const current = await readActiveBoard(database, normalized);
    if (!current) return;
    const transaction = database.transaction(BOARD_STORE_NAME, "readwrite");
    transaction.objectStore(BOARD_STORE_NAME).put({
      ...current,
      camera,
      updatedAt: new Date().toISOString(),
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function savePendingDrawingBoardExport(
  value: StoredDrawingBoardExport,
): Promise<void> {
  const database = await openDraftDatabase();
  if (!database) throw new Error("IndexedDB is unavailable; the exact export could not be retained.");
  try {
    const normalized = normalizeThreadId(value.threadId);
    const record: PendingDrawingBoardExportRecord = {
      ...value,
      threadId: normalized,
      images: await Promise.all(value.images.map(async ({ blob, ...image }) => ({
        ...image,
        bytes: await blobBytes(blob),
      }))),
    };
    const transaction = database.transaction(PENDING_BOARD_EXPORT_STORE_NAME, "readwrite");
    transaction.objectStore(PENDING_BOARD_EXPORT_STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function loadPendingDrawingBoardExport(
  threadId: string,
): Promise<StoredDrawingBoardExport | null> {
  const database = await openDraftDatabase();
  if (!database) return null;
  try {
    const value = await requestResult(
      database.transaction(PENDING_BOARD_EXPORT_STORE_NAME, "readonly")
        .objectStore(PENDING_BOARD_EXPORT_STORE_NAME)
        .get(normalizeThreadId(threadId)),
    ) as PendingDrawingBoardExportRecord | undefined;
    return value ? {
      ...value,
      images: value.images.map(({ bytes, ...image }) => ({
        ...image,
        blob: new Blob([bytes], { type: "image/png" }),
      })),
    } : null;
  } finally {
    database.close();
  }
}

export async function deletePendingDrawingBoardExport(
  threadId: string,
  commandId?: string,
): Promise<void> {
  const database = await openDraftDatabase();
  if (!database) return;
  try {
    const normalized = normalizeThreadId(threadId);
    if (commandId) {
      const current = await requestResult(
        database.transaction(PENDING_BOARD_EXPORT_STORE_NAME, "readonly")
          .objectStore(PENDING_BOARD_EXPORT_STORE_NAME)
          .get(normalized),
      ) as PendingDrawingBoardExportRecord | undefined;
      if (!current || current.commandId !== commandId) return;
    }
    const transaction = database.transaction(PENDING_BOARD_EXPORT_STORE_NAME, "readwrite");
    transaction.objectStore(PENDING_BOARD_EXPORT_STORE_NAME).delete(normalized);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

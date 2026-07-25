const DATABASE_NAME = "codex-pad-drawings";
const STORE_NAME = "drafts";
const DATABASE_VERSION = 1;
const DRAFT_VERSION = 1;

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
  updatedAt: string;
}

export interface SaveDrawingDraftInput {
  scene: string;
  instruction: string;
  background: DrawingBackground;
  pencilOnly: boolean;
  diagramJson?: string | null;
  updatedAt?: string;
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
    updatedAt: input.updatedAt ?? new Date().toISOString(),
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

async function openDraftDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDb();
  if (!factory) return null;

  const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      database.createObjectStore(STORE_NAME, { keyPath: "key" });
    }
  });
  return requestResult(request);
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
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
    return result;
  } finally {
    database.close();
  }
}

export async function loadDrawingDraft(
  threadId: string,
): Promise<StoredDrawingDraft | null> {
  const normalizedThreadId = threadId.trim().toLowerCase();
  const value = await withStore<StoredDrawingDraft>("readonly", (store) =>
    store.get(draftKeyForThread(threadId)),
  );
  if (!value || value.version !== DRAFT_VERSION || value.threadId !== normalizedThreadId) {
    return null;
  }
  return {
    ...value,
    diagramJson: typeof value.diagramJson === "string" ? value.diagramJson : null,
  };
}

export async function saveDrawingDraft(
  threadId: string,
  input: SaveDrawingDraftInput,
): Promise<StoredDrawingDraft> {
  const draft = makeStoredDrawingDraft(threadId, input);
  const storedKey = await withStore<IDBValidKey>("readwrite", (store) => store.put(draft));
  if (storedKey === null) {
    throw new Error("IndexedDB is unavailable; the drawing draft was not saved.");
  }
  return draft;
}

export async function deleteDrawingDraft(threadId: string): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(draftKeyForThread(threadId)));
}

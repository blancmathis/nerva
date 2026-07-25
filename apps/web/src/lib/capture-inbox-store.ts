import { useCallback, useEffect, useState } from "react";

import { createUuidV4 } from "./uuid";

const DATABASE_NAME = "nerva-capture-inbox";
const DATABASE_VERSION = 2;
const CAPTURE_STORE = "captures";
export const CAPTURE_INBOX_CHANGED_EVENT = "nerva:capture-inbox-changed";

export const MAX_CAPTURE_ITEMS = 200;
export const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
export const MAX_CAPTURE_INBOX_BYTES = 256 * 1024 * 1024;

export type CaptureKind = "photo" | "scan" | "sketch" | "file" | "note";

export interface CaptureInboxItem {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  readonly byteLength: number;
  readonly text: string | null;
}

interface StoredCaptureInboxItem extends CaptureInboxItem {
  readonly bytes?: ArrayBuffer;
}

export interface CaptureInboxSummary {
  readonly count: number;
  readonly byteLength: number;
}

export interface SaveCaptureInput {
  readonly kind: CaptureKind;
  readonly title: string;
  readonly blob?: Blob;
  readonly fileName?: string | null;
  readonly text?: string | null;
  readonly now?: number;
}

const EMPTY_SUMMARY: CaptureInboxSummary = { count: 0, byteLength: 0 };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("The Capture Inbox request failed.")), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("The Capture Inbox transaction was cancelled.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("The Capture Inbox transaction failed.")), { once: true });
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("Local capture storage is unavailable on this device.");
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", (event) => {
    const database = request.result;
    if (!database.objectStoreNames.contains(CAPTURE_STORE)) {
      database.createObjectStore(CAPTURE_STORE, { keyPath: "id" });
    }
    if ((event as IDBVersionChangeEvent).oldVersion < 2) {
      const store = request.transaction?.objectStore(CAPTURE_STORE);
      const cursorRequest = store?.openCursor();
      cursorRequest?.addEventListener("success", () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (typeof cursor.value === "object" && cursor.value !== null) {
          const migrated = { ...(cursor.value as Record<string, unknown>) };
          delete migrated.destination;
          delete migrated.reviewPreparation;
          delete migrated.durationMs;
          if (migrated.kind === "voice") {
            migrated.kind = "file";
            if (typeof migrated.title === "string") migrated.title = migrated.title.replace(/^Voice note\b/u, "Audio file");
          }
          cursor.update(migrated);
        }
        cursor.continue();
      });
    }
  }, { once: true });
  return requestResult(request);
}

function normalizedTitle(value: string): string {
  const title = value.trim().replace(/\s+/gu, " ").slice(0, 160);
  return title || "Untitled capture";
}

function normalizedFileName(value: string | null | undefined): string | null {
  const fileName = value?.trim().slice(0, 512) ?? "";
  return fileName || null;
}

function normalizedText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim().slice(0, 20_000);
  return text || null;
}

function normalizedMimeType(value: string | undefined): string | null {
  const mimeType = value?.trim().toLowerCase().slice(0, 160) ?? "";
  return mimeType || null;
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  if (typeof FileReader !== "undefined") {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (reader.result instanceof ArrayBuffer) resolve(reader.result);
        else reject(new Error("The capture could not be read as bytes."));
      }, { once: true });
      reader.addEventListener("error", () => reject(reader.error ?? new Error("The capture could not be read.")), { once: true });
      reader.readAsArrayBuffer(blob);
    });
  }
  throw new Error("Local capture byte access is unavailable.");
}

function isCaptureKind(value: unknown): value is CaptureKind {
  return value === "photo" || value === "scan" || value === "sketch" || value === "file" || value === "note";
}

function publicItem(stored: StoredCaptureInboxItem): CaptureInboxItem {
  return {
    id: stored.id,
    kind: stored.kind,
    title: stored.title,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    fileName: stored.fileName,
    mimeType: stored.mimeType,
    byteLength: stored.byteLength,
    text: stored.text,
  };
}

function validStoredItem(value: unknown): value is StoredCaptureInboxItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<StoredCaptureInboxItem>;
  const bytesAreValid = item.bytes === undefined
    || item.bytes instanceof ArrayBuffer
    || Object.prototype.toString.call(item.bytes) === "[object ArrayBuffer]";
  const actualByteLength = item.bytes === undefined ? 0 : item.bytes.byteLength;
  return typeof item.id === "string"
    && item.id.length > 0
    && isCaptureKind(item.kind)
    && typeof item.title === "string"
    && item.title.length > 0
    && item.title.length <= 160
    && typeof item.createdAt === "number"
    && Number.isSafeInteger(item.createdAt)
    && item.createdAt >= 0
    && typeof item.updatedAt === "number"
    && Number.isSafeInteger(item.updatedAt)
    && item.updatedAt >= item.createdAt
    && typeof item.byteLength === "number"
    && Number.isSafeInteger(item.byteLength)
    && item.byteLength >= 0
    && item.byteLength <= MAX_CAPTURE_BYTES
    && bytesAreValid
    && actualByteLength === item.byteLength
    && (item.kind === "note" ? typeof item.text === "string" && item.text.trim().length > 0 : item.byteLength > 0);
}

function notifyChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CAPTURE_INBOX_CHANGED_EVENT));
}

function summaryOf(items: readonly CaptureInboxItem[]): CaptureInboxSummary {
  return {
    count: items.length,
    byteLength: items.reduce((total, item) => total + item.byteLength, 0),
  };
}

export async function listCaptureInboxItems(): Promise<readonly CaptureInboxItem[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CAPTURE_STORE, "readonly");
    const stored = await requestResult<StoredCaptureInboxItem[]>(transaction.objectStore(CAPTURE_STORE).getAll());
    await transactionComplete(transaction);
    return stored
      .filter(validStoredItem)
      .map(publicItem)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  } finally {
    database.close();
  }
}

export async function loadCaptureInboxItem(id: string): Promise<{ readonly item: CaptureInboxItem; readonly blob: Blob | null } | null> {
  const normalizedId = id.trim();
  if (!normalizedId) return null;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CAPTURE_STORE, "readonly");
    const stored = await requestResult<StoredCaptureInboxItem | undefined>(transaction.objectStore(CAPTURE_STORE).get(normalizedId));
    await transactionComplete(transaction);
    if (!stored || !validStoredItem(stored)) return null;
    const hasBytes = stored.bytes instanceof ArrayBuffer || Object.prototype.toString.call(stored.bytes) === "[object ArrayBuffer]";
    const blob = hasBytes && stored.bytes && stored.bytes.byteLength > 0
      ? new Blob([stored.bytes], { type: stored.mimeType ?? "application/octet-stream" })
      : null;
    return { item: publicItem(stored), blob };
  } finally {
    database.close();
  }
}

export async function saveCaptureInboxItem(input: SaveCaptureInput): Promise<CaptureInboxItem> {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("The capture time is invalid.");
  const text = normalizedText(input.text);
  const blob = input.blob ?? null;
  if (input.kind === "note" && !text) throw new Error("Write a note before saving it.");
  if (input.kind !== "note" && (!blob || blob.size === 0)) throw new Error("This capture is empty.");
  if (blob && blob.size > MAX_CAPTURE_BYTES) throw new Error("One capture can be at most 32 MB.");
  const bytes = blob ? await readBlobBytes(blob) : undefined;
  const stored: StoredCaptureInboxItem = {
    id: createUuidV4(),
    kind: input.kind,
    title: normalizedTitle(input.title),
    createdAt: now,
    updatedAt: now,
    fileName: normalizedFileName(input.fileName),
    mimeType: normalizedMimeType(blob?.type),
    byteLength: blob?.size ?? 0,
    text,
    ...(bytes ? { bytes } : {}),
  };

  const database = await openDatabase();
  try {
    const transaction = database.transaction(CAPTURE_STORE, "readwrite");
    const store = transaction.objectStore(CAPTURE_STORE);
    const existing = (await requestResult<StoredCaptureInboxItem[]>(store.getAll())).filter(validStoredItem);
    if (existing.length >= MAX_CAPTURE_ITEMS) {
      transaction.abort();
      throw new Error(`Capture Inbox holds up to ${MAX_CAPTURE_ITEMS} items. Remove older captures before adding another.`);
    }
    const totalBytes = existing.reduce((total, item) => total + item.byteLength, 0) + stored.byteLength;
    if (totalBytes > MAX_CAPTURE_INBOX_BYTES) {
      transaction.abort();
      throw new Error("Capture Inbox is using its 256 MB local limit. Remove older captures before adding another.");
    }
    store.add(stored);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
  notifyChanged();
  return publicItem(stored);
}

export async function deleteCaptureInboxItems(ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CAPTURE_STORE, "readwrite");
    const store = transaction.objectStore(CAPTURE_STORE);
    uniqueIds.forEach((id) => store.delete(id));
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
  notifyChanged();
}

export async function captureInboxSummary(): Promise<CaptureInboxSummary> {
  return summaryOf(await listCaptureInboxItems());
}

export function useCaptureInboxSummary(): { readonly summary: CaptureInboxSummary; readonly refresh: () => void } {
  const [summary, setSummary] = useState<CaptureInboxSummary>(EMPTY_SUMMARY);
  const refresh = useCallback(() => {
    void captureInboxSummary().then(setSummary).catch(() => setSummary(EMPTY_SUMMARY));
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(CAPTURE_INBOX_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CAPTURE_INBOX_CHANGED_EVENT, refresh);
  }, [refresh]);
  return { summary, refresh };
}

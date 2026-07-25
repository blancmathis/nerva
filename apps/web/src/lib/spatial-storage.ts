import { migrateSpatialLayout, type SpatialLayout } from "./spatial-model";

export const SPATIAL_LAYOUT_STORAGE_KEY = "codex-pad.spatial-layout.v2";
export const LEGACY_SPATIAL_LAYOUT_STORAGE_KEY = "codex-pad.spatial-layout.v1";

const DATABASE_NAME = "codex-pad-spatial-layout";
const DATABASE_VERSION = 1;
const STORE_NAME = "layout";
const RECORD_KEY = "current";

export interface SpatialLayoutStorage {
  load(): Promise<SpatialLayout | null>;
  save(layout: SpatialLayout): Promise<void>;
}

export interface BrowserSpatialLayoutStorageOptions {
  readonly indexedDB?: IDBFactory | null;
  readonly localStorage?: Storage | null;
}

function runtimeIndexedDb(override: IDBFactory | null | undefined): IDBFactory | null {
  if (override !== undefined) return override;
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function runtimeLocalStorage(override: Storage | null | undefined): Storage | null {
  if (override !== undefined) return override;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open spatial layout database"));
    request.onblocked = () => reject(new Error("Spatial layout database upgrade is blocked"));
  });
}

async function readIndexedDb(factory: IDBFactory): Promise<unknown> {
  const database = await openDatabase(factory);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not read spatial layout"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Spatial layout read aborted"));
    });
  } finally {
    database.close();
  }
}

async function writeIndexedDb(factory: IDBFactory, layout: SpatialLayout): Promise<void> {
  const database = await openDatabase(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(layout, RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Spatial layout write aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save spatial layout"));
    });
  } finally {
    database.close();
  }
}

function readLocal(storage: Storage): unknown | null {
  for (const key of [SPATIAL_LAYOUT_STORAGE_KEY, LEGACY_SPATIAL_LAYOUT_STORAGE_KEY]) {
    try {
      const serialized = storage.getItem(key);
      if (serialized) return JSON.parse(serialized) as unknown;
    } catch {
      // A malformed or inaccessible cache must not prevent the live session list.
    }
  }
  return null;
}

/**
 * IndexedDB is authoritative when available; localStorage is a compact fallback
 * and migration source. Both receive only the sanitized identity/layout schema.
 */
export function createSpatialLayoutStorage(
  options: BrowserSpatialLayoutStorageOptions = {},
): SpatialLayoutStorage {
  async function save(layout: SpatialLayout): Promise<void> {
    const sanitized = migrateSpatialLayout(layout);
    const storage = runtimeLocalStorage(options.localStorage);
    if (storage) {
      try {
        storage.setItem(SPATIAL_LAYOUT_STORAGE_KEY, JSON.stringify(sanitized));
      } catch {
        // IndexedDB can still preserve the layout when localStorage is unavailable.
      }
    }

    const factory = runtimeIndexedDb(options.indexedDB);
    if (factory) {
      try {
        await writeIndexedDb(factory, sanitized);
      } catch {
        // Layout remains usable in memory and may already be in localStorage.
      }
    }
  }

  return {
    async load() {
      const factory = runtimeIndexedDb(options.indexedDB);
      if (factory) {
        try {
          const stored = await readIndexedDb(factory);
          if (stored !== undefined && stored !== null) return migrateSpatialLayout(stored);
        } catch {
          // Safari private mode and quota failures fall back to localStorage.
        }
      }

      const storage = runtimeLocalStorage(options.localStorage);
      if (!storage) return null;
      const stored = readLocal(storage);
      if (stored === null) return null;
      const migrated = migrateSpatialLayout(stored);
      await save(migrated);
      return migrated;
    },
    save,
  };
}

export const browserSpatialLayoutStorage = createSpatialLayoutStorage();

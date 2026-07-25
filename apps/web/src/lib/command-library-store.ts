import { openDB, type IDBPDatabase } from "idb";
import {
  createDefaultCommandLibrary,
  parseCommandLibrary,
  serializeCommandLibrary,
  type CommandLibraryConfig,
} from "./command-library";

const DATABASE_NAME = "codex-pad-command-library";
const STORE_NAME = "configuration";
const ACTIVE_KEY = "active";
const FALLBACK_KEY = "codex-pad.command-library.v1";

let databasePromise: Promise<IDBPDatabase> | null = null;

function database(): Promise<IDBPDatabase> {
  databasePromise ??= openDB(DATABASE_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    },
  });
  return databasePromise;
}

function readFallback(): CommandLibraryConfig | null {
  try {
    const value = localStorage.getItem(FALLBACK_KEY);
    return value ? parseCommandLibrary(value) : null;
  } catch {
    return null;
  }
}

export async function loadCommandLibrary(): Promise<CommandLibraryConfig> {
  try {
    const db = await database();
    const stored = await db.get(STORE_NAME, ACTIVE_KEY);
    if (stored !== undefined) return parseCommandLibrary(stored);
  } catch {
    // Safari private-mode and storage quotas can make IndexedDB unavailable.
  }
  return readFallback() ?? createDefaultCommandLibrary();
}

export async function saveCommandLibrary(library: CommandLibraryConfig): Promise<void> {
  const validated = parseCommandLibrary(library);
  const serialized = serializeCommandLibrary(validated);
  let indexedDbSaved = false;
  try {
    const db = await database();
    await db.put(STORE_NAME, validated, ACTIVE_KEY);
    indexedDbSaved = true;
  } catch {
    // The localStorage fallback below is bounded and contains validated config only.
  }
  try {
    localStorage.setItem(FALLBACK_KEY, serialized);
  } catch {
    if (!indexedDbSaved) throw new Error("Command library could not be saved on this device.");
  }
}

export async function resetCommandLibraryStoreForTests(): Promise<void> {
  try {
    const db = await databasePromise;
    db?.close();
  } finally {
    databasePromise = null;
    localStorage.removeItem(FALLBACK_KEY);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Unable to reset command library database."));
      request.onblocked = () => resolve();
    });
  }
}

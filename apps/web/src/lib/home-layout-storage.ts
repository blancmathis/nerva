import { openDB } from "idb";
import {
  migrateHomeLayout,
  migrateLegacySpatialLayout,
  type HomeLayout,
} from "./home-layout";
import { browserSpatialLayoutStorage } from "./spatial-storage";

const DATABASE = "codex-pad-product-state";
const STORE = "home";
const RECORD_KEY = "layout";
const LOCAL_KEY = "codex-pad.home-layout.v1";

async function database() {
  return openDB(DATABASE, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
}

function readLocal(): unknown | null {
  try {
    const serialized = localStorage.getItem(LOCAL_KEY);
    return serialized ? JSON.parse(serialized) as unknown : null;
  } catch {
    return null;
  }
}

export async function loadHomeLayout(): Promise<HomeLayout | null> {
  // This copy is written synchronously before IndexedDB. A reload can abort
  // the later transaction, so reading the database first can resurrect a pin.
  const local = readLocal();
  if (local !== null) return migrateHomeLayout(local);
  try {
    const db = await database();
    let stored: unknown;
    try {
      stored = await db.get(STORE, RECORD_KEY);
    } finally {
      db.close();
    }
    if (stored !== undefined && stored !== null) return migrateHomeLayout(stored);
  } catch {
    // Neither current store is readable; try the legacy presentation layout.
  }

  // One-time compatibility import from the former standalone Spatial page.
  const legacy = await browserSpatialLayoutStorage.load();
  if (legacy && (legacy.boxes.length > 0 || legacy.unassignedThreadIds.length > 0)) {
    const migrated = migrateLegacySpatialLayout(legacy);
    await saveHomeLayout(migrated);
    return migrated;
  }
  return null;
}

export async function saveHomeLayout(layout: HomeLayout): Promise<void> {
  const sanitized = migrateHomeLayout(layout);
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(sanitized));
  } catch {
    // Do not let an older local copy hide a successful IndexedDB write after
    // a quota error. Removing a key does not require additional storage space.
    try { localStorage.removeItem(LOCAL_KEY); } catch { /* Storage is inaccessible. */ }
  }
  try {
    const db = await database();
    try {
      await db.put(STORE, sanitized, RECORD_KEY);
    } finally {
      db.close();
    }
  } catch {
    // The in-memory state remains usable when browser persistence is unavailable.
  }
}

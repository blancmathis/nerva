import { openDB } from "idb";

export const AUTH_DATABASE_NAME = "codex-pad-origin-auth";
export const AUTH_OBJECT_STORE = "device-credential";
export const AUTH_RECORD_KEY = "current";
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
let credentialMutation = Promise.resolve();

interface StoredCredential {
  readonly version: 1;
  readonly bearerToken: string;
}

function validCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.bearerToken === "string"
    && BEARER_TOKEN_PATTERN.test(record.bearerToken);
}

async function database() {
  return openDB(AUTH_DATABASE_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(AUTH_OBJECT_STORE)) db.createObjectStore(AUTH_OBJECT_STORE);
    },
  });
}

function serializeCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = credentialMutation.then(operation);
  credentialMutation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The permanent device bearer is deliberately isolated in IndexedDB for this
 * exact scheme/host/port origin. There is no cookie or localStorage fallback.
 */
export async function loadBridgeBearer(): Promise<string | null> {
  if (typeof indexedDB === "undefined") return null;
  await credentialMutation;
  try {
    const db = await database();
    let value: unknown;
    try {
      value = await db.get(AUTH_OBJECT_STORE, AUTH_RECORD_KEY);
    } finally {
      db.close();
    }
    if (validCredential(value)) return value.bearerToken;
  } catch {
    // Safari private mode can make IndexedDB unavailable. Pairing can still
    // continue in memory for the current page without weakening storage.
  }
  return null;
}

export async function saveBridgeBearer(bearerToken: string): Promise<boolean> {
  if (typeof indexedDB === "undefined" || !BEARER_TOKEN_PATTERN.test(bearerToken)) return false;
  return serializeCredentialMutation(async () => {
    try {
      const db = await database();
      try {
        await db.put(AUTH_OBJECT_STORE, { version: 1, bearerToken } satisfies StoredCredential, AUTH_RECORD_KEY);
      } finally {
        db.close();
      }
      return true;
    } catch {
      return false;
    }
  });
}

export async function clearBridgeBearer(expectedBearer?: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await serializeCredentialMutation(async () => {
    try {
      const db = await database();
      try {
        const transaction = db.transaction(AUTH_OBJECT_STORE, "readwrite");
        if (expectedBearer !== undefined) {
          const stored = await transaction.store.get(AUTH_RECORD_KEY) as unknown;
          if (!validCredential(stored) || stored.bearerToken !== expectedBearer) {
            await transaction.done;
            return;
          }
        }
        await transaction.store.delete(AUTH_RECORD_KEY);
        await transaction.done;
      } finally {
        db.close();
      }
    } catch {
      // Clearing is best effort after local browser storage loss. The in-memory
      // copy is always discarded by BridgeClient before this function runs.
    }
  });
}

export function isBridgeBearer(value: unknown): value is string {
  return typeof value === "string" && BEARER_TOKEN_PATTERN.test(value);
}

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_DATABASE_NAME,
  clearBridgeBearer,
  loadBridgeBearer,
  saveBridgeBearer,
} from "./auth-store";

const TOKEN = "a".repeat(43);

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
});

describe("origin-scoped bridge credential storage", () => {
  it("survives a fresh database connection and clears on revocation", async () => {
    await expect(saveBridgeBearer(TOKEN)).resolves.toBe(true);
    await expect(loadBridgeBearer()).resolves.toBe(TOKEN);
    await clearBridgeBearer();
    await expect(loadBridgeBearer()).resolves.toBeNull();
  });

  it("rejects malformed values without a localStorage fallback", async () => {
    const localStorageWrites: string[] = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string) { localStorageWrites.push(key); };
    try {
      await expect(saveBridgeBearer("not-a-token")).resolves.toBe(false);
      await expect(loadBridgeBearer()).resolves.toBeNull();
      expect(localStorageWrites).toEqual([]);
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("uses a dedicated database rather than the display cache", () => {
    expect(AUTH_DATABASE_NAME).toBe("codex-pad-origin-auth");
  });

  it("serializes a pending clear before a newly paired credential save", async () => {
    await saveBridgeBearer("a".repeat(43));
    const clearing = clearBridgeBearer();
    const replacement = "b".repeat(43);
    const saving = saveBridgeBearer(replacement);
    await Promise.all([clearing, saving]);
    await expect(loadBridgeBearer()).resolves.toBe(replacement);
  });

  it("does not let a stale rejection clear a newly paired credential", async () => {
    const rejected = "c".repeat(43);
    const replacement = "d".repeat(43);
    await saveBridgeBearer(rejected);
    await saveBridgeBearer(replacement);

    await clearBridgeBearer(rejected);
    await expect(loadBridgeBearer()).resolves.toBe(replacement);

    await clearBridgeBearer(replacement);
    await expect(loadBridgeBearer()).resolves.toBeNull();
  });
});

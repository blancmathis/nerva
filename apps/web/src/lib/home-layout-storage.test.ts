import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialHomeLayout, homeLayoutReducer } from "./home-layout";
import { loadHomeLayout, saveHomeLayout } from "./home-layout-storage";

const LOCAL_KEY = "codex-pad.home-layout.v1";
const pinned = createInitialHomeLayout(["research", "design"]);
const unpinned = homeLayoutReducer(pinned, { type: "unpin", threadId: "research" });

describe("Home layout recovery", () => {
  beforeEach(async () => {
    localStorage.clear();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("codex-pad-product-state");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Home database remained open"));
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("retains an unpin when navigation interrupts the IndexedDB update", async () => {
    await saveHomeLayout(pinned);
    const write = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("The page was closed", "AbortError");
    });
    await saveHomeLayout(unpinned);
    write.mockRestore();

    // The synchronous write survived; IndexedDB still contains the prior pins.
    expect(JSON.parse(localStorage.getItem(LOCAL_KEY)!)).toEqual(unpinned);
    await expect(loadHomeLayout()).resolves.toEqual(unpinned);
  });

  it("uses IndexedDB when local storage cannot accept a newer layout", async () => {
    await saveHomeLayout(pinned);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    await saveHomeLayout(unpinned);
    write.mockRestore();

    await expect(loadHomeLayout()).resolves.toEqual(unpinned);
  });

  it("recovers an IndexedDB-only installation", async () => {
    await saveHomeLayout(unpinned);
    localStorage.removeItem(LOCAL_KEY);
    await expect(loadHomeLayout()).resolves.toEqual(unpinned);
  });

  it("recovers from an unreadable local copy", async () => {
    await saveHomeLayout(unpinned);
    localStorage.setItem(LOCAL_KEY, "broken JSON");
    await expect(loadHomeLayout()).resolves.toEqual(unpinned);
  });
});

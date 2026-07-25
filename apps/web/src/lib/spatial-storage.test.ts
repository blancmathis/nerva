import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_SPATIAL_LAYOUT_STORAGE_KEY,
  SPATIAL_LAYOUT_STORAGE_KEY,
  createSpatialLayoutStorage,
} from "./spatial-storage";

describe("spatial layout persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("migrates v1 groups and strips private session content", async () => {
    localStorage.setItem(
      LEGACY_SPATIAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        groups: [
          {
            id: "review",
            title: "Review",
            color: "amber",
            width: "large",
            sessionIds: [
              { threadId: "thread-a", title: "DO NOT STORE THIS TITLE", cwd: "/private/repo" },
            ],
          },
        ],
        looseSessionIds: ["thread-b"],
      }),
    );
    const storage = createSpatialLayoutStorage({ indexedDB: null, localStorage });

    const layout = await storage.load();
    expect(layout).toEqual({
      version: 2,
      boxes: [
        {
          id: "review",
          name: "Review",
          color: "amber",
          size: "wide",
          threadIds: ["thread-a"],
        },
      ],
      unassignedThreadIds: ["thread-b"],
    });

    const persisted = localStorage.getItem(SPATIAL_LAYOUT_STORAGE_KEY) ?? "";
    expect(persisted).not.toContain("DO NOT STORE");
    expect(persisted).not.toContain("/private/repo");
    expect(JSON.parse(persisted)).toEqual(layout);
  });

  it("round-trips the versioned identity-only layout through IndexedDB", async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("codex-pad-spatial-layout");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    const storage = createSpatialLayoutStorage({ indexedDB, localStorage: null });
    const layout = {
      version: 2 as const,
      boxes: [
        {
          id: "focus",
          name: "Focus",
          color: "cobalt" as const,
          size: "standard" as const,
          threadIds: ["thread-a"],
        },
      ],
      unassignedThreadIds: ["thread-b"],
    };

    await storage.save(layout);
    await expect(storage.load()).resolves.toEqual(layout);
  });
});

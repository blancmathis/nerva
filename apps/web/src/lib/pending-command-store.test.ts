import { beforeEach, describe, expect, it } from "vitest";
import {
  loadPendingCommandIds,
  MAX_PERSISTED_PENDING_COMMAND_IDS,
  PENDING_COMMAND_IDS_STORAGE_KEY,
  savePendingCommandIds,
} from "./pending-command-store";

const commandId = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

describe("pending command identity persistence", () => {
  beforeEach(() => localStorage.clear());

  it("persists only canonical opaque command IDs, never mutation payloads", () => {
    const id = commandId(1);
    const stored = savePendingCommandIds([id, "not-a-command-id", id.toUpperCase()]);

    expect(stored).toEqual([id]);
    expect(loadPendingCommandIds()).toEqual([id]);
    const serialized = localStorage.getItem(PENDING_COMMAND_IDS_STORAGE_KEY) ?? "";
    expect(JSON.parse(serialized)).toEqual({ version: 1, commandIds: [id] });
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("png");
  });

  it("keeps the newest bounded set and removes the record when reconciled", () => {
    const ids = Array.from({ length: MAX_PERSISTED_PENDING_COMMAND_IDS + 3 }, (_, index) => commandId(index + 1));
    expect(savePendingCommandIds(ids)).toEqual(ids.slice(-MAX_PERSISTED_PENDING_COMMAND_IDS));

    savePendingCommandIds([]);
    expect(localStorage.getItem(PENDING_COMMAND_IDS_STORAGE_KEY)).toBeNull();
  });

  it("fails closed on malformed or future storage records", () => {
    localStorage.setItem(PENDING_COMMAND_IDS_STORAGE_KEY, "not-json");
    expect(loadPendingCommandIds()).toEqual([]);

    localStorage.setItem(PENDING_COMMAND_IDS_STORAGE_KEY, JSON.stringify({ version: 2, commandIds: [commandId(1)] }));
    expect(loadPendingCommandIds()).toEqual([]);
  });
});

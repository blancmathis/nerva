import { afterEach, describe, expect, it } from "vitest";
import { createDefaultCommandLibrary, upsertCommand } from "./command-library";
import { loadCommandLibrary, resetCommandLibraryStoreForTests, saveCommandLibrary } from "./command-library-store";

afterEach(async () => {
  await resetCommandLibraryStoreForTests();
});

describe("command library persistence", () => {
  it("persists validated versioned configuration without transport state", async () => {
    const base = createDefaultCommandLibrary("library_persistence_test");
    const first = base.commands[0]!;
    const saved = upsertCommand(base, { ...first, label: "My review" });
    await saveCommandLibrary(saved);

    const loaded = await loadCommandLibrary();
    expect(loaded).toEqual(saved);
    expect(JSON.stringify(loaded)).not.toContain("targetThreadId");
    expect(JSON.stringify(loaded)).not.toContain("commandId\":\"111");
  });
});

import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProductStateConflictError, ProductStateStore } from "../src/product-state-store.js";

const roots: string[] = [];

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-product-state-"));
  roots.push(root);
  return join(root, "security", "product-state.json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProductStateStore", () => {
  it("writes a revisioned global layout atomically with private permissions", async () => {
    const filePath = await temporaryFile();
    const store = new ProductStateStore({ filePath, now: () => 1_750_000_000_000 });
    const initial = await store.read();
    const next = await store.update({
      expectedRevision: initial.revision,
      homeLayout: {
        ...initial.homeLayout,
        pinnedThreadIds: ["thread-a"],
        manual: { sections: [], looseThreadIds: ["thread-a"] },
      },
      preferences: { ...initial.preferences, theme: "light" },
    });

    expect(next).toMatchObject({ revision: 1, updatedAt: 1_750_000_000_000, preferences: { theme: "light" } });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(next);
  });

  it("returns the current state on an optimistic revision conflict", async () => {
    const store = new ProductStateStore({ filePath: await temporaryFile() });
    const initial = await store.read();
    await store.update({ expectedRevision: 0, homeLayout: initial.homeLayout, preferences: initial.preferences });
    await expect(store.update({ expectedRevision: 0, homeLayout: initial.homeLayout, preferences: initial.preferences }))
      .rejects.toBeInstanceOf(ProductStateConflictError);
  });

  it("rejects insecure permissions and symlinked state files", async () => {
    const filePath = await temporaryFile();
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, JSON.stringify({}), { mode: 0o600 });
    const store = new ProductStateStore({ filePath });
    await chmod(filePath, 0o644);
    await expect(store.read()).rejects.toThrow(/0600/u);

    await rm(filePath);
    const target = join(filePath, "..", "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, filePath);
    await expect(store.read()).rejects.toThrow(/symlinked/u);
  });
});

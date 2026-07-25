import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { SavedDrawingNotFoundError, SavedDrawingsStore } from "../src/saved-drawings-store.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SavedDrawingsStore", () => {
  it("keeps, lists, loads, and manually deletes a validated drawing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-drawings-"));
    roots.push(root);
    const store = new SavedDrawingsStore({ directory: join(root, "saved"), now: () => 42 });
    const png = await sharp({
      create: { width: 16, height: 12, channels: 4, background: "#ffffff" },
    }).png().toBuffer();

    const created = await store.create({
      sourceThreadId: THREAD_ID,
      sourceThreadTitle: "Glass controls",
      instruction: "Make the primary action calmer",
      pngBase64: png.toString("base64"),
      sceneJson: JSON.stringify({ version: 1, elements: [] }),
      background: "white",
      width: 16,
      height: 12,
    });

    expect(created.createdAt).toBe(42);
    expect(created.thumbnailBase64.length).toBeGreaterThan(10);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("pngBase64");
    expect((await store.get(created.id)).sceneJson).toContain("elements");

    await store.delete(created.id);
    expect(await store.list()).toEqual([]);
    await expect(store.get(created.id)).rejects.toBeInstanceOf(SavedDrawingNotFoundError);
  });

  it("rejects dimensions that do not match the PNG", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-drawings-"));
    roots.push(root);
    const store = new SavedDrawingsStore({ directory: join(root, "saved") });
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: "#ffffff" },
    }).png().toBuffer();
    await expect(store.create({
      sourceThreadId: THREAD_ID,
      sourceThreadTitle: "Mismatch",
      instruction: "",
      pngBase64: png.toString("base64"),
      sceneJson: "{}",
      background: "white",
      width: 9,
      height: 8,
    })).rejects.toThrow("dimensions");
  });
});

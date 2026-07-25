import { chmod, lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultDataPaths } from "../src/paths.js";
import {
  runStartupRuntimeCleanup,
  scavengeStaleRuntimeSketches,
  startRuntimeCleanupSchedule,
} from "../src/runtime-cleanup.js";

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  sketches: string;
  paths: ReturnType<typeof defaultDataPaths>;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-runtime-cleanup-"));
  roots.push(root);
  const paths = defaultDataPaths(root);
  const sketches = join(paths.runtime, "sketches");
  await mkdir(sketches, { recursive: true, mode: 0o700 });
  await chmod(paths.runtime, 0o700);
  await chmod(sketches, 0o700);
  return { root, sketches, paths };
}

function ownedName(fill: string): string {
  return `sketch-${fill.repeat(36)}.png`;
}

async function oldFile(path: string, mode = 0o600): Promise<void> {
  await writeFile(path, Buffer.from("normalized-private-png"), { mode });
  await chmod(path, mode);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
  await utimes(path, old, old);
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime sketch cleanup", () => {
  it("removes only a stale private regular CodexPad upload", async () => {
    const { paths, sketches } = await fixture();
    const stale = join(sketches, ownedName("a"));
    await oldFile(stale);

    await expect(scavengeStaleRuntimeSketches(paths)).resolves.toMatchObject({
      directoryState: "verified",
      removed: 1,
      failed: 0,
    });
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes stale zero-byte and partial crash artifacts", async () => {
    const { paths, sketches } = await fixture();
    const zero = join(sketches, ownedName("0"));
    const partial = join(sketches, ownedName("1"));
    await writeFile(zero, Buffer.alloc(0), { mode: 0o600 });
    await writeFile(partial, Buffer.from([137, 80, 78]), { mode: 0o600 });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(zero, old, old);
    await utimes(partial, old, old);

    await expect(scavengeStaleRuntimeSketches(paths)).resolves.toMatchObject({ removed: 2 });
    await expect(lstat(zero)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves symlink, recent, foreign-name, and non-private entries", async () => {
    const { root, paths, sketches } = await fixture();
    const outside = join(root, "outside-private.png");
    await oldFile(outside);
    const linked = join(sketches, ownedName("b"));
    await symlink(outside, linked);

    const recent = join(sketches, ownedName("c"));
    await writeFile(recent, Buffer.from("recent-private-png"), { mode: 0o600 });
    const foreignName = join(sketches, "foreign.png");
    await oldFile(foreignName);
    const foreignMode = join(sketches, ownedName("d"));
    await oldFile(foreignMode, 0o640);

    await expect(scavengeStaleRuntimeSketches(paths)).resolves.toMatchObject({ removed: 0 });
    await expect(lstat(linked)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    await expect(lstat(outside)).resolves.toMatchObject({ size: Buffer.byteLength("normalized-private-png") });
    await expect(lstat(recent)).resolves.toBeDefined();
    await expect(lstat(foreignName)).resolves.toBeDefined();
    await expect(lstat(foreignMode)).resolves.toBeDefined();
  });

  it("fails closed for a symlinked sketches directory and keeps startup logging sanitized", async () => {
    const { root, paths, sketches } = await fixture();
    await rm(sketches, { recursive: true });
    const foreignDirectory = join(root, "foreign-directory");
    await mkdir(foreignDirectory, { mode: 0o700 });
    const foreign = join(foreignDirectory, ownedName("e"));
    await oldFile(foreign);
    await symlink(foreignDirectory, sketches);

    await expect(scavengeStaleRuntimeSketches(paths)).resolves.toMatchObject({
      directoryState: "untrusted",
      removed: 0,
    });
    const warn = vi.fn();
    await runStartupRuntimeCleanup(paths, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be verified"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(root);
    await expect(lstat(foreign)).resolves.toBeDefined();
  });

  it("periodically retries a young restart artifact and stops cleanly", async () => {
    vi.useFakeTimers();
    const { paths, sketches } = await fixture();
    const artifact = join(sketches, ownedName("f"));
    await writeFile(artifact, Buffer.from("recent-private-png"), { mode: 0o600 });
    const createdAt = (await lstat(artifact)).mtimeMs;
    let now = createdAt;
    const schedule = await startRuntimeCleanupSchedule(paths, { warn: vi.fn() }, {
      intervalMs: 1_000,
      minimumAgeMs: 1_000,
      now: () => now,
    });
    await expect(lstat(artifact)).resolves.toBeDefined();

    now = createdAt + 1_001;
    await vi.advanceTimersByTimeAsync(1_000);
    await schedule.runNow();
    await expect(lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });

    await schedule.stop();
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

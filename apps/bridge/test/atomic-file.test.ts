import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withPrivateFileLock, type PrivateFileLockOptions } from "../src/atomic-file.js";

const temporaryRoots: string[] = [];

async function temporaryTarget(): Promise<{ root: string; target: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-atomic-lock-"));
  temporaryRoots.push(root);
  const target = join(root, "private.json");
  return { root, target, lockPath: `${target}.lock` };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function controlledProcessOptions(overrides: PrivateFileLockOptions = {}): PrivateFileLockOptions {
  return {
    timeoutMs: 100,
    staleAfterMs: 20,
    retryMinMs: 2,
    retryMaxMs: 5,
    isProcessAlive: async (pid) => pid === process.pid,
    readProcessStartIdentity: async (pid) => pid === process.pid ? "test-process-start" : null,
    ...overrides,
  };
}

async function writeSeedLock(
  lockPath: string,
  value: unknown,
  modifiedAtMs: number,
): Promise<void> {
  await writeFile(lockPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(lockPath, 0o600);
  await utimes(lockPath, modifiedAtMs / 1_000, modifiedAtMs / 1_000);
}

async function writeSeedReclaimClaim(
  lockPath: string,
  targetToken: string,
  claimToken: string,
  owner: { pid: number; processStartIdentity: string | null },
  modifiedAtMs: number,
): Promise<string> {
  const claimPath = `${lockPath}.reclaim-${targetToken}`;
  const ownerPath = join(claimPath, "owner.json");
  await mkdir(claimPath, { mode: 0o700 });
  await writeFile(ownerPath, `${JSON.stringify({
    version: 1,
    kind: "reclaim",
    token: claimToken,
    targetToken,
    pid: owner.pid,
    processStartIdentity: owner.processStartIdentity,
    acquiredAtMs: modifiedAtMs,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(claimPath, 0o700);
  await chmod(ownerPath, 0o600);
  await utimes(ownerPath, modifiedAtMs / 1_000, modifiedAtMs / 1_000);
  await utimes(claimPath, modifiedAtMs / 1_000, modifiedAtMs / 1_000);
  return claimPath;
}

describe("withPrivateFileLock", () => {
  it("keeps a live owner's private lock intact and fails closed on timeout", async () => {
    const { target, lockPath } = await temporaryTarget();
    let releaseOwner: (() => void) | undefined;
    let announceAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => { announceAcquired = resolve; });
    const held = withPrivateFileLock(target, async () => {
      announceAcquired?.();
      await new Promise<void>((resolve) => { releaseOwner = resolve; });
    }, controlledProcessOptions({ timeoutMs: 500, staleAfterMs: 0 }));

    await acquired;
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    const contenderRan = { value: false };
    await expect(withPrivateFileLock(target, async () => {
      contenderRan.value = true;
    }, controlledProcessOptions({ timeoutMs: 25, staleAfterMs: 0 }))).rejects.toThrow(/PID .* still owns the lock/u);
    expect(contenderRan.value).toBe(false);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      version: 1,
      kind: "lock",
      pid: process.pid,
      processStartIdentity: "test-process-start",
    });

    releaseOwner?.();
    await held;
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an old lock only after its recorded owner is dead", async () => {
    const { target, lockPath } = await temporaryTarget();
    const now = Date.now();
    await writeSeedLock(lockPath, {
      version: 1,
      kind: "lock",
      token: "a".repeat(64),
      pid: 424_242,
      processStartIdentity: "old-process-start",
      acquiredAtMs: now - 60_000,
    }, now - 60_000);

    const result = await withPrivateFileLock(target, async () => "recovered", controlledProcessOptions());
    expect(result).toBe("recovered");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(target, ".."))).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("recovers the previous two-line lock format conservatively", async () => {
    const { target, lockPath } = await temporaryTarget();
    const now = Date.now();
    await writeFile(lockPath, `424242\n${now - 60_000}\n`, { encoding: "utf8", mode: 0o600 });
    await utimes(lockPath, (now - 60_000) / 1_000, (now - 60_000) / 1_000);

    await expect(withPrivateFileLock(target, async () => 7, controlledProcessOptions())).resolves.toBe(7);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves malformed, insecure, and too-young lock files untouched", async () => {
    const malformed = await temporaryTarget();
    await writeFile(malformed.lockPath, "not-lock-metadata\n", { encoding: "utf8", mode: 0o600 });
    await expect(withPrivateFileLock(
      malformed.target,
      async () => undefined,
      controlledProcessOptions({ timeoutMs: 20, staleAfterMs: 0 }),
    )).rejects.toThrow(/metadata is malformed.*left intact/u);
    expect(await readFile(malformed.lockPath, "utf8")).toBe("not-lock-metadata\n");

    const insecure = await temporaryTarget();
    await writeFile(insecure.lockPath, "not-lock-metadata\n", { encoding: "utf8", mode: 0o644 });
    await chmod(insecure.lockPath, 0o644);
    await expect(withPrivateFileLock(
      insecure.target,
      async () => undefined,
      controlledProcessOptions({ timeoutMs: 20, staleAfterMs: 0 }),
    )).rejects.toThrow(/permissions are not private mode 0600.*left intact/u);
    expect((await stat(insecure.lockPath)).mode & 0o777).toBe(0o644);

    const young = await temporaryTarget();
    const now = Date.now();
    await writeSeedLock(young.lockPath, {
      version: 1,
      kind: "lock",
      token: "b".repeat(64),
      pid: 424_242,
      processStartIdentity: "dead-but-young",
      acquiredAtMs: now,
    }, now);
    await expect(withPrivateFileLock(
      young.target,
      async () => undefined,
      controlledProcessOptions({ timeoutMs: 20, staleAfterMs: 10_000 }),
    )).rejects.toThrow(/too young to reclaim.*left intact/u);
    expect(JSON.parse(await readFile(young.lockPath, "utf8"))).toMatchObject({ token: "b".repeat(64) });
  });

  it("treats a live reused PID as stale only when the start identity differs", async () => {
    const { target, lockPath } = await temporaryTarget();
    const now = Date.now();
    await writeSeedLock(lockPath, {
      version: 1,
      kind: "lock",
      token: "c".repeat(64),
      pid: 777,
      processStartIdentity: "old-start",
      acquiredAtMs: now - 60_000,
    }, now - 60_000);

    await expect(withPrivateFileLock(target, async () => "pid-reused", controlledProcessOptions({
      isProcessAlive: async () => true,
      readProcessStartIdentity: async (pid) => pid === 777 ? "new-start" : "test-process-start",
    }))).resolves.toBe("pid-reused");
  });

  it("serializes concurrent stale-recovery races without overlapping operations", async () => {
    const { target, lockPath } = await temporaryTarget();
    const now = Date.now();
    await writeSeedLock(lockPath, {
      version: 1,
      kind: "lock",
      token: "d".repeat(64),
      pid: 424_242,
      processStartIdentity: "dead-process",
      acquiredAtMs: now - 60_000,
    }, now - 60_000);

    let activeOperations = 0;
    let maximumActiveOperations = 0;
    // The root suite runs many CPU-heavy jsdom workers in parallel. Keep this
    // concurrency proof strict while leaving enough wall-clock room for a
    // temporarily starved event loop on slower Macs and CI runners.
    const options = controlledProcessOptions({ timeoutMs: 3_000 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => withPrivateFileLock(
      target,
      async () => {
        activeOperations += 1;
        maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
        await new Promise<void>((resolve) => setTimeout(resolve, 4));
        activeOperations -= 1;
        return index;
      },
      options,
    )));

    expect(results.sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(maximumActiveOperations).toBe(1);
    expect((await readdir(join(target, ".."))).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it("recovers a crash-stale reclaim claim without touching a later claim generation", async () => {
    const { root, target, lockPath } = await temporaryTarget();
    const now = Date.now();
    const targetToken = "f".repeat(64);
    const crashedClaimToken = "1".repeat(64);
    await writeSeedLock(lockPath, {
      version: 1,
      kind: "lock",
      token: targetToken,
      pid: 424_242,
      processStartIdentity: "dead-lock-owner",
      acquiredAtMs: now - 60_000,
    }, now - 60_000);
    const claimPath = await writeSeedReclaimClaim(
      lockPath,
      targetToken,
      crashedClaimToken,
      { pid: 424_243, processStartIdentity: "dead-reclaimer" },
      now - 60_000,
    );

    let activeOperations = 0;
    let maximumActiveOperations = 0;
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => withPrivateFileLock(
      target,
      async () => {
        activeOperations += 1;
        maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
        await new Promise<void>((resolve) => setTimeout(resolve, 3));
        activeOperations -= 1;
        return index;
      },
      controlledProcessOptions({ timeoutMs: 1_000 }),
    )));
    expect(results.sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maximumActiveOperations).toBe(1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantinePath = `${claimPath}.stale-${crashedClaimToken}`;
    expect((await stat(quarantinePath)).mode & 0o777).toBe(0o700);
    expect((await stat(join(quarantinePath, "owner.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.includes(".released-"))).toEqual([]);
  });

  it("leaves a live reclaim claim and its stale target lock intact", async () => {
    const { target, lockPath } = await temporaryTarget();
    const now = Date.now();
    const targetToken = "0".repeat(64);
    await writeSeedLock(lockPath, {
      version: 1,
      kind: "lock",
      token: targetToken,
      pid: 424_242,
      processStartIdentity: "dead-lock-owner",
      acquiredAtMs: now - 60_000,
    }, now - 60_000);
    const claimPath = await writeSeedReclaimClaim(
      lockPath,
      targetToken,
      "2".repeat(64),
      { pid: process.pid, processStartIdentity: "test-process-start" },
      now - 60_000,
    );

    await expect(withPrivateFileLock(
      target,
      async () => undefined,
      controlledProcessOptions({ timeoutMs: 20 }),
    )).rejects.toThrow(/still owns the lock generation.*left intact/u);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: targetToken });
    expect(JSON.parse(await readFile(join(claimPath, "owner.json"), "utf8"))).toMatchObject({
      token: "2".repeat(64),
    });
  });

  it("leaves a too-young dead reclaim claim fail-closed", async () => {
    const { target, lockPath } = await temporaryTarget();
    const now = Date.now();
    const targetToken = "9".repeat(64);
    await writeSeedLock(lockPath, {
      version: 1,
      kind: "lock",
      token: targetToken,
      pid: 424_242,
      processStartIdentity: "dead-lock-owner",
      acquiredAtMs: now - 60_000,
    }, now - 60_000);
    const claimPath = await writeSeedReclaimClaim(
      lockPath,
      targetToken,
      "3".repeat(64),
      { pid: 424_243, processStartIdentity: "recently-dead-reclaimer" },
      now,
    );

    await expect(withPrivateFileLock(
      target,
      async () => undefined,
      controlledProcessOptions({ timeoutMs: 20, staleAfterMs: 10_000 }),
    )).rejects.toThrow(/too young to reclaim.*left intact/u);
    await expect(stat(lockPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(claimPath)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("does not delete a replacement lock when ownership changes before release", async () => {
    const { target, lockPath } = await temporaryTarget();
    const replacement = {
      version: 1,
      kind: "lock",
      token: "e".repeat(64),
      pid: process.pid,
      processStartIdentity: "replacement-owner",
      acquiredAtMs: Date.now(),
    };

    await expect(withPrivateFileLock(target, async () => {
      await unlink(lockPath);
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { encoding: "utf8", mode: 0o600 });
    }, controlledProcessOptions())).rejects.toThrow(/ownership changed.*refusing to remove/u);

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });
});

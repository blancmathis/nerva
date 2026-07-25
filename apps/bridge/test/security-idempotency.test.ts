import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRequestSecurity,
  DualScopeConcurrencyLimiter,
  DualScopeRateLimiter,
  FixedWindowRateLimiter,
  validateListenSecurity,
} from "../src/security.js";
import {
  forgetUnresolvedCommand,
  IdempotencyLedger,
  listUnresolvedCommands,
} from "../src/idempotency.js";
import { acquireBridgeLifetimeLease, BridgeLifetimeLeaseError } from "../src/lifetime-lease.js";
import { defaultDataPaths } from "../src/paths.js";

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe("listen and browser security", () => {
  it("defaults to loopback and requires two explicit unsafe-LAN controls", () => {
    expect(() => validateListenSecurity({ host: "127.0.0.1", port: 8787 })).not.toThrow();
    expect(() => validateListenSecurity({
      host: "127.0.0.1",
      port: 8787,
      publicOrigin: "http://devbox.example:8787",
    })).toThrow(/HTTP publicOrigin/u);
    expect(() => validateListenSecurity({
      host: "127.0.0.1",
      port: 8787,
      publicOrigin: "http://127.0.0.1:8787",
      unsafeLan: true,
    })).toThrow(/concrete non-loopback IP/u);
    expect(() => validateListenSecurity({
      host: "127.0.0.1",
      port: 8787,
      publicOrigin: "http://192.168.1.20:8787",
      unsafeLan: true,
    })).not.toThrow();
    expect(() => validateListenSecurity({
      host: "127.0.0.1",
      port: 8787,
      publicOrigin: "https://mac.tailnet.example",
    })).not.toThrow();
    expect(() => validateListenSecurity({ host: "192.168.1.20", port: 8787 })).toThrow(/unsafeLan/u);
    expect(() => validateListenSecurity({ host: "192.168.1.20", port: 8787, unsafeLan: true })).toThrow(/Origin/u);
    expect(() => validateListenSecurity({
      host: "192.168.1.20",
      port: 8787,
      unsafeLan: true,
      allowedOrigins: ["http://192.168.1.20:8787"],
    })).not.toThrow();
    expect(() => validateListenSecurity({
      host: "0.0.0.0",
      port: 8787,
      unsafeLan: true,
      allowedOrigins: ["http://192.168.1.20:8787"],
    })).toThrow(/wildcard/u);
  });

  it("rejects non-origin public URLs before any loopback fast path", () => {
    expect(() => validateListenSecurity({
      host: "127.0.0.1",
      port: 8787,
      publicOrigin: "https://mac.tailnet.example/pair",
    })).toThrow(/Expected an origin/u);
  });

  it("checks exact Host and Origin and derives a non-loopback-only pairing key", () => {
    const policy = createRequestSecurity({
      host: "127.0.0.1",
      port: 8787,
      publicOrigin: "https://mac.tailnet.example",
    });
    const valid = request({
      host: "mac.tailnet.example",
      origin: "https://mac.tailnet.example",
      "tailscale-user-login": "mathis@example.test",
      "x-forwarded-for": "100.64.0.8",
      "user-agent": "Mobile Safari",
    });
    expect(() => policy.assertHost(valid)).not.toThrow();
    expect(() => policy.assertOrigin(valid, true)).not.toThrow();
    expect(policy.pairRateKey(valid)).not.toContain("mathis@example.test");
    expect(policy.authRateKey(valid)).toBe(policy.pairRateKey(valid));
    expect(policy.authRateKey(valid, "secret bearer")).not.toContain("secret bearer");
    expect(policy.authRateKey(valid, "secret bearer")).not.toBe(policy.authRateKey(valid, "another bearer"));
    expect(() => policy.assertOrigin(request({ host: "mac.tailnet.example", origin: "https://evil.example" }), true)).toThrow();
  });

  it("bounds per-identity pairing attempts", () => {
    const limiter = new FixedWindowRateLimiter(2, 10_000);
    expect(limiter.consume("device", 0).allowed).toBe(true);
    expect(limiter.consume("device", 1).allowed).toBe(true);
    expect(limiter.consume("device", 2)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.consume("other", 2).allowed).toBe(true);
  });

  it("enforces independent per-device and bridge-wide burst ceilings", () => {
    const limiter = new DualScopeRateLimiter({
      perKeyLimit: 2,
      perKeyWindowMs: 10_000,
      globalLimit: 4,
      globalWindowMs: 5_000,
      maxKeys: 2,
    });
    expect(limiter.consume("device-a", 0).allowed).toBe(true);
    expect(limiter.consume("device-a", 1).allowed).toBe(true);
    expect(limiter.consume("device-a", 2)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.consume("device-b", 3).allowed).toBe(true);
    expect(limiter.consume("device-c", 4)).toEqual({ allowed: false, retryAfterSeconds: 5 });
    expect(limiter.consume("device-c", 5_001).allowed).toBe(true);
  });

  it("rejects invalid limiter bounds", () => {
    expect(() => new FixedWindowRateLimiter(0, 1_000)).toThrow(/positive safe integer/u);
    expect(() => new FixedWindowRateLimiter(1, 0)).toThrow(/positive safe integer/u);
    expect(() => new FixedWindowRateLimiter(1, 1_000, 0)).toThrow(/positive safe integer/u);
  });

  it("can reject a blocked authentication source before another credential check", () => {
    const limiter = new DualScopeRateLimiter({
      perKeyLimit: 1,
      perKeyWindowMs: 10_000,
      globalLimit: 10,
      globalWindowMs: 10_000,
    });
    expect(limiter.check("source", 0).allowed).toBe(true);
    expect(limiter.consume("source", 1).allowed).toBe(true);
    expect(limiter.check("source", 2)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.check("fresh-source", 2).allowed).toBe(true);
    expect(limiter.check("source", 10_001).allowed).toBe(true);
  });

  it("does not pre-block an unrelated credential after the global failure ceiling", () => {
    const limiter = new DualScopeRateLimiter({
      perKeyLimit: 2,
      perKeyWindowMs: 10_000,
      globalLimit: 2,
      globalWindowMs: 10_000,
    });
    expect(limiter.consume("bad-a", 0).allowed).toBe(true);
    expect(limiter.consume("bad-b", 1).allowed).toBe(true);
    expect(limiter.check("valid", 2).allowed).toBe(false);
    expect(limiter.checkKey("valid", 2).allowed).toBe(true);
  });

  it("bounds expensive work per device and globally and restores capacity on release", () => {
    const limiter = new DualScopeConcurrencyLimiter(1, 2);
    const first = limiter.tryAcquire("device-a");
    expect(first).not.toBeNull();
    expect(limiter.tryAcquire("device-a")).toBeNull();
    const second = limiter.tryAcquire("device-b");
    expect(second).not.toBeNull();
    expect(limiter.tryAcquire("device-c")).toBeNull();
    first?.release();
    const third = limiter.tryAcquire("device-c");
    expect(third).not.toBeNull();
    first?.release();
    second?.release();
    third?.release();
    const restored = limiter.tryAcquire("device-a");
    expect(restored).not.toBeNull();
    restored?.release();
  });

  it("rejects invalid concurrency ceilings", () => {
    expect(() => new DualScopeConcurrencyLimiter(0, 1)).toThrow(/positive safe integer/u);
    expect(() => new DualScopeConcurrencyLimiter(2, 1)).toThrow(/at least as large/u);
  });
});

describe("IdempotencyLedger", () => {
  it("coalesces a commandId globally across device credential rotation", async () => {
    const ledger = new IdempotencyLedger<number>();
    let resolveOperation: ((value: number) => void) | undefined;
    const operation = vi.fn(() => new Promise<number>((resolve) => { resolveOperation = resolve; }));
    const first = await ledger.execute("device-a", "command", "same-payload", operation);
    const duplicate = await ledger.execute("device-a", "command", "same-payload", operation);
    const otherDevice = await ledger.execute("device-b", "command", "same-payload", operation);
    expect(duplicate.duplicate).toBe(true);
    expect(otherDevice.duplicate).toBe(true);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    resolveOperation?.(7);
    await expect(first.promise).resolves.toBe(7);
    await expect(duplicate.promise).resolves.toBe(7);
    await expect(otherDevice.promise).resolves.toBe(7);
    expect(ledger.status("device-b", "command")?.status).toBe("completed");
  });

  it("keeps a duplicate pending while the first durable reservation is being written", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-ledger-reservation-"));
    try {
      const ledger = new IdempotencyLedger<number>({ persistencePath: join(root, "commands.json") });
      await ledger.initialize();
      let finishOperation: ((value: number) => void) | undefined;
      const operation = vi.fn(() => new Promise<number>((resolve) => { finishOperation = resolve; }));

      const firstPending = ledger.execute("device-a", "command", "payload", operation);
      const duplicate = await ledger.execute("device-a", "command", "payload", operation);
      expect(duplicate.duplicate).toBe(true);
      let duplicateOutcome: number | "pending" = "pending";
      void duplicate.promise.then((value) => { duplicateOutcome = value; });
      await Promise.resolve();
      expect(duplicateOutcome).toBe("pending");

      const first = await firstPending;
      await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
      expect(duplicateOutcome).toBe("pending");
      finishOperation?.(23);
      await expect(first.promise).resolves.toBe(23);
      await expect(duplicate.promise).resolves.toBe(23);
      expect(duplicateOutcome).toBe(23);
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects command ID reuse with a different target or prompt", async () => {
    const ledger = new IdempotencyLedger<number>();
    const first = await ledger.execute("device-a", "command", "thread-a:prompt-one", async () => 1);
    await first.promise;
    await expect(ledger.execute("device-a", "command", "thread-b:prompt-two", async () => 2))
      .rejects.toThrow(/different command payload/u);
    await expect(ledger.execute("device-b", "command", "thread-c:prompt-three", async () => 3))
      .rejects.toThrow(/different command payload/u);
  });

  it("reconciles status and retries after re-pair without executing twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-ledger-repair-"));
    const persistencePath = join(root, "commands.json");
    try {
      const firstLedger = new IdempotencyLedger<number>({ persistencePath });
      const first = await firstLedger.execute("old-device", "durable-command", "payload", async () => 17);
      await expect(first.promise).resolves.toBe(17);

      const restartedLedger = new IdempotencyLedger<number>({ persistencePath });
      await restartedLedger.initialize();
      const retryOperation = vi.fn(async () => 99);
      expect(restartedLedger.status("new-device", "durable-command")).toMatchObject({
        status: "completed",
        result: 17,
      });
      const retry = await restartedLedger.execute(
        "new-device",
        "durable-command",
        "payload",
        retryOperation,
      );
      expect(retry.duplicate).toBe(true);
      await expect(retry.promise).resolves.toBe(17);
      expect(retryOperation).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists an in-flight command before execution and fails closed after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-ledger-"));
    const persistencePath = join(root, "commands.json");
    try {
      const firstLedger = new IdempotencyLedger<number>({ persistencePath });
      const firstOperation = vi.fn(() => new Promise<number>(() => undefined));
      await firstLedger.execute("device-a", "command", "same-media-command", firstOperation);
      expect(firstOperation).toHaveBeenCalledTimes(1);

      const restartedLedger = new IdempotencyLedger<number>({ persistencePath });
      await restartedLedger.initialize();
      const replayOperation = vi.fn(async () => 9);
      const replay = await restartedLedger.execute("device-a", "command", "same-media-command", replayOperation);
      expect(replay.duplicate).toBe(true);
      await expect(replay.promise).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN", retryable: true });
      expect(replayOperation).not.toHaveBeenCalled();
      expect(restartedLedger.status("device-a", "command")?.status).toBe("unresolved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores only a fixed-size digest for a large media command fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-ledger-digest-"));
    const persistencePath = join(root, "commands.json");
    try {
      const ledger = new IdempotencyLedger<number>({ persistencePath });
      const mediaFingerprint = JSON.stringify({ type: "sendReview", png: "A".repeat(2 * 1024 * 1024) });
      const execution = await ledger.execute("device-a", "media-command", mediaFingerprint, async () => 1);
      await expect(execution.promise).resolves.toBe(1);
      const stored = JSON.parse(await readFile(persistencePath, "utf8")) as {
        records: Array<{ fingerprint: string }>;
      };
      expect(stored.records[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect((await readFile(persistencePath)).byteLength).toBeLessThan(2_048);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists only unresolved metadata and forgets one exact uncertain record", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-ledger-admin-"));
    const persistencePath = join(root, "commands.json");
    try {
      const firstLedger = new IdempotencyLedger<number>({ persistencePath });
      await firstLedger.execute("device-a", "uncertain-command", "sensitive-payload", () => new Promise(() => undefined));

      const adminLedger = new IdempotencyLedger<number>({ persistencePath });
      await adminLedger.initialize();
      expect(adminLedger.unresolved()).toEqual([expect.objectContaining({
        deviceId: "device-a",
        commandId: "uncertain-command",
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      })]);
      expect(JSON.stringify(adminLedger.unresolved())).not.toMatch(/fingerprint|payload|result|error/u);
      await expect(adminLedger.forgetUnresolved("device-b", "uncertain-command")).resolves.toBe(false);
      await expect(adminLedger.forgetUnresolved("device-a", "uncertain-command")).resolves.toBe(true);
      expect(adminLedger.unresolved()).toEqual([]);

      const reloaded = new IdempotencyLedger<number>({ persistencePath });
      await reloaded.initialize();
      expect(reloaded.status("device-a", "uncertain-command")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reconciles a completed command after a restart and 60-minute suspension", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-ledger-suspension-"));
    const persistencePath = join(root, "commands.json");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
      const firstLedger = new IdempotencyLedger<number>({
        persistencePath,
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
      });
      const first = await firstLedger.execute("device-a", "hour-command", "payload", async () => 42);
      await expect(first.promise).resolves.toBe(42);

      vi.advanceTimersByTime(61 * 60 * 1_000);
      const restartedLedger = new IdempotencyLedger<number>({
        persistencePath,
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
      });
      await restartedLedger.initialize();
      const replayOperation = vi.fn(async () => 99);
      const replay = await restartedLedger.execute("device-a", "hour-command", "payload", replayOperation);
      expect(replay.duplicate).toBe(true);
      await expect(replay.promise).resolves.toBe(42);
      expect(replayOperation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never pressure-evicts a terminal command before the full retention window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
      const ledger = new IdempotencyLedger<number>({
        maximumRecords: 2,
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
      });
      await expect((await ledger.execute("device-a", "one", "one", async () => 1)).promise).resolves.toBe(1);
      await expect((await ledger.execute("device-a", "two", "two", async () => 2)).promise).resolves.toBe(2);

      vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
      const lostAckRetry = vi.fn(async () => 99);
      const duplicate = await ledger.execute("re-paired-device", "one", "one", lostAckRetry);
      expect(duplicate.duplicate).toBe(true);
      await expect(duplicate.promise).resolves.toBe(1);
      expect(lostAckRetry).not.toHaveBeenCalled();
      await expect(ledger.execute("device-a", "at-capacity", "three", async () => 3))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CAPACITY" });

      vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"));
      const afterExpiry = await ledger.execute("device-a", "after-expiry", "three", async () => 3);
      await expect(afterExpiry.promise).resolves.toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the full schema-safe default capacity beyond the former 4096-record ceiling", async () => {
    const ledger = new IdempotencyLedger<number>();
    expect(ledger.maximumRecords).toBe(16_384);
    for (let index = 0; index <= 4_096; index += 1) {
      const execution = await ledger.execute("device-a", `command-${index}`, `payload-${index}`, async () => index);
      await execution.promise;
    }
    expect(ledger.status("device-b", "command-4096")).toMatchObject({ status: "completed", result: 4_096 });
  });

  it("never evicts unresolved records to admit a new command", async () => {
    const ledger = new IdempotencyLedger<number>({
      maximumRecords: 1,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      isAmbiguousError: () => true,
    });
    const uncertain = await ledger.execute("device-a", "uncertain", "payload", async () => {
      throw new Error("post-write disconnect");
    });
    await expect(uncertain.promise).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    await expect(ledger.execute("device-a", "new-command", "payload", async () => 2))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CAPACITY" });
    expect(ledger.status("device-b", "uncertain")?.status).toBe("unresolved");
  });

  it("drains fire-and-forget prune persistence before closing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-ledger-drain-"));
    const persistencePath = join(root, "commands.json");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
      const ledger = new IdempotencyLedger<number>({
        persistencePath,
        retentionMs: 1,
      });
      await expect((await ledger.execute("device-a", "done", "payload", async () => 1)).promise).resolves.toBe(1);
      vi.advanceTimersByTime(2);
      expect(ledger.status("device-a", "done")).toBeNull();
      await ledger.close();
      const stored = JSON.parse(await readFile(persistencePath, "utf8")) as { records: unknown[] };
      expect(stored.records).toEqual([]);
      await expect(ledger.execute("device-a", "late", "payload", async () => 2))
        .rejects.toThrow(/closed/u);
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bridge lifetime lease and offline ledger administration", () => {
  it("permits only one owner for a data root and releases idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-lifetime-"));
    const paths = defaultDataPaths(root);
    try {
      const first = await acquireBridgeLifetimeLease(paths);
      await expect(acquireBridgeLifetimeLease(paths)).rejects.toBeInstanceOf(BridgeLifetimeLeaseError);
      await first.release();
      await first.release();
      const next = await acquireBridgeLifetimeLease(paths);
      await next.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a conservatively stale lifetime lease after a crashed owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-lifetime-stale-"));
    const paths = defaultDataPaths(root);
    const lockPath = `${paths.bridgeLifetime}.lock`;
    try {
      await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, `${JSON.stringify({
        version: 1,
        kind: "lock",
        token: "a".repeat(64),
        pid: 424_242,
        processStartIdentity: "dead-owner",
        acquiredAtMs: 1,
      })}\n`, { mode: 0o600 });
      await utimes(lockPath, new Date(1), new Date(1));

      const lease = await acquireBridgeLifetimeLease(paths, {
        lockOptions: {
          staleAfterMs: 0,
          timeoutMs: 100,
          isProcessAlive: async () => false,
          readProcessStartIdentity: async () => "current-test-owner",
        },
      });
      await lease.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses offline administration while the live lifetime lease is held", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-admin-live-"));
    const paths = defaultDataPaths(root);
    try {
      const live = await acquireBridgeLifetimeLease(paths);
      await expect(listUnresolvedCommands({ paths })).rejects.toBeInstanceOf(BridgeLifetimeLeaseError);
      await expect(forgetUnresolvedCommand("device", "command", { paths }))
        .rejects.toBeInstanceOf(BridgeLifetimeLeaseError);
      await live.release();
      await expect(listUnresolvedCommands({ paths })).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forgets one exact offline record with a locked RMW that preserves unrelated records", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-admin-rmw-"));
    const paths = defaultDataPaths(root);
    try {
      const ledger = new IdempotencyLedger<number>({ persistencePath: paths.idempotency });
      await ledger.execute("creator-a", "uncertain-a", "payload-a", () => new Promise(() => undefined));
      await ledger.execute("creator-b", "uncertain-b", "payload-b", () => new Promise(() => undefined));

      await expect(listUnresolvedCommands({ paths })).resolves.toEqual([
        expect.objectContaining({ deviceId: "creator-a", commandId: "uncertain-a" }),
        expect.objectContaining({ deviceId: "creator-b", commandId: "uncertain-b" }),
      ]);
      await expect(forgetUnresolvedCommand("wrong-creator", "uncertain-a", { paths })).resolves.toBe(false);
      await expect(forgetUnresolvedCommand("creator-a", "uncertain-a", { paths })).resolves.toBe(true);
      await expect(listUnresolvedCommands({ paths })).resolves.toEqual([
        expect.objectContaining({ deviceId: "creator-b", commandId: "uncertain-b" }),
      ]);

      const reloaded = new IdempotencyLedger<number>({ persistencePath: paths.idempotency });
      await reloaded.initialize();
      expect(reloaded.status("repaired-device", "uncertain-a")).toBeNull();
      expect(reloaded.status("repaired-device", "uncertain-b")?.status).toBe("unresolved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

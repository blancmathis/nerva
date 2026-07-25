import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWritePrivateJson, assertPrivateRegularFile, withPrivateFileLock } from "./atomic-file.js";
import { withBridgeLifetimeLease } from "./lifetime-lease.js";
import { defaultDataPaths, type BridgeDataPaths } from "./paths.js";

export type CommandRecordStatus = "inFlight" | "completed" | "failed" | "unresolved";

export interface StoredCommandError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CommandStatus<Result> {
  commandId: string;
  status: CommandRecordStatus;
  createdAt: number;
  updatedAt: number;
  result?: Result;
  error?: StoredCommandError;
}

export interface UnresolvedCommandMetadata {
  deviceId: string;
  commandId: string;
  createdAt: number;
  updatedAt: number;
}

interface InternalRecord<Result> extends CommandStatus<Result> {
  deviceId: string;
  fingerprint: string;
  promise: Promise<Result>;
}

export interface IdempotentExecution<Result> {
  duplicate: boolean;
  promise: Promise<Result>;
}

export interface IdempotencyLedgerOptions {
  maximumRecords?: number;
  retentionMs?: number;
  persistencePath?: string;
  isAmbiguousError?: (error: unknown) => boolean;
}

export class IdempotencyCapacityError extends Error {
  readonly code = "IDEMPOTENCY_CAPACITY";
  readonly retryable = true;
  constructor() {
    super(
      "The durable command ledger reached its safety bound. Completed and failed commands expire only after the full idempotency window; unresolved commands require explicit offline reconciliation. No command record was evicted.",
    );
  }
}

export class IdempotencyCollisionError extends Error {
  readonly code = "COMMAND_ID_COLLISION";
  readonly retryable = false;
  constructor() {
    super("This commandId was already used for a different command payload");
  }
}

export class DeliveryUnknownError extends Error {
  readonly code = "DELIVERY_UNKNOWN";
  readonly retryable = true;
  constructor(message = "Codex may have accepted this command, but its acknowledgement was not received. The same commandId will not execute again.") {
    super(message);
    this.name = "DeliveryUnknownError";
  }
}

class RecordedCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(error: StoredCommandError) {
    super(error.message);
    this.name = "RecordedCommandError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

const persistedErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
}).strict();

const persistedRecordSchema = z.object({
  deviceId: z.string().min(1).max(128),
  commandId: z.string().min(1).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["inFlight", "completed", "failed", "unresolved"]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  result: z.unknown().optional(),
  error: persistedErrorSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.status === "completed" && record.result === undefined) {
    context.addIssue({ code: "custom", message: "A completed command requires a result", path: ["result"] });
  }
  if ((record.status === "failed" || record.status === "unresolved") && record.error === undefined) {
    context.addIssue({ code: "custom", message: "A failed or unresolved command requires an error", path: ["error"] });
  }
  if (record.status !== "completed" && record.result !== undefined) {
    context.addIssue({ code: "custom", message: "Only completed commands may retain a result", path: ["result"] });
  }
  if (record.status !== "failed" && record.status !== "unresolved" && record.error !== undefined) {
    context.addIssue({ code: "custom", message: "Only failed or unresolved commands may retain an error", path: ["error"] });
  }
});

const persistedLedgerSchema = z.object({
  version: z.literal(1),
  records: z.array(persistedRecordSchema).max(16_384),
}).strict();

type PersistedRecord = z.infer<typeof persistedRecordSchema>;

function digestFingerprint(fingerprint: string): string {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

function publicStatus<Result>(record: InternalRecord<Result>): CommandStatus<Result> {
  return {
    commandId: record.commandId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function normalizeCode(value: unknown): string {
  const raw = typeof value === "string" ? value : "COMMAND_FAILED";
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 64);
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(normalized) ? normalized : "COMMAND_FAILED";
}

function publicError(error: unknown): StoredCommandError {
  if (error instanceof Error) {
    const code = normalizeCode("code" in error ? error.code : undefined);
    const retryable = "retryable" in error && error.retryable === true;
    return { code, message: error.message.slice(0, 500) || "Command failed", retryable };
  }
  return { code: "COMMAND_FAILED", message: "Command failed", retryable: false };
}

function promiseForPersisted<Result>(record: PersistedRecord): Promise<Result> {
  if (record.status === "completed") return Promise.resolve(record.result as Result);
  const error = record.error ?? {
    code: record.status === "unresolved" ? "DELIVERY_UNKNOWN" : "COMMAND_FAILED",
    message: record.status === "unresolved"
      ? "Codex may have accepted this command, but its acknowledgement was not received. The same commandId will not execute again."
      : "Command failed",
    retryable: record.status === "unresolved",
  };
  const promise = Promise.reject<Result>(new RecordedCommandError(error));
  void promise.catch(() => undefined);
  return promise;
}

export class IdempotencyLedger<Result> {
  readonly #records = new Map<string, InternalRecord<Result>>();
  readonly maximumRecords: number;
  readonly retentionMs: number;
  readonly persistencePath?: string;
  readonly #isAmbiguousError: (error: unknown) => boolean;
  #initialized = false;
  #initializePromise: Promise<void> | null = null;
  #persistQueue = Promise.resolve();
  readonly #activeFinalizations = new Set<Promise<void>>();
  #closed = false;

  constructor(options: IdempotencyLedgerOptions = {}) {
    this.maximumRecords = options.maximumRecords ?? 16_384;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.maximumRecords) || this.maximumRecords < 1 || this.maximumRecords > 16_384) {
      throw new Error("maximumRecords must be an integer from 1 through 16384");
    }
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 0) {
      throw new Error("retentionMs must be a non-negative safe integer");
    }
    if (options.persistencePath !== undefined) this.persistencePath = options.persistencePath;
    this.#isAmbiguousError = options.isAmbiguousError ?? (() => false);
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Idempotency ledger is closed"));
    if (this.#initialized) return Promise.resolve();
    this.#initializePromise ??= this.#load();
    return this.#initializePromise;
  }

  async execute(
    deviceId: string,
    commandId: string,
    fingerprint: string,
    operation: () => Promise<Result>,
  ): Promise<IdempotentExecution<Result>> {
    if (this.#closed) throw new Error("Idempotency ledger is closed");
    // startBridge initializes the ledger before serving requests. Avoid an
    // otherwise unnecessary resolved-promise yield so a new in-memory
    // reservation is visible before another HTTP command can race admission.
    if (!this.#initialized) await this.initialize();
    const duplicate = this.existing(deviceId, commandId, fingerprint);
    if (duplicate !== null) return duplicate;
    this.#pruneExpired();
    if (this.#records.size >= this.maximumRecords) throw new IdempotencyCapacityError();

    const now = Date.now();
    const key = this.#key(commandId);
    const fingerprintDigest = digestFingerprint(fingerprint);
    let resolveRecord!: (result: Result) => void;
    let rejectRecord!: (error: unknown) => void;
    const recordPromise = new Promise<Result>((resolve, reject) => {
      resolveRecord = resolve;
      rejectRecord = reject;
    });
    // A duplicate may observe this promise while the initial durable
    // reservation is still being written. It must remain pending until the
    // one real operation reaches a durable terminal outcome.
    void recordPromise.catch(() => undefined);
    const record: InternalRecord<Result> = {
      deviceId,
      commandId,
      status: "inFlight",
      createdAt: now,
      updatedAt: now,
      fingerprint: fingerprintDigest,
      promise: recordPromise,
    };
    this.#records.set(key, record);
    try {
      await this.#persist();
    } catch (error) {
      this.#records.delete(key);
      rejectRecord(error);
      throw error;
    }

    const finalization = Promise.resolve()
      .then(operation)
      .then(
        async (result) => {
          record.status = "completed";
          record.updatedAt = Date.now();
          record.result = result;
          try {
            await this.#persist();
          } catch {
            const unknown = new DeliveryUnknownError("Codex acknowledged this command, but the acknowledgement could not be durably recorded. The same commandId will not execute again in this bridge process.");
            record.status = "unresolved";
            delete record.result;
            record.error = publicError(unknown);
            rejectRecord(unknown);
            return;
          }
          resolveRecord(result);
        },
        async (error: unknown) => {
          record.updatedAt = Date.now();
          if (this.#isAmbiguousError(error)) {
            const unknown = new DeliveryUnknownError();
            record.status = "unresolved";
            record.error = publicError(unknown);
            await this.#persist().catch(() => undefined);
            rejectRecord(unknown);
            return;
          }
          record.status = "failed";
          record.error = publicError(error);
          try {
            await this.#persist();
          } catch {
            const unknown = new DeliveryUnknownError("The command outcome could not be durably recorded. The same commandId will not execute again in this bridge process.");
            record.status = "unresolved";
            record.error = publicError(unknown);
            rejectRecord(unknown);
            return;
          }
          rejectRecord(error);
        },
      )
      .catch(async () => {
        const unknown = new DeliveryUnknownError("The command outcome could not be finalized safely. The same commandId will not execute again in this bridge process.");
        record.status = "unresolved";
        record.updatedAt = Date.now();
        delete record.result;
        record.error = publicError(unknown);
        await this.#persist().catch(() => undefined);
        rejectRecord(unknown);
      });
    this.#activeFinalizations.add(finalization);
    void finalization
      .finally(() => this.#activeFinalizations.delete(finalization))
      .catch(() => undefined);
    return { duplicate: false, promise: recordPromise };
  }

  /**
   * Synchronous duplicate lookup used before command admission. Command IDs
   * are global across credential rotation; deviceId is retained only as
   * creator metadata on the first durable reservation.
   */
  existing(
    _deviceId: string,
    commandId: string,
    fingerprint: string,
  ): IdempotentExecution<Result> | null {
    if (this.#closed) throw new Error("Idempotency ledger is closed");
    if (!this.#initialized) throw new Error("Idempotency ledger must be initialized before duplicate reads");
    this.#pruneExpired();
    const record = this.#records.get(this.#key(commandId));
    if (record === undefined) return null;
    if (record.fingerprint !== digestFingerprint(fingerprint)) throw new IdempotencyCollisionError();
    return { duplicate: true, promise: record.promise };
  }

  status(_deviceId: string, commandId: string): CommandStatus<Result> | null {
    if (this.#closed) throw new Error("Idempotency ledger is closed");
    if (!this.#initialized) throw new Error("Idempotency ledger must be initialized before status reads");
    this.#pruneExpired();
    const record = this.#records.get(this.#key(commandId));
    return record === undefined ? null : publicStatus(record);
  }

  unresolved(): readonly UnresolvedCommandMetadata[] {
    if (!this.#initialized) throw new Error("Idempotency ledger must be initialized before unresolved reads");
    return [...this.#records.values()]
      .filter((record) => record.status === "unresolved")
      .map((record) => ({
        deviceId: record.deviceId,
        commandId: record.commandId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.commandId.localeCompare(right.commandId));
  }

  async forgetUnresolved(deviceId: string, commandId: string): Promise<boolean> {
    if (this.#closed) throw new Error("Idempotency ledger is closed");
    await this.initialize();
    const key = this.#key(commandId);
    const record = this.#records.get(key);
    if (record === undefined || record.deviceId !== deviceId || record.status !== "unresolved") return false;
    this.#records.delete(key);
    try {
      await this.#persist();
    } catch (error) {
      this.#records.set(key, record);
      throw error;
    }
    return true;
  }

  /** Stop new access and wait for every queued snapshot write to settle. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#activeFinalizations]);
    await this.#persistQueue;
  }

  #key(commandId: string): string {
    return commandId;
  }

  async #load(): Promise<void> {
    let records: PersistedRecord[] = [];
    if (this.persistencePath !== undefined) {
      try {
        await assertPrivateRegularFile(this.persistencePath);
        const raw = await readFile(this.persistencePath, "utf8");
        records = persistedLedgerSchema.parse(JSON.parse(raw) as unknown).records;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    let recovered = false;
    const now = Date.now();
    for (const stored of records) {
      if ((stored.status === "completed" || stored.status === "failed") && now - stored.updatedAt >= this.retentionMs) {
        recovered = true;
        continue;
      }
      const normalized: PersistedRecord = stored.status === "inFlight"
        ? {
            ...stored,
            status: "unresolved",
            updatedAt: now,
            error: {
              code: "DELIVERY_UNKNOWN",
              message: "The bridge restarted before this command acknowledgement was durably recorded. The same commandId will not execute again.",
              retryable: true,
            },
          }
        : stored;
      recovered ||= normalized !== stored;
      const record: InternalRecord<Result> = {
        deviceId: normalized.deviceId,
        commandId: normalized.commandId,
        fingerprint: normalized.fingerprint,
        status: normalized.status,
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
        ...(normalized.result === undefined ? {} : { result: normalized.result as Result }),
        ...(normalized.error === undefined ? {} : { error: normalized.error }),
        promise: promiseForPersisted<Result>(normalized),
      };
      const key = this.#key(record.commandId);
      const existing = this.#records.get(key);
      if (existing === undefined) {
        this.#records.set(key, record);
      } else {
        // Version 1 ledgers scoped IDs by credential. Credential rotation can
        // therefore reveal multiple historical owners for one commandId. A
        // conservative unresolved record prevents either payload from running
        // again while retaining only the first creator as audit metadata.
        const collision = new DeliveryUnknownError(
          "This commandId existed under more than one historical device credential. Its outcome requires manual reconciliation and it will not execute again.",
        );
        existing.status = "unresolved";
        existing.createdAt = Math.min(existing.createdAt, record.createdAt);
        existing.updatedAt = now;
        delete existing.result;
        existing.error = publicError(collision);
        existing.promise = promiseForPersisted<Result>({
          deviceId: existing.deviceId,
          commandId: existing.commandId,
          fingerprint: existing.fingerprint,
          status: existing.status,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          error: existing.error,
        });
        recovered = true;
      }
    }
    this.#pruneExpired(now, false);
    if (this.#records.size > this.maximumRecords) {
      throw new IdempotencyCapacityError();
    }
    this.#initialized = true;
    if (recovered) await this.#persist();
  }

  #pruneExpired(now = Date.now(), persist = true): void {
    let changed = false;
    for (const [key, record] of this.#records) {
      if ((record.status === "completed" || record.status === "failed") && now - record.updatedAt >= this.retentionMs) {
        this.#records.delete(key);
        changed = true;
      }
    }
    if (changed && persist) void this.#persist().catch(() => undefined);
  }

  #persist(): Promise<void> {
    if (this.persistencePath === undefined) return Promise.resolve();
    const records = [...this.#records.values()].map((record): PersistedRecord => ({
      deviceId: record.deviceId,
      commandId: record.commandId,
      fingerprint: record.fingerprint,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }));
    const file = persistedLedgerSchema.parse({ version: 1, records });
    const run = this.#persistQueue.then(() => withPrivateFileLock(
      this.persistencePath as string,
      () => atomicWritePrivateJson(this.persistencePath as string, file),
    ));
    this.#persistQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export interface CommandLedgerAdminOptions {
  paths?: BridgeDataPaths;
  dataRoot?: string;
}

async function readPersistedRecords(path: string): Promise<PersistedRecord[]> {
  try {
    await assertPrivateRegularFile(path);
    return persistedLedgerSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown).records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function withOfflineLedgerRecords<T>(
  options: CommandLedgerAdminOptions,
  operation: (records: PersistedRecord[], path: string) => Promise<T>,
): Promise<T> {
  const paths = options.paths ?? defaultDataPaths(options.dataRoot);
  return withBridgeLifetimeLease(paths, () => withPrivateFileLock(paths.idempotency, async () => {
    const records = await readPersistedRecords(paths.idempotency);
    return operation(records, paths.idempotency);
  }));
}

/** Offline administrative read; returns IDs and timestamps only, never payload fingerprints or outcomes. */
export async function listUnresolvedCommands(
  options: CommandLedgerAdminOptions = {},
): Promise<readonly UnresolvedCommandMetadata[]> {
  return withOfflineLedgerRecords(options, async (records) => records
    .filter((record) => record.status === "unresolved" || record.status === "inFlight")
    .map((record) => ({
      deviceId: record.deviceId,
      commandId: record.commandId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
    .sort((left, right) => left.updatedAt - right.updatedAt || left.commandId.localeCompare(right.commandId)));
}

/**
 * Offline administrative deletion for one exact unresolved record. The CLI
 * owns the explicit acknowledgement gate and warns that execution may already
 * have happened before invoking this function.
 */
export async function forgetUnresolvedCommand(
  deviceId: string,
  commandId: string,
  options: CommandLedgerAdminOptions = {},
): Promise<boolean> {
  return withOfflineLedgerRecords(options, async (records, path) => {
    const index = records.findIndex((record) => (
      record.deviceId === deviceId
      && record.commandId === commandId
      && (record.status === "unresolved" || record.status === "inFlight")
    ));
    if (index < 0) return false;
    records.splice(index, 1);
    await atomicWritePrivateJson(path, persistedLedgerSchema.parse({ version: 1, records }));
    return true;
  });
}

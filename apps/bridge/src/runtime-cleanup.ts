import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeDataPaths } from "./paths.js";

const SKETCH_DIRECTORY_MODE = 0o700;
const SKETCH_FILE_MODE = 0o600;
const SKETCH_NAME = /^sketch-[a-f0-9]{36}\.png$/u;
const MAX_NORMALIZED_SKETCH_BYTES = 8 * 1024 * 1024;

export const DEFAULT_STALE_SKETCH_AGE_MS = 15 * 60 * 1_000;
export const DEFAULT_RUNTIME_CLEANUP_SCAN_LIMIT = 512;
export const DEFAULT_RUNTIME_CLEANUP_REMOVE_LIMIT = 128;
export const DEFAULT_RUNTIME_CLEANUP_INTERVAL_MS = 15 * 60 * 1_000;

export interface RuntimeCleanupOptions {
  now?: () => number;
  minimumAgeMs?: number;
  scanLimit?: number;
  removeLimit?: number;
}

export interface RuntimeCleanupScheduleOptions extends RuntimeCleanupOptions {
  intervalMs?: number;
}

export interface RuntimeCleanupReport {
  directoryState: "absent" | "untrusted" | "verified";
  scanned: number;
  removed: number;
  failed: number;
  truncated: boolean;
}

export interface RuntimeCleanupLogger {
  warn(message: string): void;
}

export class UnsafeRuntimeDirectoryError extends Error {
  readonly code = "UNSAFE_RUNTIME_DIRECTORY";
  constructor() {
    super("Normalized uploads require exact private Codex Pad runtime directories");
    this.name = "UnsafeRuntimeDirectoryError";
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`Runtime cleanup bound must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function emptyReport(directoryState: RuntimeCleanupReport["directoryState"]): RuntimeCleanupReport {
  return { directoryState, scanned: 0, removed: 0, failed: 0, truncated: false };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function establishPrivateDirectory(path: string, currentUid: number): Promise<void> {
  try {
    await mkdir(path, { mode: SKETCH_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const details = await lstat(path).catch(() => null);
  if (
    details === null
    || details.isSymbolicLink()
    || !details.isDirectory()
    || details.uid !== currentUid
    || (details.mode & 0o777) !== SKETCH_DIRECTORY_MODE
  ) {
    throw new UnsafeRuntimeDirectoryError();
  }
}

/** Creates missing exact directories but never follows or chmods an existing entry. */
export async function ensurePrivateSketchDirectory(paths: BridgeDataPaths): Promise<string> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw new UnsafeRuntimeDirectoryError();
  await establishPrivateDirectory(paths.runtime, currentUid);
  const directoryPath = join(paths.runtime, "sketches");
  await establishPrivateDirectory(directoryPath, currentUid);
  return directoryPath;
}

/**
 * Removes only old, private, CodexPad-named normalized PNGs from the exact
 * Application Support runtime/sketches directory. No recursive operation is
 * used, and O_NOFOLLOW prevents opening a symlink as a candidate file.
 */
export async function scavengeStaleRuntimeSketches(
  paths: BridgeDataPaths,
  options: RuntimeCleanupOptions = {},
): Promise<RuntimeCleanupReport> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) return emptyReport("untrusted");

  const now = options.now?.() ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_STALE_SKETCH_AGE_MS;
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1) {
    throw new RangeError("Runtime cleanup minimum age must be a positive integer");
  }
  const scanLimit = boundedInteger(
    options.scanLimit,
    DEFAULT_RUNTIME_CLEANUP_SCAN_LIMIT,
    4_096,
  );
  const removeLimit = boundedInteger(
    options.removeLimit,
    DEFAULT_RUNTIME_CLEANUP_REMOVE_LIMIT,
    512,
  );
  const directoryPath = join(paths.runtime, "sketches");

  let runtimeDetails;
  try {
    runtimeDetails = await lstat(paths.runtime);
  } catch (error) {
    if (isMissing(error)) return emptyReport("absent");
    throw error;
  }
  if (
    runtimeDetails.isSymbolicLink()
    || !runtimeDetails.isDirectory()
    || runtimeDetails.uid !== currentUid
    || (runtimeDetails.mode & 0o777) !== SKETCH_DIRECTORY_MODE
  ) {
    return emptyReport("untrusted");
  }

  let directoryDetails;
  try {
    directoryDetails = await lstat(directoryPath);
  } catch (error) {
    if (isMissing(error)) return emptyReport("absent");
    throw error;
  }
  if (
    directoryDetails.isSymbolicLink()
    || !directoryDetails.isDirectory()
    || directoryDetails.uid !== currentUid
    || (directoryDetails.mode & 0o777) !== SKETCH_DIRECTORY_MODE
  ) {
    return emptyReport("untrusted");
  }

  const report = emptyReport("verified");
  const directory = await opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (report.scanned >= scanLimit || report.removed >= removeLimit) {
        report.truncated = true;
        break;
      }
      report.scanned += 1;
      if (!SKETCH_NAME.test(entry.name) || entry.isSymbolicLink()) continue;

      const candidatePath = join(directoryPath, entry.name);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(candidatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const details = await handle.stat();
        if (
          !details.isFile()
          || details.uid !== currentUid
          || (details.mode & 0o777) !== SKETCH_FILE_MODE
          || details.nlink !== 1
          || details.size > MAX_NORMALIZED_SKETCH_BYTES
          || now - details.mtimeMs < minimumAgeMs
        ) {
          continue;
        }
        await unlink(candidatePath);
        report.removed += 1;
      } catch (error) {
        if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ELOOP") {
          report.failed += 1;
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return report;
}

/** Startup wrapper: cleanup failures never prevent the authenticated bridge from starting. */
export async function runStartupRuntimeCleanup(
  paths: BridgeDataPaths,
  logger: RuntimeCleanupLogger,
  options: RuntimeCleanupOptions = {},
): Promise<void> {
  try {
    const report = await scavengeStaleRuntimeSketches(paths, options);
    if (report.directoryState === "untrusted") {
      logger.warn("Codex Pad skipped stale sketch cleanup because the private runtime directory could not be verified.");
    }
    if (report.removed > 0) {
      logger.warn(`Codex Pad removed ${report.removed} stale normalized sketch upload(s).`);
    }
    if (report.failed > 0 || report.truncated) {
      logger.warn("Codex Pad left some runtime sketch entries untouched; cleanup remained bounded and will retry at a later startup.");
    }
  } catch {
    logger.warn("Codex Pad could not inspect stale normalized sketch uploads; bridge startup continued without deleting runtime files.");
  }
}

export interface RuntimeCleanupSchedule {
  runNow(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Runs once before returning, then retries at a low frequency so an upload
 * that was still young during an immediate restart cannot live indefinitely.
 */
export async function startRuntimeCleanupSchedule(
  paths: BridgeDataPaths,
  logger: RuntimeCleanupLogger,
  options: RuntimeCleanupScheduleOptions = {},
): Promise<RuntimeCleanupSchedule> {
  const intervalMs = boundedInteger(
    options.intervalMs,
    DEFAULT_RUNTIME_CLEANUP_INTERVAL_MS,
    24 * 60 * 60 * 1_000,
  );
  if (intervalMs < 1_000) {
    throw new RangeError("Runtime cleanup interval must be at least 1 second");
  }
  const cleanupOptions: RuntimeCleanupOptions = {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.minimumAgeMs === undefined ? {} : { minimumAgeMs: options.minimumAgeMs }),
    ...(options.scanLimit === undefined ? {} : { scanLimit: options.scanLimit }),
    ...(options.removeLimit === undefined ? {} : { removeLimit: options.removeLimit }),
  };
  let stopped = false;
  let activeRun: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    if (stopped) return;
    activeRun ??= runStartupRuntimeCleanup(paths, logger, cleanupOptions)
      .finally(() => { activeRun = null; });
    await activeRun;
  };
  await run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  return {
    runNow: run,
    async stop() {
      if (stopped) {
        await activeRun;
        return;
      }
      stopped = true;
      clearInterval(timer);
      await activeRun;
    },
  };
}

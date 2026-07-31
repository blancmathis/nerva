import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LOCK_METADATA_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const MAX_LOCK_METADATA_BYTES = 4_096;
const LOCK_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

interface PrivateLockMetadata {
  version: typeof LOCK_METADATA_VERSION;
  kind: "lock";
  token: string;
  pid: number;
  processStartIdentity: string | null;
  acquiredAtMs: number;
}

interface ReclaimMetadata {
  version: typeof LOCK_METADATA_VERSION;
  kind: "reclaim";
  token: string;
  targetToken: string;
  pid: number;
  processStartIdentity: string | null;
  acquiredAtMs: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface ObservedLock {
  identity: FileIdentity;
  metadata: PrivateLockMetadata;
  modifiedAtMs: number;
  legacy: boolean;
}

interface ObservedReclaimClaim {
  identity: FileIdentity;
  metadata: ReclaimMetadata;
  modifiedAtMs: number;
}

interface InvalidLock {
  issue: string;
}

type LockObservation = ObservedLock | InvalidLock | null;

export interface PrivateFileLockOptions {
  /** How long an acquisition may wait before failing closed. */
  timeoutMs?: number;
  /** Minimum metadata and filesystem age before a dead owner may be reclaimed. */
  staleAfterMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Dependency seams used by deterministic tests; production callers should omit them. */
  isProcessAlive?: (pid: number) => Promise<boolean>;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
}

interface ResolvedPrivateFileLockOptions {
  timeoutMs: number;
  staleAfterMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  isProcessAlive: (pid: number) => Promise<boolean>;
  readProcessStartIdentity: (pid: number) => Promise<string | null>;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isDirectory()) {
      throw new Error(`Expected a private directory at ${path}`);
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && details.uid !== currentUid) {
      throw new Error(`Refusing a private directory not owned by the current user: ${path}`);
    }
    // Change permissions through the already-verified descriptor. A path
    // replacement between lstat/chmod must never redirect this operation.
    await handle.chmod(0o700);
  } catch (error) {
    if (errno(error) === "ELOOP") {
      throw new Error(`Refusing a symbolic link as a private directory: ${path}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function assertPrivateRegularFile(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile()) {
      throw new Error(`Expected a regular file at ${path}`);
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && details.uid !== currentUid) {
      throw new Error(`Refusing a private file not owned by the current user: ${path}`);
    }
    if (details.nlink !== 1) {
      throw new Error(`Refusing a hard-linked private file at ${path}`);
    }
    if ((details.mode & 0o777) !== 0o600) {
      throw new Error(`Refusing insecure permissions on ${path}; expected mode 0600`);
    }
  } catch (error) {
    if (errno(error) === "ELOOP") {
      throw new Error(`Refusing a symbolic link as a private file: ${path}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function resolveLockOptions(options: PrivateFileLockOptions): ResolvedPrivateFileLockOptions {
  const resolved: ResolvedPrivateFileLockOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    retryMinMs: options.retryMinMs ?? 10,
    retryMaxMs: options.retryMaxMs ?? 100,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    readProcessStartIdentity: options.readProcessStartIdentity ?? defaultReadProcessStartIdentity,
  };
  assertNonNegativeSafeInteger("timeoutMs", resolved.timeoutMs);
  assertNonNegativeSafeInteger("staleAfterMs", resolved.staleAfterMs);
  if (!Number.isSafeInteger(resolved.retryMinMs) || resolved.retryMinMs <= 0) {
    throw new Error("retryMinMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(resolved.retryMaxMs) || resolved.retryMaxMs < resolved.retryMinMs) {
    throw new Error("retryMaxMs must be a safe integer greater than or equal to retryMinMs");
  }
  return resolved;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function defaultIsProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errno(error) === "ESRCH") return false;
    // EPERM and unknown platform errors are deliberately treated as alive.
    // Availability must never win over deleting a possibly active lock.
    return true;
  }
}

async function readLinuxProcessStartIdentity(pid: number): Promise<string | null> {
  try {
    const [statLine, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "unknown-boot"),
    ]);
    const closingParenthesis = statLine.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    // Fields after the command name begin at proc field 3. Start time is field 22.
    const tail = statLine.slice(closingParenthesis + 1).trim().split(/\s+/u);
    const startTicks = tail[19];
    return startTicks === undefined ? null : `linux:${bootId.trim()}:${startTicks}`;
  } catch {
    return null;
  }
}

async function readPsProcessStartIdentity(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFile("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 1_000,
      maxBuffer: 4_096,
      windowsHide: true,
    });
    const normalized = stdout.trim().replace(/\s+/gu, " ");
    return normalized.length === 0 ? null : `ps:${normalized}`;
  } catch {
    return null;
  }
}

async function defaultReadProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") return readLinuxProcessStartIdentity(pid);
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return readPsProcessStartIdentity(pid);
  }
  return null;
}

function isPrivateLockMetadata(value: unknown): value is PrivateLockMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PrivateLockMetadata>;
  return candidate.version === LOCK_METADATA_VERSION
    && candidate.kind === "lock"
    && typeof candidate.token === "string"
    && LOCK_TOKEN_PATTERN.test(candidate.token)
    && Number.isSafeInteger(candidate.pid)
    && (candidate.pid ?? 0) > 0
    && (candidate.processStartIdentity === null
      || (typeof candidate.processStartIdentity === "string"
        && candidate.processStartIdentity.length > 0
        && candidate.processStartIdentity.length <= 512))
    && Number.isSafeInteger(candidate.acquiredAtMs)
    && (candidate.acquiredAtMs ?? 0) > 0;
}

function isReclaimMetadata(value: unknown): value is ReclaimMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ReclaimMetadata>;
  return candidate.version === LOCK_METADATA_VERSION
    && candidate.kind === "reclaim"
    && typeof candidate.token === "string"
    && LOCK_TOKEN_PATTERN.test(candidate.token)
    && typeof candidate.targetToken === "string"
    && LOCK_TOKEN_PATTERN.test(candidate.targetToken)
    && Number.isSafeInteger(candidate.pid)
    && (candidate.pid ?? 0) > 0
    && (candidate.processStartIdentity === null
      || (typeof candidate.processStartIdentity === "string"
        && candidate.processStartIdentity.length > 0
        && candidate.processStartIdentity.length <= 512))
    && Number.isSafeInteger(candidate.acquiredAtMs)
    && (candidate.acquiredAtMs ?? 0) > 0;
}

function parseLegacyLockMetadata(text: string, identity: FileIdentity): PrivateLockMetadata | null {
  const match = /^(\d+)\n(\d+)\n?$/u.exec(text);
  if (match === null) return null;
  const pid = Number(match[1]);
  const acquiredAtMs = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(acquiredAtMs) || acquiredAtMs <= 0) {
    return null;
  }
  const token = createHash("sha256")
    .update(`legacy\0${identity.dev}\0${identity.ino}\0${pid}\0${acquiredAtMs}`)
    .digest("hex");
  return {
    version: LOCK_METADATA_VERSION,
    kind: "lock",
    token,
    pid,
    processStartIdentity: null,
    acquiredAtMs,
  };
}

async function observeLock(lockPath: string): Promise<LockObservation> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    if (errno(error) === "ELOOP") return { issue: "the lock path is a symbolic link" };
    throw error;
  }

  try {
    const details = await handle.stat();
    if (!details.isFile()) return { issue: "the lock path is not a regular file" };
    if ((details.mode & 0o077) !== 0) return { issue: "the lock permissions are not private mode 0600" };
    if (details.size <= 0 || details.size > MAX_LOCK_METADATA_BYTES) {
      return { issue: "the lock metadata size is invalid" };
    }
    const text = await handle.readFile("utf8");
    const identity = { dev: details.dev, ino: details.ino };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      const legacy = parseLegacyLockMetadata(text, identity);
      if (legacy === null) return { issue: "the lock metadata is malformed" };
      return { identity, metadata: legacy, modifiedAtMs: details.mtimeMs, legacy: true };
    }
    if (!isPrivateLockMetadata(parsed)) return { issue: "the lock metadata is malformed" };
    return { identity, metadata: parsed, modifiedAtMs: details.mtimeMs, legacy: false };
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function createPrivateLinkedFile(path: string, value: unknown): Promise<boolean> {
  const directory = dirname(path);
  const token = randomBytes(16).toString("hex");
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${token}.candidate`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error) {
      if (errno(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((error: unknown) => {
      if (errno(error) !== "ENOENT") throw error;
    });
  }
}

function reclaimPathFor(lockPath: string, targetToken: string): string {
  return `${lockPath}.reclaim-${targetToken}`;
}

function reclaimOwnerPath(claimPath: string): string {
  return join(claimPath, "owner.json");
}

async function createPrivateClaimDirectory(path: string, metadata: ReclaimMetadata): Promise<boolean> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(16).toString("hex")}.candidate-dir`,
  );
  let directoryCreated = false;
  let ownerHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(temporaryPath, { mode: 0o700 });
    directoryCreated = true;
    ownerHandle = await open(
      reclaimOwnerPath(temporaryPath),
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await ownerHandle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await ownerHandle.sync();
    await ownerHandle.close();
    ownerHandle = undefined;
    const temporaryDirectoryHandle = await open(temporaryPath, fsConstants.O_RDONLY);
    try {
      await temporaryDirectoryHandle.sync();
    } finally {
      await temporaryDirectoryHandle.close();
    }
    // Node does not expose renameat2(RENAME_NOREPLACE). The authoritative
    // claim directories created by this implementation are non-empty, so the
    // preflight plus rename preserves no-replace semantics between compliant
    // contenders: a concurrent populated winner makes rename fail ENOTEMPTY.
    try {
      await lstat(path);
      return false;
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    try {
      await rename(temporaryPath, path);
      directoryCreated = false;
      return true;
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(errno(error) ?? "")) return false;
      throw error;
    }
  } finally {
    await ownerHandle?.close().catch(() => undefined);
    if (directoryCreated) {
      await unlink(reclaimOwnerPath(temporaryPath)).catch((error: unknown) => {
        if (errno(error) !== "ENOENT") throw error;
      });
      await rmdir(temporaryPath).catch((error: unknown) => {
        if (errno(error) !== "ENOENT") throw error;
      });
    }
  }
}

async function observeReclaimClaim(path: string): Promise<ObservedReclaimClaim | InvalidLock | null> {
  let directoryDetails: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryDetails = await lstat(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
  if (directoryDetails.isSymbolicLink()) return { issue: "the reclaim claim path is a symbolic link" };
  if (!directoryDetails.isDirectory()) return { issue: "the reclaim claim path is not a directory" };
  if ((directoryDetails.mode & 0o077) !== 0) {
    return { issue: "the reclaim claim directory permissions are not private mode 0700" };
  }

  let ownerHandle: Awaited<ReturnType<typeof open>>;
  try {
    ownerHandle = await open(reclaimOwnerPath(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errno(error) === "ENOENT") return { issue: "the reclaim claim owner metadata is missing" };
    if (errno(error) === "ELOOP") return { issue: "the reclaim claim owner metadata is a symbolic link" };
    throw error;
  }
  try {
    const ownerDetails = await ownerHandle.stat();
    if (!ownerDetails.isFile()) return { issue: "the reclaim claim owner metadata is not a regular file" };
    if ((ownerDetails.mode & 0o077) !== 0) {
      return { issue: "the reclaim claim owner permissions are not private mode 0600" };
    }
    if (ownerDetails.size <= 0 || ownerDetails.size > MAX_LOCK_METADATA_BYTES) {
      return { issue: "the reclaim claim owner metadata size is invalid" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await ownerHandle.readFile("utf8")) as unknown;
    } catch {
      return { issue: "the reclaim claim owner metadata is malformed" };
    }
    if (!isReclaimMetadata(parsed)) return { issue: "the reclaim claim owner metadata is malformed" };
    return {
      identity: { dev: directoryDetails.dev, ino: directoryDetails.ino },
      metadata: parsed,
      modifiedAtMs: Math.max(directoryDetails.mtimeMs, ownerDetails.mtimeMs),
    };
  } finally {
    await ownerHandle.close();
  }
}

interface AcquiredReclaimClaim {
  metadata: ReclaimMetadata;
  path: string;
  identity: FileIdentity;
}

type ReclaimClaimAcquisition =
  | { claim: AcquiredReclaimClaim; issue?: never }
  | { claim: null; issue: string };

async function tryCreateReclaimClaim(
  lockPath: string,
  targetToken: string,
  processStartIdentity: string | null,
): Promise<AcquiredReclaimClaim | null> {
  const metadata: ReclaimMetadata = {
    version: LOCK_METADATA_VERSION,
    kind: "reclaim",
    token: randomBytes(32).toString("hex"),
    targetToken,
    pid: process.pid,
    processStartIdentity,
    acquiredAtMs: Date.now(),
  };
  const path = reclaimPathFor(lockPath, targetToken);
  if (!await createPrivateClaimDirectory(path, metadata)) return null;
  const observed = await observeReclaimClaim(path);
  if (observed === null || "issue" in observed || observed.metadata.token !== metadata.token) {
    throw new Error(`Could not verify newly acquired private reclaim claim ${path}`);
  }
  return { metadata, path, identity: observed.identity };
}

async function quarantineStaleReclaimClaim(
  path: string,
  observed: ObservedReclaimClaim,
): Promise<boolean> {
  const quarantinePath = `${path}.stale-${observed.metadata.token}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(errno(error) ?? "")) return false;
    throw error;
  }
  const quarantined = await observeReclaimClaim(quarantinePath);
  if (quarantined !== null
    && !("issue" in quarantined)
    && quarantined.metadata.token === observed.metadata.token
    && sameIdentity(quarantined.identity, observed.identity)) {
    // Keep this tiny private tombstone. A delayed contender that inspected the
    // old generation cannot then rename a newly acquired claim over the same
    // destination. It does not occupy the authoritative claim path.
    return true;
  }
  if (await observeReclaimClaim(path) === null) {
    await rename(quarantinePath, path).catch(() => undefined);
  }
  throw new Error(`Private reclaim claim ownership changed at ${path}; refusing recovery`);
}

type LockDisposition =
  | { reclaimable: true }
  | { reclaimable: false; issue: string };

async function classifyOwnedGeneration(
  metadata: Pick<PrivateLockMetadata, "pid" | "processStartIdentity" | "acquiredAtMs">,
  modifiedAtMs: number,
  options: ResolvedPrivateFileLockOptions,
  identityCache: Map<number, Promise<string | null>>,
): Promise<LockDisposition> {
  const now = Date.now();
  const metadataAgeMs = now - metadata.acquiredAtMs;
  const filesystemAgeMs = now - modifiedAtMs;
  if (metadataAgeMs < options.staleAfterMs || filesystemAgeMs < options.staleAfterMs) {
    return { reclaimable: false, issue: "the owner metadata or filesystem object is too young to reclaim" };
  }

  if (!await options.isProcessAlive(metadata.pid)) return { reclaimable: true };
  if (metadata.processStartIdentity === null) {
    return {
      reclaimable: false,
      issue: `PID ${metadata.pid} is alive and the stored start identity is unavailable`,
    };
  }
  let identityPromise = identityCache.get(metadata.pid);
  if (identityPromise === undefined) {
    identityPromise = options.readProcessStartIdentity(metadata.pid);
    identityCache.set(metadata.pid, identityPromise);
  }
  const currentIdentity = await identityPromise;
  if (currentIdentity === null) {
    return {
      reclaimable: false,
      issue: `PID ${metadata.pid} is alive and its current start identity could not be verified`,
    };
  }
  if (currentIdentity === metadata.processStartIdentity) {
    return { reclaimable: false, issue: `PID ${metadata.pid} still owns the lock generation` };
  }
  // A live PID with a different start identity is a reused PID, not the owner
  // recorded in this lock.
  return { reclaimable: true };
}

async function classifyLock(
  observed: ObservedLock,
  options: ResolvedPrivateFileLockOptions,
  identityCache: Map<number, Promise<string | null>>,
): Promise<LockDisposition> {
  return classifyOwnedGeneration(observed.metadata, observed.modifiedAtMs, options, identityCache);
}

async function classifyReclaimClaim(
  observed: ObservedReclaimClaim,
  options: ResolvedPrivateFileLockOptions,
  identityCache: Map<number, Promise<string | null>>,
): Promise<LockDisposition> {
  return classifyOwnedGeneration(observed.metadata, observed.modifiedAtMs, options, identityCache);
}

async function acquireReclaimClaim(
  lockPath: string,
  targetToken: string,
  selfStartIdentity: string | null,
  options: ResolvedPrivateFileLockOptions,
  identityCache: Map<number, Promise<string | null>>,
): Promise<ReclaimClaimAcquisition> {
  const created = await tryCreateReclaimClaim(lockPath, targetToken, selfStartIdentity);
  if (created !== null) return { claim: created };
  const path = reclaimPathFor(lockPath, targetToken);
  const observed = await observeReclaimClaim(path);
  if (observed === null) return { claim: null, issue: "the competing reclaim claim disappeared" };
  if ("issue" in observed) return { claim: null, issue: observed.issue };
  if (observed.metadata.targetToken !== targetToken) {
    return { claim: null, issue: "the reclaim claim targets a different lock generation" };
  }
  const disposition = await classifyReclaimClaim(observed, options, identityCache);
  if (!disposition.reclaimable) return { claim: null, issue: disposition.issue };
  if (!await quarantineStaleReclaimClaim(path, observed)) {
    return { claim: null, issue: "another process is recovering this stale reclaim claim" };
  }
  const recovered = await tryCreateReclaimClaim(lockPath, targetToken, selfStartIdentity);
  return recovered === null
    ? { claim: null, issue: "another process acquired the recovered reclaim claim" }
    : { claim: recovered };
}

async function releaseReclaimClaim(claim: AcquiredReclaimClaim): Promise<void> {
  const current = await observeReclaimClaim(claim.path);
  if (current === null || "issue" in current
    || current.metadata.token !== claim.metadata.token
    || current.metadata.targetToken !== claim.metadata.targetToken
    || !sameIdentity(current.identity, claim.identity)) {
    throw new Error(`Private file-lock reclaim ownership changed at ${claim.path}; refusing to remove it`);
  }

  const releasedPath = `${claim.path}.released-${claim.metadata.token}`;
  await rename(claim.path, releasedPath);
  const released = await observeReclaimClaim(releasedPath);
  if (released === null || "issue" in released
    || released.metadata.token !== claim.metadata.token
    || !sameIdentity(released.identity, claim.identity)) {
    throw new Error(`Private file-lock reclaim ownership changed at ${claim.path}; refusing cleanup`);
  }
  // The authoritative path was released atomically. Cleanup is best-effort;
  // a crash here leaves only a non-authoritative private tombstone.
  await unlink(reclaimOwnerPath(releasedPath)).catch(() => undefined);
  await rmdir(releasedPath).catch(() => undefined);
}

async function tryReclaimLock(
  lockPath: string,
  candidate: ObservedLock,
  options: ResolvedPrivateFileLockOptions,
  selfStartIdentity: string | null,
  identityCache: Map<number, Promise<string | null>>,
): Promise<{ reclaimed: boolean; issue?: string }> {
  const acquisition = await acquireReclaimClaim(
    lockPath,
    candidate.metadata.token,
    selfStartIdentity,
    options,
    identityCache,
  );
  if (acquisition.claim === null) return { reclaimed: false, issue: acquisition.issue };
  const claim = acquisition.claim;
  try {
    const current = await observeLock(lockPath);
    if (current === null) return { reclaimed: false, issue: "the stale lock disappeared" };
    if ("issue" in current) return { reclaimed: false, issue: current.issue };
    if (current.metadata.token !== candidate.metadata.token || !sameIdentity(current.identity, candidate.identity)) {
      return { reclaimed: false, issue: "the lock generation changed before recovery" };
    }
    const disposition = await classifyLock(current, options, identityCache);
    if (!disposition.reclaimable) return { reclaimed: false, issue: disposition.issue };
    await unlink(lockPath);
    return { reclaimed: true };
  } finally {
    await releaseReclaimClaim(claim);
  }
}

async function releaseOwnedLock(
  lockPath: string,
  owner: PrivateLockMetadata,
  identity: FileIdentity,
  selfStartIdentity: string | null,
  options: ResolvedPrivateFileLockOptions,
  identityCache: Map<number, Promise<string | null>>,
): Promise<void> {
  const acquisition = await acquireReclaimClaim(
    lockPath,
    owner.token,
    selfStartIdentity,
    options,
    identityCache,
  );
  if (acquisition.claim === null) {
    throw new Error(
      `Could not verify private file-lock release ownership at ${lockPath}; ${acquisition.issue}; refusing to remove it`,
    );
  }
  const claim = acquisition.claim;
  try {
    const current = await observeLock(lockPath);
    if (current === null || "issue" in current
      || current.metadata.token !== owner.token
      || !sameIdentity(current.identity, identity)) {
      throw new Error(`Private file-lock ownership changed at ${lockPath}; refusing to remove it`);
    }
    await unlink(lockPath);
  } finally {
    await releaseReclaimClaim(claim);
  }
}

export async function withPrivateFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: PrivateFileLockOptions = {},
): Promise<T> {
  const resolved = resolveLockOptions(options);
  const lockPath = `${path}.lock`;
  await ensurePrivateDirectory(dirname(path));
  const deadline = Date.now() + resolved.timeoutMs;
  const ownerToken = randomBytes(32).toString("hex");
  const selfStartIdentity = await resolved.readProcessStartIdentity(process.pid);
  const identityCache = new Map<number, Promise<string | null>>();
  identityCache.set(process.pid, Promise.resolve(selfStartIdentity));
  let delayMs = resolved.retryMinMs;
  let lastIssue = "another owner holds the lock";

  for (;;) {
    const owner: PrivateLockMetadata = {
      version: LOCK_METADATA_VERSION,
      kind: "lock",
      token: ownerToken,
      pid: process.pid,
      processStartIdentity: selfStartIdentity,
      acquiredAtMs: Date.now(),
    };
    if (await createPrivateLinkedFile(lockPath, owner)) {
      const observed = await observeLock(lockPath);
      if (observed === null || "issue" in observed || observed.metadata.token !== owner.token) {
        throw new Error(`Could not verify newly acquired private file lock ${lockPath}`);
      }
      try {
        return await operation();
      } finally {
        await releaseOwnedLock(
          lockPath,
          owner,
          observed.identity,
          selfStartIdentity,
          resolved,
          identityCache,
        );
      }
    }

    const observed = await observeLock(lockPath);
    if (observed === null) continue;
    if ("issue" in observed) {
      lastIssue = observed.issue;
    } else {
      const disposition = await classifyLock(observed, resolved, identityCache);
      if (disposition.reclaimable) {
        const recovery = await tryReclaimLock(
          lockPath,
          observed,
          resolved,
          selfStartIdentity,
          identityCache,
        );
        if (recovery.reclaimed) continue;
        lastIssue = recovery.issue ?? "another process is reclaiming this exact stale lock generation";
      } else {
        lastIssue = disposition.issue;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for private file lock ${lockPath}; ${lastIssue}. The lock was left intact (fail-closed).`,
      );
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
    delayMs = Math.min(resolved.retryMaxMs, delayMs * 2);
  }
}

import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { atomicWritePrivateJson, ensurePrivateDirectory } from "./atomic-file.js";
import { defaultDataPaths } from "./paths.js";
import type { VerifiedMultiImageInputCapability } from "./thread-transport.js";

const CAPABILITY_FILE_NAME = "image-input-capability.json";
const MAX_CAPABILITY_RECORD_BYTES = 16 * 1024;
const MAX_SCHEMA_MANIFEST_BYTES = 64 * 1024;
const MAX_SCHEMA_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SCHEMA_FILES = 10_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PROBE = "runtime-disposable-thread-bounded-multi-local-image" as const;

const absoluteBinaryPathSchema = z.string().min(1).max(4_096).refine(
  (value) => isAbsolute(value) && !value.includes("\0"),
  "Expected an absolute binary path",
);

const imageInputCapabilityRecordSchema = z.object({
  version: z.literal(1),
  codexBinaryPath: absoluteBinaryPathSchema,
  codexVersion: z.string().min(1).max(512),
  serverUserAgent: z.string().min(1).max(512),
  verifiedAt: z.iso.datetime(),
  probe: z.literal(PROBE),
  singleImageStartVerified: z.literal(true),
  maxStartImages: z.literal(12),
  maxSteerImages: z.literal(0),
  disposableThreadDeleted: z.literal(true),
  schemaSha256: z.string().regex(SHA256_PATTERN),
}).strict();

const relativeSchemaPathSchema = z.string().min(1).max(4_096).refine((value) => {
  if (value.includes("\0") || value.startsWith("/") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Expected a normalized relative schema path");

const protocolSchemaManifestSchema = z.object({
  formatVersion: z.literal(1),
  codexBinary: absoluteBinaryPathSchema,
  codexBinarySha256: z.string().regex(SHA256_PATTERN).optional(),
  codexVersion: z.string().min(1).max(512),
  generatedAt: z.iso.datetime(),
  schemaSha256: z.string().regex(SHA256_PATTERN),
  files: z.array(relativeSchemaPathSchema).min(1).max(MAX_SCHEMA_FILES).refine(
    (files) => new Set(files).size === files.length,
    "Expected unique schema paths",
  ),
}).strict();

export type ImageInputCapabilityRecord = z.infer<typeof imageInputCapabilityRecordSchema>;

export interface ImageInputCapabilityEvidence {
  readonly securityDirectory: string;
  readonly codexBinaryPath: string;
  readonly codexVersion: string;
  readonly serverUserAgent: string;
  readonly verifiedAt: string;
  /**
   * SHA-256 of the exact app-server schema used by the disposable probe.
   * The caller must compute and validate it against its trusted schema source.
   */
  readonly schemaSha256: string;
}

export interface ExpectedImageInputCapabilityIdentity {
  readonly securityDirectory: string;
  readonly codexBinaryPath: string;
  readonly codexVersion: string;
  /** The caller must recompute or otherwise validate this trusted expected hash. */
  readonly schemaSha256: string;
}

export interface InstalledImageInputCapabilityIdentity {
  readonly codexBinaryPath: string;
  readonly codexVersion: string;
  /** Override only for tests or an explicitly configured bridge data root. */
  readonly dataRoot?: string;
}

export type ImageInputAttestationStatus = "absent" | "valid" | "invalid-or-stale";

export interface InstalledImageInputCapabilityInspection {
  readonly attestationStatus: ImageInputAttestationStatus;
  readonly capability?: VerifiedMultiImageInputCapability;
}

function capabilityPath(securityDirectory: string): string {
  return join(securityDirectory, CAPABILITY_FILE_NAME);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

interface RegularFileMetadata {
  readonly mode: number;
  readonly nlink: number;
  isFile(): boolean;
}

function isPrivateRegularFile(details: RegularFileMetadata): boolean {
  return details.isFile() && details.nlink === 1 && (details.mode & 0o777) === 0o600;
}

async function boundedRead(handle: Awaited<ReturnType<typeof open>>): Promise<string | undefined> {
  const buffer = Buffer.allocUnsafe(MAX_CAPABILITY_RECORD_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset === 0 || offset > MAX_CAPABILITY_RECORD_BYTES) return undefined;
  return buffer.subarray(0, offset).toString("utf8");
}

async function readRegularFileNoFollow(path: string, maximumBytes: number): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maximumBytes) return undefined;
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size > maximumBytes
    ) {
      return undefined;
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== contents.length
      || after.size > maximumBytes
    ) {
      return undefined;
    }
    return contents;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hashSchemaDirectory(root: string): Promise<{
  readonly hash: string;
  readonly files: readonly string[];
} | undefined> {
  const rootMetadata = await lstat(root).catch(() => undefined);
  if (rootMetadata === undefined || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    return undefined;
  }

  const digest = createHash("sha256");
  const files: string[] = [];
  async function visit(directory: string): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) return false;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute).catch(() => undefined);
      if (metadata === undefined || metadata.isSymbolicLink()) return false;
      if (metadata.isDirectory()) {
        if (!(await visit(absolute))) return false;
      } else if (metadata.isFile()) {
        if (entry.name === "manifest.json") continue;
        if (files.length >= MAX_SCHEMA_FILES) return false;
        const contents = await readRegularFileNoFollow(absolute, MAX_SCHEMA_FILE_BYTES);
        if (contents === undefined) return false;
        const relativePath = absolute.slice(root.length + 1);
        // Keep this byte-for-byte aligned with setup/doctor schema hashing.
        digest.update(relativePath);
        digest.update("\0");
        digest.update(contents);
        digest.update("\0");
        files.push(relativePath);
      } else {
        return false;
      }
    }
    return true;
  }

  if (!(await visit(root)) || files.length === 0) return undefined;
  return {
    hash: digest.digest("hex"),
    files,
  };
}

async function capabilityRecordExists(securityDirectory: string): Promise<boolean> {
  if (!isAbsolute(securityDirectory)) return false;
  try {
    await lstat(capabilityPath(securityDirectory));
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

async function validInstalledSchemaHashes(
  cacheDirectory: string,
  identity: InstalledImageInputCapabilityIdentity,
): Promise<readonly string[]> {
  const schemaRoot = join(cacheDirectory, "app-server-schemas");
  const rootMetadata = await lstat(schemaRoot).catch(() => undefined);
  if (rootMetadata === undefined || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return [];
  const entries = await readdir(schemaRoot, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return [];

  const hashes: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(schemaRoot, entry.name);
    const manifestContents = await readRegularFileNoFollow(
      join(directory, "manifest.json"),
      MAX_SCHEMA_MANIFEST_BYTES,
    );
    if (manifestContents === undefined) continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(manifestContents.toString("utf8")) as unknown;
    } catch {
      continue;
    }
    const parsed = protocolSchemaManifestSchema.safeParse(parsedJson);
    if (
      !parsed.success
      || parsed.data.codexBinary !== identity.codexBinaryPath
      || parsed.data.codexVersion !== identity.codexVersion
    ) {
      continue;
    }
    const actual = await hashSchemaDirectory(directory);
    if (
      actual !== undefined
      && actual.hash === parsed.data.schemaSha256
      && JSON.stringify(actual.files) === JSON.stringify(parsed.data.files)
    ) {
      hashes.push(actual.hash);
    }
  }
  return hashes;
}

/**
 * Persist only the fixed, bounded proof shape accepted by Codex Pad. The caller
 * supplies the schema hash; this module deliberately does not infer it from a
 * mutable schema directory.
 */
export async function writeImageInputCapabilityRecord(
  evidence: ImageInputCapabilityEvidence,
): Promise<ImageInputCapabilityRecord> {
  const recordResult = imageInputCapabilityRecordSchema.safeParse({
    version: 1,
    codexBinaryPath: evidence.codexBinaryPath,
    codexVersion: evidence.codexVersion,
    serverUserAgent: evidence.serverUserAgent,
    verifiedAt: evidence.verifiedAt,
    probe: PROBE,
    singleImageStartVerified: true,
    maxStartImages: 12,
    maxSteerImages: 0,
    disposableThreadDeleted: true,
    schemaSha256: evidence.schemaSha256,
  });
  if (!recordResult.success || !isAbsolute(evidence.securityDirectory)) {
    throw new Error("Invalid image-input capability evidence");
  }

  try {
    const beforeDirectory = await lstat(evidence.securityDirectory).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (beforeDirectory?.isSymbolicLink() || (beforeDirectory !== undefined && !beforeDirectory.isDirectory())) {
      throw new Error("unsafe-directory");
    }

    await ensurePrivateDirectory(evidence.securityDirectory);
    const directory = await lstat(evidence.securityDirectory);
    if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o777) !== 0o700) {
      throw new Error("unsafe-directory");
    }

    const target = capabilityPath(evidence.securityDirectory);
    const existing = await lstat(target).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isFile())) {
      throw new Error("unsafe-target");
    }

    await atomicWritePrivateJson(target, recordResult.data);
    const written = await lstat(target);
    if (written.isSymbolicLink() || !isPrivateRegularFile(written)) {
      throw new Error("unsafe-result");
    }
    return recordResult.data;
  } catch {
    // This error is intentionally path-free: a caller may surface it in a
    // remote diagnostic response, where local filesystem details do not belong.
    throw new Error("Unable to persist the private image-input capability record");
  }
}

/**
 * Read a bounded private record without following its final symlink. Every
 * invalid, missing, insecure, or unreadable state is the same fail-closed
 * result, and no local path is included in that result.
 */
export async function readImageInputCapabilityRecord(
  securityDirectory: string,
): Promise<ImageInputCapabilityRecord | undefined> {
  if (!isAbsolute(securityDirectory)) return undefined;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const directory = await lstat(securityDirectory);
    if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o777) !== 0o700) {
      return undefined;
    }

    const target = capabilityPath(securityDirectory);
    const before = await lstat(target);
    if (before.isSymbolicLink() || !isPrivateRegularFile(before) || before.size > MAX_CAPABILITY_RECORD_BYTES) {
      return undefined;
    }

    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !isPrivateRegularFile(opened)
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size > MAX_CAPABILITY_RECORD_BYTES
    ) {
      return undefined;
    }

    const raw = await boundedRead(handle);
    if (raw === undefined) return undefined;
    const after = await handle.stat();
    if (
      !isPrivateRegularFile(after)
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size > MAX_CAPABILITY_RECORD_BYTES
    ) {
      return undefined;
    }

    const parsed = imageInputCapabilityRecordSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Project persisted evidence only when it belongs to the exact current toolchain. */
export async function readVerifiedMultiImageInputCapability(
  expected: ExpectedImageInputCapabilityIdentity,
): Promise<VerifiedMultiImageInputCapability | undefined> {
  const record = await readImageInputCapabilityRecord(expected.securityDirectory);
  if (
    record === undefined
    || record.codexBinaryPath !== expected.codexBinaryPath
    || record.codexVersion !== expected.codexVersion
    || record.schemaSha256 !== expected.schemaSha256
  ) {
    return undefined;
  }

  return {
    verified: true,
    serverUserAgent: record.serverUserAgent,
    verifiedAt: record.verifiedAt,
    probe: record.probe,
    maxImages: record.maxStartImages,
  };
}

/**
 * Inspect the installed-version cache and private attestation without probing
 * or exposing either local path. Presence is reported only so the local CLI can
 * distinguish the normal no-attestation state from stale/tampered evidence.
 */
export async function inspectInstalledMultiImageInputCapability(
  identity: InstalledImageInputCapabilityIdentity,
): Promise<InstalledImageInputCapabilityInspection> {
  const paths = defaultDataPaths(identity.dataRoot);
  const recordExists = await capabilityRecordExists(paths.security);
  if (!recordExists) return { attestationStatus: "absent" };
  if (
    !absoluteBinaryPathSchema.safeParse(identity.codexBinaryPath).success
    || identity.codexVersion.trim().length === 0
    || identity.codexVersion.length > 512
  ) {
    return { attestationStatus: "invalid-or-stale" };
  }

  try {
    const hashes = await validInstalledSchemaHashes(paths.cache, identity);
    for (const schemaSha256 of hashes) {
      const capability = await readVerifiedMultiImageInputCapability({
        securityDirectory: paths.security,
        codexBinaryPath: identity.codexBinaryPath,
        codexVersion: identity.codexVersion,
        schemaSha256,
      });
      if (capability !== undefined) {
        return { attestationStatus: "valid", capability };
      }
    }
  } catch {
    // Fail closed. This inspection result is intentionally path-free so it is
    // safe to use for a concise local warning and never becomes public proof.
  }
  return { attestationStatus: "invalid-or-stale" };
}

/** Load only a fully recomputed, exact-version, exact-binary capability. */
export async function loadInstalledMultiImageInputCapability(
  identity: InstalledImageInputCapabilityIdentity,
): Promise<VerifiedMultiImageInputCapability | undefined> {
  return (await inspectInstalledMultiImageInputCapability(identity)).capability;
}

import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const CAPABILITY_FILE_NAME = "image-input-capability.json";
const MAX_CAPABILITY_RECORD_BYTES = 16 * 1024;
const PROBE = "runtime-disposable-thread-bounded-multi-local-image";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXPECTED_RECORD_KEYS = [
  "codexBinaryPath",
  "codexVersion",
  "disposableThreadDeleted",
  "maxStartImages",
  "maxSteerImages",
  "probe",
  "schemaSha256",
  "serverUserAgent",
  "singleImageStartVerified",
  "verifiedAt",
  "version",
];

class AttestationStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "AttestationStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new AttestationStoreError(code);
}

function missing(error) {
  return error?.code === "ENOENT";
}

function currentIdentity() {
  const account = userInfo();
  const processUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !Number.isSafeInteger(account.uid)
    || processUid === undefined
    || processUid !== account.uid
    || !isAbsolute(account.homedir)
    || account.homedir.includes("\0")
  ) {
    fail("CURRENT_USER_IDENTITY_UNAVAILABLE");
  }
  return { homeDirectory: account.homedir, uid: account.uid };
}

function storeForIdentity(identity) {
  if (
    !Number.isSafeInteger(identity?.uid)
    || identity.uid < 0
    || typeof identity.homeDirectory !== "string"
    || !isAbsolute(identity.homeDirectory)
    || identity.homeDirectory.includes("\0")
  ) {
    fail("INVALID_STORE_IDENTITY");
  }
  const library = join(identity.homeDirectory, "Library");
  const applicationSupport = join(library, "Application Support");
  const applicationRoot = join(applicationSupport, "CodexPad");
  const securityDirectory = join(applicationRoot, "security");
  return {
    ...identity,
    library,
    applicationSupport,
    applicationRoot,
    securityDirectory,
    attestationPath: join(securityDirectory, CAPABILITY_FILE_NAME),
  };
}

function canonicalStore() {
  return storeForIdentity(currentIdentity());
}

export function canonicalImageInputAttestationPath() {
  return canonicalStore().attestationPath;
}

function safeDirectory(metadata, expectedUid, privateDirectory) {
  return !metadata.isSymbolicLink()
    && metadata.isDirectory()
    && metadata.uid === expectedUid
    && (privateDirectory
      ? (metadata.mode & 0o777) === 0o700
      : (metadata.mode & 0o022) === 0);
}

async function requireDirectory(path, expectedUid, privateDirectory) {
  const metadata = await lstat(path).catch((error) => {
    if (missing(error)) return undefined;
    fail("ATTESTATION_PARENT_UNSAFE");
  });
  if (metadata === undefined || !safeDirectory(metadata, expectedUid, privateDirectory)) {
    fail("ATTESTATION_PARENT_UNSAFE");
  }
  return metadata;
}

async function inspectExistingStore(store) {
  await requireDirectory(store.homeDirectory, store.uid, false);
  for (const path of [store.library, store.applicationSupport]) {
    const metadata = await lstat(path).catch((error) => {
      if (missing(error)) return undefined;
      fail("ATTESTATION_PARENT_UNSAFE");
    });
    if (metadata === undefined) return undefined;
    if (!safeDirectory(metadata, store.uid, false)) fail("ATTESTATION_PARENT_UNSAFE");
  }
  for (const path of [store.applicationRoot, store.securityDirectory]) {
    const metadata = await lstat(path).catch((error) => {
      if (missing(error)) return undefined;
      fail("ATTESTATION_PARENT_UNSAFE");
    });
    if (metadata === undefined) return undefined;
    if (!safeDirectory(metadata, store.uid, true)) fail("ATTESTATION_PARENT_UNSAFE");
  }
  return requireDirectory(store.securityDirectory, store.uid, true);
}

async function ensureStore(store) {
  await requireDirectory(store.homeDirectory, store.uid, false);
  await requireDirectory(store.library, store.uid, false);
  await requireDirectory(store.applicationSupport, store.uid, false);

  for (const path of [store.applicationRoot, store.securityDirectory]) {
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") fail("ATTESTATION_PARENT_CREATE_FAILED");
    });
    await requireDirectory(path, store.uid, true);
  }
  return requireDirectory(store.securityDirectory, store.uid, true);
}

function safeAttestationFile(metadata, expectedUid) {
  return !metadata.isSymbolicLink()
    && metadata.isFile()
    && metadata.uid === expectedUid
    && metadata.nlink === 1
    && (metadata.mode & 0o777) === 0o600
    && metadata.size > 0
    && metadata.size <= MAX_CAPABILITY_RECORD_BYTES;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validBoundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validIsoInstant(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (match === null) return false;
  const milliseconds = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const normalized = `${match[1]}.${milliseconds}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === normalized;
}

export function isStrictImageInputAttestation(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== EXPECTED_RECORD_KEYS.length) return false;
  if (!keys.every((key, index) => key === EXPECTED_RECORD_KEYS[index])) return false;
  return value.version === 1
    && validBoundedString(value.codexBinaryPath, 4_096)
    && isAbsolute(value.codexBinaryPath)
    && !value.codexBinaryPath.includes("\0")
    && validBoundedString(value.codexVersion, 512)
    && validBoundedString(value.serverUserAgent, 512)
    && validIsoInstant(value.verifiedAt)
    && value.probe === PROBE
    && value.singleImageStartVerified === true
    && value.maxStartImages === 12
    && value.maxSteerImages === 0
    && value.disposableThreadDeleted === true
    && typeof value.schemaSha256 === "string"
    && SHA256_PATTERN.test(value.schemaSha256);
}

async function readStrictAttestation(store) {
  const securityMetadata = await inspectExistingStore(store);
  if (securityMetadata === undefined) return undefined;

  let handle;
  try {
    const before = await lstat(store.attestationPath).catch((error) => {
      if (missing(error)) return undefined;
      fail("ATTESTATION_INVALIDATION_REFUSED");
    });
    if (before === undefined) return undefined;
    if (!safeAttestationFile(before, store.uid)) fail("ATTESTATION_INVALIDATION_REFUSED");

    handle = await open(
      store.attestationPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    ).catch(() => fail("ATTESTATION_INVALIDATION_REFUSED"));
    const opened = await handle.stat();
    if (!safeAttestationFile(opened, store.uid) || !sameFile(before, opened)) {
      fail("ATTESTATION_INVALIDATION_REFUSED");
    }

    const buffer = Buffer.allocUnsafe(MAX_CAPABILITY_RECORD_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0 || offset > MAX_CAPABILITY_RECORD_BYTES) {
      fail("ATTESTATION_INVALIDATION_REFUSED");
    }

    let parsed;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      parsed = JSON.parse(text);
    } catch {
      fail("ATTESTATION_INVALIDATION_REFUSED");
    }
    if (!isStrictImageInputAttestation(parsed)) fail("ATTESTATION_INVALIDATION_REFUSED");

    const after = await handle.stat();
    const finalPath = await lstat(store.attestationPath).catch(() => undefined);
    const finalParent = await lstat(store.securityDirectory).catch(() => undefined);
    if (
      !safeAttestationFile(after, store.uid)
      || !sameFile(opened, after)
      || finalPath === undefined
      || !safeAttestationFile(finalPath, store.uid)
      || !sameFile(opened, finalPath)
      || finalParent === undefined
      || !safeDirectory(finalParent, store.uid, true)
      || !sameFile(securityMetadata, finalParent)
    ) {
      fail("ATTESTATION_INVALIDATION_REFUSED");
    }
    return { handle, metadata: opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function invalidateStore(store) {
  const inspected = await readStrictAttestation(store);
  if (inspected === undefined) return;
  try {
    await unlink(store.attestationPath);
    const after = await inspected.handle.stat();
    if (after.nlink !== 0 || !sameFile(after, inspected.metadata)) {
      fail("ATTESTATION_INVALIDATION_REFUSED");
    }
  } catch {
    fail("ATTESTATION_INVALIDATION_FAILED");
  } finally {
    await inspected.handle.close().catch(() => {});
  }
}

export async function invalidateCanonicalImageInputAttestation() {
  await invalidateStore(canonicalStore());
}

async function writeStore(store, value) {
  if (!isStrictImageInputAttestation(value)) fail("ATTESTATION_WRITE_REFUSED");
  const securityMetadata = await ensureStore(store);
  const existing = await lstat(store.attestationPath).catch((error) => {
    if (missing(error)) return undefined;
    fail("ATTESTATION_WRITE_REFUSED");
  });
  if (existing !== undefined) fail("ATTESTATION_WRITE_REFUSED");

  const temporaryPath = join(
    store.securityDirectory,
    `.${basename(store.attestationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let linked = false;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const temporaryMetadata = await handle.stat();
    if (!safeAttestationFile(temporaryMetadata, store.uid)) fail("ATTESTATION_WRITE_REFUSED");

    const finalParent = await lstat(store.securityDirectory);
    if (
      !safeDirectory(finalParent, store.uid, true)
      || !sameFile(securityMetadata, finalParent)
    ) {
      fail("ATTESTATION_WRITE_REFUSED");
    }
    const targetBeforeLink = await lstat(store.attestationPath).catch((error) => {
      if (missing(error)) return undefined;
      fail("ATTESTATION_WRITE_REFUSED");
    });
    if (targetBeforeLink !== undefined) fail("ATTESTATION_WRITE_REFUSED");

    await link(temporaryPath, store.attestationPath);
    linked = true;
    await unlink(temporaryPath);

    const written = await lstat(store.attestationPath);
    if (!safeAttestationFile(written, store.uid) || !sameFile(temporaryMetadata, written)) {
      fail("ATTESTATION_WRITE_REFUSED");
    }
    const directoryHandle = await open(
      store.securityDirectory,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const openedDirectory = await directoryHandle.stat();
      if (!safeDirectory(openedDirectory, store.uid, true) || !sameFile(securityMetadata, openedDirectory)) {
        fail("ATTESTATION_WRITE_REFUSED");
      }
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (linked && handle !== undefined) {
      const target = await lstat(store.attestationPath).catch(() => undefined);
      const opened = await handle.stat().catch(() => undefined);
      if (target !== undefined && opened !== undefined && sameFile(target, opened)) {
        await unlink(store.attestationPath).catch(() => {});
      }
    }
    await unlink(temporaryPath).catch(() => {});
    if (error instanceof AttestationStoreError) throw error;
    fail("ATTESTATION_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeCanonicalImageInputAttestation(value) {
  await writeStore(canonicalStore(), value);
}

// No production caller can supply a path. This narrow seam exists only so the
// filesystem safety contract can be exercised without touching a real profile.
export const testOnlyAttestationStore = Object.freeze({
  storeForIdentity,
  invalidateStore,
  writeStore,
});

import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, opendir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeIdentity } from "@codex-pad/protocol";

const MAX_SNAPSHOT_ATTEMPTS = 3;

export interface ImmutableWebBuildSnapshot {
  readonly root: string;
  release(): Promise<void>;
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(relativePath: string): Promise<void> {
    const directoryPath = relativePath.length === 0 ? root : join(root, relativePath);
    const directory = await opendir(directoryPath);
    const entries = [];
    for await (const entry of directory) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const childRelativePath = relativePath.length === 0
        ? entry.name
        : join(relativePath, entry.name);
      const childPath = join(root, childRelativePath);
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing symlink in the Nerva web build: ${childRelativePath}`);
      }
      if (metadata.isDirectory()) {
        hash.update("\0directory\0");
        hash.update(childRelativePath);
        await visit(childRelativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Refusing non-file entry in the Nerva web build: ${childRelativePath}`);
      }
      hash.update("\0file\0");
      hash.update(childRelativePath);
      hash.update("\0");
      hash.update(await readFile(childPath));
    }
  }

  await visit("");
  return hash.digest("hex");
}

async function assertSnapshotIdentity(root: string, runtimeIdentity: RuntimeIdentity): Promise<void> {
  if (runtimeIdentity.buildRevision === "development") return;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, "app-meta.json"), "utf8")) as unknown;
  } catch {
    throw new Error("The Nerva web build is missing a readable app-meta.json identity");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("The Nerva web build identity is invalid");
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.buildRevision !== runtimeIdentity.buildRevision) {
    throw new Error("The Nerva web build revision does not match the bridge build revision");
  }
  if (metadata.apiContractVersion !== runtimeIdentity.apiContractVersion) {
    throw new Error("The Nerva web build API contract does not match the bridge API contract");
  }
}

/**
 * Freeze the generated PWA for one bridge generation.
 *
 * The repository build directory is intentionally mutable. Serving it directly
 * lets a later `npm run build` replace the PWA underneath a still-running
 * bridge, after which the exact-build mutation gate correctly rejects the new
 * client. A private snapshot keeps every response on one attested build until
 * the bridge is explicitly restarted.
 */
export async function createImmutableWebBuildSnapshot(
  sourceRoot: string,
  runtimeIdentity: RuntimeIdentity,
): Promise<ImmutableWebBuildSnapshot | null> {
  let sourceMetadata;
  try {
    sourceMetadata = await lstat(sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Nerva web build root: ${sourceRoot}`);
  }

  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const parent = await mkdtemp(join(tmpdir(), "nerva-web-build-"));
    const snapshotRoot = join(parent, "build");
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await rm(parent, { recursive: true, force: true });
    };
    try {
      await cp(sourceRoot, snapshotRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
      const [sourceDigest, snapshotDigest] = await Promise.all([
        directoryDigest(sourceRoot),
        directoryDigest(snapshotRoot),
      ]);
      if (sourceDigest !== snapshotDigest) {
        await release();
        if (attempt < MAX_SNAPSHOT_ATTEMPTS) continue;
        throw new Error("The Nerva web build changed repeatedly while the bridge was starting");
      }
      await assertSnapshotIdentity(snapshotRoot, runtimeIdentity);
      return { root: snapshotRoot, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
  throw new Error("Could not create an immutable Nerva web build snapshot");
}

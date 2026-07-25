import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface LockPackage {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly resolved?: string;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockPackage>>;
}

export interface RuntimeLicensePackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly source: string;
  readonly directFrom: readonly string[];
  readonly optional: boolean;
  readonly lockPaths: readonly string[];
}

export interface RuntimeLicenseInventory {
  readonly schemaVersion: 1;
  readonly generatedFrom: "package-lock.json";
  readonly packageLockVersion: number;
  readonly packages: readonly RuntimeLicensePackage[];
}

function packageNameFromLockPath(lockPath: string): string {
  return lockPath.split("node_modules/").at(-1) ?? lockPath;
}

/**
 * Build the external production dependency inventory from npm's lock metadata.
 * This deliberately includes platform-optional packages: a release lockfile can
 * install those artifacts on another supported machine even when they are not
 * present in the current node_modules directory.
 */
export async function collectRuntimeLicenseInventory(
  root: string,
): Promise<RuntimeLicenseInventory> {
  const lock = JSON.parse(
    await readFile(resolve(root, "package-lock.json"), "utf8"),
  ) as PackageLock;
  const packages = lock.packages;
  if (!packages || typeof lock.lockfileVersion !== "number") {
    throw new Error("package-lock.json must contain npm package metadata");
  }

  const workspaceNames = new Set(
    Object.entries(packages)
      .filter(([lockPath]) => !lockPath.includes("node_modules/"))
      .map(([, manifest]) => manifest.name)
      .filter((name): name is string => Boolean(name)),
  );
  const directFromByName = new Map<string, Set<string>>();
  for (const [lockPath, manifest] of Object.entries(packages)) {
    if (lockPath.includes("node_modules/")) continue;
    for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
      if (workspaceNames.has(dependencyName)) continue;
      const owners = directFromByName.get(dependencyName) ?? new Set<string>();
      owners.add(lockPath || ".");
      directFromByName.set(dependencyName, owners);
    }
  }

  const byIdentity = new Map<
    string,
    {
      name: string;
      version: string;
      license: string;
      source: string;
      directFrom: Set<string>;
      optional: boolean;
      lockPaths: Set<string>;
    }
  >();

  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (
      !lockPath.includes("node_modules/") ||
      metadata.dev === true ||
      !metadata.version
    ) {
      continue;
    }
    const name = packageNameFromLockPath(lockPath);
    if (workspaceNames.has(name)) continue;

    const identity = `${name}@${metadata.version}`;
    const existing = byIdentity.get(identity);
    if (existing) {
      if (
        existing.license !== (metadata.license ?? "") ||
        existing.source !== (metadata.resolved ?? "")
      ) {
        throw new Error(`conflicting lock metadata for ${identity}`);
      }
      existing.optional &&= metadata.optional === true;
      existing.lockPaths.add(lockPath);
      continue;
    }

    byIdentity.set(identity, {
      name,
      version: metadata.version,
      license: metadata.license ?? "",
      source: metadata.resolved ?? "",
      directFrom: new Set(directFromByName.get(name) ?? []),
      optional: metadata.optional === true,
      lockPaths: new Set([lockPath]),
    });
  }

  return {
    schemaVersion: 1,
    generatedFrom: "package-lock.json",
    packageLockVersion: lock.lockfileVersion,
    packages: [...byIdentity.values()]
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(
          `${right.name}@${right.version}`,
          "en",
        ),
      )
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        license: entry.license,
        source: entry.source,
        directFrom: [...entry.directFrom].sort(),
        optional: entry.optional,
        lockPaths: [...entry.lockPaths].sort(),
      })),
  };
}

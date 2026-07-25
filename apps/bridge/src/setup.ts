import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDesktopOwnershipAttestation,
  defaultDesktopOwnershipAttestationPath,
  type CreateDesktopOwnershipAttestationOptions,
  type DesktopOwnershipInstallation,
  type OwnershipCommandRunner,
} from "./desktop-ownership.js";

export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 8787;

export interface CodexPadConfig {
  readonly version: 1;
  readonly bridge: {
    readonly host: typeof DEFAULT_BRIDGE_HOST;
    readonly port: number;
  };
  readonly tailscale: {
    readonly serveHttpsPort: 443;
  };
}

export interface CodexPadPaths {
  readonly root: string;
  readonly config: string;
  readonly security: string;
  readonly runtime: string;
  readonly cache: string;
  readonly desktopOwnershipAttestation: string;
}

export interface SetupResult {
  readonly ok: boolean;
  readonly created: readonly string[];
  readonly existing: readonly string[];
  readonly paths: CodexPadPaths;
  readonly config: CodexPadConfig;
  readonly notes: readonly string[];
  readonly schema?: ProtocolSchemaManifest;
  readonly ownershipAttestation?: {
    readonly createdAt: string;
    readonly evidenceSha256: string;
  };
}

export interface SetupDependencies {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly protocolSchema?: ProtocolSchemaGenerationOptions;
  readonly desktopOwnership?: {
    readonly installation: DesktopOwnershipInstallation;
    readonly socketPath?: string;
    readonly runCommand: OwnershipCommandRunner;
    readonly collectEvidence?: CreateDesktopOwnershipAttestationOptions["collectEvidence"];
    readonly now?: () => Date;
  };
}

export interface ProtocolSchemaManifest {
  readonly formatVersion: 1;
  readonly codexBinary: string;
  readonly codexVersion: string;
  readonly generatedAt: string;
  readonly schemaSha256: string;
  readonly files: readonly string[];
}

export interface ProtocolSchemaGenerationOptions {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly binaryVersion: string;
  readonly run: (
    executable: string,
    arguments_: readonly string[],
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  readonly now?: () => Date;
}

export function codexPadPaths(homeDirectory = homedir()): CodexPadPaths {
  const root = join(homeDirectory, "Library", "Application Support", "CodexPad");
  return {
    root,
    config: join(root, "config.json"),
    security: join(root, "security"),
    runtime: join(root, "runtime"),
    cache: join(root, "cache"),
    desktopOwnershipAttestation: defaultDesktopOwnershipAttestationPath(homeDirectory),
  };
}

export function defaultConfig(): CodexPadConfig {
  return {
    version: 1,
    bridge: {
      host: DEFAULT_BRIDGE_HOST,
      port: DEFAULT_BRIDGE_PORT,
    },
    tailscale: {
      serveHttpsPort: 443,
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(
  path: string,
  created: string[],
  existing: string[],
): Promise<void> {
  if (await pathExists(path)) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) {
      throw new Error(`Refusing to replace non-directory path: ${path}`);
    }
    await chmod(path, 0o700);
    existing.push(path);
    return;
  }

  await mkdir(path, { mode: 0o700, recursive: false });
  await chmod(path, 0o700);
  created.push(path);
}

async function writeJsonAtomicExclusive(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  const temporaryPath = join(
    parent,
    `.config.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporaryPath, "wx", 0o600);

  try {
    await handle.writeFile(payload, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    // `link` is exclusive: unlike rename on Unix it cannot overwrite a config
    // created by a concurrent setup process.
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    await chmod(path, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function safeVersionDirectory(version: string): string {
  const safe = version.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "unknown-version";
}

async function collectSchemaFiles(
  root: string,
  current = root,
): Promise<readonly { readonly relativePath: string; readonly contents: Buffer }[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const collected: { relativePath: string; contents: Buffer }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectSchemaFiles(root, absolute)));
    } else if (entry.isFile()) {
      const relativePath = absolute.slice(root.length + 1);
      if (relativePath !== "manifest.json") {
        collected.push({ relativePath, contents: await readFile(absolute) });
      }
    }
  }
  return collected;
}

export async function generateProtocolSchemas(
  paths: CodexPadPaths,
  options: ProtocolSchemaGenerationOptions,
): Promise<ProtocolSchemaManifest | undefined> {
  if (!options.enabled) {
    return undefined;
  }

  const protocolCache = join(paths.cache, "app-server-schemas");
  const destination = join(protocolCache, safeVersionDirectory(options.binaryVersion));
  const manifestPath = join(destination, "manifest.json");
  if (await pathExists(manifestPath)) {
    return JSON.parse(await readFile(manifestPath, "utf8")) as ProtocolSchemaManifest;
  }

  await mkdir(protocolCache, { mode: 0o700, recursive: true });
  await chmod(protocolCache, 0o700);
  const temporary = join(
    protocolCache,
    `.schema.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await mkdir(temporary, { mode: 0o700 });

  try {
    const result = await options.run(options.binaryPath, [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      temporary,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Codex schema generation failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const files = await collectSchemaFiles(temporary);
    if (files.length === 0) {
      throw new Error("Codex schema generation completed without producing schema files.");
    }
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(file.contents);
      hash.update("\0");
    }
    const manifest: ProtocolSchemaManifest = {
      formatVersion: 1,
      codexBinary: options.binaryPath,
      codexVersion: options.binaryVersion,
      generatedAt: (options.now ?? (() => new Date()))().toISOString(),
      schemaSha256: hash.digest("hex"),
      files: files.map((file) => file.relativePath),
    };
    const manifestHandle = await open(join(temporary, "manifest.json"), "wx", 0o600);
    await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await manifestHandle.close();
    await rename(temporary, destination);
    return manifest;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

function parseExistingConfig(raw: string, path: string): CodexPadConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${String(error)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("bridge" in parsed) ||
    typeof parsed.bridge !== "object" ||
    parsed.bridge === null ||
    !("host" in parsed.bridge) ||
    parsed.bridge.host !== DEFAULT_BRIDGE_HOST ||
    !("port" in parsed.bridge) ||
    typeof parsed.bridge.port !== "number" ||
    !Number.isInteger(parsed.bridge.port) ||
    parsed.bridge.port < 1 ||
    parsed.bridge.port > 65_535
  ) {
    throw new Error(
      `Unsupported Codex Pad config in ${path}; setup will not overwrite it. ` +
        `The bridge host must remain ${DEFAULT_BRIDGE_HOST}.`,
    );
  }

  return {
    version: 1,
    bridge: {
      host: DEFAULT_BRIDGE_HOST,
      port: parsed.bridge.port,
    },
    tailscale: {
      serveHttpsPort: 443,
    },
  };
}

/**
 * Creates only Codex Pad-owned local state. It intentionally does not bootstrap
 * Codex app-server, change launchctl/environment state, restart Desktop, or
 * configure Tailscale.
 */
export async function setupCodexPad(
  dependencies: SetupDependencies = {},
): Promise<SetupResult> {
  const platform = dependencies.platform ?? process.platform;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const paths = codexPadPaths(homeDirectory);

  if (platform !== "darwin") {
    return {
      ok: false,
      created: [],
      existing: [],
      paths,
      config: defaultConfig(),
      notes: ["Codex Pad's bridge currently supports macOS only; no files were changed."],
    };
  }

  const created: string[] = [];
  const existing: string[] = [];
  // The parent is macOS-owned/user-shared state. Create it if absent, but never
  // chmod or otherwise claim it as Codex Pad state.
  await mkdir(dirname(paths.root), { recursive: true });
  await ensurePrivateDirectory(paths.root, created, existing);
  await ensurePrivateDirectory(paths.security, created, existing);
  await ensurePrivateDirectory(paths.runtime, created, existing);
  await ensurePrivateDirectory(paths.cache, created, existing);

  let config: CodexPadConfig;
  if (await pathExists(paths.config)) {
    const metadata = await lstat(paths.config);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing non-regular or symlinked config path: ${paths.config}`);
    }
    existing.push(paths.config);
    await chmod(paths.config, 0o600);
    config = parseExistingConfig(await readFile(paths.config, "utf8"), paths.config);
  } else {
    config = defaultConfig();
    await writeJsonAtomicExclusive(paths.config, config);
    created.push(paths.config);
  }

  const schema = dependencies.protocolSchema
    ? await generateProtocolSchemas(paths, dependencies.protocolSchema)
    : undefined;
  const ownershipExisted = await pathExists(paths.desktopOwnershipAttestation);
  const ownershipAttestation = dependencies.desktopOwnership
    ? await createDesktopOwnershipAttestation({
        attestationPath: paths.desktopOwnershipAttestation,
        socketPath: dependencies.desktopOwnership.socketPath
          ?? join(homeDirectory, ".codex", "app-server-control", "app-server-control.sock"),
        installation: dependencies.desktopOwnership.installation,
        platform,
        runCommand: dependencies.desktopOwnership.runCommand,
        ...(dependencies.desktopOwnership.collectEvidence === undefined
          ? {}
          : { collectEvidence: dependencies.desktopOwnership.collectEvidence }),
        ...(dependencies.desktopOwnership.now === undefined
          ? {}
          : { now: dependencies.desktopOwnership.now }),
      })
    : undefined;
  if (ownershipAttestation !== undefined) {
    (ownershipExisted ? existing : created).push(paths.desktopOwnershipAttestation);
  }

  return {
    ok: true,
    created,
    existing,
    paths,
    config,
    notes: [
      "Only Codex Pad Application Support state was created or permission-hardened.",
      "Managed app-server bootstrap, Codex Desktop restart, and Tailscale Serve remain explicit user actions.",
      ...(ownershipAttestation === undefined
        ? ["Desktop ownership attestation was not changed."]
        : ["Desktop ownership was attested only after a positive current process/socket topology probe."]),
    ],
    ...(schema ? { schema } : {}),
    ...(ownershipAttestation
      ? {
          ownershipAttestation: {
            createdAt: ownershipAttestation.createdAt,
            evidenceSha256: ownershipAttestation.evidenceSha256,
          },
        }
      : {}),
  };
}

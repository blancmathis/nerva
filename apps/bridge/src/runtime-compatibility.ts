import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Ajv from "ajv";
import { AppServerClient } from "./app-server-client.js";

export type RuntimeCapabilityState = "available" | "unavailable" | "unverified";

export type RuntimeCapabilityId =
  | "sessions"
  | "models"
  | "skills"
  | "usage"
  | "exactTaskMutations"
  | "taskCreation";

export interface RuntimeCapabilityResult {
  readonly id: RuntimeCapabilityId;
  readonly state: RuntimeCapabilityState;
  readonly reason: string;
}

export interface RuntimeCompatibilityResult {
  readonly state: "compatible" | "limited" | "unavailable";
  readonly source: "live" | "cache" | "none";
  readonly userAgent?: string;
  readonly desktopBinarySha256?: string;
  readonly daemonBinarySha256?: string;
  readonly desktopSchemaSha256?: string;
  readonly daemonSchemaSha256?: string;
  readonly capabilities: readonly RuntimeCapabilityResult[];
  readonly checkedAt: string;
  readonly detail: string;
}

export interface ProbeRuntimeCompatibilityOptions {
  readonly desktopBinaryPath: string;
  readonly desktopVersion?: string;
  readonly daemonBinaryPath: string;
  readonly daemonVersion?: string;
  readonly socketPath: string;
  readonly cacheRoot: string;
  readonly attestationPath: string;
  readonly now?: () => Date;
  readonly connect?: typeof AppServerClient.connectManaged;
}

interface SchemaManifest {
  readonly formatVersion: 1;
  readonly codexBinary: string;
  readonly codexBinarySha256: string;
  readonly codexVersion: string;
  readonly schemaSha256: string;
  readonly files: readonly string[];
}

interface CompatibilityAttestation {
  readonly formatVersion: 1;
  readonly key: string;
  readonly result: RuntimeCompatibilityResult;
}

const UUID = "00000000-0000-4000-8000-000000000001";
const READ_SAMPLES: Readonly<Record<"sessions" | "models" | "skills" | "usage", unknown>> = {
  sessions: {
    id: 1,
    method: "thread/list",
    params: {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    },
  },
  models: { id: 2, method: "model/list", params: { limit: 100, includeHidden: false } },
  skills: { id: 3, method: "skills/list", params: { cwds: ["/"], forceReload: false } },
  usage: { id: 4, method: "account/rateLimits/read", params: null },
};

const MUTATION_SAMPLES: Readonly<Record<"exactTaskMutations" | "taskCreation", readonly unknown[]>> = {
  exactTaskMutations: [
    {
      id: 5,
      method: "thread/settings/update",
      params: { threadId: UUID, effort: "low" },
    },
    {
      id: 6,
      method: "turn/start",
      params: {
        threadId: UUID,
        clientUserMessageId: UUID,
        input: [{ type: "text", text: "compatibility probe", text_elements: [] }],
      },
    },
    {
      id: 7,
      method: "turn/steer",
      params: {
        threadId: UUID,
        expectedTurnId: UUID,
        clientUserMessageId: UUID,
        input: [{ type: "text", text: "compatibility probe", text_elements: [] }],
      },
    },
  ],
  taskCreation: [
    { id: 8, method: "thread/start", params: { ephemeral: false } },
    { id: 9, method: "thread/fork", params: { threadId: UUID, ephemeral: false } },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readManifest(
  cacheRoot: string,
  version: string | undefined,
  expectedBinaryPath: string,
  expectedBinarySha256: string,
): Promise<{ readonly directory: string; readonly manifest: SchemaManifest } | undefined> {
  if (!version) return undefined;
  const schemaRoot = join(cacheRoot, "app-server-schemas");
  try {
    const entries = await readdir(schemaRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const directory = join(schemaRoot, entry.name);
      const result = await readManifestDirectory(
        directory,
        version,
        expectedBinaryPath,
        expectedBinarySha256,
      );
      if (result) return result;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readManifestDirectory(
  directory: string,
  version: string,
  expectedBinaryPath: string,
  expectedBinarySha256: string,
): Promise<{ readonly directory: string; readonly manifest: SchemaManifest } | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown;
    if (!isRecord(value) || value.formatVersion !== 1 || typeof value.codexVersion !== "string"
      || typeof value.codexBinary !== "string" || typeof value.schemaSha256 !== "string"
      || typeof value.codexBinarySha256 !== "string"
      || !Array.isArray(value.files) || value.files.some((file) => typeof file !== "string")) {
      return undefined;
    }
    const manifest = value as unknown as SchemaManifest;
    if (manifest.codexVersion !== version
      || manifest.codexBinarySha256 !== expectedBinarySha256
      || await realpath(manifest.codexBinary) !== await realpath(expectedBinaryPath)) return undefined;
    const collected: Array<{ readonly relative: string; readonly contents: Buffer }> = [];
    async function visit(current: string): Promise<void> {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(current, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile() && entry.name !== "manifest.json") {
          collected.push({ relative: absolute.slice(directory.length + 1), contents: await readFile(absolute) });
        }
      }
    }
    await visit(directory);
    const digest = createHash("sha256");
    for (const file of collected) {
      digest.update(file.relative);
      digest.update("\0");
      digest.update(file.contents);
      digest.update("\0");
    }
    if (digest.digest("hex") !== manifest.schemaSha256
      || JSON.stringify(collected.map((file) => file.relative)) !== JSON.stringify(manifest.files)) {
      return undefined;
    }
    return { directory, manifest };
  } catch {
    return undefined;
  }
}

async function inspectSchema(
  cached: Awaited<ReturnType<typeof readManifest>>,
): Promise<Map<RuntimeCapabilityId, RuntimeCapabilityResult> | undefined> {
  if (!cached) return undefined;
  try {
    const schema = JSON.parse(await readFile(join(cached.directory, "ClientRequest.json"), "utf8"));
    const validate = new Ajv({ strict: false, allErrors: true, logger: false }).compile(schema);
    const results = new Map<RuntimeCapabilityId, RuntimeCapabilityResult>();
    for (const [id, sample] of Object.entries(READ_SAMPLES) as Array<[
      "sessions" | "models" | "skills" | "usage",
      unknown,
    ]>) {
      const available = validate(sample);
      results.set(id, {
        id,
        state: available ? "available" : "unavailable",
        reason: available
          ? "The generated request schema accepts Nerva's representative payload."
          : "The generated request schema rejects Nerva's representative payload.",
      });
    }
    for (const [id, samples] of Object.entries(MUTATION_SAMPLES) as Array<[
      "exactTaskMutations" | "taskCreation",
      readonly unknown[],
    ]>) {
      const available = samples.every((sample) => validate(sample));
      results.set(id, {
        id,
        state: available ? "available" : "unavailable",
        reason: available
          ? "The generated request schema accepts every representative Nerva mutation payload."
          : "At least one representative Nerva mutation payload is missing or incompatible.",
      });
    }
    return results;
  } catch {
    return undefined;
  }
}

function compatibleState(capabilities: readonly RuntimeCapabilityResult[]): RuntimeCompatibilityResult["state"] {
  const structural = capabilities.filter((entry) => entry.id === "sessions" || entry.id === "models");
  if (structural.some((entry) => entry.state !== "available")) return "unavailable";
  return capabilities.every((entry) => entry.state === "available") ? "compatible" : "limited";
}

function parseCachedAttestation(value: unknown, key: string): RuntimeCompatibilityResult | undefined {
  if (!isRecord(value) || value.formatVersion !== 1 || value.key !== key || !isRecord(value.result)) {
    return undefined;
  }
  const result = value.result as unknown as RuntimeCompatibilityResult;
  if (!["compatible", "limited", "unavailable"].includes(result.state)
    || !Array.isArray(result.capabilities)
    || typeof result.checkedAt !== "string"
    || Number.isNaN(Date.parse(result.checkedAt))
    || typeof result.detail !== "string"
    || result.capabilities.length !== 6
    || new Set(result.capabilities.map((entry) => entry.id)).size !== 6
    || result.capabilities.some((entry) =>
      !["sessions", "models", "skills", "usage", "exactTaskMutations", "taskCreation"].includes(entry.id)
      || !["available", "unavailable", "unverified"].includes(entry.state)
      || typeof entry.reason !== "string")) return undefined;
  return { ...result, source: "cache" };
}

async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o077) !== 0) {
    throw new Error("Compatibility cache directory is not private.");
  }
  const temporary = join(parent, `.protocol-compatibility.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function probeRuntimeCompatibility(
  options: ProbeRuntimeCompatibilityOptions,
): Promise<RuntimeCompatibilityResult> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  let desktopBinarySha256: string;
  let daemonBinarySha256: string;
  let desktopBinaryPath: string;
  let daemonBinaryPath: string;
  try {
    [desktopBinaryPath, daemonBinaryPath] = await Promise.all([
      realpath(options.desktopBinaryPath),
      realpath(options.daemonBinaryPath),
    ]);
    [desktopBinarySha256, daemonBinarySha256] = await Promise.all([
      fileSha256(resolve(desktopBinaryPath)),
      fileSha256(resolve(daemonBinaryPath)),
    ]);
  } catch {
    return {
      state: "unavailable",
      source: "none",
      capabilities: [],
      checkedAt,
      detail: "The exact Desktop and daemon binaries could not be fingerprinted.",
    };
  }
  const [desktopSchema, daemonSchema] = await Promise.all([
    readManifest(options.cacheRoot, options.desktopVersion, desktopBinaryPath, desktopBinarySha256),
    readManifest(options.cacheRoot, options.daemonVersion, daemonBinaryPath, daemonBinarySha256),
  ]);
  const desktopCapabilities = await inspectSchema(desktopSchema);
  const daemonCapabilities = await inspectSchema(daemonSchema);
  const schemaCapabilities: RuntimeCapabilityResult[] = [];
  for (const id of [
    "sessions",
    "models",
    "skills",
    "usage",
    "exactTaskMutations",
    "taskCreation",
  ] as const) {
    const desktop = desktopCapabilities?.get(id);
    const daemon = daemonCapabilities?.get(id);
    const available = desktop?.state === "available" && daemon?.state === "available";
    schemaCapabilities.push({
      id,
      state: available ? "available" : desktop === undefined || daemon === undefined ? "unverified" : "unavailable",
      reason: available
        ? "Both generated schemas accept Nerva's representative payloads."
        : desktop === undefined || daemon === undefined
          ? "A current generated schema is missing or invalid."
          : "Desktop and daemon schemas do not both accept Nerva's representative payloads.",
    });
  }

  let connection: Awaited<ReturnType<typeof AppServerClient.connectManaged>> | undefined;
  try {
    connection = await (options.connect ?? AppServerClient.connectManaged)({
      codexBinaryPath: daemonBinaryPath,
      socketPath: options.socketPath,
      requestTimeoutMs: 5_000,
    });
    const userAgent = connection.client.serverInfo?.userAgent;
    const key = createHash("sha256").update(JSON.stringify({
      desktopBinarySha256,
      daemonBinarySha256,
      desktopSchemaSha256: desktopSchema?.manifest.schemaSha256 ?? null,
      daemonSchemaSha256: daemonSchema?.manifest.schemaSha256 ?? null,
      userAgent: userAgent ?? null,
    })).digest("hex");
    try {
      const [metadata, parentMetadata] = await Promise.all([
        lstat(options.attestationPath),
        lstat(dirname(options.attestationPath)),
      ]);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
        && (metadata.mode & 0o077) === 0 && (uid === undefined || metadata.uid === uid)
        && parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink()
        && (parentMetadata.mode & 0o077) === 0 && (uid === undefined || parentMetadata.uid === uid)) {
        const cached = parseCachedAttestation(
          JSON.parse(await readFile(options.attestationPath, "utf8")),
          key,
        );
        if (cached) return cached;
      }
    } catch {
      // Absence or invalid evidence triggers fresh structural reads.
    }
    const [threads, models] = await Promise.all([
      connection.client.call("thread/list", {
        limit: 1,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: true,
      }),
      connection.client.call("model/list", { limit: 1, includeHidden: false }),
    ]);
    if (!isRecord(threads) || !Array.isArray(threads.data)
      || !isRecord(models) || !Array.isArray(models.data)) {
      throw new Error("Structural read response validation failed.");
    }
    const capabilities: RuntimeCapabilityResult[] = schemaCapabilities.map((entry): RuntimeCapabilityResult =>
      entry.id === "sessions" || entry.id === "models"
        ? { ...entry, state: entry.state === "unavailable" ? "unavailable" : "available",
            reason: "The live managed daemon returned a structurally valid response and its schema is not incompatible." }
        : entry,
    );
    const result: RuntimeCompatibilityResult = {
      state: compatibleState(capabilities),
      source: "live",
      ...(userAgent ? { userAgent } : {}),
      desktopBinarySha256,
      daemonBinarySha256,
      ...(desktopSchema ? { desktopSchemaSha256: desktopSchema.manifest.schemaSha256 } : {}),
      ...(daemonSchema ? { daemonSchemaSha256: daemonSchema.manifest.schemaSha256 } : {}),
      capabilities,
      checkedAt,
      detail: "The managed daemon accepted initialize and returned valid thread/list and model/list responses.",
    };
    const keyedResult = { ...result };
    await writePrivateJsonAtomic(options.attestationPath, {
      formatVersion: 1,
      key,
      result: keyedResult,
    } satisfies CompatibilityAttestation).catch(() => undefined);
    return result;
  } catch (error) {
    return {
      state: "unavailable",
      source: "none",
      desktopBinarySha256,
      daemonBinarySha256,
      ...(desktopSchema ? { desktopSchemaSha256: desktopSchema.manifest.schemaSha256 } : {}),
      ...(daemonSchema ? { daemonSchemaSha256: daemonSchema.manifest.schemaSha256 } : {}),
      capabilities: schemaCapabilities.map((entry) =>
        entry.id === "sessions" || entry.id === "models"
          ? { ...entry, state: "unavailable", reason: "The live read-only compatibility probe failed closed." }
          : entry,
      ),
      checkedAt,
      detail: error instanceof Error ? error.message : "The live read-only compatibility probe failed.",
    };
  } finally {
    await connection?.client.close().catch(() => undefined);
  }
}

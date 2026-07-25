import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  MAX_SITE_RECORDS_PER_ASSOCIATION,
  MAX_SITE_RECORDS_PER_CONTEXT,
  SITE_RECORD_VERSION,
  SiteReviewError,
  associationKey,
  canonicalizeApprovedSiteOrigin,
  canonicalizeBridgeMagicDnsOrigin,
  canonicalizeSitePublicOrigin,
  createSiteOriginPolicy,
  deriveSitePublicOrigin,
  isLoopbackSiteOrigin,
  normalizeExactThreadUuid,
  normalizeProjectCwdIdentifier,
  normalizeSiteAssociation,
  projectCwdIdentifier,
  siteOriginPort,
  unavailableRemoteBrowserAssociation,
  type ApprovedSiteRecord,
  type ApproveSiteInput,
  type RemoteBrowserAssociation,
  type SiteAssociation,
  type SiteLookupContext,
  type SiteOriginPolicy,
} from "@codex-pad/site-review";

import {
  assertPrivateRegularFile,
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  withPrivateFileLock,
} from "./atomic-file.js";
import { type BridgeDataPaths, defaultDataPaths } from "./paths.js";

const REGISTRY_VERSION = 1 as const;
const MAX_REGISTRY_BYTES = 1_048_576;
const MAX_SITE_RECORDS = 1_000;
const SITE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export const DEFAULT_SITE_REVIEW_PORTS = [
  3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 9000,
] as const;

interface StoredRegistry {
  version: typeof REGISTRY_VERSION;
  generation: number;
  sites: ApprovedSiteRecord[];
}

export interface SiteRegistryOptions {
  originPolicy: SiteOriginPolicy;
  bridgePublicOrigin?: string;
  appSupportPath?: string;
  filePath?: string;
  now?: () => Date;
}

export interface CompatibilitySiteRegistryOptions {
  paths?: BridgeDataPaths;
  publicBridgeOrigin?: string;
  allowedLoopbackPorts?: readonly number[];
  allowedMagicDnsOrigins?: readonly string[];
}

/** Compatibility projection consumed by the bridge session list and CLI. */
export interface SiteRecord {
  associationId: string;
  targetKind: "thread" | "project";
  targetId: string;
  name: string;
  loopbackUrl: string;
  publicOrigin: string | null;
  createdAt: number;
  updatedAt: number;
  remoteBrowser: RemoteBrowserAssociation;
}

export interface AddSiteInput {
  /** Omit to create another stable site record, even for the same session. */
  siteId?: string;
  targetId: string;
  targetKind: "thread" | "project";
  loopbackUrl: string;
  publicOrigin?: string;
  name?: string;
}

function invalidRegistry(message: string): never {
  throw new SiteReviewError("SITE_NOT_APPROVED", message);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidRegistry(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeSiteId(siteId: string): string {
  if (typeof siteId !== "string" || !SITE_ID.test(siteId)) {
    throw new SiteReviewError(
      "SITE_NOT_APPROVED",
      "Site id must be 1-64 lowercase letters, digits, underscores, or hyphens",
    );
  }
  return siteId;
}

function normalizeLabel(label: string): string {
  const normalized = typeof label === "string" ? label.normalize("NFC") : label;
  if (
    typeof normalized !== "string" ||
    normalized !== normalized.trim() ||
    normalized.length < 1 ||
    normalized.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new SiteReviewError("SITE_NOT_APPROVED", "Site label must be 1-120 printable characters");
  }
  return normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStoredSites(left: ApprovedSiteRecord, right: ApprovedSiteRecord): number {
  return compareText(associationKey(left.association), associationKey(right.association))
    || compareText(left.label, right.label)
    || compareText(left.publicOrigin ?? left.origin, right.publicOrigin ?? right.origin)
    || compareText(left.siteId, right.siteId);
}

function compareContextSites(left: ApprovedSiteRecord, right: ApprovedSiteRecord): number {
  const leftScope = left.association.kind === "thread" ? 0 : 1;
  const rightScope = right.association.kind === "thread" ? 0 : 1;
  return leftScope - rightScope
    || compareText(left.label, right.label)
    || compareText(left.publicOrigin ?? left.origin, right.publicOrigin ?? right.origin)
    || compareText(left.siteId, right.siteId);
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return invalidRegistry(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function parseAssociation(value: unknown): SiteAssociation {
  const object = assertObject(value, "Site association");
  if (object.kind === "thread" && typeof object.threadId === "string") {
    return { kind: "thread", threadId: normalizeExactThreadUuid(object.threadId) };
  }
  if (object.kind === "project" && typeof object.projectCwdId === "string") {
    return {
      kind: "project",
      projectCwdId: normalizeProjectCwdIdentifier(object.projectCwdId),
    };
  }
  return invalidRegistry("Site association is invalid");
}

function parseRemoteBrowser(value: unknown): RemoteBrowserAssociation {
  const object = assertObject(value, "Remote browser association");
  if (
    object.status === "unavailable" &&
    object.reason === "thread-tab-mapping-unproven" &&
    typeof object.detail === "string"
  ) {
    return {
      status: "unavailable",
      reason: "thread-tab-mapping-unproven",
      detail: object.detail.slice(0, 512),
    };
  }
  if (
    object.status === "experimental" &&
    object.reason === "thread-tab-mapping-proven-for-session" &&
    typeof object.detail === "string" &&
    typeof object.proofId === "string" &&
    object.proofId.length > 0 &&
    object.proofId.length <= 128
  ) {
    return {
      status: "experimental",
      reason: "thread-tab-mapping-proven-for-session",
      detail: object.detail.slice(0, 512),
      proofId: object.proofId,
    };
  }
  return invalidRegistry("Remote browser association is invalid");
}

function assertPublicOriginMatchesBridge(
  publicOrigin: string | null,
  bridgePublicOrigin?: string,
): string | null {
  if (publicOrigin === null || bridgePublicOrigin === undefined) return publicOrigin;
  const bridgeHostname = new URL(bridgePublicOrigin).hostname.toLowerCase();
  const siteHostname = new URL(publicOrigin).hostname.toLowerCase();
  if (siteHostname !== bridgeHostname) {
    throw new SiteReviewError(
      "INVALID_ORIGIN",
      "Site public origin must use the exact configured bridge MagicDNS hostname",
    );
  }
  return publicOrigin;
}

function parseSiteRecord(
  value: unknown,
  policy: SiteOriginPolicy,
  bridgePublicOrigin?: string,
): ApprovedSiteRecord {
  const object = assertObject(value, "Site record");
  if (object.version !== SITE_RECORD_VERSION) invalidRegistry("Unsupported site record version");
  if (typeof object.siteId !== "string") invalidRegistry("Site record is missing siteId");
  if (typeof object.label !== "string") invalidRegistry("Site record is missing label");
  if (typeof object.origin !== "string") invalidRegistry("Site record is missing origin");
  const origin = canonicalizeApprovedSiteOrigin(object.origin, policy);
  if (
    object.publicOrigin !== undefined &&
    object.publicOrigin !== null &&
    typeof object.publicOrigin !== "string"
  ) {
    invalidRegistry("Site publicOrigin must be a string or null");
  }
  // Persisted null remains null. Derivation is an approval-time convenience,
  // not a read-time mutation of the registry contract.
  const publicOrigin = assertPublicOriginMatchesBridge(normalizePublicOrigin(
    origin,
    typeof object.publicOrigin === "string" ? object.publicOrigin : null,
  ), bridgePublicOrigin);
  return {
    version: SITE_RECORD_VERSION,
    siteId: normalizeSiteId(object.siteId),
    label: normalizeLabel(object.label),
    association: parseAssociation(object.association),
    origin,
    publicOrigin,
    approvedAt: normalizeTimestamp(object.approvedAt, "approvedAt"),
    updatedAt: normalizeTimestamp(object.updatedAt, "updatedAt"),
    remoteBrowser: parseRemoteBrowser(object.remoteBrowser),
  };
}

function normalizePublicOrigin(
  sourceOrigin: string,
  publicOrigin: string | null | undefined,
  bridgePublicOrigin?: string,
): string | null {
  const port = siteOriginPort(sourceOrigin);
  if (!isLoopbackSiteOrigin(sourceOrigin)) {
    const canonicalSource = canonicalizeSitePublicOrigin(sourceOrigin, port);
    if (publicOrigin === null || publicOrigin === undefined) return canonicalSource;
    const canonicalPublic = canonicalizeSitePublicOrigin(publicOrigin, port);
    if (canonicalPublic !== canonicalSource) {
      throw new SiteReviewError(
        "INVALID_ORIGIN",
        "A private HTTPS source must use the same public site origin",
      );
    }
    return canonicalSource;
  }
  if (publicOrigin !== null && publicOrigin !== undefined) {
    return canonicalizeSitePublicOrigin(publicOrigin, port);
  }
  return bridgePublicOrigin === undefined
    ? null
    : deriveSitePublicOrigin(bridgePublicOrigin, port);
}

function parseStoredRegistry(
  value: unknown,
  policy: SiteOriginPolicy,
  bridgePublicOrigin?: string,
): StoredRegistry {
  const object = assertObject(value, "Site registry");
  if (object.version !== REGISTRY_VERSION || !Array.isArray(object.sites)) {
    return invalidRegistry("Unsupported site registry format");
  }
  const generation = object.generation === undefined ? 0 : object.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    invalidRegistry("Site registry generation is invalid");
  }
  if (object.sites.length > MAX_SITE_RECORDS) invalidRegistry("Site registry is too large");
  const sites = object.sites.map((site) => parseSiteRecord(site, policy, bridgePublicOrigin));
  const ids = new Set<string>();
  const associationCounts = new Map<string, number>();
  for (const site of sites) {
    if (ids.has(site.siteId)) invalidRegistry(`Duplicate site id: ${site.siteId}`);
    ids.add(site.siteId);
    const key = associationKey(site.association);
    const count = (associationCounts.get(key) ?? 0) + 1;
    if (count > MAX_SITE_RECORDS_PER_ASSOCIATION) {
      invalidRegistry(`Too many sites registered for association: ${key}`);
    }
    associationCounts.set(key, count);
  }
  return { version: REGISTRY_VERSION, generation, sites: sites.sort(compareStoredSites) };
}

function nextRegistryGeneration(generation: number): number {
  if (generation >= Number.MAX_SAFE_INTEGER) invalidRegistry("Site registry generation is exhausted");
  return generation + 1;
}

function contextAssociationKeys(context: SiteLookupContext): Set<string> {
  const keys = new Set<string>();
  if (context.threadId !== undefined) keys.add(`thread:${normalizeExactThreadUuid(context.threadId)}`);
  if (context.projectId !== undefined) keys.add(normalizeProjectCwdIdentifier(context.projectId));
  if (context.projectCwd !== undefined) keys.add(projectCwdIdentifier(context.projectCwd));
  return keys;
}

export class SiteRegistry {
  readonly filePath: string;
  readonly #policy: SiteOriginPolicy;
  readonly #bridgePublicOrigin: string | undefined;
  readonly #now: () => Date;

  constructor(options: SiteRegistryOptions) {
    const root = options.appSupportPath ?? defaultDataPaths().root;
    this.filePath = options.filePath ?? join(root, "security", "sites.json");
    this.#policy = options.originPolicy;
    this.#bridgePublicOrigin =
      options.bridgePublicOrigin === undefined
        ? undefined
        : canonicalizeBridgeMagicDnsOrigin(options.bridgePublicOrigin);
    this.#now = options.now ?? (() => new Date());
  }

  async approve(input: ApproveSiteInput): Promise<ApprovedSiteRecord> {
    return this.approveAssociation({
      ...(input.siteId === undefined ? {} : { siteId: input.siteId }),
      label: input.label,
      origin: input.origin,
      ...(input.publicOrigin === undefined ? {} : { publicOrigin: input.publicOrigin }),
      association: normalizeSiteAssociation(input.association),
    });
  }

  async approveAssociation(input: {
    siteId?: string;
    label: string;
    origin: string;
    publicOrigin?: string;
    association: SiteAssociation;
  }): Promise<ApprovedSiteRecord> {
    const siteId = normalizeSiteId(input.siteId ?? randomUUID());
    const timestamp = this.#now().toISOString();
    const association = parseAssociation(input.association);
    const origin = canonicalizeApprovedSiteOrigin(input.origin, this.#policy);
    const label = normalizeLabel(input.label);
    const publicOrigin = assertPublicOriginMatchesBridge(normalizePublicOrigin(
      origin,
      input.publicOrigin,
      this.#bridgePublicOrigin,
    ), this.#bridgePublicOrigin);

    return withPrivateFileLock(this.filePath, async () => {
      const current = await this.#readUnlocked();
      const existingIndex = current.sites.findIndex((site) => site.siteId === siteId);
      const existing = existingIndex === -1 ? undefined : current.sites[existingIndex];
      if (
        existing !== undefined
        && (
          associationKey(existing.association) !== associationKey(association)
          || existing.origin !== origin
        )
      ) {
        throw new SiteReviewError(
          "SITE_NOT_APPROVED",
          "A stable site id cannot be reassigned to another association or origin; register a new site id",
        );
      }
      if (existing === undefined) {
        const count = current.sites.filter(
          (site) => associationKey(site.association) === associationKey(association),
        ).length;
        if (count >= MAX_SITE_RECORDS_PER_ASSOCIATION) {
          invalidRegistry(
            `An association cannot contain more than ${MAX_SITE_RECORDS_PER_ASSOCIATION} sites`,
          );
        }
      }
      const record: ApprovedSiteRecord = {
        version: SITE_RECORD_VERSION,
        siteId,
        label,
        association,
        origin,
        publicOrigin,
        approvedAt: existing?.approvedAt ?? timestamp,
        updatedAt: timestamp,
        remoteBrowser: existing?.remoteBrowser ?? unavailableRemoteBrowserAssociation(),
      };
      if (existingIndex === -1) {
        if (current.sites.length >= MAX_SITE_RECORDS) invalidRegistry("Site registry is full");
        current.sites.push(record);
      } else {
        current.sites[existingIndex] = record;
      }
      current.sites.sort(compareStoredSites);
      current.generation = nextRegistryGeneration(current.generation);
      await atomicWritePrivateJson(this.filePath, current);
      return record;
    });
  }

  async revoke(siteIdInput: string): Promise<boolean> {
    const siteId = normalizeSiteId(siteIdInput);
    return withPrivateFileLock(this.filePath, async () => {
      const current = await this.#readUnlocked();
      const sites = current.sites.filter((site) => site.siteId !== siteId);
      if (sites.length === current.sites.length) return false;
      await atomicWritePrivateJson(this.filePath, {
        version: REGISTRY_VERSION,
        generation: nextRegistryGeneration(current.generation),
        sites,
      });
      return true;
    });
  }

  async listAll(): Promise<ApprovedSiteRecord[]> {
    return [...(await this.#readUnlocked()).sites].sort(compareStoredSites);
  }

  async snapshot(): Promise<{ generation: number; sites: ApprovedSiteRecord[] }> {
    const snapshot = await this.#readUnlocked();
    return { generation: snapshot.generation, sites: [...snapshot.sites].sort(compareStoredSites) };
  }

  async listForContext(context: SiteLookupContext): Promise<ApprovedSiteRecord[]> {
    const keys = contextAssociationKeys(context);
    if (keys.size === 0) return [];
    const sites = (await this.#readUnlocked()).sites.filter((site) =>
      keys.has(associationKey(site.association)),
    );
    return sites.sort(compareContextSites).slice(0, MAX_SITE_RECORDS_PER_CONTEXT);
  }

  async requireApprovedForContext(
    siteIdInput: string,
    context: SiteLookupContext,
  ): Promise<ApprovedSiteRecord> {
    const siteId = normalizeSiteId(siteIdInput);
    const keys = contextAssociationKeys(context);
    if (keys.size === 0) {
      throw new SiteReviewError("SITE_NOT_APPROVED", "Capture requires a thread or project association");
    }
    const site = (await this.#readUnlocked()).sites.find((candidate) => candidate.siteId === siteId);
    if (site === undefined || !keys.has(associationKey(site.association))) {
      throw new SiteReviewError("SITE_NOT_APPROVED", "Site is not approved for this thread or project");
    }
    return site;
  }

  async #readUnlocked(): Promise<StoredRegistry> {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await ensurePrivateDirectory(dirname(this.filePath));
        return { version: REGISTRY_VERSION, generation: 0, sites: [] };
      }
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      return invalidRegistry("Refusing a non-regular or symlinked site registry");
    }
    await assertPrivateRegularFile(this.filePath);
    if (details.size > MAX_REGISTRY_BYTES) invalidRegistry("Site registry file is too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch (error) {
      throw new SiteReviewError(
        "SITE_NOT_APPROVED",
        `Unable to parse the private site registry: ${(error as Error).message}`,
      );
    }
    return parseStoredRegistry(parsed, this.#policy, this.#bridgePublicOrigin);
  }
}

function compatibilityPolicy(options: CompatibilitySiteRegistryOptions): SiteOriginPolicy {
  return createSiteOriginPolicy({
    allowedLoopbackPorts: options.allowedLoopbackPorts ?? DEFAULT_SITE_REVIEW_PORTS,
    allowedMagicDnsOrigins: options.allowedMagicDnsOrigins ?? [],
  });
}

export function createCompatibilitySiteRegistry(
  options: CompatibilitySiteRegistryOptions = {},
): SiteRegistry {
  return new SiteRegistry({
    originPolicy: compatibilityPolicy(options),
    ...(options.publicBridgeOrigin === undefined
      ? {}
      : { bridgePublicOrigin: options.publicBridgeOrigin }),
    ...(options.paths === undefined ? {} : { filePath: options.paths.sites }),
  });
}

function compatibilityRecord(record: ApprovedSiteRecord): SiteRecord {
  return {
    associationId: record.siteId,
    targetKind: record.association.kind,
    targetId:
      record.association.kind === "thread"
        ? record.association.threadId
        : record.association.projectCwdId,
    name: record.label,
    loopbackUrl: record.origin,
    publicOrigin: record.publicOrigin,
    createdAt: Date.parse(record.approvedAt),
    updatedAt: Date.parse(record.updatedAt),
    remoteBrowser: record.remoteBrowser,
  };
}

export async function listSites(
  options: CompatibilitySiteRegistryOptions = {},
): Promise<SiteRecord[]> {
  return (await readSites(options)).sites;
}

export interface SiteRegistrySnapshot {
  generation: number;
  sites: SiteRecord[];
}

export async function readSites(
  options: CompatibilitySiteRegistryOptions = {},
): Promise<SiteRegistrySnapshot> {
  const snapshot = await createCompatibilitySiteRegistry(options).snapshot();
  return {
    generation: snapshot.generation,
    sites: snapshot.sites.map(compatibilityRecord),
  };
}

export async function addSite(
  input: AddSiteInput,
  options: CompatibilitySiteRegistryOptions = {},
): Promise<SiteRecord> {
  if (input.publicOrigin !== undefined && options.publicBridgeOrigin === undefined) {
    throw new SiteReviewError(
      "INVALID_ORIGIN",
      "An explicit site public origin requires the authoritative bridge MagicDNS origin",
    );
  }
  const registry = createCompatibilitySiteRegistry(options);
  const association: SiteAssociation =
    input.targetKind === "thread"
      ? { kind: "thread", threadId: normalizeExactThreadUuid(input.targetId) }
      : {
          kind: "project",
          projectCwdId: isAbsolute(input.targetId)
            ? projectCwdIdentifier(input.targetId)
            : normalizeProjectCwdIdentifier(input.targetId),
        };
  const record = await registry.approveAssociation({
    ...(input.siteId === undefined ? {} : { siteId: input.siteId }),
    label: input.name ?? `Registered ${input.targetKind} site`,
    origin: input.loopbackUrl,
    ...(input.publicOrigin === undefined ? {} : { publicOrigin: input.publicOrigin }),
    association,
  });
  return compatibilityRecord(record);
}

export async function removeSite(
  id: string,
  options: CompatibilitySiteRegistryOptions = {},
): Promise<boolean> {
  try {
    return await createCompatibilitySiteRegistry(options).revoke(id);
  } catch (error) {
    if (error instanceof SiteReviewError && error.code === "SITE_NOT_APPROVED") return false;
    throw error;
  }
}

import {
  AllSessionsResponseSchema,
  MAX_SITE_ASSOCIATIONS_PER_SESSION,
  NativeSessionsResponseSchema,
  SiteAssociationSchema,
  type AllSessionsResponse,
  type NativeSessionsResponse,
  type SessionSummary as ProtocolSessionSummary,
  type SiteAssociation,
} from "@codex-pad/protocol";
import { openThread, type DesktopProcessIdentity } from "@codex-pad/codex-desktop";
import {
  normalizeExactThreadUuid,
  projectCwdIdentifier,
  type SiteLookupContext,
} from "@codex-pad/site-review";
import { basename } from "node:path";
import type { ThreadRuntimeStatus, ThreadTransport } from "./thread-transport.js";
import type { BridgeStateService } from "./state.js";
import { readSites, type SiteRecord } from "./site-registry.js";
import type { BridgeDataPaths } from "./paths.js";
import { SessionCatalogCache } from "./session-catalog-cache.js";

const NATIVE_PROJECT_CONTEXT_TTL_MS = 5 * 60 * 1_000;
const NATIVE_PROJECT_CONTEXT_FAILURE_TTL_MS = 5_000;

interface NativeProjectContext {
  projectId: string | null;
  projectLabel: string | null;
}

export interface SessionsServiceOptions {
  transport: ThreadTransport;
  state: BridgeStateService;
  paths: BridgeDataPaths;
  publicBridgeOrigin?: string;
  siteCaptureAvailable?: boolean;
  siteCaptureUnavailableReason?: string | null;
  openExactThread?: (threadId: string) => Promise<void>;
  invalidateTargetAuthority?: (
    expectedThreadId: string,
    desktopIdentity: DesktopProcessIdentity,
  ) => void;
  now?: () => number;
}

function visualStatus(status: ThreadRuntimeStatus): ProtocolSessionSummary["visualStatus"] {
  switch (status) {
    case "active": return "working";
    case "idle": return "idle";
    case "systemError": return "error";
    case "notLoaded":
    case "unknown": return "degraded";
  }
}

function safeNativeStatus(status: ThreadRuntimeStatus): string {
  switch (status) {
    case "active": return "working";
    case "idle": return "idle";
    case "systemError": return "error";
    case "notLoaded":
    case "unknown": return "degraded";
  }
}

export const TYPED_REMOTE_BROWSER_TRANSPORT_UNAVAILABLE_DETAIL =
  "Remote Mac browser control is disabled because this build has no safe typed remote-browser transport.";
export const SAME_HOST_DIRECT_MODE_UNAVAILABLE_DETAIL =
  "Live site preview is disabled because the registered site shares the bridge hostname and therefore is not an independent browser storage boundary.";

export function siteInteractionModes(
  record: SiteRecord,
): SiteAssociation["interactionModes"] {
  const remoteBrowser = record.remoteBrowser.status === "unavailable"
    ? {
        status: "unavailable" as const,
        reason: "thread-tab-mapping-unproven" as const,
        detail: record.remoteBrowser.detail,
        association: record.remoteBrowser,
      }
    : {
        status: "unavailable" as const,
        reason: "typed-remote-browser-transport-unavailable" as const,
        detail: TYPED_REMOTE_BROWSER_TRANSPORT_UNAVAILABLE_DETAIL,
        association: record.remoteBrowser,
      };
  return {
    selected: "none",
    direct: {
      status: "unavailable",
      reason: "same-host-storage-boundary",
      detail: SAME_HOST_DIRECT_MODE_UNAVAILABLE_DETAIL,
    },
    remoteBrowser,
  };
}

export function safeProjectLabel(cwd: string | null): string | null {
  if (cwd === null) return null;
  const label = basename(cwd).normalize("NFC").trim().slice(0, 120);
  if (label === "" || label === "." || label === ".." || /[\\/\u0000-\u001f\u007f]/u.test(label)) return null;
  return label;
}

export function safeProjectId(cwd: string | null): string | null {
  if (cwd === null) return null;
  try {
    return projectCwdIdentifier(cwd);
  } catch {
    return null;
  }
}

export function siteAssociationFromRecord(
  record: SiteRecord | undefined,
  siteCaptureAvailable: boolean,
  siteCaptureUnavailableReason: string | null,
  reviewDeliveryVerified = false,
  contextThreadId?: string,
): SiteAssociation | null {
  if (record === undefined || record.publicOrigin === null) return null;
  const threadId = record.targetKind === "thread" ? record.targetId : contextThreadId;
  if (threadId === undefined) return null;
  const publicOrigin = new URL(record.publicOrigin);
  if (publicOrigin.protocol !== "https:") return null;
  return SiteAssociationSchema.parse({
    associationId: record.associationId,
    threadId,
    projectId: record.targetKind === "project" ? record.targetId : null,
    name: record.name,
    origin: publicOrigin.origin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    capabilities: {
      state: siteCaptureAvailable
        ? reviewDeliveryVerified ? "available" : "degraded"
        : "unavailable",
      canCaptureFrames: siteCaptureAvailable,
      canSendReview: siteCaptureAvailable && reviewDeliveryVerified,
      supportsInlinePng: true,
      supportsUploadRefs: false,
      maxFrames: 12,
      maxFrameBytes: 8 * 1024 * 1024,
      maxTotalBytes: 24 * 1024 * 1024,
      reason: !siteCaptureAvailable
        ? siteCaptureUnavailableReason ?? "Site capture is unavailable"
        : reviewDeliveryVerified
          ? null
          : "Review delivery has not been verified for both Desktop ownership and bounded multi-image input.",
    },
    interactionModes: siteInteractionModes(record),
  });
}

function compareSessionSiteRecords(left: SiteRecord, right: SiteRecord): number {
  const leftScope = left.targetKind === "thread" ? 0 : 1;
  const rightScope = right.targetKind === "thread" ? 0 : 1;
  if (leftScope !== rightScope) return leftScope - rightScope;
  const leftName = left.name.normalize("NFC");
  const rightName = right.name.normalize("NFC");
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  return left.associationId < right.associationId
    ? -1
    : left.associationId > right.associationId ? 1 : 0;
}

export function siteAssociationsForSession(
  records: readonly SiteRecord[],
  threadId: string,
  projectId: string | null,
  siteCaptureAvailable: boolean,
  siteCaptureUnavailableReason: string | null,
  reviewDeliveryVerified = false,
): SiteAssociation[] {
  const seenSiteIds = new Set<string>();
  const matching = records
    .filter((record) => (
      (record.targetKind === "thread" && record.targetId === threadId)
      || (
        projectId !== null
        && record.targetKind === "project"
        && record.targetId === projectId
      )
    ))
    .sort(compareSessionSiteRecords);
  const associations: SiteAssociation[] = [];
  for (const record of matching) {
    if (seenSiteIds.has(record.associationId)) continue;
    seenSiteIds.add(record.associationId);
    const association = siteAssociationFromRecord(
      record,
      siteCaptureAvailable,
      siteCaptureUnavailableReason,
      reviewDeliveryVerified,
      threadId,
    );
    if (association !== null) associations.push(association);
    if (associations.length >= MAX_SITE_ASSOCIATIONS_PER_SESSION) break;
  }
  return associations;
}

export class SessionsService {
  readonly #transport: ThreadTransport;
  readonly #state: BridgeStateService;
  readonly #paths: BridgeDataPaths;
  readonly #publicBridgeOrigin: string | undefined;
  readonly #siteCaptureAvailable: boolean;
  readonly #siteCaptureUnavailableReason: string | null;
  readonly #openNavigationThread: (threadId: string) => Promise<void>;
  readonly #openExactThread: (
    threadId: string,
    desktopIdentity: DesktopProcessIdentity,
    beforeDispatch: () => void,
  ) => Promise<void>;
  readonly #invalidateTargetAuthority: (
    expectedThreadId: string,
    desktopIdentity: DesktopProcessIdentity,
  ) => void;
  readonly #now: () => number;
  readonly #sessionCatalogCache: SessionCatalogCache;
  #lastSuccessfulCatalog: readonly ProtocolSessionSummary[] | null = null;
  #activeNativeThreadIds = new Set<string>();
  readonly #nativeProjectContexts = new Map<string, {
    expiresAt: number;
    value: NativeProjectContext | null;
  }>();
  readonly #nativeProjectContextReads = new Map<string, Promise<NativeProjectContext | null>>();
  #nativeListRequest: Promise<NativeSessionsResponse> | null = null;
  #knownSessionThreadIds = new Set<string>();
  #openChain = Promise.resolve();

  constructor(options: SessionsServiceOptions) {
    this.#transport = options.transport;
    this.#state = options.state;
    this.#paths = options.paths;
    this.#publicBridgeOrigin = options.publicBridgeOrigin;
    this.#siteCaptureAvailable = options.siteCaptureAvailable ?? false;
    this.#siteCaptureUnavailableReason = options.siteCaptureUnavailableReason ?? null;
    const invalidateTargetAuthority = options.invalidateTargetAuthority ?? (() => undefined);
    this.#invalidateTargetAuthority = invalidateTargetAuthority;
    this.#openNavigationThread = options.openExactThread ?? ((threadId) => openThread(threadId));
    this.#openExactThread = options.openExactThread === undefined
      ? (threadId, desktopIdentity, beforeDispatch) => openThread(threadId, { desktopIdentity, beforeDispatch })
      : async (threadId, _desktopIdentity, beforeDispatch) => {
          // Injected sinks are already test-validated; revoke immediately before
          // handing control to the sink just as the production deep-link does.
          beforeDispatch();
          await options.openExactThread?.(threadId);
        };
    this.#now = options.now ?? Date.now;
    this.#sessionCatalogCache = new SessionCatalogCache(options.paths, this.#now);
  }

  async list(): Promise<AllSessionsResponse> {
    try {
      const response = (await this.#listWithRegistry()).response;
      this.#lastSuccessfulCatalog = response.sessions;
      await this.#sessionCatalogCache.write(response.sessions).catch(() => undefined);
      return response;
    } catch (error) {
      const cached = this.#lastSuccessfulCatalog
        ?? await this.#sessionCatalogCache.read().catch(() => null);
      if (cached === null) throw error;
      const snapshot = this.#state.current();
      const sessions = cached.map((session): ProtocolSessionSummary => ({
        ...session,
        nativeStatus: "degraded",
        visualStatus: "degraded",
        activityLabel: null,
        selected: false,
        microSlot: null,
        siteAssociations: [],
        siteAssociation: null,
      }));
      this.#knownSessionThreadIds = new Set(sessions.map((session) => session.threadId));
      return AllSessionsResponseSchema.parse({
        sequence: snapshot.sequence,
        timestamp: this.#now(),
        sessions,
      });
    }
  }

  async listNative(): Promise<NativeSessionsResponse> {
    if (this.#nativeListRequest !== null) return this.#nativeListRequest;
    let request!: Promise<NativeSessionsResponse>;
    request = this.#listNativeResponse().finally(() => {
      if (this.#nativeListRequest === request) this.#nativeListRequest = null;
    });
    this.#nativeListRequest = request;
    return request;
  }

  async #listNativeResponse(): Promise<NativeSessionsResponse> {
    const snapshot = this.#state.current();
    const slots = snapshot.slots.filter(
      (slot): slot is typeof slot & { threadId: string } => slot.threadId !== null,
    );
    this.#activeNativeThreadIds = new Set(slots.map((slot) => slot.threadId));
    for (const threadId of this.#nativeProjectContexts.keys()) {
      if (!this.#activeNativeThreadIds.has(threadId)) this.#nativeProjectContexts.delete(threadId);
    }
    const [registry, projectContexts] = await Promise.all([
      readSites({
        paths: this.#paths,
        ...(this.#publicBridgeOrigin === undefined
          ? {}
          : { publicBridgeOrigin: this.#publicBridgeOrigin }),
      }),
      Promise.all(slots.map((slot) => this.#nativeProjectContext(slot.threadId))),
    ]);
    const capabilities = this.#state.capabilities();
    const reviewDeliveryVerified = capabilities.multiImageInputVerified
      && capabilities.desktopOwnershipVerified;
    const sessions = slots.map((slot, index): ProtocolSessionSummary => {
      const projectContext = projectContexts[index] ?? null;
      const projectId = projectContext?.projectId ?? null;
      const projectLabel = projectContext?.projectLabel ?? null;
      const siteAssociations = siteAssociationsForSession(
        registry.sites,
        slot.threadId,
        projectId,
        this.#siteCaptureAvailable,
        this.#siteCaptureUnavailableReason,
        reviewDeliveryVerified,
      );
      return {
        threadId: slot.threadId,
        title: slot.title,
        nativeStatus: slot.nativeStatus,
        visualStatus: slot.visualStatus,
        activityLabel: null,
        activityAt: slot.activityAt,
        projectId,
        projectLabel: projectId === null ? null : projectLabel,
        selected: slot.selected,
        microSlot: slot.slot,
        ownedByHost: slot.ownedByHost,
        siteAssociations,
        siteAssociation: siteAssociations[0] ?? null,
      };
    });
    return NativeSessionsResponseSchema.parse({
      sequence: snapshot.sequence,
      timestamp: this.#now(),
      registryGeneration: registry.generation,
      sessions,
    });
  }

  async #nativeProjectContext(threadId: string): Promise<NativeProjectContext | null> {
    const now = this.#now();
    const cached = this.#nativeProjectContexts.get(threadId);
    if (cached !== undefined && cached.expiresAt > now) return cached.value;
    const inFlight = this.#nativeProjectContextReads.get(threadId);
    if (inFlight !== undefined) return inFlight;

    let request!: Promise<NativeProjectContext | null>;
    request = this.#transport.threadRead(threadId)
      .then((session): NativeProjectContext => {
        const projectLabel = safeProjectLabel(session.cwd);
        const projectId = projectLabel === null ? null : safeProjectId(session.cwd);
        return {
          projectId,
          projectLabel: projectId === null ? null : projectLabel,
        };
      })
      .catch(() => null)
      .then((value) => {
        if (this.#activeNativeThreadIds.has(threadId)) {
          this.#nativeProjectContexts.set(threadId, {
            expiresAt: this.#now() + (value === null
              ? NATIVE_PROJECT_CONTEXT_FAILURE_TTL_MS
              : NATIVE_PROJECT_CONTEXT_TTL_MS),
            value,
          });
        }
        return value;
      })
      .finally(() => {
        if (this.#nativeProjectContextReads.get(threadId) === request) {
          this.#nativeProjectContextReads.delete(threadId);
        }
      });
    this.#nativeProjectContextReads.set(threadId, request);
    return request;
  }

  async resolveSiteLookupContext(threadIdInput: string): Promise<SiteLookupContext> {
    const threadId = normalizeExactThreadUuid(threadIdInput);
    const native = this.#state.current().slots.some((slot) => slot.threadId === threadId);
    const session = native
      ? await this.#transport.threadRead(threadId)
      : (await this.#transport.listSessions()).find(
          (candidate) => candidate.threadId === threadId,
        );
    if (session === undefined) throw new SessionNotFoundError();
    const projectLabel = safeProjectLabel(session.cwd);
    const projectId = projectLabel === null ? null : safeProjectId(session.cwd);
    return {
      threadId,
      ...(projectId === null ? {} : { projectId }),
    };
  }

  /**
   * Registry management may use the last sanitized catalog while the managed
   * app-server is recovering. Capture remains bound to the stricter live lookup
   * above because it causes browser I/O.
   */
  async resolveSiteManagementContext(threadIdInput: string): Promise<SiteLookupContext> {
    const threadId = normalizeExactThreadUuid(threadIdInput);
    const session = (await this.list()).sessions.find((candidate) => candidate.threadId === threadId);
    if (session === undefined) throw new SessionNotFoundError();
    return {
      threadId,
      ...(session.projectId === null ? {} : { projectId: session.projectId }),
    };
  }

  async #listWithRegistry(): Promise<{
    response: AllSessionsResponse;
    registryGeneration: number;
  }> {
    const [transportSessions, registry] = await Promise.all([
      this.#transport.listSessions(),
      readSites({
        paths: this.#paths,
        ...(this.#publicBridgeOrigin === undefined
          ? {}
          : { publicBridgeOrigin: this.#publicBridgeOrigin }),
      }),
    ]);
    const sites = registry.sites;
    const snapshot = this.#state.current();
    const capabilities = this.#state.capabilities();
    const reviewDeliveryVerified = capabilities.multiImageInputVerified
      && capabilities.desktopOwnershipVerified;
    const sessions = transportSessions.map((session): ProtocolSessionSummary => {
      const slot = snapshot.slots.find((candidate) => candidate.threadId === session.threadId);
      const projectLabel = safeProjectLabel(session.cwd);
      const projectId = projectLabel === null ? null : safeProjectId(session.cwd);
      const siteAssociations = siteAssociationsForSession(
        sites,
        session.threadId,
        projectId,
        this.#siteCaptureAvailable,
        this.#siteCaptureUnavailableReason,
        reviewDeliveryVerified,
      );
      return {
        threadId: session.threadId,
        title: session.title,
        nativeStatus: slot?.nativeStatus ?? safeNativeStatus(session.status),
        visualStatus: slot?.visualStatus ?? visualStatus(session.status),
        activityAt: slot?.activityAt ?? (session.updatedAt > 0 ? session.updatedAt : null),
        activityLabel: null,
        projectId,
        projectLabel: projectId === null ? null : projectLabel,
        selected: snapshot.selectedThreadId === session.threadId,
        microSlot: slot?.slot ?? null,
        ownedByHost: true,
        siteAssociations,
        siteAssociation: siteAssociations[0] ?? null,
      };
    });
    const response = AllSessionsResponseSchema.parse({
      sequence: snapshot.sequence,
      timestamp: this.#now(),
      sessions,
    });
    this.#knownSessionThreadIds = new Set(response.sessions.map((session) => session.threadId));
    return { response, registryGeneration: registry.generation };
  }

  async openSession(threadId: string): Promise<void> {
    const knownFromNativeSnapshot = this.#state.current().slots.some(
      (slot) => slot.threadId === threadId,
    );
    if (
      !knownFromNativeSnapshot
      && !this.#knownSessionThreadIds.has(threadId)
    ) {
      const current = await this.list();
      if (!current.sessions.some((session) => session.threadId === threadId)) {
        throw new SessionNotFoundError();
      }
    }
    const dispatch = this.#openChain.then(async () => {
      // A deep-link changes only Desktop navigation. Revoke any previous
      // selected-target proof before dispatch, but do not require app-server
      // writer ownership for this read-only navigation action.
      this.#state.invalidateTargetAuthority();
      await this.#openNavigationThread(threadId);
    });
    this.#openChain = dispatch.then(() => undefined, () => undefined);
    await dispatch;
  }

  /** For a thread ID returned directly by thread/start; avoids a state-list race. */
  async openCreatedThread(threadId: string): Promise<void> {
    await this.#serializedOpen(threadId);
  }

  async #serializedOpen(threadId: string): Promise<void> {
    const dispatch = this.#openChain.then(async () => {
      const acquire = this.#transport.acquireNativeMutationAuthority;
      const consume = this.#transport.consumeNativeMutationAuthority;
      if (acquire === undefined || consume === undefined) {
        throw new SessionMutationAuthorityError();
      }
      const grant = await acquire.call(this.#transport);
      let dispatched = false;
      try {
        await this.#openExactThread(
          threadId,
          grant.desktopIdentity,
          () => {
            consume.call(this.#transport, grant.authority);
            this.#invalidateTargetAuthority(threadId, grant.desktopIdentity);
            dispatched = true;
          },
        );
        await this.#state.confirmSelectedThread(threadId, grant.desktopIdentity);
      } catch (error) {
        if (!dispatched) throw error;
        throw new SessionSelectionDeliveryUnknownError(error);
      }
    });
    this.#openChain = dispatch.then(() => undefined, () => undefined);
    await dispatch;
  }
}

export class SessionMutationAuthorityError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE";
  readonly statusCode = 409;

  constructor() {
    super("Fresh Desktop ownership authority is required before changing the selected task.");
    this.name = "SessionMutationAuthorityError";
  }
}

export class SessionSelectionDeliveryUnknownError extends Error {
  readonly code = "DELIVERY_UNKNOWN";
  readonly retryable = true;
  readonly detail = { phase: "post-dispatch" } as const;

  constructor(cause?: unknown) {
    super(
      "Desktop may have accepted the exact task deep link, but the selected-task postcondition was not confirmed.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "SessionSelectionDeliveryUnknownError";
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND";
  readonly statusCode = 404;
  constructor() {
    super("The exact task is not present in the current sanitized session list");
  }
}

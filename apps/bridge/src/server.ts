import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z, ZodError } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type WebSocket from "ws";
import {
  ClientWsMessageSchema,
  CommandAckSchema,
  CommandRequestSchema,
  CommandStatusResponseSchema,
  DiagramUpdateRequestSchema,
  ProductStateUpdateRequestSchema,
  SavedDrawingCreateRequestSchema,
  SiteQaRecordedActionSchema,
  RuntimeDiagnosticsSchema,
  ServerWsMessageSchema,
  type ApiError,
  type BridgeHealth,
  type Command,
  type CommandAck,
  type CommandError,
  type CommandResult,
  type CodexUsageSnapshot,
  type ContextRoomStatus,
  type RuntimeCapabilityCheck,
  type RuntimeDiagnostics,
  type RuntimeSchemaCompatibility,
} from "@codex-pad/protocol";
import { CodexDesktopAdapter } from "@codex-pad/codex-desktop";
import { SiteReviewError } from "@codex-pad/site-review";
import {
  CredentialCapacityError,
  CredentialStore,
  legacyCookieClearHeaders,
  readBearerToken,
  readWebSocketTicketProtocol,
  WebSocketTicketStore,
  WEB_SOCKET_PROTOCOL,
  webSocketTicketProtocol,
  type AuthenticatedDevice,
} from "./auth.js";
import { PairingStore, showPairingInfo, type PairingInfo } from "./pairing.js";
import { defaultDataPaths, type BridgeDataPaths } from "./paths.js";
import {
  createRequestSecurity,
  DualScopeConcurrencyLimiter,
  DualScopeRateLimiter,
  FixedWindowRateLimiter,
  SecurityError,
  validateListenSecurity,
  type ConcurrencyLease,
} from "./security.js";
import { IdempotencyLedger, type CommandStatus } from "./idempotency.js";
import { BridgeStateService } from "./state.js";
import { createExactTargetAuthorityDomain } from "./exact-target-authority.js";
import type {
  ThreadTransport,
  VerifiedMultiImageInputCapability,
} from "./thread-transport.js";
import { ReconnectingManagedTransport } from "./managed-transport-provider.js";
import {
  ProtocolCommandExecutor,
  type LibraryCommandDefinition,
} from "./commands.js";
import { SessionsService, siteAssociationsForSession } from "./sessions.js";
import type { ReviewInstructionHook } from "./review.js";
import { createCompatibilitySiteRegistry, readSites } from "./site-registry.js";
import { createOptionalSystemChromeDriver, SiteCaptureService } from "./site-capture.js";
import {
  listOpenCodexBrowserTabs,
  openCodexBrowserTab,
  type OpenBrowserTabsResult,
} from "./browser-tabs.js";
import {
  VerifiedBrowserTabRuntime,
  type BrowserTabRuntime,
} from "./browser-tab-runtime.js";
import { DOCTOR_WSS_SUBPROTOCOL } from "./wss-probe.js";
import { startRuntimeCleanupSchedule } from "./runtime-cleanup.js";
import { ProductStateConflictError, ProductStateStore } from "./product-state-store.js";
import { SavedDrawingsStore } from "./saved-drawings-store.js";
import {
  DiagramConflictError,
  DiagramStore,
} from "./diagram-store.js";
import {
  acquireBridgeLifetimeLease,
  type BridgeLifetimeLease,
} from "./lifetime-lease.js";
import { ContextRoomAdapter, normalizeContextRoomOrigin } from "./context-room-adapter.js";
import {
  IntelligentNotificationEngine,
  PushSubscriptionInputSchema,
  PushSubscriptionStore,
  StandardsWebPushDelivery,
  VapidKeyStore,
  type PushDelivery,
} from "./push-notifications.js";

const VERSION = "0.1.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_HTTP_BODY_BYTES = 34 * 1024 * 1024;
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;
const MAX_WS_CONNECTIONS = 24;
const REFRESH_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

const pairRequestSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  deviceName: z.string().trim().min(1).max(80),
}).strict();

const deviceParamsSchema = z.object({ id: z.uuid() }).strict();
const savedDrawingParamsSchema = z.object({ id: z.uuid() }).strict();
const diagramParamsSchema = z.object({ id: z.uuid() }).strict();
const diagramQuerySchema = z.object({ threadId: z.uuid() }).strict();
const commandParamsSchema = z.object({ commandId: z.uuid() }).strict();
const siteParamsSchema = z.object({ siteId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u) }).strict();
const browserTabParamsSchema = z.object({ tabId: z.string().regex(/^tab_[a-f0-9]{24}$/u) }).strict();
const siteCaptureBodySchema = z.object({
  threadId: z.uuid(),
  path: z.string().min(1).max(2_048).regex(/^\/(?!\/)[^\u0000-\u001f\u007f\\]*$/u),
  viewport: z.enum(["ipad-landscape", "ipad-portrait", "mobile-portrait", "desktop-wide"]),
  scroll: z.object({
    x: z.number().int().min(0).max(1_000_000),
    y: z.number().int().min(0).max(1_000_000),
  }).strict(),
}).strict();
const siteManagementQuerySchema = z.object({ threadId: z.uuid() }).strict();
const browserTabControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number().min(0).max(8_192), y: z.number().min(0).max(8_192) }).strict(),
  z.object({
    type: z.literal("scroll"),
    x: z.number().min(0).max(8_192),
    y: z.number().min(0).max(8_192),
    deltaX: z.number().min(-4_000).max(4_000),
    deltaY: z.number().min(-4_000).max(4_000),
  }).strict(),
  z.object({ type: z.literal("insertText"), text: z.string().max(1_000) }).strict(),
  z.object({ type: z.literal("navigate"), url: z.string().trim().min(1).max(2_048) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Backspace", "Escape", "Tab"]) }).strict(),
  z.object({ type: z.enum(["back", "forward", "reload"]) }).strict(),
]);
const siteCreateBodySchema = z.object({
  threadId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  url: z.url().max(2_048),
  scope: z.enum(["thread", "project"]),
}).strict();
const libraryDefinitionsSchema = z.array(z.object({
  libraryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  label: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8_000),
}).strict()).max(32);

const configSchema = z.object({
  version: z.literal(1),
  bridge: z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65_535) }).strict(),
  tailscale: z.object({ serveHttpsPort: z.literal(443) }).strict(),
}).strict();

interface SocketRecord {
  socket: WebSocket;
  device: AuthenticatedDevice;
  alive: boolean;
}

export class WebSocketAdmissionGate {
  readonly #maximum: number;
  readonly #reservations = new WeakSet<object>();
  #count = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_WS_CONNECTIONS) {
      throw new Error(`WebSocket connection limit must be between 1 and ${MAX_WS_CONNECTIONS}`);
    }
    this.#maximum = maximum;
  }

  tryReserve(owner: object): boolean {
    if (this.#reservations.has(owner) || this.#count >= this.#maximum) return false;
    this.#reservations.add(owner);
    this.#count += 1;
    return true;
  }

  release(owner: object): void {
    if (!this.#reservations.delete(owner)) return;
    this.#count -= 1;
  }

  get count(): number {
    return this.#count;
  }
}

export interface StartBridgeOptions {
  host?: string;
  port?: number;
  unsafeLan?: boolean;
  publicOrigin?: string;
  allowedOrigins?: readonly string[];
  dataRoot?: string;
  paths?: BridgeDataPaths;
  webRoot?: string;
  adapter?: CodexDesktopAdapter;
  transport?: ThreadTransport;
  codexVersion?: string | null;
  schemaCompatibility?: RuntimeSchemaCompatibility;
  contextRoomOrigin?: string;
  multiImageInputCapability?: VerifiedMultiImageInputCapability;
  openExactThread?: (threadId: string) => Promise<void>;
  libraryCommands?: readonly LibraryCommandDefinition[];
  reviewInstructionHook?: ReviewInstructionHook;
  refreshIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** May reduce, but never raise, the audited bridge-wide admission ceiling. */
  maxWebSocketConnections?: number;
  siteCaptureService?: SiteCaptureService | null;
  /** Test seam for the read-only, ownership-attested Codex Browser inventory. */
  openBrowserTabs?: (threadId: string) => Promise<OpenBrowserTabsResult>;
  /** Test seam for bounded control of one explicitly selected verified browser page. */
  browserTabRuntime?: BrowserTabRuntime;
  /** Test seam for encrypted standards-based Web Push delivery. */
  pushDelivery?: PushDelivery;
  /** Test-only reduction of the completion aggregation window. */
  notificationCompletionGroupDelayMs?: number;
  logger?: Pick<Console, "warn" | "error">;
}

export interface BridgeHandle {
  app: FastifyInstance;
  url: string;
  state: BridgeStateService;
  createPairing(publicOrigin: string, deviceNameHint?: string): Promise<PairingInfo>;
  revokeDevice(deviceId: string): Promise<boolean>;
  close(): Promise<void>;
}

function apiError(code: ApiError["code"], message: string, retryable = false): ApiError {
  return { code, message: message.slice(0, 500), retryable, details: null };
}

function publicHealthReason(state: BridgeHealth["state"]): string | null {
  switch (state) {
    case "live": return null;
    case "reconnecting": return "Codex Pad is reconnecting to native Codex state.";
    case "degraded": return "Native Codex capabilities are temporarily degraded.";
    case "stale": return "Native Codex state is temporarily stale.";
    case "offline": return "Native Codex is currently offline.";
  }
}

function safeCommandError(error: unknown): CommandError {
  const rawCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "COMMAND_FAILED";
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 64);
  const normalizedCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : "COMMAND_FAILED";
  const declaredRetryable = typeof error === "object" && error !== null && "retryable" in error && error.retryable === true;
  const retryable = declaredRetryable || [
    "AGENT_BUSY",
    "APP_SERVER_AUTHORITY_STALE",
    "APP_SERVER_CLOSED",
    "APP_SERVER_TARGET_STALE",
    "APP_SERVER_TIMEOUT",
    "APP_SERVER_UNAVAILABLE",
    "BROWSER_OPEN_UNKNOWN",
    "CDP_CONNECTION_FAILED",
    "IDEMPOTENCY_CAPACITY",
    "MANAGED_PROXY_EXITED",
    "MUTATION_AUTHORITY_STALE",
    "NATIVE_DISCOVERY_FAILED",
    "QUEUE_FULL",
    "THREAD_CHANGED",
  ].includes(normalizedCode);
  const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message.slice(0, 500)
    : "Command failed";
  return {
    code: normalizedCode,
    message,
    retryable,
  };
}

function commandOutcomeMayBeUnknown(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (["APP_SERVER_DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN", "delivery-unknown", "BROWSER_OPEN_UNKNOWN"].includes(code)) return true;
  if (code !== "APP_SERVER_UNAVAILABLE") return false;
  // APP_SERVER_UNAVAILABLE is also used for definite pre-dispatch states such
  // as connect backoff, missing ownership, or a closed provider. Only an
  // explicitly preserved post-write client code is ambiguous.
  if (!("detail" in error) || typeof error.detail !== "object" || error.detail === null) return false;
  const clientCode = "clientCode" in error.detail && typeof error.detail.clientCode === "string"
    ? error.detail.clientCode
    : "";
  const phase = "phase" in error.detail && typeof error.detail.phase === "string"
    ? error.detail.phase
    : "";
  return clientCode === "APP_SERVER_DELIVERY_UNKNOWN"
    && (phase === "post-write" || phase === "post-response");
}

function commandAck(
  command: Command,
  duplicate: boolean,
  state: BridgeStateService,
  result: CommandResult | null,
  error: unknown = null,
): CommandAck {
  const commandError = error === null ? null : safeCommandError(error);
  const unresolved = commandError?.code === "DELIVERY_UNKNOWN";
  return CommandAckSchema.parse({
    commandId: command.commandId,
    disposition: duplicate ? "duplicate" : "accepted",
    status: error === null ? (result === null ? "inFlight" : "succeeded") : unresolved ? "inFlight" : "failed",
    sequence: result?.sequence ?? state.current().sequence,
    targetThreadId: result?.targetThreadId ?? command.expectedThreadId,
    error: commandError,
  });
}

function commandStatusResponse(
  commandId: string,
  record: CommandStatus<CommandResult> | null,
  state: BridgeStateService,
) {
  if (record === null) {
    return CommandStatusResponseSchema.parse({
      commandId,
      status: "unknown",
      sequence: state.current().sequence,
      targetThreadId: null,
      result: null,
      error: null,
      updatedAt: Date.now(),
    });
  }
  return CommandStatusResponseSchema.parse({
    commandId,
    status: record.status === "completed" ? "succeeded" : record.status === "unresolved" ? "inFlight" : record.status,
    sequence: record.result?.sequence ?? state.current().sequence,
    targetThreadId: record.result?.targetThreadId ?? null,
    result: record.result ?? null,
    error: record.status === "failed" || record.status === "unresolved"
      ? safeCommandError(record.error ?? new Error("Command failed"))
      : null,
    updatedAt: record.updatedAt,
  });
}

async function loadConfig(paths: BridgeDataPaths): Promise<z.infer<typeof configSchema> | null> {
  try {
    return configSchema.parse(JSON.parse(await readFile(paths.config, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pairingOrigin(paths: BridgeDataPaths, allowInsecureHttp = false): Promise<string | undefined> {
  const info = await showPairingInfo({ paths });
  if (info === null) return undefined;
  const origin = new URL(info.qrPayload);
  if (origin.protocol !== "https:" && !(allowInsecureHttp && info.insecureDevelopment === true)) return undefined;
  return origin.origin;
}

function addressUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

function cspHeader(): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
  ];
  directives.push("frame-src 'self'");
  return directives.join("; ");
}

type StartupCleanup = () => void | Promise<void>;

async function runStartupCleanups(
  cleanups: readonly StartupCleanup[],
  logger: Pick<Console, "warn" | "error">,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
      logger.warn(`Codex Pad startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export async function startBridge(options: StartBridgeOptions = {}): Promise<BridgeHandle> {
  const logger = options.logger ?? console;
  const paths = options.paths ?? defaultDataPaths(options.dataRoot);
  const lifetimeLease = await acquireBridgeLifetimeLease(paths);
  const startupCleanups: StartupCleanup[] = [];
  try {
    const handle = await startBridgeWithLifetimeLease(
      options,
      paths,
      lifetimeLease,
      startupCleanups,
    );
    startupCleanups.length = 0;
    return handle;
  } catch (error) {
    const cleanupErrors = await runStartupCleanups(startupCleanups, logger);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Codex Pad startup failed and its data-root lease was retained because cleanup did not finish safely",
      );
    }
    try {
      await lifetimeLease.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Codex Pad startup failed and its data-root lease could not be released safely",
      );
    }
    throw error;
  }
}

async function startBridgeWithLifetimeLease(
  options: StartBridgeOptions,
  paths: BridgeDataPaths,
  lifetimeLease: BridgeLifetimeLease,
  startupCleanups: StartupCleanup[],
): Promise<BridgeHandle> {
  const logger = options.logger ?? console;
  const runtimeCleanup = await startRuntimeCleanupSchedule(paths, logger);
  startupCleanups.push(() => runtimeCleanup.stop());
  const config = await loadConfig(paths);
  const host = options.host ?? process.env.CODEX_PAD_HOST ?? config?.bridge.host ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.CODEX_PAD_PORT ?? config?.bridge.port ?? DEFAULT_PORT);
  const unsafeLan = options.unsafeLan ?? process.env.CODEX_PAD_UNSAFE_LAN === "1";
  const publicOrigin = options.publicOrigin ?? process.env.CODEX_PAD_PUBLIC_ORIGIN ?? await pairingOrigin(paths, unsafeLan);
  const developmentOrigins = process.env.NODE_ENV === "development"
    ? ["http://127.0.0.1:5173", "http://localhost:5173"]
    : [];
  const allowedOrigins = [...developmentOrigins, ...(options.allowedOrigins ?? [])];
  validateListenSecurity({ host, port, unsafeLan, ...(publicOrigin === undefined ? {} : { publicOrigin }), allowedOrigins });
  if (unsafeLan) {
    logger.warn("WARNING: Codex Pad unsafe LAN mode is active; authentication, Origin checks, and CSP remain enforced.");
  }
  const security = createRequestSecurity({
    host,
    port,
    unsafeLan,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    allowedOrigins,
  });
  const credentialStore = new CredentialStore({ paths });
  const pairingStore = new PairingStore({ paths });
  const productStateStore = new ProductStateStore({ paths });
  const pushSubscriptions = new PushSubscriptionStore({ paths });
  const vapidKeys = await new VapidKeyStore({ paths }).getOrCreate();
  const pushDelivery = options.pushDelivery ?? new StandardsWebPushDelivery(
    vapidKeys,
    publicOrigin?.startsWith("https://") === true ? publicOrigin : "https://nerva.local",
  );
  const savedDrawingsStore = new SavedDrawingsStore({ paths });
  const diagramStore = new DiagramStore({ paths });
  const adapter = options.adapter ?? new CodexDesktopAdapter();
  // One process-local domain binds state-issued exact-target proofs to this
  // provider only. Tokens minted by any other domain fail at the write sink.
  const targetAuthorityDomain = createExactTargetAuthorityDomain();
  const transport = options.transport ?? new ReconnectingManagedTransport({
    targetAuthorityConsumer: targetAuthorityDomain.providerConsumer,
    logger: (message) => logger.warn(message),
    ...(options.multiImageInputCapability === undefined
      ? {}
      : { multiImageInputCapability: options.multiImageInputCapability }),
  });
  const ownsAdapter = options.adapter === undefined;
  const ownsTransport = options.transport === undefined;
  const ownedTransportClose = ownsTransport && "close" in transport && typeof transport.close === "function"
    ? (transport.close as () => void | Promise<void>).bind(transport)
    : null;
  if (ownsAdapter) startupCleanups.push(() => adapter.close());
  if (ownedTransportClose !== null) startupCleanups.push(ownedTransportClose);
  const state = new BridgeStateService({
    adapter,
    transport,
    targetAuthorityIssuer: targetAuthorityDomain.stateIssuer,
    ...(options.codexVersion === undefined ? {} : { codexVersion: options.codexVersion }),
  });
  const notificationEngine = new IntelligentNotificationEngine({
    subscriptions: pushSubscriptions,
    delivery: pushDelivery,
    productState: productStateStore,
    logger,
    ...(options.notificationCompletionGroupDelayMs === undefined
      ? {}
      : { completionGroupDelayMs: options.notificationCompletionGroupDelayMs }),
  });
  startupCleanups.push(() => notificationEngine.close());
  const libraries = libraryDefinitionsSchema.parse(options.libraryCommands ?? []);
  const bridgeMagicDnsOrigin = publicOrigin !== undefined
    && new URL(publicOrigin).protocol === "https:"
    && new URL(publicOrigin).hostname.endsWith(".ts.net")
    && new URL(publicOrigin).port === ""
    ? publicOrigin
    : undefined;
  const siteRegistry = createCompatibilitySiteRegistry({
    paths,
    ...(bridgeMagicDnsOrigin === undefined ? {} : { publicBridgeOrigin: bridgeMagicDnsOrigin }),
  });
  let siteCaptureUnavailableReason: string | null = null;
  let siteCaptureService: SiteCaptureService | null;
  if (options.siteCaptureService !== undefined) {
    siteCaptureService = options.siteCaptureService;
    if (siteCaptureService === null) siteCaptureUnavailableReason = "Site capture was disabled by bridge configuration";
  } else {
    const optionalDriver = await createOptionalSystemChromeDriver();
    if (optionalDriver.available) {
      siteCaptureService = new SiteCaptureService({ registry: siteRegistry, driver: optionalDriver.driver });
    } else {
      siteCaptureService = null;
      siteCaptureUnavailableReason = optionalDriver.detail;
    }
  }
  const sessions = new SessionsService({
    transport,
    state,
    paths,
    invalidateTargetAuthority: (threadId, desktopIdentity) =>
      state.invalidateTargetAuthority(threadId, desktopIdentity),
    ...(bridgeMagicDnsOrigin === undefined ? {} : { publicBridgeOrigin: bridgeMagicDnsOrigin }),
    ...(options.openExactThread === undefined ? {} : { openExactThread: options.openExactThread }),
    siteCaptureAvailable: siteCaptureService !== null,
    siteCaptureUnavailableReason,
  });
  const openBrowserTabs = options.openBrowserTabs
    ?? ((threadId: string) => listOpenCodexBrowserTabs(transport, threadId, [
      `http://${host}:${port}`,
      ...(publicOrigin === undefined ? [] : [publicOrigin]),
    ]));
  const browserTabRuntime = options.browserTabRuntime ?? new VerifiedBrowserTabRuntime(transport);

  async function managedSitesForThread(threadId: string) {
    const context = await sessions.resolveSiteManagementContext(threadId);
    const [records, approved] = await Promise.all([
      readSites({
        paths,
        ...(bridgeMagicDnsOrigin === undefined ? {} : { publicBridgeOrigin: bridgeMagicDnsOrigin }),
      }),
      siteRegistry.listForContext(context),
    ]);
    const stateCapabilities = state.capabilities();
    const associations = siteAssociationsForSession(
      records.sites,
      threadId,
      context.projectId ?? null,
      siteCaptureService !== null,
      siteCaptureUnavailableReason,
      stateCapabilities.multiImageInputVerified && stateCapabilities.desktopOwnershipVerified,
    );
    const associationsById = new Map(associations.map((association) => [association.associationId, association]));
    return approved.map((record) => ({
      siteId: record.siteId,
      name: record.label,
      scope: record.association.kind === "thread" ? "thread" as const : "project" as const,
      publicOrigin: record.publicOrigin,
      createdAt: Date.parse(record.approvedAt),
      updatedAt: Date.parse(record.updatedAt),
      association: associationsById.get(record.siteId) ?? null,
    }));
  }
  const executor = new ProtocolCommandExecutor({
    state,
    transport,
    sessions,
    paths,
    logger,
    libraryCommands: libraries,
    openBrowserTab: (threadId, url) => openCodexBrowserTab(transport, threadId, url),
    ...(options.reviewInstructionHook === undefined ? {} : { reviewInstructionHook: options.reviewInstructionHook }),
  });
  const ledger = new IdempotencyLedger<CommandResult>({
    maximumRecords: 16_384,
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
    persistencePath: paths.idempotency,
    isAmbiguousError: commandOutcomeMayBeUnknown,
  });
  startupCleanups.push(() => ledger.close());
  await ledger.initialize();
  const keyedPairLimit = new FixedWindowRateLimiter(8, 5 * 60 * 1_000);
  const globalPairLimit = new FixedWindowRateLimiter(60, 60 * 1_000);
  const authFailureLimit = new DualScopeRateLimiter({
    perKeyLimit: 12,
    perKeyWindowMs: 60_000,
    globalLimit: 240,
    globalWindowMs: 60_000,
  });
  const mutationLimit = new DualScopeRateLimiter({
    perKeyLimit: 120,
    perKeyWindowMs: 60_000,
    globalLimit: 600,
    globalWindowMs: 60_000,
  });
  // Native/app-server mutations share snapshot authority. Admit exactly one
  // new command bridge-wide so distinct IDs cannot pass the same sequence
  // check concurrently. A header-matched in-flight ID uses a separate bounded
  // body-only admission slot, then coalesces on the durable ledger record.
  const commandConcurrency = new DualScopeConcurrencyLimiter(1, 1);
  const commandBodyConcurrency = new DualScopeConcurrencyLimiter(1, 2);
  const captureConcurrency = new DualScopeConcurrencyLimiter(1, 2);
  const browserTabConcurrency = new DualScopeConcurrencyLimiter(2, 4);
  const imageCommandConcurrency = new DualScopeConcurrencyLimiter(1, 2);
  const savedDrawingConcurrency = new DualScopeConcurrencyLimiter(1, 2);
  const diagramConcurrency = new DualScopeConcurrencyLimiter(1, 2);
  const webSocketTickets = new WebSocketTicketStore();
  const webSocketAdmissions = new WebSocketAdmissionGate(
    options.maxWebSocketConnections ?? MAX_WS_CONNECTIONS,
  );
  const requestDevices = new WeakMap<FastifyRequest, AuthenticatedDevice>();
  const commandRequestLeases = new WeakMap<FastifyRequest, ConcurrencyLease>();
  const commandBodyRequestLeases = new WeakMap<FastifyRequest, ConcurrencyLease>();
  const admittedCommandIds = new WeakMap<FastifyRequest, string>();
  const inFlightDuplicateRequests = new WeakSet<FastifyRequest>();
  const commandHandlersStarted = new WeakSet<FastifyRequest>();
  const webSocketTicketOrigins = new WeakMap<FastifyRequest, string>();
  const sockets = new Set<SocketRecord>();
  let lastCodexUsage: Extract<CodexUsageSnapshot, { available: true }> | null = null;
  const schemaCompatibility = options.schemaCompatibility ?? {
    state: "unknown",
    summary: "Installed-version schema compatibility was not supplied by this bridge host.",
    remediation: "Run: npm run setup -- --generate-schemas",
  } satisfies RuntimeSchemaCompatibility;
  const contextRoom = new ContextRoomAdapter(normalizeContextRoomOrigin(
    options.contextRoomOrigin ?? process.env.CODEX_PAD_CONTEXT_ROOM_ORIGIN,
  ));
  let lastContextRoomStatus: ContextRoomStatus | null = null;

  const app = Fastify({
    logger: false,
    bodyLimit: MAX_HTTP_BODY_BYTES,
    connectionTimeout: 20_000,
    requestTimeout: 150_000,
    keepAliveTimeout: 72_000,
    trustProxy: false,
  });
  startupCleanups.push(() => app.close());
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      perMessageDeflate: false,
      handleProtocols(protocols) {
        if (protocols.has(DOCTOR_WSS_SUBPROTOCOL)) return DOCTOR_WSS_SUBPROTOCOL;
        return protocols.has(WEB_SOCKET_PROTOCOL) ? WEB_SOCKET_PROTOCOL : false;
      },
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    security.assertHost(request);
    reply.header("Content-Security-Policy", cspHeader());
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(self), geolocation=(), microphone=(self), payment=(), usb=()");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Cache-Control", request.url.startsWith("/api/") ? "no-store" : "no-cache");
    // Migration only: delete the former host-wide credential cookies so an
    // upgraded browser cannot send them to sibling review ports.
    reply.header("Set-Cookie", legacyCookieClearHeaders(!unsafeLan));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SecurityError) {
      void reply.code(403).send({ ok: false, error: apiError("FORBIDDEN", "Request rejected by bridge security policy") });
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send({ ok: false, error: apiError("INVALID_REQUEST", "Request did not match the bridge protocol") });
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      void reply.code(413).send({ ok: false, error: apiError("PAYLOAD_TOO_LARGE", "Request body exceeds the bridge limit") });
      return;
    }
    logger.error(error instanceof Error ? error.message : String(error));
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const code: ApiError["code"] = statusCode === 400
      ? "INVALID_REQUEST"
      : statusCode === 404
        ? "NOT_FOUND"
        : statusCode === 409
          ? "CONFLICT"
          : "INTERNAL_ERROR";
    const publicMessage = error instanceof Error ? error.message : "Bridge request failed";
    void reply.code(statusCode).send({ ok: false, error: apiError(code, statusCode >= 500 ? "Bridge request failed" : publicMessage) });
  });

  async function sendRateLimit(
    reply: FastifyReply,
    retryAfterSeconds: number,
    message: string,
  ): Promise<void> {
    reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
    await reply.code(429).send({ ok: false, error: apiError("RATE_LIMITED", message, true) });
  }

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedDevice | null> {
    const bearerToken = readBearerToken(request.headers.authorization);
    const rateKey = security.authRateKey(request, bearerToken);
    // A bridge-wide invalid-guess ceiling may throttle more invalid guesses,
    // but it must never pre-block verification of an unrelated valid bearer.
    const preflight = authFailureLimit.checkKey(rateKey);
    if (!preflight.allowed) {
      await sendRateLimit(reply, preflight.retryAfterSeconds, "Authentication attempts are temporarily limited");
      return null;
    }
    const device = await credentialStore.verify(bearerToken);
    if (device === null) {
      const failure = authFailureLimit.consume(rateKey);
      if (!failure.allowed) {
        await sendRateLimit(reply, failure.retryAfterSeconds, "Authentication attempts are temporarily limited");
      } else {
        await reply.code(401).send({ ok: false, error: apiError("UNAUTHENTICATED", "Pair this device again") });
      }
      return null;
    }
    requestDevices.set(request, device);
    return device;
  }

  function requireOrigin(request: FastifyRequest): string {
    const origin = security.assertOrigin(request, true);
    if (origin === null) throw new SecurityError("Missing Origin header");
    return origin;
  }

  async function allowMutation(device: AuthenticatedDevice, reply: FastifyReply): Promise<boolean> {
    const decision = mutationLimit.consume(device.id);
    if (decision.allowed) return true;
    await sendRateLimit(reply, decision.retryAfterSeconds, "Device mutations are temporarily limited");
    return false;
  }

  function releaseCommandRequest(request: FastifyRequest): void {
    const executionLease = commandRequestLeases.get(request);
    if (executionLease !== undefined) {
      commandRequestLeases.delete(request);
      executionLease.release();
    }
    const bodyLease = commandBodyRequestLeases.get(request);
    if (bodyLease !== undefined) {
      commandBodyRequestLeases.delete(request);
      bodyLease.release();
    }
  }

  async function admitCommandRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const presentedCommandId = request.headers["x-codex-pad-command-id"];
    if (presentedCommandId !== undefined) {
      const { commandId } = commandParamsSchema.parse({ commandId: presentedCommandId });
      admittedCommandIds.set(request, commandId);
      if (ledger.status(device.id, commandId)?.status === "inFlight") {
        const bodyLease = commandBodyConcurrency.tryAcquire(device.id);
        if (bodyLease === null) {
          await sendRateLimit(reply, 1, "Command body admission capacity is temporarily full");
          return;
        }
        commandBodyRequestLeases.set(request, bodyLease);
        inFlightDuplicateRequests.add(request);
        return;
      }
    }
    const lease = commandConcurrency.tryAcquire(device.id);
    if (lease === null) {
      await sendRateLimit(reply, 1, "Another command mutation is still in progress");
      return;
    }
    commandRequestLeases.set(request, lease);
  }

  async function admitWebSocketTicketRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const origin = requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    webSocketTicketOrigins.set(request, origin);
  }

  async function executeCommand(device: AuthenticatedDevice, command: Command): Promise<CommandAck> {
    let execution;
    try {
      execution = await ledger.execute(
        device.id,
        command.commandId,
        JSON.stringify(command),
        () => executor.execute(command),
      );
    } catch (error) {
      return commandAck(command, false, state, null, error);
    }
    return acknowledgeExecution(command, execution);
  }

  function runtimeDiagnostics(): RuntimeDiagnostics {
    const snapshot = state.current();
    const capabilities = state.capabilities();
    const proof = state.runtimeProof();
    const recovering = snapshot.bridgeHealth.state === "reconnecting"
      || snapshot.bridgeHealth.state === "stale";
    const offline = snapshot.bridgeHealth.state === "offline";
    const foundationState: RuntimeCapabilityCheck["state"] = offline
      ? "unavailable"
      : recovering
        ? "recovering"
        : "needsVerification";
    const foundationReason = snapshot.bridgeHealth.reason
      ?? (offline ? "Native Codex is offline." : "A fresh native proof is required.");
    const catalogProofAt = Math.max(
      proof.skillsCatalogLoadedAt ?? 0,
      proof.modelsCatalogLoadedAt ?? 0,
    ) || null;
    const checks: RuntimeCapabilityCheck[] = [
      {
        id: "sessions",
        label: "Sessions",
        state: proof.slotsAuthoritative ? "available" : foundationState,
        reason: proof.slotsAuthoritative ? null : foundationReason,
        lastProvenAt: proof.lastNativeProofAt,
      },
      {
        id: "nativeControls",
        label: "Native controls",
        state: proof.selectedAuthoritative && capabilities.desktopOwnershipVerified
          ? "available"
          : foundationState,
        reason: proof.selectedAuthoritative && capabilities.desktopOwnershipVerified
          ? null
          : proof.slotsAuthoritative
            ? "Open one exact task on the Mac to verify selected-task control."
            : foundationReason,
        lastProvenAt: proof.selectedAuthoritative ? proof.lastNativeProofAt : null,
      },
      {
        id: "composerAttachment",
        label: "Composer attachment",
        state: capabilities.drawing ? "available" : foundationState,
        reason: capabilities.drawing
          ? null
          : proof.selectedAuthoritative
            ? "The installed Codex renderer did not prove composer attachment."
            : "Open and verify this exact task before attaching a drawing.",
        lastProvenAt: capabilities.drawing ? proof.lastNativeProofAt : null,
      },
      {
        id: "skillsAndModels",
        label: "Skills & models",
        state: proof.transportConnected
          && proof.transportInitialized
          && proof.skillsCatalogLoadedAt !== null
          && proof.modelsCatalogLoadedAt !== null
          ? "available"
          : offline
            ? "unavailable"
            : "recovering",
        reason: proof.skillsCatalogLoadedAt !== null && proof.modelsCatalogLoadedAt !== null
          ? `${capabilities.models.length} models and ${capabilities.skills.length} skills loaded.`
          : "The managed app-server is still loading its verified catalogs.",
        lastProvenAt: catalogProofAt,
      },
      {
        id: "approvals",
        label: "Approvals",
        state: proof.transportConnected
          && proof.transportInitialized
          && capabilities.desktopOwnershipVerified
          ? "available"
          : foundationState,
        reason: proof.transportConnected
          && proof.transportInitialized
          && capabilities.desktopOwnershipVerified
          ? "Action controls appear only for an exact pending approval."
          : "Approval control requires the managed app-server and Desktop ownership proof.",
        lastProvenAt: capabilities.desktopOwnershipVerified ? proof.lastNativeProofAt : null,
      },
      {
        id: "sites",
        label: "Sites",
        state: siteCaptureService !== null || (
          proof.transportConnected
          && proof.transportInitialized
          && capabilities.desktopOwnershipVerified
        )
          ? "available"
          : foundationState,
        reason: siteCaptureService !== null
          ? "Managed capture is available; live Browser tabs are verified per task."
          : proof.transportConnected && proof.transportInitialized
            ? "Live Browser tabs are verified per selected task."
            : siteCaptureUnavailableReason ?? "Site access is waiting for the managed app-server.",
        lastProvenAt: proof.transportConnected && proof.transportInitialized ? snapshot.timestamp : null,
      },
    ];
    return RuntimeDiagnosticsSchema.parse({
      protocolVersion: 1,
      bridgeVersion: VERSION,
      codexVersion: capabilities.codexVersion,
      snapshotSequence: snapshot.sequence,
      capturedAt: Date.now(),
      bridgeHealth: snapshot.bridgeHealth,
      schemaCompatibility,
      checks,
    });
  }

  async function acknowledgeExecution(
    command: Command,
    execution: { duplicate: boolean; promise: Promise<CommandResult> },
  ): Promise<CommandAck> {
    try {
      const result = await execution.promise;
      return commandAck(command, execution.duplicate, state, result);
    } catch (error) {
      return commandAck(command, execution.duplicate, state, null, error);
    }
  }

  app.get("/api/health", async () => {
    const healthState = state.current().bridgeHealth.state;
    return {
      ok: true,
      data: {
        version: VERSION,
        state: healthState,
        reason: publicHealthReason(healthState),
        pairingConfigured: (await pairingStore.show()) !== null,
        unsafeLan,
        multiImageInputVerified: state.capabilities().multiImageInputVerified,
        desktopOwnershipVerified: state.capabilities().desktopOwnershipVerified,
      },
    };
  });

  app.get("/api/runtime", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    return { ok: true, data: runtimeDiagnostics() };
  });

  app.get("/api/context-room", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    const next = await contextRoom.status();
    lastContextRoomStatus = next.available ? next : lastContextRoomStatus;
    return {
      ok: true,
      data: next.available || lastContextRoomStatus === null
        ? next
        : { ...lastContextRoomStatus, available: false, checkedAt: next.checkedAt, reason: next.reason },
    };
  });

  app.post("/api/pair", { bodyLimit: 2_048 }, async (request, reply) => {
    const origin = requireOrigin(request);
    const globalAttempt = globalPairLimit.consume("global");
    const keyedAttempt = keyedPairLimit.consume(security.pairRateKey(request));
    if (!globalAttempt.allowed || !keyedAttempt.allowed) {
      const retryAfter = Math.max(globalAttempt.retryAfterSeconds, keyedAttempt.retryAfterSeconds);
      reply.header("Retry-After", String(retryAfter));
      return reply.code(429).send({ ok: false, error: apiError("RATE_LIMITED", "Pairing attempts are temporarily limited", true) });
    }
    const body = pairRequestSchema.parse(request.body);
    let redeemed;
    try {
      redeemed = await pairingStore.redeem(
        body.nonce,
        origin,
        () => credentialStore.issue(body.deviceName),
        async (issued) => {
          await credentialStore.revoke(issued.device.id);
          await pendingDeviceCleanup.get(issued.device.id);
        },
      );
    } catch (error) {
      if (error instanceof CredentialCapacityError) {
        return reply.code(409).send({
          ok: false,
          error: apiError("CONFLICT", error.message),
        });
      }
      throw error;
    }
    if (!redeemed.ok) {
      return reply.code(401).send({ ok: false, error: apiError("UNAUTHENTICATED", "Pairing code is invalid or expired") });
    }
    return reply.code(201).send({
      ok: true,
      data: {
        paired: true,
        device: redeemed.value.device,
        bearerToken: redeemed.value.bearerToken,
      },
    });
  });

  app.post("/api/ws-ticket", {
    // Ticket issuance has no body. Authenticate and rate-limit before the
    // content-type parser can allocate attacker-controlled request bytes.
    bodyLimit: 1,
    onRequest: admitWebSocketTicketRequest,
  }, async (request) => {
    const origin = webSocketTicketOrigins.get(request);
    const device = requestDevices.get(request);
    if (origin === undefined || device === undefined) throw new SecurityError();
    const issued = webSocketTickets.issue(device, origin);
    return {
      ok: true,
      data: {
        ticket: issued.ticket,
        protocol: webSocketTicketProtocol(issued.ticket),
        expiresAt: issued.expiresAt,
      },
    };
  });

  app.get("/api/snapshot", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    // A foregrounded PWA must be able to recover an app-server connection that
    // went idle while iPadOS suspended it. Return the last safe snapshot only
    // when the bounded live refresh itself fails.
    const snapshot = await state.refresh().catch(() => state.current());
    return { ok: true, data: snapshot };
  });

  app.get("/api/usage", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    if (transport.readCodexUsage === undefined) {
      return {
        ok: true,
        data: {
          available: false,
          stale: false,
          fetchedAt: Date.now(),
          reason: "usage-unavailable",
        } satisfies CodexUsageSnapshot,
      };
    }
    try {
      const usage = await transport.readCodexUsage();
      lastCodexUsage = { available: true, stale: false, ...usage };
      return { ok: true, data: lastCodexUsage };
    } catch {
      if (lastCodexUsage !== null) {
        return { ok: true, data: { ...lastCodexUsage, stale: true } };
      }
      return {
        ok: true,
        data: {
          available: false,
          stale: false,
          fetchedAt: Date.now(),
          reason: "app-server-unavailable",
        } satisfies CodexUsageSnapshot,
      };
    }
  });

  app.get("/api/product-state", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    return { ok: true, data: await productStateStore.read() };
  });

  app.get("/api/push", async (request, reply) => {
    const device = await authenticate(request, reply);
    if (device === null) return;
    return {
      ok: true,
      data: {
        supported: true,
        subscribed: await pushSubscriptions.hasDevice(device.id),
        publicKey: vapidKeys.publicKey,
      },
    };
  });

  app.put("/api/push/subscription", { bodyLimit: 8_192 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const subscription = PushSubscriptionInputSchema.parse(request.body);
    await pushSubscriptions.upsert(device.id, subscription);
    return { ok: true, data: { subscribed: true } };
  });

  app.delete("/api/push/subscription", { bodyLimit: 1 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    await pushSubscriptions.removeDevice(device.id);
    return { ok: true, data: { subscribed: false } };
  });

  app.put("/api/product-state", { bodyLimit: 128 * 1024 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const input = ProductStateUpdateRequestSchema.parse(request.body);
    try {
      return { ok: true, data: await productStateStore.update(input) };
    } catch (error) {
      if (error instanceof ProductStateConflictError) {
        return reply.code(409).send({
          ok: false,
          error: {
            ...apiError("CONFLICT", error.message),
            details: { currentRevision: error.current.revision },
          },
        });
      }
      throw error;
    }
  });

  app.get("/api/saved-drawings", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    return { ok: true, data: { drawings: await savedDrawingsStore.list() } };
  });

  app.get("/api/saved-drawings/:id", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    const { id } = savedDrawingParamsSchema.parse(request.params);
    return { ok: true, data: await savedDrawingsStore.get(id) };
  });

  app.post("/api/saved-drawings", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const lease = savedDrawingConcurrency.tryAcquire(device.id);
    if (lease === null) return sendRateLimit(reply, 1, "Another Saved Drawings change is still in progress");
    try {
      const input = SavedDrawingCreateRequestSchema.parse(request.body);
      return reply.code(201).send({ ok: true, data: await savedDrawingsStore.create(input) });
    } finally {
      lease.release();
    }
  });

  app.delete("/api/saved-drawings/:id", async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const { id } = savedDrawingParamsSchema.parse(request.params);
    const lease = savedDrawingConcurrency.tryAcquire(device.id);
    if (lease === null) return sendRateLimit(reply, 1, "Another Saved Drawings change is still in progress");
    try {
      await savedDrawingsStore.delete(id);
      return { ok: true, data: { deleted: true, drawingId: id } };
    } finally {
      lease.release();
    }
  });

  app.get("/api/diagrams", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    const { threadId } = diagramQuerySchema.parse(request.query);
    return { ok: true, data: { diagrams: await diagramStore.list(threadId) } };
  });

  app.get("/api/diagrams/:id", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    const { id } = diagramParamsSchema.parse(request.params);
    return { ok: true, data: await diagramStore.get(id) };
  });

  app.put("/api/diagrams/:id", { bodyLimit: 512 * 1024 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const { id } = diagramParamsSchema.parse(request.params);
    const { threadId } = diagramQuerySchema.parse(request.query);
    const lease = diagramConcurrency.tryAcquire(device.id);
    if (lease === null) return sendRateLimit(reply, 1, "Another diagram change is still in progress");
    try {
      const input = DiagramUpdateRequestSchema.parse(request.body);
      try {
        return {
          ok: true,
          data: await diagramStore.update(id, threadId, input, "ipad"),
        };
      } catch (error) {
        if (error instanceof DiagramConflictError) {
          return reply.code(409).send({
            ok: false,
            error: {
              ...apiError("CONFLICT", error.message),
              details: { currentRevision: error.current.revision },
            },
          });
        }
        throw error;
      }
    } finally {
      lease.release();
    }
  });

  app.get("/api/capabilities", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    return {
      ok: true,
      data: {
        ...state.capabilities(),
        libraries,
        siteCapture: {
          available: siteCaptureService !== null,
          reason: siteCaptureService === null ? siteCaptureUnavailableReason : null,
        },
      },
    };
  });

  app.get("/api/sessions", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    return { ok: true, data: await sessions.list() };
  });

  app.get("/api/native-sessions", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    return { ok: true, data: await sessions.listNative() };
  });

  app.get("/api/sites", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    const { threadId } = siteManagementQuerySchema.parse(request.query);
    return { ok: true, data: { sites: await managedSitesForThread(threadId) } };
  });

  app.get("/api/browser-tabs", async (request, reply) => {
    if (await authenticate(request, reply) === null) return;
    const { threadId } = siteManagementQuerySchema.parse(request.query);
    await sessions.resolveSiteManagementContext(threadId);
    return { ok: true, data: await openBrowserTabs(threadId) };
  });

  app.get("/api/browser-tabs/:tabId/frame", async (request, reply) => {
    const device = await authenticate(request, reply);
    if (device === null) return;
    const { tabId } = browserTabParamsSchema.parse(request.params);
    const { threadId } = siteManagementQuerySchema.parse(request.query);
    await sessions.resolveSiteManagementContext(threadId);
    const lease = browserTabConcurrency.tryAcquire(device.id);
    if (lease === null) {
      await sendRateLimit(reply, 1, "Browser page capacity is temporarily full");
      return;
    }
    try {
      return { ok: true, data: await browserTabRuntime.frame(threadId, tabId) };
    } catch (error) {
      return reply.code(409).send({
        ok: false,
        error: apiError("CONFLICT", error instanceof Error ? error.message : "The browser page is unavailable"),
      });
    } finally {
      lease.release();
    }
  });

  app.post("/api/browser-tabs/:tabId/control", { bodyLimit: 8_192 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const { tabId } = browserTabParamsSchema.parse(request.params);
    const { threadId } = siteManagementQuerySchema.parse(request.query);
    const action = browserTabControlSchema.parse(request.body);
    await sessions.resolveSiteManagementContext(threadId);
    const lease = browserTabConcurrency.tryAcquire(device.id);
    if (lease === null) {
      await sendRateLimit(reply, 1, "Browser page capacity is temporarily full");
      return;
    }
    try {
      return { ok: true, data: await browserTabRuntime.control(threadId, tabId, action) };
    } catch (error) {
      return reply.code(409).send({
        ok: false,
        error: apiError("CONFLICT", error instanceof Error ? error.message : "The browser page is unavailable"),
      });
    } finally {
      lease.release();
    }
  });

  app.post("/api/browser-tabs/:tabId/recorded-control", { bodyLimit: 8_192 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const { tabId } = browserTabParamsSchema.parse(request.params);
    const { threadId } = siteManagementQuerySchema.parse(request.query);
    const action = SiteQaRecordedActionSchema.parse(request.body);
    await sessions.resolveSiteManagementContext(threadId);
    const lease = browserTabConcurrency.tryAcquire(device.id);
    if (lease === null) {
      await sendRateLimit(reply, 1, "Browser page capacity is temporarily full");
      return;
    }
    try {
      return { ok: true, data: await browserTabRuntime.recordedControl(threadId, tabId, action) };
    } catch (error) {
      return reply.code(409).send({
        ok: false,
        error: apiError("CONFLICT", error instanceof Error ? error.message : "The recorded browser action could not be applied"),
      });
    } finally {
      lease.release();
    }
  });

  app.post("/api/sites", { bodyLimit: 4_096 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const body = siteCreateBodySchema.parse(request.body);
    const context = await sessions.resolveSiteManagementContext(body.threadId);
    if (body.scope === "project" && context.projectId === undefined) {
      return reply.code(409).send({
        ok: false,
        error: apiError("CONFLICT", "This task has no verified project identity"),
      });
    }
    try {
      await siteRegistry.approveAssociation({
        label: body.name,
        origin: new URL(body.url).origin,
        association: body.scope === "thread"
          ? { kind: "thread", threadId: body.threadId }
          : { kind: "project", projectCwdId: context.projectId! },
      });
    } catch (error) {
      if (error instanceof SiteReviewError) {
        return reply.code(400).send({
          ok: false,
          error: apiError("INVALID_REQUEST", error.message),
        });
      }
      throw error;
    }
    const sites = await managedSitesForThread(body.threadId);
    return reply.code(201).send({ ok: true, data: { sites } });
  });

  app.delete("/api/sites/:siteId", async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const { siteId } = siteParamsSchema.parse(request.params);
    const { threadId } = siteManagementQuerySchema.parse(request.query);
    const context = await sessions.resolveSiteManagementContext(threadId);
    try {
      await siteRegistry.requireApprovedForContext(siteId, context);
    } catch (error) {
      if (error instanceof SiteReviewError) {
        return reply.code(404).send({
          ok: false,
          error: apiError("NOT_FOUND", "Site is not linked to this task or project"),
        });
      }
      throw error;
    }
    const removed = await siteRegistry.revoke(siteId);
    return { ok: true, data: { removed, siteId } };
  });

  app.post("/api/sites/:siteId/capture", { bodyLimit: 4_096 }, async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const { siteId } = siteParamsSchema.parse(request.params);
    const body = siteCaptureBodySchema.parse(request.body);
    if (siteCaptureService === null) {
      return reply.code(501).send({
        ok: false,
        error: apiError("UNSUPPORTED", siteCaptureUnavailableReason ?? "Site capture is unavailable"),
      });
    }
    const lease = captureConcurrency.tryAcquire(device.id);
    if (lease === null) {
      await sendRateLimit(reply, 1, "Site capture capacity is temporarily full");
      return;
    }
    try {
      const context = await sessions.resolveSiteLookupContext(body.threadId);
      const capture = await siteCaptureService.capture(
        context,
        { siteId, path: body.path, viewport: body.viewport, scroll: body.scroll },
      );
      const finalPath = capture.finalPath;
      if (
        !finalPath.startsWith("/")
        || finalPath.startsWith("//")
        || finalPath.includes("#")
        || finalPath.length > 2_048
        || /[\u0000-\u001f\u007f\\]/u.test(finalPath)
      ) {
        throw new Error("Capture driver returned an invalid final path");
      }
      return {
        ok: true,
        data: {
          siteId: capture.siteId,
          title: capture.title ?? null,
          finalPath,
          viewport: capture.viewport,
          scroll: capture.scroll,
          redirectCount: capture.redirectCount,
          pngBase64: Buffer.from(capture.png).toString("base64"),
          width: capture.width,
          height: capture.height,
        },
      };
    } finally {
      lease.release();
    }
  });

  app.post("/api/command", {
    bodyLimit: MAX_HTTP_BODY_BYTES,
    onRequest: admitCommandRequest,
    onError: async (request) => {
      if (!commandHandlersStarted.has(request)) releaseCommandRequest(request);
    },
    onRequestAbort: async (request) => {
      if (!commandHandlersStarted.has(request)) releaseCommandRequest(request);
    },
    onResponse: async (request) => { releaseCommandRequest(request); },
  }, async (request, reply) => {
    commandHandlersStarted.add(request);
    try {
      const device = requestDevices.get(request);
      if (
        device === undefined
        || (!commandRequestLeases.has(request) && !inFlightDuplicateRequests.has(request))
      ) throw new SecurityError();
      const { command } = CommandRequestSchema.parse(request.body);
      const admittedCommandId = admittedCommandIds.get(request);
      if (admittedCommandId !== undefined && admittedCommandId !== command.commandId) {
        return reply.code(400).send({
          ok: false,
          error: apiError("INVALID_REQUEST", "Command ID header does not match request body"),
        });
      }
      if (inFlightDuplicateRequests.has(request)) {
        // Re-read and fingerprint the record synchronously after parsing. The
        // first reservation may have failed durability after onRequest saw it;
        // only a still-existing record may bypass the main execution lease.
        let existing: ReturnType<typeof ledger.existing>;
        try {
          existing = ledger.existing(device.id, command.commandId, JSON.stringify(command));
        } catch (error) {
          const ack = commandAck(command, false, state, null, error);
          return { ok: true, data: ack };
        }
        if (existing !== null) {
          const ack = await acknowledgeExecution(command, existing);
          return { ok: true, data: ack };
        }
        const lease = commandConcurrency.tryAcquire(device.id);
        if (lease === null) {
          await sendRateLimit(reply, 1, "Another command mutation is still in progress");
          return;
        }
        commandRequestLeases.set(request, lease);
      }
      if (command.type !== "sendSketch" && command.type !== "sendReview") {
        const ack = await executeCommand(device, command);
        return { ok: true, data: ack };
      }
      const imageLease = imageCommandConcurrency.tryAcquire(device.id);
      if (imageLease === null) {
        await sendRateLimit(reply, 1, "Image command capacity is temporarily full");
        return;
      }
      try {
        const ack = await executeCommand(device, command);
        return { ok: true, data: ack };
      } finally {
        imageLease.release();
      }
    } finally {
      releaseCommandRequest(request);
    }
  });

  app.get("/api/commands/:commandId", async (request, reply) => {
    const device = await authenticate(request, reply);
    if (device === null) return;
    const { commandId } = commandParamsSchema.parse(request.params);
    return { ok: true, data: commandStatusResponse(commandId, ledger.status(device.id, commandId), state) };
  });

  app.get("/api/devices", async (request, reply) => {
    const device = await authenticate(request, reply);
    if (device === null) return;
    return {
      ok: true,
      data: {
        currentDeviceId: device.id,
        devices: await credentialStore.list(),
      },
    };
  });

  app.delete("/api/devices/:id", async (request, reply) => {
    requireOrigin(request);
    const device = await authenticate(request, reply);
    if (device === null || !await allowMutation(device, reply)) return;
    const { id } = deviceParamsSchema.parse(request.params);
    const revoked = await credentialStore.revoke(id);
    if (!revoked) return reply.code(404).send({ ok: false, error: apiError("NOT_FOUND", "Device was not found") });
    await pendingDeviceCleanup.get(id);
    return { ok: true, data: { revoked: true, deviceId: id } };
  });

  app.get("/ws", {
    websocket: true,
    preValidation: async (request, reply) => {
      const origin = requireOrigin(request);
      if (!webSocketAdmissions.tryReserve(request)) {
        await sendRateLimit(reply, 1, "WebSocket connection limit reached");
        return;
      }
      let accepted = false;
      try {
        const requestedProtocols = String(request.headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((protocol) => protocol.trim());
        if (requestedProtocols.includes(DOCTOR_WSS_SUBPROTOCOL)) {
          accepted = true;
          return;
        }
        const ticket = readWebSocketTicketProtocol(request.headers["sec-websocket-protocol"]);
        const rateKey = security.authRateKey(request, ticket);
        const preflight = authFailureLimit.checkKey(rateKey);
        if (!preflight.allowed) {
          await sendRateLimit(reply, preflight.retryAfterSeconds, "Authentication attempts are temporarily limited");
          return;
        }
        const ticketDevice = webSocketTickets.consume(ticket, origin);
        const device = ticketDevice === null
          ? null
          : await credentialStore.activeDevice(ticketDevice.id);
        if (device === null || ticketDevice === null || device.id !== ticketDevice.id) {
          const failure = authFailureLimit.consume(rateKey);
          if (!failure.allowed) {
            await sendRateLimit(reply, failure.retryAfterSeconds, "Authentication attempts are temporarily limited");
          } else {
            await reply.code(401).send({ ok: false, error: apiError("UNAUTHENTICATED", "WebSocket ticket is invalid or expired") });
          }
          return;
        }
        requestDevices.set(request, device);
        accepted = true;
      } finally {
        if (!accepted) webSocketAdmissions.release(request);
      }
    },
  }, (socket, request) => {
    socket.once("close", () => webSocketAdmissions.release(request));
    const device = requestDevices.get(request);
    if (device === undefined) {
      socket.close(4401, "unauthenticated");
      return;
    }
    const record: SocketRecord = { socket, device, alive: true };
    sockets.add(record);
    socket.on("pong", () => { record.alive = true; });
    socket.on("close", () => sockets.delete(record));
    socket.on("message", (data) => {
      const dataBytes = Array.isArray(data)
        ? data.reduce((total, part) => total + part.byteLength, 0)
        : data.byteLength;
      if (dataBytes > MAX_WS_PAYLOAD_BYTES) {
        socket.close(1009, "message too large");
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { socket.close(1007, "invalid json"); return; }
      const message = ClientWsMessageSchema.safeParse(parsed);
      if (!message.success) { socket.close(1007, "invalid message"); return; }
      if (message.data.type === "ping") {
        socket.send(JSON.stringify(ServerWsMessageSchema.parse({ type: "pong", nonce: message.data.nonce })));
        return;
      }
      if (message.data.type === "hello") {
        const snapshot = state.current();
        socket.send(JSON.stringify(ServerWsMessageSchema.parse({ type: "snapshot", snapshot })));
        return;
      }
      socket.send(JSON.stringify(ServerWsMessageSchema.parse({
        type: "error",
        bridgeInstanceId: state.current().bridgeInstanceId,
        sequence: state.current().sequence,
        commandId: message.data.command.commandId,
        error: apiError("UNSUPPORTED", "Mutations use authenticated HTTP so reconnect never replays them"),
      })));
    });
    socket.send(JSON.stringify(ServerWsMessageSchema.parse({ type: "snapshot", snapshot: state.current() })));
  });

  const sendToSocket = (record: SocketRecord, payload: unknown): void => {
    if (record.socket.readyState === 1) record.socket.send(JSON.stringify(payload));
  };
  const unsubscribeState = state.subscribe((snapshot) => {
    void notificationEngine.observe(snapshot).catch(() => {
      logger.warn("Nerva intelligent notification evaluation failed.");
    });
    const snapshotMessage = ServerWsMessageSchema.parse({ type: "snapshot", snapshot });
    const healthMessage = ServerWsMessageSchema.parse({
      type: "health",
      bridgeInstanceId: snapshot.bridgeInstanceId,
      sequence: snapshot.sequence,
      health: snapshot.bridgeHealth,
    });
    for (const record of sockets) {
      sendToSocket(record, snapshotMessage);
      sendToSocket(record, healthMessage);
    }
  });

  const pendingDeviceCleanup = new Map<string, Promise<void>>();
  const closeDeviceSockets = (deviceId: string): void => {
    webSocketTickets.revokeDevice(deviceId);
    const cleanup = (pendingDeviceCleanup.get(deviceId) ?? Promise.resolve())
      .then(() => pushSubscriptions.removeDevice(deviceId))
      .then(() => undefined)
      .catch(() => {
        logger.warn("Nerva could not remove the revoked device's Web Push subscription.");
      })
      .finally(() => {
        if (pendingDeviceCleanup.get(deviceId) === cleanup) pendingDeviceCleanup.delete(deviceId);
      });
    pendingDeviceCleanup.set(deviceId, cleanup);
    for (const record of sockets) {
      if (record.device.id === deviceId) record.socket.close(4401, "credential revoked");
    }
  };
  credentialStore.on("revoked", closeDeviceSockets);

  const refreshState = (): void => {
    void state.refresh().catch(() => {
      logger.warn("Codex Pad state refresh failed; the last safe snapshot remains active.");
    });
  };
  const refreshTimer = setInterval(refreshState, options.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  let heartbeatRunning = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    void (async () => {
      for (const record of [...sockets]) {
        if (!record.alive) {
          record.socket.terminate();
          continue;
        }
        const verified = await credentialStore.activeDevice(record.device.id).catch(() => null);
        if (verified === null || verified.id !== record.device.id) {
          record.socket.close(4401, "credential revoked");
          continue;
        }
        record.alive = false;
        record.socket.ping();
      }
    })().finally(() => { heartbeatRunning = false; });
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  refreshTimer.unref();
  heartbeatTimer.unref();
  startupCleanups.push(() => {
    clearInterval(refreshTimer);
    clearInterval(heartbeatTimer);
    unsubscribeState();
    notificationEngine.close();
    credentialStore.off("revoked", closeDeviceSockets);
    for (const record of sockets) record.socket.close(1001, "bridge startup failed");
  });
  refreshState();

  const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const webRoot = options.webRoot ?? defaultWebRoot;
  const hasWeb = await access(webRoot).then(() => true, () => false);
  if (hasWeb) {
    // The web build uses content-hashed asset names. Keep the wildcard route so
    // a running bridge can serve assets generated by a later frontend rebuild.
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url === "/ws") {
      return reply.code(404).send({ ok: false, error: apiError("NOT_FOUND", "Route not found") });
    }
    if (hasWeb) return reply.type("text/html").sendFile("index.html");
    return reply.type("text/html").send("<!doctype html><meta charset=utf-8><title>Codex Pad</title><p>Build apps/web before serving the PWA.</p>");
  });

  await app.listen({ host, port });
  const url = addressUrl(host, port);
  let closePromise: Promise<void> | null = null;
  const closeBridge = async (): Promise<void> => {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    clearInterval(refreshTimer);
    clearInterval(heartbeatTimer);
    unsubscribeState();
    notificationEngine.close();
    credentialStore.off("revoked", closeDeviceSockets);
    for (const record of sockets) record.socket.close(1001, "bridge stopping");
    await attempt(() => runtimeCleanup.stop());
    await attempt(() => app.close());
    await attempt(async () => {
      await Promise.all([...pendingDeviceCleanup.values()]);
    });
    // No request can enqueue a new ledger write after Fastify has closed. Wait
    // for active command finalization and every prune snapshot before allowing
    // another bridge or offline administrator to acquire the data-root lease.
    await attempt(() => ledger.close());
    if (ownedTransportClose !== null) await attempt(ownedTransportClose);
    if (ownsAdapter) await attempt(() => adapter.close());
    if (errors.length === 0) await attempt(() => lifetimeLease.release());
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Codex Pad bridge shutdown did not complete cleanly; its data-root lease was retained fail-closed",
      );
    }
  };
  return {
    app,
    url,
    state,
    createPairing(origin, deviceNameHint) {
      return pairingStore.rotate({ publicOrigin: origin, ...(deviceNameHint === undefined ? {} : { deviceNameHint }) });
    },
    async revokeDevice(deviceId) {
      const revoked = await credentialStore.revoke(deviceId);
      await pendingDeviceCleanup.get(deviceId);
      return revoked;
    },
    close() {
      closePromise ??= closeBridge();
      return closePromise;
    },
  };
}

import { isAbsolute } from "node:path";
import type { DesktopProcessIdentity } from "@codex-pad/codex-desktop";
import type { CodexUsageCredits, CodexUsageWindow } from "@codex-pad/protocol";

import {
  AppServerClient,
  AppServerClientError,
  AppServerRpcError,
  type AppServerWriteAuthorityToken,
  type AppServerInboundRequest,
  type AppServerNotification,
  type AppServerRequestId,
} from "./app-server-client.js";
import type { ExactTargetAuthorityToken } from "./exact-target-authority.js";

type UnknownRecord = Record<string, unknown>;

export type ThreadRuntimeStatus = "active" | "idle" | "notLoaded" | "systemError" | "unknown";
export type CommandDisposition = "started" | "steered" | "queued";
export type PendingApprovalKind = "commandExecution" | "fileChange" | "permissions";

export interface SendSketchInput {
  commandId: string;
  threadId: string;
  instruction: string;
  imagePath: string;
  assertTargetAuthority: TargetAuthorityGuard;
}

export interface SendReviewInput {
  commandId: string;
  threadId: string;
  instruction: string;
  imagePaths: string[];
  assertTargetAuthority: TargetAuthorityGuard;
}

export type TargetAuthorityGuard = (
  desktopIdentity?: DesktopProcessIdentity,
) => ExactTargetAuthorityToken | Promise<ExactTargetAuthorityToken>;

declare const NATIVE_MUTATION_AUTHORITY_BRAND: unique symbol;
export interface NativeMutationAuthorityToken {
  readonly [NATIVE_MUTATION_AUTHORITY_BRAND]: true;
}

export interface NativeMutationAuthority {
  readonly authority: NativeMutationAuthorityToken;
  readonly desktopIdentity: DesktopProcessIdentity;
}

export interface RunLibraryCommandInput {
  commandId: string;
  threadId: string;
  text: string;
  assertTargetAuthority: TargetAuthorityGuard;
}

export interface CommandAck {
  commandId: string;
  threadId: string;
  turnId: string | null;
  disposition: CommandDisposition;
  duplicate: boolean;
}

export interface ActionAck {
  commandId: string;
  threadId: string;
  duplicate: boolean;
}

export interface ThreadSnapshot {
  threadId: string;
  status: ThreadRuntimeStatus;
  activeTurnId: string | null;
  cwd: string | null;
  refreshedAt: string;
  raw: UnknownRecord;
}

export interface SessionSummary {
  threadId: string;
  title: string;
  cwd: string | null;
  updatedAt: number;
  status: ThreadRuntimeStatus;
}

export interface TransportHealth {
  mode: "managed-control-socket" | "injected-test-transport";
  connected: boolean;
  initialized: boolean;
  selectedThreadId: string | null;
  localImageSteerVerified: boolean;
  multiImageInputVerified: boolean;
  desktopOwnershipVerified: boolean;
  serverUserAgent: string | null;
  queuedSketches: number;
  detail?: string;
}

export interface CodexUsageReadResult {
  fetchedAt: number;
  planType: string | null;
  limitName: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: CodexUsageCredits | null;
  rateLimitReached: boolean;
}

export interface VerifiedLocalImageSteerCapability {
  verified: true;
  serverUserAgent: string;
  verifiedAt: string;
  probe: "runtime-disposable-thread";
}

export interface VerifiedMultiImageInputCapability {
  verified: true;
  serverUserAgent: string;
  verifiedAt: string;
  probe: "runtime-disposable-thread-bounded-multi-local-image";
  maxImages: number;
}

export interface PendingApproval {
  requestId: AppServerRequestId;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: PendingApprovalKind;
  actionable: boolean;
  summary: string | null;
  raw: UnknownRecord;
}

export interface ApprovalDecisionInput {
  commandId: string;
  requestId: AppServerRequestId;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: PendingApprovalKind;
  assertTargetAuthority: TargetAuthorityGuard;
}

export interface NewThreadInput {
  commandId: string;
  cwd?: string;
  model?: string;
}

export interface ForkThreadInput {
  commandId: string;
  threadId: string;
  lastTurnId?: string;
  assertTargetAuthority: TargetAuthorityGuard;
}

export interface ReasoningInput {
  commandId: string;
  threadId: string;
  effort: string;
  assertTargetAuthority: TargetAuthorityGuard;
}

export interface ModelInfo {
  readonly model: string;
  readonly displayName: string;
  readonly supportedReasoningEfforts: readonly string[];
  readonly defaultReasoningEffort: string;
  readonly isDefault: boolean;
}

export interface ModelReasoningInput extends ReasoningInput {
  readonly model: string;
}

export interface InvokeSkillInput {
  commandId: string;
  threadId: string;
  skillName: string;
  instruction?: string;
  assertTargetAuthority: TargetAuthorityGuard;
}

export interface StartTurnInput {
  commandId: string;
  threadId: string;
  input: UserInput[];
  effort?: string;
  assertTargetAuthority: TargetAuthorityGuard;
}

export interface SteerTurnInput {
  commandId: string;
  threadId: string;
  expectedTurnId: string;
  input: UserInput[];
  assertTargetAuthority: TargetAuthorityGuard;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  cwd: string;
  enabled: boolean;
}

export type ThreadTransportErrorCode =
  | "AMBIGUOUS_ACTIVE_TURN"
  | "AGENT_BUSY"
  | "APP_SERVER_UNAVAILABLE"
  | "APPROVAL_NOT_ACTIONABLE"
  | "APPROVAL_NOT_FOUND"
  | "CAPABILITY_UNAVAILABLE"
  | "COMMAND_ID_COLLISION"
  | "INVALID_COMMAND"
  | "INVALID_IMAGE_PATH"
  | "INVALID_THREAD_ID"
  | "QUEUE_FULL"
  | "STALE_EXPECTED_TURN"
  | "TARGET_NOT_SELECTED"
  | "THREAD_NOT_IDLE"
  | "THREAD_NOT_LOADED"
  | "THREAD_RESPONSE_MISMATCH"
  | "THREAD_STATE_UNKNOWN";

export class ThreadTransportError extends Error {
  readonly code: ThreadTransportErrorCode;
  readonly detail?: unknown;

  constructor(code: ThreadTransportErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "ThreadTransportError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface ThreadTransport {
  health(): Promise<TransportHealth>;
  /**
   * Refresh the private Desktop ownership proof used to bind authoritative
   * native reads. This exposes no write authority and is intentionally absent
   * from injected transports that do not model the managed Desktop boundary.
   */
  refreshDesktopOwnershipIdentity?(): Promise<DesktopProcessIdentity | null>;
  /** Acquire after all asynchronous preparation; consume at the native sink. */
  acquireNativeMutationAuthority?(
    finalTargetGuard?: TargetAuthorityGuard,
  ): Promise<NativeMutationAuthority>;
  consumeNativeMutationAuthority?(authority: NativeMutationAuthorityToken): void;
  selectThread(threadId: string, assertTargetAuthority: TargetAuthorityGuard): Promise<ThreadSnapshot>;
  clearSelectedThread(): void;
  threadRead(threadId: string): Promise<ThreadSnapshot>;
  resumeThread(threadId: string, assertTargetAuthority: TargetAuthorityGuard): Promise<ThreadSnapshot>;
  listSessions(): Promise<SessionSummary[]>;
  sendSketch(input: SendSketchInput): Promise<CommandAck>;
  sendReview(input: SendReviewInput): Promise<CommandAck>;
  runLibraryCommand(input: RunLibraryCommandInput): Promise<CommandAck>;
  startTurn(input: StartTurnInput): Promise<CommandAck>;
  steerTurn(input: SteerTurnInput): Promise<CommandAck>;
  newThread(input: NewThreadInput): Promise<ThreadSnapshot>;
  forkThread(input: ForkThreadInput): Promise<ThreadSnapshot>;
  setReasoning(input: ReasoningInput): Promise<ActionAck>;
  setModelReasoning(input: ModelReasoningInput): Promise<ActionAck>;
  listModels(): Promise<ModelInfo[]>;
  readCodexUsage?(): Promise<CodexUsageReadResult>;
  listSkills(cwds?: string[]): Promise<SkillInfo[]>;
  invokeSkill(input: InvokeSkillInput): Promise<CommandAck>;
  listPendingApprovals(threadId?: string): PendingApproval[];
  approve(input: ApprovalDecisionInput): Promise<ActionAck>;
  reject(input: ApprovalDecisionInput): Promise<ActionAck>;
}

export interface ManagedThreadTransportOptions {
  maxQueuedSketchesPerThread?: number;
  maxIdempotencyEntries?: number;
  queueWaitTimeoutMs?: number;
  localImageSteerCapability?: VerifiedLocalImageSteerCapability;
  multiImageInputCapability?: VerifiedMultiImageInputCapability;
  /** Revalidated immediately before accepting and dispatching every mutation. */
  assertMutationAuthority?: (
    finalTargetGuard?: TargetAuthorityGuard,
  ) => AppServerWriteAuthorityToken | Promise<AppServerWriteAuthorityToken>;
}

type RoutedCommand =
  | {
      kind: "review";
      commandId: string;
      threadId: string;
      instruction: string;
      imagePaths: string[];
      assertTargetAuthority: TargetAuthorityGuard;
    }
  | {
      kind: "library";
      commandId: string;
      threadId: string;
      text: string;
      assertTargetAuthority: TargetAuthorityGuard;
    };

type QueuedReview = {
  readonly input: RoutedCommand;
  readonly resolve: (ack: CommandAck) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  phase: "queued" | "dispatching" | "settled";
};

type IdempotentEntry<T> = {
  readonly fingerprint: string;
  readonly promise: Promise<T>;
  settled: boolean;
};

type QueuedDispatchListener = (
  event:
    | { type: "queued"; commandId: string; threadId: string; activeTurnId: string | null }
    | { type: "dispatched"; commandId: string; threadId: string; turnId: string }
    | { type: "failed"; commandId: string; threadId: string; error: Error },
) => void;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// Production does not retain normalized media behind an HTTP request. Callers
// receive an immediate typed busy result unless a deliberately constructed
// transport opts into the legacy in-process queue (used only by bounded tests).
const DEFAULT_QUEUE_LIMIT = 0;
const DEFAULT_IDEMPOTENCY_LIMIT = 512;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 120_000;
const MAX_REVIEW_IMAGES = 12;
const MAX_PENDING_APPROVALS = 64;
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 5;
const MAX_SESSIONS = SESSION_PAGE_SIZE * MAX_SESSION_PAGES;
const MAX_CURSOR_LENGTH = 4_096;
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireThreadId(threadId: string): string {
  if (!UUID_PATTERN.test(threadId)) {
    throw new ThreadTransportError(
      "INVALID_THREAD_ID",
      "Codex thread IDs must be UUIDs; no default-thread fallback is permitted.",
    );
  }
  return threadId.toLowerCase();
}

function requireCommandId(commandId: string): string {
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    throw new ThreadTransportError(
      "INVALID_COMMAND",
      "Command IDs must be 8-128 safe identifier characters.",
    );
  }
  return commandId;
}

function requireTurnId(turnId: string): string {
  if (!UUID_PATTERN.test(turnId)) {
    throw new ThreadTransportError("INVALID_COMMAND", "Expected turn IDs must be UUIDs.");
  }
  return turnId.toLowerCase();
}

function requireImagePath(imagePath: string): string {
  if (!isAbsolute(imagePath) || imagePath.includes("\0")) {
    throw new ThreadTransportError(
      "INVALID_IMAGE_PATH",
      "Sketches must use an absolute, NUL-free local image path validated by the bridge.",
    );
  }
  return imagePath;
}

function requireInstruction(instruction: string): string {
  const normalized = instruction.trim();
  if (normalized.length === 0 || normalized.length > 8_000) {
    throw new ThreadTransportError(
      "INVALID_COMMAND",
      "Sketch instructions must contain 1-8,000 non-whitespace characters.",
    );
  }
  return normalized;
}

function requireOptionalInstruction(instruction: string): string {
  const normalized = instruction.trim();
  if (normalized.length > 8_000) {
    throw new ThreadTransportError(
      "INVALID_COMMAND",
      "Sketch instructions must contain at most 8,000 characters.",
    );
  }
  return normalized;
}

function requireInputs(input: UserInput[]): UserInput[] {
  if (input.length === 0 || input.length > 16) {
    throw new ThreadTransportError("INVALID_COMMAND", "A turn requires 1-16 input items.");
  }
  for (const item of input) {
    if (item.type === "text") requireInstruction(item.text);
    if (item.type === "localImage") requireImagePath(item.path);
    if (item.type === "skill" && (item.name.trim() === "" || !isAbsolute(item.path))) {
      throw new ThreadTransportError("INVALID_COMMAND", "Skill inputs require a name and absolute path.");
    }
  }
  return input;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeStatus(value: unknown): ThreadRuntimeStatus {
  if (!isRecord(value) || typeof value.type !== "string") return "unknown";
  switch (value.type) {
    case "active":
    case "idle":
    case "notLoaded":
    case "systemError":
      return value.type;
    default:
      return "unknown";
  }
}

function extractActiveTurnId(thread: UnknownRecord): string | null {
  if (!Array.isArray(thread.turns)) return null;
  const activeIds: string[] = [];
  for (const candidate of thread.turns) {
    if (!isRecord(candidate) || candidate.status !== "inProgress" || typeof candidate.id !== "string") {
      continue;
    }
    if (UUID_PATTERN.test(candidate.id)) activeIds.push(candidate.id.toLowerCase());
  }

  if (activeIds.length > 1) {
    throw new ThreadTransportError(
      "AMBIGUOUS_ACTIVE_TURN",
      "The app-server reported more than one active turn for a thread.",
      activeIds,
    );
  }
  return activeIds[0] ?? null;
}

function snapshotFromResponse(response: unknown, expectedThreadId: string): ThreadSnapshot {
  if (!isRecord(response) || !isRecord(response.thread)) {
    throw new ThreadTransportError(
      "THREAD_RESPONSE_MISMATCH",
      "The app-server did not return a thread object.",
      response,
    );
  }

  const thread = response.thread;
  if (typeof thread.id !== "string" || thread.id.toLowerCase() !== expectedThreadId) {
    throw new ThreadTransportError(
      "THREAD_RESPONSE_MISMATCH",
      "The app-server response did not match the exact requested thread.",
      { expectedThreadId, returnedThreadId: thread.id },
    );
  }

  const reportedStatus = normalizeStatus(thread.status);
  const activeTurnId = extractActiveTurnId(thread);
  const status = activeTurnId === null ? reportedStatus : "active";
  return {
    threadId: expectedThreadId,
    status,
    activeTurnId,
    cwd: typeof thread.cwd === "string" ? thread.cwd : null,
    refreshedAt: new Date().toISOString(),
    // Preserve the bounded app-server response envelope. thread/resume carries
    // the exact model and reasoning fields beside the thread object, while
    // thread/read intentionally does not.
    raw: response,
  };
}

function latestActiveTurnIdFromPage(response: unknown): string | null {
  if (!isRecord(response) || !Array.isArray(response.data) || response.data.length > 1) {
    throw new ThreadTransportError(
      "THREAD_RESPONSE_MISMATCH",
      "thread/turns/list did not return one bounded turn page.",
      response,
    );
  }
  const latest = response.data[0];
  if (latest === undefined) return null;
  if (!isRecord(latest) || typeof latest.status !== "string") {
    throw new ThreadTransportError(
      "THREAD_RESPONSE_MISMATCH",
      "thread/turns/list returned an invalid latest turn.",
      response,
    );
  }
  if (latest.status !== "inProgress") return null;
  if (typeof latest.id !== "string" || !UUID_PATTERN.test(latest.id)) {
    throw new ThreadTransportError(
      "THREAD_RESPONSE_MISMATCH",
      "thread/turns/list returned an invalid active turn identifier.",
      response,
    );
  }
  return latest.id.toLowerCase();
}

function extractTurnId(response: unknown): string {
  if (!isRecord(response)) {
    throw new ThreadTransportError("THREAD_RESPONSE_MISMATCH", "Missing turn response.", response);
  }

  const candidate =
    isRecord(response.turn) && typeof response.turn.id === "string"
      ? response.turn.id
      : typeof response.turnId === "string"
        ? response.turnId
        : null;
  if (candidate === null || !UUID_PATTERN.test(candidate)) {
    throw new ThreadTransportError(
      "THREAD_RESPONSE_MISMATCH",
      "The app-server returned an invalid turn identifier.",
      response,
    );
  }
  return candidate.toLowerCase();
}

function parseMutationResponse<T>(method: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AppServerClientError && error.code === "APP_SERVER_DELIVERY_UNKNOWN") {
      throw error;
    }
    throw new AppServerClientError(
      "APP_SERVER_DELIVERY_UNKNOWN",
      `App-server acknowledged mutating request ${method}, but the response could not be reconciled safely.`,
      {
        phase: "post-response",
        clientCode: error instanceof ThreadTransportError ? error.code : "RESPONSE_VALIDATION_FAILED",
      },
    );
  }
}

function approvalKey(requestId: AppServerRequestId): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function validApprovalRequestId(requestId: AppServerRequestId): boolean {
  return typeof requestId === "number"
    ? Number.isSafeInteger(requestId)
    : requestId.length >= 1
      && requestId.length <= 128
      && !/[\u0000-\u001f\u007f]/u.test(requestId);
}

function validApprovalItemId(itemId: string): boolean {
  return itemId.length >= 1
    && itemId.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(itemId);
}

function approvalSummary(params: UnknownRecord): string | null {
  const candidate = typeof params.reason === "string"
    ? params.reason
    : typeof params.command === "string"
      ? params.command
      : null;
  if (candidate === null) return null;
  const normalized = candidate.trim();
  return normalized.length >= 1
    && normalized.length <= 500
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

export class ManagedThreadTransport implements ThreadTransport {
  private readonly client: AppServerClient;
  private readonly maxQueuedSketchesPerThread: number;
  private readonly maxIdempotencyEntries: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly localImageSteerVerified: boolean;
  private readonly multiImageInputLimit: number;
  private readonly mutationAuthorityGuard: (
    finalTargetGuard?: TargetAuthorityGuard,
  ) => AppServerWriteAuthorityToken | Promise<AppServerWriteAuthorityToken>;
  private readonly states = new Map<string, ThreadSnapshot>();
  private readonly sketchQueues = new Map<string, QueuedReview[]>();
  // This is an internal, process-local coalescing guard. Restart-safe public-command
  // idempotency belongs to the authenticated server ledger that wraps the executor.
  private readonly commandLedger = new Map<string, IdempotentEntry<unknown>>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly queuedDispatchListeners = new Set<QueuedDispatchListener>();
  private readonly flushingThreads = new Set<string>();
  private selectedThreadId: string | null = null;

  constructor(client: AppServerClient, options: ManagedThreadTransportOptions = {}) {
    this.client = client;
    this.maxQueuedSketchesPerThread =
      options.maxQueuedSketchesPerThread ?? DEFAULT_QUEUE_LIMIT;
    this.maxIdempotencyEntries = options.maxIdempotencyEntries ?? DEFAULT_IDEMPOTENCY_LIMIT;
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
    const capability = options.localImageSteerCapability;
    this.localImageSteerVerified =
      capability?.verified === true &&
      capability.probe === "runtime-disposable-thread" &&
      capability.serverUserAgent === client.serverInfo?.userAgent &&
      !Number.isNaN(Date.parse(capability.verifiedAt));
    const multiImageCapability = options.multiImageInputCapability;
    this.multiImageInputLimit =
      multiImageCapability?.verified === true &&
      multiImageCapability.probe === "runtime-disposable-thread-bounded-multi-local-image" &&
      multiImageCapability.serverUserAgent === client.serverInfo?.userAgent &&
      !Number.isNaN(Date.parse(multiImageCapability.verifiedAt)) &&
      Number.isInteger(multiImageCapability.maxImages) &&
      multiImageCapability.maxImages === MAX_REVIEW_IMAGES
        ? multiImageCapability.maxImages
        : 0;
    this.mutationAuthorityGuard = options.assertMutationAuthority ?? (() => {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "Shared Desktop ownership is not attested; app-server mutations are disabled.",
      );
    });

    client.onNotification((notification) => this.handleNotification(notification));
    client.onServerRequest((request) => this.handleServerRequest(request));
    client.onClose(() => {
      this.states.clear();
      this.rejectAllQueued(
        new ThreadTransportError(
          "APP_SERVER_UNAVAILABLE",
          "The managed app-server disconnected before a queued sketch was acknowledged.",
        ),
      );
    });
  }

  async health(): Promise<TransportHealth> {
    const connected = this.client.isInitialized && !this.client.isClosed;
    const health: TransportHealth = {
      mode:
        this.client.transportKind === "managed-proxy"
          ? "managed-control-socket"
          : "injected-test-transport",
      connected,
      initialized: this.client.isInitialized,
      selectedThreadId: this.selectedThreadId,
      localImageSteerVerified: this.localImageSteerVerified,
      multiImageInputVerified: this.multiImageInputLimit === MAX_REVIEW_IMAGES,
      desktopOwnershipVerified: false,
      serverUserAgent: this.client.serverInfo?.userAgent ?? null,
      queuedSketches: [...this.sketchQueues.values()].reduce(
        (total, queue) => total + queue.length,
        0,
      ),
    };
    if (!connected) health.detail = "No initialized managed app-server control connection.";
    return health;
  }

  async selectThread(
    threadId: string,
    assertTargetAuthority: TargetAuthorityGuard,
  ): Promise<ThreadSnapshot> {
    const target = requireThreadId(threadId);
    if (this.selectedThreadId !== null && this.selectedThreadId !== target) {
      const previous = this.selectedThreadId;
      this.selectedThreadId = null;
      this.rejectThreadQueue(
        previous,
        new ThreadTransportError(
          "TARGET_NOT_SELECTED",
          "The queued command target is no longer the exact selected thread.",
          { selectedThreadId: target, requestedThreadId: previous },
        ),
      );
    }
    // Read verifies the identifier without a fallback; resume then explicitly joins this
    // connection to the selected thread so turn/approval notifications reach its queue.
    await this.threadRead(target);
    this.selectedThreadId = target;
    let snapshot: ThreadSnapshot;
    try {
      snapshot = await this.resumeThread(target, assertTargetAuthority);
    } catch (error) {
      if (this.selectedThreadId === target) this.selectedThreadId = null;
      throw error;
    }
    if (snapshot.status === "notLoaded" || snapshot.status === "unknown") {
      throw new ThreadTransportError(
        "THREAD_NOT_LOADED",
        "The selected Codex thread could not be loaded into the managed app-server.",
      );
    }
    this.selectedThreadId = target;
    return snapshot;
  }

  clearSelectedThread(): void {
    const previous = this.selectedThreadId;
    this.selectedThreadId = null;
    if (previous !== null) {
      this.rejectThreadQueue(
        previous,
        new ThreadTransportError(
          "TARGET_NOT_SELECTED",
          "The queued command target is no longer selected.",
          { selectedThreadId: null, requestedThreadId: previous },
        ),
      );
    }
  }

  async threadRead(threadId: string): Promise<ThreadSnapshot> {
    const target = requireThreadId(threadId);
    this.assertConnected();
    const response = await this.client.call("thread/read", {
      threadId: target,
      includeTurns: false,
    });
    let snapshot = snapshotFromResponse(response, target);
    if (snapshot.status === "active" && snapshot.activeTurnId === null) {
      snapshot = {
        ...snapshot,
        activeTurnId: await this.readLatestActiveTurnId(target),
      };
    }
    this.states.set(target, snapshot);
    return snapshot;
  }

  async resumeThread(
    threadId: string,
    assertTargetAuthority: TargetAuthorityGuard,
  ): Promise<ThreadSnapshot> {
    const target = requireThreadId(threadId);
    this.assertConnected();
    const authority = await this.assertTargetAndMutationAuthority(
      target,
      assertTargetAuthority,
      true,
    );
    const response = await this.client.mutate("thread/resume", {
      threadId: target,
      excludeTurns: true,
      initialTurnsPage: {
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    }, authority);
    let snapshot = snapshotFromResponse(response, target);
    if (snapshot.status === "active" && snapshot.activeTurnId === null) {
      const initialPage = isRecord(response) ? response.initialTurnsPage : undefined;
      snapshot = {
        ...snapshot,
        activeTurnId: initialPage === undefined || initialPage === null
          ? await this.readLatestActiveTurnId(target)
          : latestActiveTurnIdFromPage(initialPage),
      };
    }
    this.states.set(target, snapshot);
    return snapshot;
  }

  async listSessions(): Promise<SessionSummary[]> {
    this.assertConnected();
    const sessions: SessionSummary[] = [];
    const seenThreadIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
      const params: UnknownRecord = {
        limit: SESSION_PAGE_SIZE,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: true,
      };
      if (cursor !== undefined) params.cursor = cursor;
      const response = await this.client.call("thread/list", params);
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new ThreadTransportError(
          "THREAD_RESPONSE_MISMATCH",
          "thread/list returned an invalid response.",
          response,
        );
      }

      for (const value of response.data) {
        if (!isRecord(value) || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
          continue;
        }
        const threadId = value.id.toLowerCase();
        if (seenThreadIds.has(threadId)) continue;
        seenThreadIds.add(threadId);
        const name = typeof value.name === "string" ? value.name : "";
        const preview = typeof value.preview === "string" ? value.preview : "";
        const title = (name.trim() || preview.trim() || "Untitled task")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .slice(0, 240);
        sessions.push({
          threadId,
          title,
          cwd: typeof value.cwd === "string" ? value.cwd : null,
          updatedAt:
            typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
              ? value.updatedAt
              : 0,
          status: normalizeStatus(value.status),
        });
        if (sessions.length === MAX_SESSIONS) return sessions;
      }

      if (response.nextCursor === null) return sessions;
      if (
        typeof response.nextCursor !== "string" ||
        response.nextCursor.trim().length === 0 ||
        response.nextCursor.length > MAX_CURSOR_LENGTH ||
        response.nextCursor.includes("\0")
      ) {
        throw new ThreadTransportError(
          "THREAD_RESPONSE_MISMATCH",
          "thread/list returned a malformed pagination cursor.",
          response.nextCursor,
        );
      }
      if (seenCursors.has(response.nextCursor)) {
        throw new ThreadTransportError(
          "THREAD_RESPONSE_MISMATCH",
          "thread/list returned a cyclic pagination cursor.",
          response.nextCursor,
        );
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }

    return sessions;
  }

  async sendSketch(input: SendSketchInput): Promise<CommandAck> {
    return this.sendReview({
      commandId: input.commandId,
      threadId: input.threadId,
      instruction: input.instruction,
      imagePaths: [input.imagePath],
      assertTargetAuthority: input.assertTargetAuthority,
    });
  }

  async sendReview(input: SendReviewInput): Promise<CommandAck> {
    if (input.imagePaths.length === 0 || input.imagePaths.length > MAX_REVIEW_IMAGES) {
      throw new ThreadTransportError(
        "INVALID_COMMAND",
        `A review must contain 1-${MAX_REVIEW_IMAGES} ordered images.`,
      );
    }
    if (input.imagePaths.length > 1 && input.imagePaths.length > this.multiImageInputLimit) {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        this.multiImageInputLimit === 0
          ? "Multi-image app-server input has not been verified by a bounded runtime probe."
          : `The runtime probe verified at most ${this.multiImageInputLimit} ordered images.`,
      );
    }
    const normalized: RoutedCommand = {
      kind: "review",
      commandId: requireCommandId(input.commandId),
      threadId: requireThreadId(input.threadId),
      instruction: requireOptionalInstruction(input.instruction),
      imagePaths: input.imagePaths.map(requireImagePath),
      assertTargetAuthority: input.assertTargetAuthority,
    };
    this.assertSelected(normalized.threadId);

    return this.idempotent<CommandAck>(
      normalized.commandId,
      fingerprint(normalized),
      () => this.dispatchReview(normalized),
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  async runLibraryCommand(input: RunLibraryCommandInput): Promise<CommandAck> {
    const normalized: RoutedCommand = {
      kind: "library",
      commandId: requireCommandId(input.commandId),
      threadId: requireThreadId(input.threadId),
      text: requireInstruction(input.text),
      assertTargetAuthority: input.assertTargetAuthority,
    };
    this.assertSelected(normalized.threadId);
    return this.idempotent<CommandAck>(
      normalized.commandId,
      fingerprint(normalized),
      () => this.dispatchRoutedCommand(normalized),
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  async startTurn(input: StartTurnInput): Promise<CommandAck> {
    const commandId = requireCommandId(input.commandId);
    const threadId = requireThreadId(input.threadId);
    const turnInput = requireInputs(input.input);
    this.assertSelected(threadId);
    const effort = input.effort;
    if (effort !== undefined && !EFFORT_PATTERN.test(effort)) {
      throw new ThreadTransportError("INVALID_COMMAND", "Invalid reasoning effort.");
    }

    return this.idempotent<CommandAck>(
      commandId,
      fingerprint({ threadId, turnInput, effort }),
      async () => {
        const snapshot = await this.refreshLoadedTarget(threadId);
        if (snapshot.status !== "idle" || snapshot.activeTurnId !== null) {
          throw new ThreadTransportError(
            "THREAD_NOT_IDLE",
            "turn/start is only allowed after the exact target is authoritatively idle.",
            snapshot,
          );
        }
        const params: UnknownRecord = {
          threadId,
          clientUserMessageId: commandId,
          input: turnInput,
        };
        if (effort !== undefined) params.effort = effort;
        const authority = await this.assertTargetAndMutationAuthority(
          threadId,
          input.assertTargetAuthority,
          true,
        );
        const response = await this.client.mutate("turn/start", params, authority);
        const turnId = parseMutationResponse("turn/start", () => extractTurnId(response));
        this.states.set(threadId, { ...snapshot, status: "active", activeTurnId: turnId });
        return { commandId, threadId, turnId, disposition: "started", duplicate: false };
      },
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  async steerTurn(input: SteerTurnInput): Promise<CommandAck> {
    const commandId = requireCommandId(input.commandId);
    const threadId = requireThreadId(input.threadId);
    const expectedTurnId = requireTurnId(input.expectedTurnId);
    const turnInput = requireInputs(input.input);
    this.assertSelected(threadId);

    return this.idempotent<CommandAck>(
      commandId,
      fingerprint({ threadId, expectedTurnId, turnInput }),
      async () => {
        const snapshot = await this.refreshLoadedTarget(threadId);
        if (snapshot.status !== "active" || snapshot.activeTurnId !== expectedTurnId) {
          throw new ThreadTransportError(
            "STALE_EXPECTED_TURN",
            "The expected turn is no longer the exact active turn; the command was not retried.",
            snapshot,
          );
        }
        return this.performSteer(
          commandId,
          threadId,
          expectedTurnId,
          turnInput,
          input.assertTargetAuthority,
          true,
        );
      },
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  async newThread(input: NewThreadInput): Promise<ThreadSnapshot> {
    const commandId = requireCommandId(input.commandId);
    if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
      throw new ThreadTransportError("INVALID_COMMAND", "New thread cwd must be absolute.");
    }
    if (input.model !== undefined && input.model.trim() === "") {
      throw new ThreadTransportError("INVALID_COMMAND", "New thread model cannot be empty.");
    }

    return this.idempotent<ThreadSnapshot>(
      commandId,
      fingerprint(input),
      async () => {
        this.assertConnected();
        const params: UnknownRecord = {
          ephemeral: false,
        };
        if (input.cwd !== undefined) params.cwd = input.cwd;
        if (input.model !== undefined) params.model = input.model;
        // Creating a brand-new thread has no pre-existing native target. It is
        // the sole managed mutation that is ownership-only at this boundary.
        const authority = await this.assertMutationAuthority();
        const response = await this.client.mutate("thread/start", params, authority);
        const snapshot = parseMutationResponse("thread/start", () => {
          if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== "string") {
            throw new ThreadTransportError(
              "THREAD_RESPONSE_MISMATCH",
              "thread/start did not return a thread.",
              response,
            );
          }
          const threadId = requireThreadId(response.thread.id);
          return snapshotFromResponse(response, threadId);
        });
        const { threadId } = snapshot;
        this.states.set(threadId, snapshot);
        this.selectedThreadId = threadId;
        return snapshot;
      },
      (snapshot) => snapshot,
    );
  }

  async forkThread(input: ForkThreadInput): Promise<ThreadSnapshot> {
    const commandId = requireCommandId(input.commandId);
    const sourceThreadId = requireThreadId(input.threadId);
    const lastTurnId = input.lastTurnId === undefined ? undefined : requireTurnId(input.lastTurnId);
    this.assertSelected(sourceThreadId);

    return this.idempotent<ThreadSnapshot>(
      commandId,
      fingerprint({ sourceThreadId, lastTurnId }),
      async () => {
        const source = await this.refreshLoadedTarget(sourceThreadId);
        if (source.status !== "idle" || source.activeTurnId !== null) {
          throw new ThreadTransportError(
            "THREAD_NOT_IDLE",
            "Forking is disabled while the exact source thread has an active turn.",
          );
        }
        const params: UnknownRecord = { threadId: sourceThreadId, ephemeral: false };
        if (lastTurnId !== undefined) params.lastTurnId = lastTurnId;
        const authority = await this.assertTargetAndMutationAuthority(
          sourceThreadId,
          input.assertTargetAuthority,
          true,
        );
        const response = await this.client.mutate("thread/fork", params, authority);
        const snapshot = parseMutationResponse("thread/fork", () => {
          if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== "string") {
            throw new ThreadTransportError(
              "THREAD_RESPONSE_MISMATCH",
              "thread/fork did not return a thread.",
              response,
            );
          }
          const forkedThreadId = requireThreadId(response.thread.id);
          if (forkedThreadId === sourceThreadId) {
            throw new ThreadTransportError(
              "THREAD_RESPONSE_MISMATCH",
              "thread/fork returned the source thread instead of a new thread.",
            );
          }
          return snapshotFromResponse(response, forkedThreadId);
        });
        const forkedThreadId = snapshot.threadId;
        this.states.set(forkedThreadId, snapshot);
        this.selectedThreadId = forkedThreadId;
        return snapshot;
      },
      (snapshot) => snapshot,
    );
  }

  async setReasoning(input: ReasoningInput): Promise<ActionAck> {
    const commandId = requireCommandId(input.commandId);
    const threadId = requireThreadId(input.threadId);
    if (!EFFORT_PATTERN.test(input.effort)) {
      throw new ThreadTransportError("INVALID_COMMAND", "Invalid reasoning effort.");
    }
    this.assertSelected(threadId);

    return this.idempotent<ActionAck>(
      commandId,
      fingerprint({ threadId, effort: input.effort }),
      async () => {
        await this.refreshLoadedTarget(threadId);
        const authority = await this.assertTargetAndMutationAuthority(
          threadId,
          input.assertTargetAuthority,
          true,
        );
        await this.client.mutate(
          "thread/settings/update",
          { threadId, effort: input.effort },
          authority,
        );
        return { commandId, threadId, duplicate: false };
      },
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  async setModelReasoning(input: ModelReasoningInput): Promise<ActionAck> {
    const commandId = requireCommandId(input.commandId);
    const threadId = requireThreadId(input.threadId);
    const model = requireOptionalInstruction(input.model).trim();
    if (model.length > 100 || !EFFORT_PATTERN.test(input.effort)) {
      throw new ThreadTransportError("INVALID_COMMAND", "Invalid model or reasoning effort.");
    }
    this.assertSelected(threadId);

    return this.idempotent<ActionAck>(
      commandId,
      fingerprint({ threadId, model, effort: input.effort }),
      async () => {
        const catalog = await this.listModels();
        const exact = catalog.find((candidate) => candidate.model === model);
        if (exact === undefined || !exact.supportedReasoningEfforts.includes(input.effort)) {
          throw new ThreadTransportError(
            "CAPABILITY_UNAVAILABLE",
            "That exact model and reasoning combination is not exposed by this Codex installation.",
          );
        }
        await this.refreshLoadedTarget(threadId);
        const authority = await this.assertTargetAndMutationAuthority(
          threadId,
          input.assertTargetAuthority,
          true,
        );
        await this.client.mutate(
          "thread/settings/update",
          { threadId, model, effort: input.effort },
          authority,
        );
        return { commandId, threadId, duplicate: false };
      },
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    this.assertConnected();
    const models: ModelInfo[] = [];
    const seenModels = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      const response = await this.client.call("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new ThreadTransportError(
          "THREAD_RESPONSE_MISMATCH",
          "model/list returned an invalid response.",
          response,
        );
      }
      for (const entry of response.data) {
        if (
          !isRecord(entry)
          || typeof entry.model !== "string"
          || typeof entry.displayName !== "string"
          || !Array.isArray(entry.supportedReasoningEfforts)
          || typeof entry.defaultReasoningEffort !== "string"
        ) continue;
        const model = entry.model.trim();
        if (!model || model.length > 100 || seenModels.has(model)) continue;
        const efforts = entry.supportedReasoningEfforts.flatMap((option) => {
          if (!isRecord(option) || typeof option.reasoningEffort !== "string") return [];
          return EFFORT_PATTERN.test(option.reasoningEffort) ? [option.reasoningEffort] : [];
        });
        if (efforts.length === 0) continue;
        seenModels.add(model);
        models.push({
          model,
          displayName: entry.displayName.trim().slice(0, 120) || model,
          supportedReasoningEfforts: [...new Set(efforts)],
          defaultReasoningEffort: entry.defaultReasoningEffort,
          isDefault: entry.isDefault === true,
        });
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor.length > 0
        ? response.nextCursor
        : null;
      if (nextCursor === null || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return models;
  }

  async readCodexUsage(): Promise<CodexUsageReadResult> {
    this.assertConnected();
    const response = await this.client.call("account/rateLimits/read");
    if (!isRecord(response) || !isRecord(response.rateLimits)) {
      throw new ThreadTransportError(
        "THREAD_RESPONSE_MISMATCH",
        "account/rateLimits/read returned an invalid response.",
        response,
      );
    }

    const byLimitId = isRecord(response.rateLimitsByLimitId)
      ? response.rateLimitsByLimitId
      : null;
    const namedCodex = byLimitId && isRecord(byLimitId.codex) ? byLimitId.codex : null;
    const matchingCodex = byLimitId
      ? Object.values(byLimitId).find((candidate) => isRecord(candidate) && candidate.limitId === "codex")
      : undefined;
    const snapshot = namedCodex ?? (isRecord(matchingCodex) ? matchingCodex : response.rateLimits);

    const windowFrom = (value: unknown): CodexUsageWindow | null => {
      if (!isRecord(value) || !Number.isFinite(value.usedPercent)) return null;
      const usedPercent = Math.min(100, Math.max(0, Math.round(Number(value.usedPercent))));
      const windowMinutes = Number.isSafeInteger(value.windowDurationMins)
        && Number(value.windowDurationMins) > 0
        ? Number(value.windowDurationMins)
        : null;
      const resetsAt = Number.isSafeInteger(value.resetsAt)
        && Number(value.resetsAt) >= 0
        && Number(value.resetsAt) <= Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
        ? Number(value.resetsAt) * 1_000
        : null;
      return { usedPercent, windowMinutes, resetsAt };
    };

    const credits = isRecord(snapshot.credits)
      && typeof snapshot.credits.hasCredits === "boolean"
      && typeof snapshot.credits.unlimited === "boolean"
      ? {
          hasCredits: snapshot.credits.hasCredits,
          unlimited: snapshot.credits.unlimited,
          balance: typeof snapshot.credits.balance === "string"
            ? snapshot.credits.balance.trim().slice(0, 120) || null
            : null,
        }
      : null;
    const primary = windowFrom(snapshot.primary);
    const secondary = windowFrom(snapshot.secondary);
    if (primary === null && secondary === null && credits === null) {
      throw new ThreadTransportError(
        "THREAD_RESPONSE_MISMATCH",
        "account/rateLimits/read did not expose a usable Codex usage snapshot.",
        response,
      );
    }

    return {
      fetchedAt: Date.now(),
      planType: typeof snapshot.planType === "string" ? snapshot.planType.slice(0, 80) : null,
      limitName: typeof snapshot.limitName === "string"
        ? snapshot.limitName.trim().slice(0, 120) || null
        : null,
      primary,
      secondary,
      credits,
      rateLimitReached: typeof snapshot.rateLimitReachedType === "string",
    };
  }

  async listSkills(cwds: string[] = []): Promise<SkillInfo[]> {
    this.assertConnected();
    if (cwds.some((cwd) => !isAbsolute(cwd))) {
      throw new ThreadTransportError("INVALID_COMMAND", "Skill roots must be absolute paths.");
    }
    const response = await this.client.call("skills/list", { cwds, forceReload: false });
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new ThreadTransportError(
        "THREAD_RESPONSE_MISMATCH",
        "skills/list returned an invalid response.",
        response,
      );
    }

    const skills: SkillInfo[] = [];
    for (const entry of response.data) {
      if (!isRecord(entry) || typeof entry.cwd !== "string" || !Array.isArray(entry.skills)) continue;
      for (const skill of entry.skills) {
        if (
          !isRecord(skill) ||
          typeof skill.name !== "string" ||
          typeof skill.description !== "string" ||
          typeof skill.path !== "string" ||
          typeof skill.enabled !== "boolean" ||
          !isAbsolute(skill.path)
        ) {
          continue;
        }
        skills.push({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          cwd: entry.cwd,
          enabled: skill.enabled,
        });
      }
    }
    return skills;
  }

  async invokeSkill(input: InvokeSkillInput): Promise<CommandAck> {
    const commandId = requireCommandId(input.commandId);
    const threadId = requireThreadId(input.threadId);
    const skillName = input.skillName.trim();
    if (skillName.length === 0 || skillName.length > 128) {
      throw new ThreadTransportError("INVALID_COMMAND", "Invalid skill name.");
    }
    this.assertSelected(threadId);

    return this.idempotent<CommandAck>(
      commandId,
      fingerprint(input),
      async () => {
        await this.assertTargetAndMutationAuthority(
          threadId,
          input.assertTargetAuthority,
          true,
        );
        const snapshot = await this.refreshLoadedTarget(threadId);
        const roots = snapshot.cwd === null ? [] : [snapshot.cwd];
        const candidates = (await this.listSkills(roots)).filter(
          (skill) => skill.enabled && skill.name === skillName,
        );
        if (candidates.length !== 1) {
          throw new ThreadTransportError(
            "CAPABILITY_UNAVAILABLE",
            `Skill ${skillName} is not uniquely available for the selected thread.`,
          );
        }
        const skill = candidates[0];
        if (skill === undefined) {
          throw new ThreadTransportError("CAPABILITY_UNAVAILABLE", "Skill resolution failed closed.");
        }
        const turnInput: UserInput[] = [{ type: "skill", name: skill.name, path: skill.path }];
        if (input.instruction !== undefined) {
          turnInput.push({
            type: "text",
            text: requireInstruction(input.instruction),
            text_elements: [],
          });
        }
        if (snapshot.status === "idle" && snapshot.activeTurnId === null) {
          const authority = await this.assertTargetAndMutationAuthority(
            threadId,
            input.assertTargetAuthority,
            true,
          );
          const response = await this.client.mutate("turn/start", {
            threadId,
            clientUserMessageId: commandId,
            input: turnInput,
          }, authority);
          const turnId = parseMutationResponse("turn/start", () => extractTurnId(response));
          return { commandId, threadId, turnId, disposition: "started", duplicate: false };
        }
        if (snapshot.status === "active" && snapshot.activeTurnId !== null) {
          return this.performSteer(
            commandId,
            threadId,
            snapshot.activeTurnId,
            turnInput,
            input.assertTargetAuthority,
            true,
          );
        }
        throw new ThreadTransportError(
          "THREAD_STATE_UNKNOWN",
          "A skill can only be routed to a loaded idle thread or its exact active turn.",
          snapshot,
        );
      },
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  listPendingApprovals(threadId?: string): PendingApproval[] {
    const target = threadId === undefined ? undefined : requireThreadId(threadId);
    return [...this.pendingApprovals.values()].filter(
      (approval) => target === undefined || approval.threadId === target,
    );
  }

  approve(input: ApprovalDecisionInput): Promise<ActionAck> {
    return this.respondToApproval(input, "accept");
  }

  reject(input: ApprovalDecisionInput): Promise<ActionAck> {
    return this.respondToApproval(input, "decline");
  }

  onQueuedDispatch(listener: QueuedDispatchListener): () => void {
    this.queuedDispatchListeners.add(listener);
    return () => this.queuedDispatchListeners.delete(listener);
  }

  private async dispatchReview(input: RoutedCommand): Promise<CommandAck> {
    return this.dispatchRoutedCommand(input);
  }

  private async dispatchRoutedCommand(input: RoutedCommand): Promise<CommandAck> {
    // Queue acceptance and direct dispatch both require the exact native target
    // before and after the asynchronous Desktop ownership probe.
    await this.assertTargetAndMutationAuthority(
      input.threadId,
      input.assertTargetAuthority,
      true,
    );
    const snapshot = await this.refreshLoadedTarget(input.threadId);
    const userInput: UserInput[] = this.toUserInput(input);

    if (snapshot.status === "idle" && snapshot.activeTurnId === null) {
      const authority = await this.assertTargetAndMutationAuthority(
        input.threadId,
        input.assertTargetAuthority,
        true,
      );
      const response = await this.client.mutate("turn/start", {
        threadId: input.threadId,
        clientUserMessageId: input.commandId,
        input: userInput,
      }, authority);
      const turnId = parseMutationResponse("turn/start", () => extractTurnId(response));
      this.states.set(input.threadId, {
        ...snapshot,
        status: "active",
        activeTurnId: turnId,
      });
      return {
        commandId: input.commandId,
        threadId: input.threadId,
        turnId,
        disposition: "started",
        duplicate: false,
      };
    }

    if (snapshot.status === "active") {
      const steeringIsVerified = input.kind === "library" || this.localImageSteerVerified;
      if (steeringIsVerified && snapshot.activeTurnId !== null) {
        return this.performSteer(
          input.commandId,
          input.threadId,
          snapshot.activeTurnId,
          userInput,
          input.assertTargetAuthority,
          true,
        );
      }
      if (this.maxQueuedSketchesPerThread === 0) {
        throw new ThreadTransportError(
          "AGENT_BUSY",
          "The selected agent is busy and verified image steering is unavailable; nothing was queued or sent.",
        );
      }
      await this.assertTargetAndMutationAuthority(
        input.threadId,
        input.assertTargetAuthority,
        true,
      );
      return this.enqueueSketch(input, snapshot.activeTurnId);
    }

    if (snapshot.status === "notLoaded") {
      throw new ThreadTransportError(
        "THREAD_NOT_LOADED",
        "The exact selected thread is not loaded; the sketch was not sent elsewhere.",
      );
    }
    throw new ThreadTransportError(
      "THREAD_STATE_UNKNOWN",
      "The selected thread is not authoritatively idle or active.",
      snapshot,
    );
  }

  private async performSteer(
    commandId: string,
    threadId: string,
    expectedTurnId: string,
    input: UserInput[],
    assertTargetAuthority?: TargetAuthorityGuard,
    requireTargetAuthority = false,
  ): Promise<CommandAck> {
    try {
      const authority = await this.assertTargetAndMutationAuthority(
        threadId,
        assertTargetAuthority,
        requireTargetAuthority,
      );
      const response = await this.client.mutate("turn/steer", {
        threadId,
        clientUserMessageId: commandId,
        input,
        expectedTurnId,
      }, authority);
      const returnedTurnId = parseMutationResponse("turn/steer", () => {
        const candidate = extractTurnId(response);
        if (candidate !== expectedTurnId) {
          throw new ThreadTransportError(
            "THREAD_RESPONSE_MISMATCH",
            "turn/steer acknowledged a different turn.",
            { expectedTurnId, returnedTurnId: candidate },
          );
        }
        return candidate;
      });
      return {
        commandId,
        threadId,
        turnId: returnedTurnId,
        disposition: "steered",
        duplicate: false,
      };
    } catch (error) {
      if (error instanceof ThreadTransportError) throw error;
      if (error instanceof AppServerRpcError) {
        let current: ThreadSnapshot | undefined;
        try {
          current = await this.threadRead(threadId);
        } catch {
          // The original stale-turn failure remains the authoritative result.
        }
        throw new ThreadTransportError(
          "STALE_EXPECTED_TURN",
          "turn/steer failed its exact active-turn precondition and was not retried.",
          { expectedTurnId, current, rpcCode: error.code, rpcMessage: error.message },
        );
      }
      throw error;
    }
  }

  private enqueueSketch(input: RoutedCommand, activeTurnId: string | null): Promise<CommandAck> {
    if (this.maxQueuedSketchesPerThread === 0) {
      throw new ThreadTransportError(
        "AGENT_BUSY",
        "The selected agent is busy and verified image steering is unavailable; nothing was queued or sent.",
      );
    }
    const queue = this.sketchQueues.get(input.threadId) ?? [];
    if (queue.length >= this.maxQueuedSketchesPerThread) {
      throw new ThreadTransportError(
        "QUEUE_FULL",
        `The selected thread already has ${queue.length} queued sketches.`,
      );
    }
    return new Promise<CommandAck>((resolveQueued, rejectQueued) => {
      const queued: QueuedReview = {
        input,
        resolve: resolveQueued,
        reject: rejectQueued,
        timer: null,
        phase: "queued",
      };
      queued.timer = setTimeout(() => {
        if (queued.phase !== "queued") return;
        const currentQueue = this.sketchQueues.get(input.threadId);
        if (currentQueue !== undefined) {
          const index = currentQueue.indexOf(queued);
          if (index >= 0) currentQueue.splice(index, 1);
          if (currentQueue.length === 0) this.sketchQueues.delete(input.threadId);
        }
        const error = new ThreadTransportError(
          "APP_SERVER_UNAVAILABLE",
          `Queued sketch ${input.commandId} did not begin dispatch within ${this.queueWaitTimeoutMs} ms.`,
        );
        this.rejectQueuedEntry(queued, error);
      }, this.queueWaitTimeoutMs);

      queue.push(queued);
      this.sketchQueues.set(input.threadId, queue);
      for (const listener of this.queuedDispatchListeners) {
        listener({
          type: "queued",
          commandId: input.commandId,
          threadId: input.threadId,
          activeTurnId,
        });
      }
    });
  }

  private async flushSketchQueue(threadId: string): Promise<void> {
    if (this.flushingThreads.has(threadId)) return;
    if ((this.sketchQueues.get(threadId)?.length ?? 0) === 0 || this.client.isClosed) return;
    this.flushingThreads.add(threadId);
    let dispatching: QueuedReview | undefined;

    try {
      this.assertSelected(threadId);
      const snapshot = await this.refreshLoadedTarget(threadId);
      // Selection may have changed while the authoritative read was in flight.
      this.assertSelected(threadId);
      if (snapshot.status !== "idle" || snapshot.activeTurnId !== null) return;
      const candidate = this.sketchQueues.get(threadId)?.[0];
      if (candidate === undefined) return;
      await this.assertTargetAndMutationAuthority(
        candidate.input.threadId,
        candidate.input.assertTargetAuthority,
        true,
      );
      // The native-authority guard may be asynchronous. Recheck both selection and
      // queue ownership so a timeout or selection change cannot later dispatch it.
      this.assertSelected(threadId);
      const queue = this.sketchQueues.get(threadId);
      if (queue?.[0] !== candidate) return;
      dispatching = queue.shift();
      if (dispatching === undefined) return;
      if (dispatching.input.threadId !== threadId) {
        throw new ThreadTransportError(
          "THREAD_RESPONSE_MISMATCH",
          "A queued command did not match its exact thread queue.",
        );
      }
      // Once the entry owns an in-flight RPC, only that RPC may settle its promise.
      // Cancelling the queue-wait timer first prevents callers from cleaning image
      // files while turn/start still references them.
      this.beginQueuedDispatch(dispatching);
      if (queue.length === 0 && this.sketchQueues.get(threadId) === queue) {
        this.sketchQueues.delete(threadId);
      }
      const authority = await this.assertTargetAndMutationAuthority(
        dispatching.input.threadId,
        dispatching.input.assertTargetAuthority,
        true,
      );
      const response = await this.client.mutate("turn/start", {
        threadId,
        clientUserMessageId: dispatching.input.commandId,
        input: this.toUserInput(dispatching.input),
      }, authority);
      const turnId = parseMutationResponse("turn/start", () => extractTurnId(response));
      this.states.set(threadId, {
        ...snapshot,
        status: "active",
        activeTurnId: turnId,
        refreshedAt: new Date().toISOString(),
      });
      this.resolveQueuedEntry(dispatching, {
        commandId: dispatching.input.commandId,
        threadId,
        turnId,
        disposition: "queued",
        duplicate: false,
      });
    } catch (error) {
      const queue = this.sketchQueues.get(threadId);
      const queued = dispatching ?? queue?.shift();
      if (queued !== undefined) {
        if (queue?.length === 0 && this.sketchQueues.get(threadId) === queue) {
          this.sketchQueues.delete(threadId);
        }
        const dispatchError = error instanceof Error ? error : new Error(String(error));
        this.rejectQueuedEntry(queued, dispatchError);
      }
    } finally {
      this.flushingThreads.delete(threadId);
    }
  }

  private toUserInput(input: RoutedCommand): UserInput[] {
    if (input.kind === "library") {
      return [{ type: "text", text: input.text, text_elements: [] }];
    }
    return [
      ...(input.instruction.length > 0
        ? [{ type: "text" as const, text: input.instruction, text_elements: [] as [] }]
        : []),
      ...input.imagePaths.map((path): UserInput => ({ type: "localImage", path })),
    ];
  }

  private assertCommandTargetAuthority(
    threadId: string,
    guard: TargetAuthorityGuard | undefined,
    required: boolean,
  ): void {
    this.assertSelected(threadId);
    if (required && guard === undefined) {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "A fresh native exact-target authority guard is required for this command.",
      );
    }
  }

  private async assertTargetAndMutationAuthority(
    threadId: string,
    guard: TargetAuthorityGuard | undefined,
    required: boolean,
  ): Promise<AppServerWriteAuthorityToken> {
    this.assertCommandTargetAuthority(threadId, guard, required);
    return this.assertMutationAuthority(guard === undefined
      ? undefined
      : async (desktopIdentity) => {
          this.assertSelected(threadId);
          const authority = await guard(desktopIdentity);
          // The identity-bound adapter refresh may yield; transport selection
          // must still match before the provider issues its one-shot permit.
          this.assertSelected(threadId);
          return authority;
        });
  }

  private async respondToApproval(
    input: ApprovalDecisionInput,
    decision: "accept" | "decline",
  ): Promise<ActionAck> {
    const commandId = requireCommandId(input.commandId);
    const threadId = requireThreadId(input.threadId);
    const turnId = requireTurnId(input.turnId);
    this.assertSelected(threadId);

    return this.idempotent<ActionAck>(
      commandId,
      fingerprint({ ...input, threadId, turnId, decision }),
      async () => {
        const key = approvalKey(input.requestId);
        const approval = this.pendingApprovals.get(key);
        if (
          approval === undefined ||
          approval.threadId !== threadId ||
          approval.turnId !== turnId ||
          approval.itemId !== input.itemId ||
          approval.kind !== input.kind
        ) {
          throw new ThreadTransportError(
            "APPROVAL_NOT_FOUND",
            "No pending approval matches the exact request, thread, turn, and item.",
          );
        }
        if (!approval.actionable || approval.kind === "permissions") {
          throw new ThreadTransportError(
            "APPROVAL_NOT_ACTIONABLE",
            "This approval type is surfaced read-only because its grant semantics are not modeled.",
          );
        }
        const authority = await this.assertTargetAndMutationAuthority(
          threadId,
          input.assertTargetAuthority,
          true,
        );
        const current = this.pendingApprovals.get(key);
        if (
          current !== approval
          || current.threadId !== threadId
          || current.turnId !== turnId
          || current.itemId !== input.itemId
          || current.kind !== input.kind
          || !current.actionable
        ) {
          throw new ThreadTransportError(
            "APPROVAL_NOT_FOUND",
            "The exact pending approval changed while mutation authority was revalidated.",
          );
        }
        await this.client.respond(approval.requestId, { decision }, authority);
        // A server may reuse a request ID after accepting the response write.
        // Do not let completion of the older response erase a replacement that
        // arrived while the underlying duplex write was still in flight.
        if (this.pendingApprovals.get(key) === approval) {
          this.pendingApprovals.delete(key);
        }
        return { commandId, threadId, duplicate: false };
      },
      (ack) => ({ ...ack, duplicate: true }),
    );
  }

  private handleNotification(notification: AppServerNotification): void {
    if (!isRecord(notification.params)) return;
    const params = notification.params;

    if (notification.method === "thread/status/changed") {
      if (typeof params.threadId !== "string" || !UUID_PATTERN.test(params.threadId)) return;
      const threadId = params.threadId.toLowerCase();
      const previous = this.states.get(threadId);
      if (previous === undefined) return;
      const status = normalizeStatus(params.status);
      this.states.set(threadId, {
        ...previous,
        status,
        activeTurnId: status === "idle" ? null : previous.activeTurnId,
        refreshedAt: new Date().toISOString(),
      });
      if (status === "idle") void this.flushSketchQueue(threadId);
      return;
    }

    if (notification.method === "turn/started") {
      if (
        typeof params.threadId !== "string" ||
        !UUID_PATTERN.test(params.threadId) ||
        !isRecord(params.turn) ||
        typeof params.turn.id !== "string" ||
        !UUID_PATTERN.test(params.turn.id)
      ) {
        return;
      }
      const threadId = params.threadId.toLowerCase();
      const previous = this.states.get(threadId);
      if (previous !== undefined) {
        this.states.set(threadId, {
          ...previous,
          status: "active",
          activeTurnId: params.turn.id.toLowerCase(),
          refreshedAt: new Date().toISOString(),
        });
      }
      return;
    }

    if (notification.method === "turn/completed") {
      if (
        typeof params.threadId !== "string" ||
        !UUID_PATTERN.test(params.threadId) ||
        !isRecord(params.turn) ||
        typeof params.turn.id !== "string"
      ) {
        return;
      }
      const threadId = params.threadId.toLowerCase();
      const previous = this.states.get(threadId);
      if (previous?.activeTurnId === params.turn.id.toLowerCase()) {
        this.states.set(threadId, {
          ...previous,
          status: "idle",
          activeTurnId: null,
          refreshedAt: new Date().toISOString(),
        });
        void this.flushSketchQueue(threadId);
      }
      return;
    }

    if (notification.method === "serverRequest/resolved") {
      if (params.requestId !== undefined && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
        this.pendingApprovals.delete(approvalKey(params.requestId));
      }
      return;
    }

    if (notification.method === "thread/deleted" || notification.method === "thread/closed") {
      if (typeof params.threadId !== "string" || !UUID_PATTERN.test(params.threadId)) return;
      const threadId = params.threadId.toLowerCase();
      this.states.delete(threadId);
      this.rejectThreadQueue(
        threadId,
        new ThreadTransportError(
          "THREAD_NOT_LOADED",
          "The exact queued thread was closed before its command could be dispatched.",
        ),
      );
      if (this.selectedThreadId === threadId) this.selectedThreadId = null;
    }
  }

  private handleServerRequest(request: AppServerInboundRequest): void {
    if (!isRecord(request.params)) return;
    const params = request.params;
    if (
      !validApprovalRequestId(request.id) ||
      typeof params.threadId !== "string" ||
      !UUID_PATTERN.test(params.threadId) ||
      typeof params.turnId !== "string" ||
      !UUID_PATTERN.test(params.turnId) ||
      typeof params.itemId !== "string" ||
      !validApprovalItemId(params.itemId)
    ) {
      return;
    }

    let kind: PendingApprovalKind;
    let actionable: boolean;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        kind = "commandExecution";
        actionable = true;
        break;
      case "item/fileChange/requestApproval":
        kind = "fileChange";
        actionable = true;
        break;
      case "item/permissions/requestApproval":
        kind = "permissions";
        actionable = false;
        break;
      default:
        return;
    }

    const key = approvalKey(request.id);
    if (!this.pendingApprovals.has(key) && this.pendingApprovals.size >= MAX_PENDING_APPROVALS) return;
    this.pendingApprovals.set(key, {
      requestId: request.id,
      threadId: params.threadId.toLowerCase(),
      turnId: params.turnId.toLowerCase(),
      itemId: params.itemId,
      kind,
      actionable,
      summary: approvalSummary(params),
      raw: params,
    });
  }

  private async refreshLoadedTarget(threadId: string): Promise<ThreadSnapshot> {
    const snapshot = await this.threadRead(threadId);
    if (snapshot.status === "notLoaded") {
      throw new ThreadTransportError(
        "THREAD_NOT_LOADED",
        "The exact selected thread is no longer loaded in the managed app-server.",
      );
    }
    return snapshot;
  }

  private async readLatestActiveTurnId(threadId: string): Promise<string | null> {
    const page = await this.client.call("thread/turns/list", {
      threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    return latestActiveTurnIdFromPage(page);
  }

  private assertSelected(threadId: string): void {
    if (this.selectedThreadId === null || this.selectedThreadId !== threadId) {
      throw new ThreadTransportError(
        "TARGET_NOT_SELECTED",
        "The command target is not the exact currently selected thread; no fallback was attempted.",
        { selectedThreadId: this.selectedThreadId, requestedThreadId: threadId },
      );
    }
  }

  private assertConnected(): void {
    if (!this.client.isInitialized || this.client.isClosed) {
      throw new ThreadTransportError(
        "APP_SERVER_UNAVAILABLE",
        "No initialized managed app-server connection is available.",
      );
    }
  }

  private async assertMutationAuthority(
    finalTargetGuard?: TargetAuthorityGuard,
  ): Promise<AppServerWriteAuthorityToken> {
    this.assertConnected();
    let authority: AppServerWriteAuthorityToken;
    try {
      authority = await this.mutationAuthorityGuard(finalTargetGuard);
    } catch (error) {
      if (error instanceof ThreadTransportError) throw error;
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "Shared Desktop ownership could not be revalidated; app-server mutations are disabled.",
      );
    }
    // The guard may perform process and socket probes. The transport must still
    // be initialized after that asynchronous boundary.
    this.assertConnected();
    return authority;
  }

  private async idempotent<T>(
    commandId: string,
    commandFingerprint: string,
    operation: () => Promise<T> | T,
    duplicateResult: (value: T) => T,
  ): Promise<T> {
    const existing = this.commandLedger.get(commandId) as IdempotentEntry<T> | undefined;
    if (existing !== undefined) {
      if (existing.fingerprint !== commandFingerprint) {
        throw new ThreadTransportError(
          "COMMAND_ID_COLLISION",
          "A command ID was reused with a different payload.",
        );
      }
      return duplicateResult(await existing.promise);
    }

    const promise = Promise.resolve().then(operation);
    const entry: IdempotentEntry<T> = {
      fingerprint: commandFingerprint,
      promise,
      settled: false,
    };
    this.commandLedger.set(commandId, entry);
    void promise.then(
      () => {
        entry.settled = true;
        this.trimCommandLedger();
      },
      () => {
        entry.settled = true;
        this.trimCommandLedger();
      },
    );
    this.trimCommandLedger();
    // Retain rejected/ambiguous outcomes as well as successes for the lifetime of
    // this transport instance. The public server ledger owns restart durability.
    return promise;
  }

  private trimCommandLedger(): void {
    while (this.commandLedger.size > this.maxIdempotencyEntries) {
      const oldestSettled = [...this.commandLedger.entries()].find(([, entry]) => entry.settled)?.[0];
      if (oldestSettled === undefined) return;
      this.commandLedger.delete(oldestSettled);
    }
  }

  private beginQueuedDispatch(queued: QueuedReview): void {
    if (queued.phase !== "queued") {
      throw new ThreadTransportError(
        "THREAD_STATE_UNKNOWN",
        "A queued command lost exclusive dispatch ownership.",
      );
    }
    if (queued.timer !== null) clearTimeout(queued.timer);
    queued.timer = null;
    queued.phase = "dispatching";
  }

  private resolveQueuedEntry(queued: QueuedReview, ack: CommandAck & { turnId: string }): void {
    if (queued.phase === "settled") return;
    if (queued.timer !== null) clearTimeout(queued.timer);
    queued.timer = null;
    queued.phase = "settled";
    queued.resolve(ack);
    for (const listener of this.queuedDispatchListeners) {
      listener({
        type: "dispatched",
        commandId: queued.input.commandId,
        threadId: queued.input.threadId,
        turnId: ack.turnId,
      });
    }
  }

  private rejectQueuedEntry(queued: QueuedReview, error: Error): void {
    if (queued.phase === "settled") return;
    if (queued.timer !== null) clearTimeout(queued.timer);
    queued.timer = null;
    queued.phase = "settled";
    queued.reject(error);
    for (const listener of this.queuedDispatchListeners) {
      listener({
        type: "failed",
        commandId: queued.input.commandId,
        threadId: queued.input.threadId,
        error,
      });
    }
  }

  private rejectThreadQueue(threadId: string, error: Error): void {
    const queue = this.sketchQueues.get(threadId);
    if (queue === undefined) return;
    this.sketchQueues.delete(threadId);
    for (const queued of queue.splice(0)) this.rejectQueuedEntry(queued, error);
  }

  private rejectAllQueued(error: Error): void {
    for (const threadId of [...this.sketchQueues.keys()]) this.rejectThreadQueue(threadId, error);
  }
}

export function isTransportError(error: unknown): error is ThreadTransportError {
  return error instanceof ThreadTransportError;
}

export function unavailableFromClientError(error: unknown): ThreadTransportError | undefined {
  if (error instanceof AppServerClientError) {
    const phase = isRecord(error.detail) && typeof error.detail.phase === "string"
      ? error.detail.phase
      : undefined;
    return new ThreadTransportError("APP_SERVER_UNAVAILABLE", error.message, {
      clientCode: error.code,
      ...(phase === undefined ? {} : { phase }),
    });
  }
  return undefined;
}

import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopProcessIdentity } from "@codex-pad/codex-desktop";
import {
  AppServerClient,
  AppServerClientError,
  type AppServerWriteAuthorityIssuer,
  type AppServerWriteAuthorityToken,
} from "./app-server-client.js";
import {
  FileDesktopOwnershipVerifier,
  runOwnershipCommand,
  type DesktopOwnershipInspection,
  type DesktopOwnershipVerifier,
} from "./desktop-ownership.js";
import type { ManagedSocketPeerExpectation } from "./unix-socket-generation.js";
import {
  createExactTargetAuthorityDomain,
  type ExactTargetAuthorityConsumer,
} from "./exact-target-authority.js";
import {
  ManagedThreadTransport,
  ThreadTransportError,
  type ActionAck,
  type ApprovalDecisionInput,
  type CommandAck,
  type CodexUsageReadResult,
  type ForkThreadInput,
  type InvokeSkillInput,
  type ModelInfo,
  type ModelReasoningInput,
  type NewThreadInput,
  type NativeMutationAuthority,
  type NativeMutationAuthorityToken,
  type PendingApproval,
  type ReasoningInput,
  type RunLibraryCommandInput,
  type SendReviewInput,
  type SendSketchInput,
  type SessionSummary,
  type SkillInfo,
  type StartTurnInput,
  type SteerTurnInput,
  type TargetAuthorityGuard,
  type ThreadSnapshot,
  type ThreadTransport,
  type TransportHealth,
  type VerifiedMultiImageInputCapability,
} from "./thread-transport.js";

export interface ReconnectingManagedTransportOptions {
  codexBinaryPath?: string;
  socketPath?: string;
  /** Backwards-compatible name for the first retry delay. */
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
  now?: () => number;
  random?: () => number;
  multiImageInputCapability?: VerifiedMultiImageInputCapability;
  ownershipAttestationPath?: string;
  /** Provider-side half of the exact-target domain shared by production composition. */
  targetAuthorityConsumer?: ExactTargetAuthorityConsumer;
  /** Deterministic test injection; production has no environment-variable bypass. */
  ownershipVerifier?: DesktopOwnershipVerifier;
  /** Receives redacted connection diagnostics; never include prompts, task IDs, or socket paths. */
  logger?: (message: string) => void;
}

const DEFAULT_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

interface NativeMutationAuthorityState {
  readonly transport: ReconnectingManagedTransport;
  readonly client: AppServerClient;
  readonly writeAuthority: AppServerWriteAuthorityToken;
  used: boolean;
}

interface IssuedManagedMutationAuthority {
  readonly writeAuthority: AppServerWriteAuthorityToken;
  readonly desktopIdentity?: DesktopProcessIdentity;
}

const NATIVE_MUTATION_AUTHORITIES = new WeakMap<object, NativeMutationAuthorityState>();

function desktopIdentityFromOwnership(
  ownership: DesktopOwnershipInspection,
): DesktopProcessIdentity | null {
  const desktop = ownership.verified ? ownership.currentEvidence?.desktop : undefined;
  if (
    desktop === undefined
    || (desktop.bundleId !== "com.openai.codex" && desktop.bundleId !== "com.openai.chatgpt")
  ) return null;
  return Object.freeze({
    pid: desktop.pid,
    startedAt: desktop.startedAt,
    appPath: desktop.appPath,
    executablePath: desktop.executablePath,
    bundleId: desktop.bundleId,
  });
}

export function managedRetryDelay(
  consecutiveFailures: number,
  initialDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const attempt = Math.max(1, Math.floor(consecutiveFailures));
  const initial = Math.max(1, Math.floor(initialDelayMs));
  const maximum = Math.max(initial, Math.floor(maxDelayMs));
  const exponential = Math.min(maximum, initial * (2 ** Math.min(attempt - 1, 30)));
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  // Equal jitter avoids synchronized retries while retaining exponential growth.
  return Math.max(1, Math.round(exponential * (0.5 + (normalized * 0.5))));
}

function safeManagedConnectionError(error: unknown): string {
  if (error instanceof AppServerClientError) {
    switch (error.code) {
      case "INVALID_MANAGED_SOCKET":
        return "Managed app-server socket validation failed";
      case "INVALID_CODEX_BINARY":
        return "Desktop-bundled Codex validation failed";
      case "APP_SERVER_TIMEOUT":
        return "Managed app-server handshake timed out";
      case "PROTOCOL_ERROR":
      case "PROTOCOL_MALFORMED_FRAME":
        return "Managed app-server protocol validation failed";
      case "APP_SERVER_CLOSED":
      case "APP_SERVER_AUTHORITY_STALE":
      case "APP_SERVER_METHOD_NOT_ALLOWED":
      case "APP_SERVER_NOT_INITIALIZED":
      case "APP_SERVER_DELIVERY_UNKNOWN":
      case "MANAGED_PROXY_EXITED":
        return "Managed app-server connection is unavailable";
    }
  }
  return "Managed app-server connection failed";
}

export class ReconnectingManagedTransport implements ThreadTransport {
  readonly #codexBinaryPath: string;
  readonly #socketPath: string;
  readonly #retryInitialDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #multiImageInputCapability: VerifiedMultiImageInputCapability | undefined;
  readonly #ownershipVerifier: DesktopOwnershipVerifier;
  readonly #targetAuthorityConsumer: ExactTargetAuthorityConsumer;
  readonly #logger: (message: string) => void;
  #client: AppServerClient | null = null;
  #writeAuthority: AppServerWriteAuthorityIssuer | null = null;
  #delegate: ManagedThreadTransport | null = null;
  #connecting: Promise<ManagedThreadTransport> | null = null;
  #consecutiveFailures = 0;
  #nextAttemptAt = 0;
  #lastError = "Managed app-server has not connected yet";
  #lastOwnership: DesktopOwnershipInspection = {
    verified: false,
    canCreate: false,
    code: "attestation-missing",
    summary: "Shared Desktop ownership has not been attested; app-server mutations are disabled.",
  };
  #boundSocketPeer: ManagedSocketPeerExpectation | null = null;
  #ownershipEpoch = 0;
  #closed = false;

  constructor(options: ReconnectingManagedTransportOptions = {}) {
    this.#codexBinaryPath = options.codexBinaryPath ?? process.env.CODEX_PAD_CODEX_BINARY ?? DEFAULT_CODEX_BINARY;
    this.#socketPath = options.socketPath
      ?? process.env.CODEX_PAD_APP_SERVER_SOCKET
      ?? join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
    this.#retryInitialDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    this.#retryMaxDelayMs = Math.max(
      this.#retryInitialDelayMs,
      Math.floor(options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS),
    );
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#multiImageInputCapability = options.multiImageInputCapability;
    this.#ownershipVerifier = options.ownershipVerifier ?? new FileDesktopOwnershipVerifier({
      ...(options.ownershipAttestationPath === undefined
        ? {}
        : { attestationPath: options.ownershipAttestationPath }),
      socketPath: this.#socketPath,
      codexBinaryPath: this.#codexBinaryPath,
      runCommand: runOwnershipCommand,
    });
    // An isolated fallback is fail-closed for standalone providers. Production
    // injects the consumer paired with BridgeStateService's issuer.
    this.#targetAuthorityConsumer = options.targetAuthorityConsumer
      ?? createExactTargetAuthorityDomain().providerConsumer;
    this.#logger = options.logger ?? (() => undefined);
  }

  async health(): Promise<TransportHealth> {
    if (this.#delegate === null && !this.#closed && this.#now() >= this.#nextAttemptAt) {
      await this.#connect().catch(() => undefined);
    }
    const delegate = this.#delegate;
    if (delegate !== null) {
      const [health, ownership] = await Promise.all([
        delegate.health(),
        this.#refreshOwnership(),
      ]);
      if (this.#delegate !== delegate) {
        return {
          mode: "managed-control-socket",
          connected: false,
          initialized: false,
          selectedThreadId: null,
          localImageSteerVerified: false,
          multiImageInputVerified: false,
          desktopOwnershipVerified: false,
          serverUserAgent: null,
          queuedSketches: 0,
          detail: ownership.summary,
        };
      }
      return {
        ...health,
        desktopOwnershipVerified: ownership.verified,
        ...(!ownership.verified ? { detail: ownership.summary } : {}),
      };
    }
    return {
      mode: "managed-control-socket",
      connected: false,
      initialized: false,
      selectedThreadId: null,
      localImageSteerVerified: false,
      multiImageInputVerified: false,
      desktopOwnershipVerified: false,
      serverUserAgent: null,
      queuedSketches: 0,
      detail: this.#lastError,
    };
  }

  async refreshDesktopOwnershipIdentity(): Promise<DesktopProcessIdentity | null> {
    if (this.#closed || this.#client === null || this.#delegate === null) return null;
    const probe = await this.#refreshOwnershipWithGeneration();
    if (
      !probe.ownership.verified
      || probe.client === null
      || !this.#ownershipProbeIsCurrent(probe.client, probe.generation)
    ) return null;
    return desktopIdentityFromOwnership(probe.ownership);
  }

  async acquireNativeMutationAuthority(
    finalTargetGuard?: TargetAuthorityGuard,
  ): Promise<NativeMutationAuthority> {
    const issued = await this.#issueMutationAuthority(finalTargetGuard);
    if (issued.desktopIdentity === undefined) {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "Shared Desktop ownership is required for provider-authorized native dispatch.",
      );
    }
    const client = this.#client;
    if (client === null || client.isClosed) {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "Desktop ownership changed before native dispatch authority was issued.",
      );
    }
    const authority = Object.freeze({});
    NATIVE_MUTATION_AUTHORITIES.set(authority, {
      transport: this,
      client,
      writeAuthority: issued.writeAuthority,
      used: false,
    });
    return Object.freeze({
      authority: authority as NativeMutationAuthorityToken,
      desktopIdentity: issued.desktopIdentity,
    });
  }

  consumeNativeMutationAuthority(authority: NativeMutationAuthorityToken): void {
    const state = NATIVE_MUTATION_AUTHORITIES.get(authority);
    if (
      state === undefined
      || state.transport !== this
      || state.client !== this.#client
      || state.used
      || state.client.isClosed
    ) {
      throw new AppServerClientError(
        "APP_SERVER_AUTHORITY_STALE",
        "Managed Desktop authority changed before native dispatch.",
        { phase: "pre-write" },
      );
    }
    // Consume the facade before invoking AppServerClient's synchronous proof so
    // re-entry and throwing validation can never reuse a native permit.
    state.used = true;
    NATIVE_MUTATION_AUTHORITIES.delete(authority);
    state.client.consumeWriteAuthority(state.writeAuthority);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#invalidateWriteAuthority(client);
    this.#client = null;
    this.#delegate = null;
    await client?.close();
  }

  clearSelectedThread(): void { this.#delegate?.clearSelectedThread(); }
  listPendingApprovals(threadId?: string): PendingApproval[] { return this.#delegate?.listPendingApprovals(threadId) ?? []; }
  selectThread(threadId: string, assertTargetAuthority: TargetAuthorityGuard): Promise<ThreadSnapshot> {
    return this.#run((transport) => transport.selectThread(threadId, assertTargetAuthority));
  }
  threadRead(threadId: string): Promise<ThreadSnapshot> { return this.#run((transport) => transport.threadRead(threadId)); }
  resumeThread(threadId: string, assertTargetAuthority: TargetAuthorityGuard): Promise<ThreadSnapshot> {
    return this.#run((transport) => transport.resumeThread(threadId, assertTargetAuthority));
  }
  listSessions(): Promise<SessionSummary[]> { return this.#run((transport) => transport.listSessions()); }
  sendSketch(input: SendSketchInput): Promise<CommandAck> { return this.#run((transport) => transport.sendSketch(input)); }
  sendReview(input: SendReviewInput): Promise<CommandAck> { return this.#run((transport) => transport.sendReview(input)); }
  runLibraryCommand(input: RunLibraryCommandInput): Promise<CommandAck> { return this.#run((transport) => transport.runLibraryCommand(input)); }
  startTurn(input: StartTurnInput): Promise<CommandAck> { return this.#run((transport) => transport.startTurn(input)); }
  steerTurn(input: SteerTurnInput): Promise<CommandAck> { return this.#run((transport) => transport.steerTurn(input)); }
  newThread(input: NewThreadInput): Promise<ThreadSnapshot> { return this.#run((transport) => transport.newThread(input)); }
  forkThread(input: ForkThreadInput): Promise<ThreadSnapshot> { return this.#run((transport) => transport.forkThread(input)); }
  setReasoning(input: ReasoningInput): Promise<ActionAck> { return this.#run((transport) => transport.setReasoning(input)); }
  setModelReasoning(input: ModelReasoningInput): Promise<ActionAck> { return this.#run((transport) => transport.setModelReasoning(input)); }
  listModels(): Promise<ModelInfo[]> { return this.#run((transport) => transport.listModels()); }
  readCodexUsage(): Promise<CodexUsageReadResult> { return this.#run((transport) => transport.readCodexUsage()); }
  listSkills(cwds?: string[]): Promise<SkillInfo[]> { return this.#run((transport) => transport.listSkills(cwds)); }
  invokeSkill(input: InvokeSkillInput): Promise<CommandAck> { return this.#run((transport) => transport.invokeSkill(input)); }
  approve(input: ApprovalDecisionInput): Promise<ActionAck> { return this.#run((transport) => transport.approve(input)); }
  reject(input: ApprovalDecisionInput): Promise<ActionAck> { return this.#run((transport) => transport.reject(input)); }

  async #run<T>(operation: (transport: ManagedThreadTransport) => Promise<T>): Promise<T> {
    const transport = this.#delegate ?? await this.#connect();
    try {
      return await operation(transport);
    } catch (error) {
      if (this.#client?.isClosed) this.#disconnect("Managed app-server connection closed");
      throw error;
    }
  }

  #connect(): Promise<ManagedThreadTransport> {
    if (this.#closed) return Promise.reject(this.#unavailable("Managed transport is closed"));
    if (this.#delegate !== null) return Promise.resolve(this.#delegate);
    if (this.#connecting !== null) return this.#connecting;
    if (this.#now() < this.#nextAttemptAt) {
      return Promise.reject(this.#unavailable("Managed app-server reconnect is backing off after a failed attempt"));
    }
    this.#connecting = AppServerClient.connectManaged({
      codexBinaryPath: this.#codexBinaryPath,
      socketPath: this.#socketPath,
      requestTimeoutMs: 30_000,
      maxFrameBytes: 4 * 1024 * 1024,
      initialize: {
        clientInfo: { name: "codex-pad", title: "Codex Pad", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    }).then(async (connection) => {
      const { client, writeAuthority } = connection;
      if (this.#closed) {
        writeAuthority.revoke();
        void client.close();
        throw this.#unavailable("Managed transport closed during connection");
      }
      const delegate = new ManagedThreadTransport(client, {
        ...(this.#multiImageInputCapability === undefined
          ? {}
          : { multiImageInputCapability: this.#multiImageInputCapability }),
        assertMutationAuthority: (finalTargetGuard) => this.#assertMutationAuthority(finalTargetGuard),
      });
      this.#client = client;
      this.#writeAuthority = writeAuthority;
      this.#delegate = delegate;
      client.onClose((error) => this.#disconnect(
        `Managed app-server disconnected (${error.code}); reconnect is pending`,
        client,
      ));
      // A responsive private socket is useful for reads, but is not writable
      // authority. Revalidate once for this connection and again at each write.
      await this.#refreshOwnership();
      if (client.isClosed || this.#client !== client || this.#delegate !== delegate) {
        throw this.#unavailable("Managed app-server disconnected during ownership verification");
      }
      this.#consecutiveFailures = 0;
      this.#nextAttemptAt = 0;
      this.#lastError = "";
      return delegate;
    }).catch((error: unknown) => {
      this.#lastError = safeManagedConnectionError(error);
      const code = error instanceof AppServerClientError ? error.code : "UNKNOWN";
      this.#logger(`${this.#lastError} (${code})`);
      if (!this.#closed && this.#nextAttemptAt <= this.#now()) this.#scheduleRetry();
      throw this.#unavailable(this.#lastError);
    }).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #disconnect(reason: string, expectedClient?: AppServerClient): void {
    if (expectedClient !== undefined && this.#client !== expectedClient) return;
    this.#invalidateWriteAuthority(this.#client);
    this.#client = null;
    this.#writeAuthority = null;
    this.#delegate = null;
    this.#boundSocketPeer = null;
    this.#lastError = reason;
    this.#logger(reason);
    if (!this.#closed) this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    this.#consecutiveFailures += 1;
    this.#nextAttemptAt = this.#now() + managedRetryDelay(
      this.#consecutiveFailures,
      this.#retryInitialDelayMs,
      this.#retryMaxDelayMs,
      this.#random,
    );
  }

  #unavailable(message: string): ThreadTransportError {
    return new ThreadTransportError("APP_SERVER_UNAVAILABLE", message);
  }

  async #refreshOwnership(): Promise<DesktopOwnershipInspection> {
    return (await this.#refreshOwnershipWithGeneration()).ownership;
  }

  async #refreshOwnershipWithGeneration(): Promise<{
    readonly ownership: DesktopOwnershipInspection;
    readonly generation: number;
    readonly client: AppServerClient | null;
  }> {
    const client = this.#client;
    const generation = this.#invalidateWriteAuthority(client);
    let ownership: DesktopOwnershipInspection;
    try {
      ownership = await this.#ownershipVerifier.verify();
    } catch {
      ownership = {
        verified: false,
        canCreate: false,
        code: "topology-unavailable",
        summary: "Desktop ownership could not be revalidated; app-server mutations are disabled.",
      };
    }
    if (!this.#ownershipProbeIsCurrent(client, generation)) {
      return { ownership: this.#runtimePeerUnavailable(), generation, client };
    }
    if (!ownership.verified) {
      if (
        client !== null
        && this.#boundSocketPeer !== null
        && !(await client.verifyManagedSocketPeer(this.#boundSocketPeer).catch(() => false))
      ) {
        if (!this.#ownershipProbeIsCurrent(client, generation)) {
          return { ownership: this.#runtimePeerUnavailable(), generation, client };
        }
        this.#disconnect("Managed app-server socket generation changed; reconnect is pending", client);
        await client.close().catch(() => undefined);
        ownership = this.#runtimePeerUnavailable();
      }
      if (this.#ownershipProbeIsCurrent(client, generation)) this.#lastOwnership = ownership;
      return { ownership, generation, client };
    }

    const currentEvidence = ownership.currentEvidence;
    if (client === null || currentEvidence === undefined) {
      if (client !== null) {
        this.#disconnect("Managed app-server ownership evidence is incomplete", client);
        await client.close().catch(() => undefined);
      }
      ownership = this.#runtimePeerUnavailable();
      if (this.#ownershipProbeIsCurrent(client, generation)) this.#lastOwnership = ownership;
      return { ownership, generation, client };
    }
    const expected: ManagedSocketPeerExpectation = {
      socket: {
        path: currentEvidence.socket.path,
        device: currentEvidence.socket.device,
        inode: currentEvidence.socket.inode,
        uid: currentEvidence.socket.uid,
        listenerAddress: currentEvidence.socket.listenerAddress,
        listenerKernelInode: currentEvidence.socket.listenerKernelInode,
        listenerGeneration: currentEvidence.socket.listenerGeneration,
      },
      daemonPid: currentEvidence.daemon.pid,
      desktopClient: {
        pid: currentEvidence.desktopClient.pid,
        serverEndpointAddress: currentEvidence.desktopClient.serverEndpointAddress,
        serverEndpointGeneration: currentEvidence.desktopClient.serverEndpointGeneration,
        clientEndpointAddress: currentEvidence.desktopClient.clientEndpointAddress,
        clientEndpointGeneration: currentEvidence.desktopClient.clientEndpointGeneration,
      },
    };
    const peerVerified = await client.verifyManagedSocketPeer(expected).catch(() => false);
    if (!this.#ownershipProbeIsCurrent(client, generation)) {
      return { ownership: this.#runtimePeerUnavailable(), generation, client };
    }
    if (
      (this.#boundSocketPeer !== null
        && JSON.stringify(this.#boundSocketPeer) !== JSON.stringify(expected))
      || !peerVerified
      || client.isClosed
    ) {
      this.#disconnect("Managed app-server socket generation changed; reconnect is pending", client);
      await client.close().catch(() => undefined);
      ownership = this.#runtimePeerUnavailable();
      return { ownership, generation, client };
    }
    this.#boundSocketPeer = expected;
    this.#lastOwnership = ownership;
    return { ownership, generation, client };
  }

  #runtimePeerUnavailable(): DesktopOwnershipInspection {
    return {
      verified: false,
      canCreate: false,
      code: "topology-unavailable",
      summary: "The managed socket client is not bound to the attested Desktop socket generation; app-server mutations are disabled.",
    };
  }

  async #assertMutationAuthority(
    finalTargetGuard?: TargetAuthorityGuard,
  ): Promise<AppServerWriteAuthorityToken> {
    return (await this.#issueMutationAuthority(finalTargetGuard)).writeAuthority;
  }

  async #issueMutationAuthority(
    finalTargetGuard?: TargetAuthorityGuard,
  ): Promise<IssuedManagedMutationAuthority> {
    const probe = await this.#refreshOwnershipWithGeneration();
    const ownership = probe.ownership;
    if (!ownership.verified) {
      if (finalTargetGuard === undefined) {
        throw new ThreadTransportError(
          "CAPABILITY_UNAVAILABLE",
          ownership.summary,
          { ownership: ownership.code },
        );
      }
      const client = probe.client;
      const writeAuthority = this.#writeAuthority;
      const delegate = this.#delegate;
      if (
        client === null
        || writeAuthority === null
        || delegate === null
        || !this.#ownershipProbeIsCurrent(client, probe.generation)
        || client.isClosed
      ) {
        throw new ThreadTransportError(
          "CAPABILITY_UNAVAILABLE",
          "Managed app-server connection changed before exact-target dispatch.",
        );
      }
      const exactTargetAuthority = await finalTargetGuard(undefined);
      if (
        this.#ownershipEpoch !== probe.generation
        || this.#client !== client
        || this.#writeAuthority !== writeAuthority
        || this.#delegate !== delegate
        || client.isClosed
      ) {
        throw new ThreadTransportError(
          "CAPABILITY_UNAVAILABLE",
          "Managed app-server connection changed before exact-target dispatch.",
        );
      }
      const issuedWriteAuthority = writeAuthority.issue(() => {
        this.#targetAuthorityConsumer(exactTargetAuthority);
        if (
          this.#ownershipEpoch !== probe.generation
          || this.#client !== client
          || this.#writeAuthority !== writeAuthority
          || this.#delegate !== delegate
          || client.isClosed
        ) {
          throw new Error("stale exact-target write authority");
        }
      });
      return Object.freeze({ writeAuthority: issuedWriteAuthority });
    }
    const client = probe.client;
    const writeAuthority = this.#writeAuthority;
    const delegate = this.#delegate;
    const boundSocketPeer = this.#boundSocketPeer;
    if (
      client === null
      || writeAuthority === null
      || delegate === null
      || boundSocketPeer === null
      || !this.#ownershipProbeIsCurrent(client, probe.generation)
    ) {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "Desktop ownership changed before app-server dispatch.",
      );
    }
    const desktopIdentity = desktopIdentityFromOwnership(ownership);
    if (desktopIdentity === null) {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "The attested Desktop process identity is incomplete.",
      );
    }
    // This is deliberately the final external await. The returned opaque target
    // proof remains live across subsequent Promise continuations and is consumed
    // synchronously by AppServerClient immediately before the WebSocket write.
    const exactTargetAuthority = await finalTargetGuard?.(desktopIdentity);
    if (
      this.#ownershipEpoch !== probe.generation
      || this.#client !== client
      || this.#writeAuthority !== writeAuthority
      || this.#delegate !== delegate
      || this.#boundSocketPeer !== boundSocketPeer
      || client.isClosed
    ) {
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "Desktop ownership changed before app-server dispatch.",
      );
    }
    const boundFingerprint = JSON.stringify(boundSocketPeer);
    const issuedWriteAuthority = writeAuthority.issue(() => {
      if (exactTargetAuthority !== undefined) {
        this.#targetAuthorityConsumer(exactTargetAuthority);
      }
      if (
        this.#ownershipEpoch !== probe.generation
        || this.#client !== client
        || this.#writeAuthority !== writeAuthority
        || this.#delegate !== delegate
        || this.#boundSocketPeer === null
        || JSON.stringify(this.#boundSocketPeer) !== boundFingerprint
        || client.isClosed
        || this.#ownershipVerifier.verifyDesktopProcessAtWriteBoundary?.(desktopIdentity) !== true
        || !client.verifyManagedSocketPeerAtWriteBoundary(boundSocketPeer)
      ) {
        throw new Error("stale write authority");
      }
    });
    return Object.freeze({ writeAuthority: issuedWriteAuthority, desktopIdentity });
  }

  #invalidateWriteAuthority(client: AppServerClient | null): number {
    this.#ownershipEpoch += 1;
    if (client === this.#client) this.#writeAuthority?.revoke();
    return this.#ownershipEpoch;
  }

  #ownershipProbeIsCurrent(client: AppServerClient | null, generation: number): boolean {
    return this.#ownershipEpoch === generation && this.#client === client;
  }
}

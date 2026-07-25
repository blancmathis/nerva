import { constants as fsConstants, lstatSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import WebSocket, { type RawData } from "ws";
import { runOwnershipCommand } from "./desktop-ownership.js";
import {
  verifyManagedSocketPeer as verifyManagedSocketPeerGeneration,
  verifyManagedSocketPeerAtWriteBoundary,
  type ManagedSocketPeerExpectation,
} from "./unix-socket-generation.js";

export type AppServerRequestId = number | string;

declare const WRITE_AUTHORITY_BRAND: unique symbol;
export interface AppServerWriteAuthorityToken {
  readonly [WRITE_AUTHORITY_BRAND]: true;
}

export interface AppServerWriteAuthorityIssuer {
  issue(assertCurrent: () => void): AppServerWriteAuthorityToken;
  revoke(): void;
}

export interface ManagedAppServerConnection {
  readonly client: AppServerClient;
  readonly writeAuthority: AppServerWriteAuthorityIssuer;
}

interface WriteAuthorityState {
  readonly client: AppServerClient;
  readonly issuer: ManagedWriteAuthorityIssuer;
  readonly epoch: number;
  readonly assertCurrent: () => void;
  used: boolean;
}

const WRITE_AUTHORITIES = new WeakMap<object, WriteAuthorityState>();

const READ_ONLY_METHODS = new Set([
  "account/rateLimits/read",
  "model/list",
  "skills/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
]);

const MUTATING_METHODS = new Set([
  "thread/fork",
  "thread/resume",
  "thread/settings/update",
  "thread/start",
  "turn/start",
  "turn/steer",
]);

export interface JsonlDuplex {
  readonly readable: AsyncIterable<Uint8Array | string>;
  write(data: string): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface AppServerInitializeParams {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    mcpServerOpenaiFormElicitation?: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface AppServerInitializeResponse {
  userAgent: string;
  [key: string]: unknown;
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerInboundRequest {
  id: AppServerRequestId;
  method: string;
  params?: unknown;
}

export interface ManagedProxyOptions {
  codexBinaryPath: string;
  socketPath: string;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  initialize?: Partial<AppServerInitializeParams>;
}

export type AppServerClientErrorCode =
  | "APP_SERVER_AUTHORITY_STALE"
  | "APP_SERVER_CLOSED"
  | "APP_SERVER_DELIVERY_UNKNOWN"
  | "APP_SERVER_METHOD_NOT_ALLOWED"
  | "APP_SERVER_NOT_INITIALIZED"
  | "APP_SERVER_TIMEOUT"
  | "INVALID_CODEX_BINARY"
  | "INVALID_MANAGED_SOCKET"
  | "MANAGED_PROXY_EXITED"
  | "PROTOCOL_ERROR"
  | "PROTOCOL_MALFORMED_FRAME";

export class AppServerClientError extends Error {
  readonly code: AppServerClientErrorCode;
  readonly detail?: unknown;

  constructor(code: AppServerClientErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "AppServerClientError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

class ManagedWriteAuthorityIssuer implements AppServerWriteAuthorityIssuer {
  readonly #client: AppServerClient;
  #epoch = 0;

  constructor(client: AppServerClient) {
    this.#client = client;
  }

  issue(assertCurrent: () => void): AppServerWriteAuthorityToken {
    if (
      this.#client.transportKind !== "managed-proxy"
      || !this.#client.isInitialized
      || this.#client.isClosed
    ) {
      throw new AppServerClientError(
        "APP_SERVER_AUTHORITY_STALE",
        "Managed app-server write authority is unavailable.",
        { phase: "pre-write" },
      );
    }
    const token = Object.freeze({});
    WRITE_AUTHORITIES.set(token, {
      client: this.#client,
      issuer: this,
      epoch: this.#epoch,
      assertCurrent,
      used: false,
    });
    return token as AppServerWriteAuthorityToken;
  }

  revoke(): void {
    this.#epoch += 1;
  }

  isCurrent(epoch: number): boolean {
    return this.#epoch === epoch;
  }
}

type PendingRequest = {
  readonly method: string;
  readonly delivery: "query" | "mutation";
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  writeStarted: boolean;
};

type NotificationListener = (notification: AppServerNotification) => void;
type ServerRequestListener = (request: AppServerInboundRequest) => void;
type ProtocolErrorListener = (error: AppServerClientError) => void;
type CloseListener = (error: AppServerClientError) => void;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_INITIALIZE: AppServerInitializeParams = {
  clientInfo: {
    name: "codex-pad",
    title: "Codex Pad",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: false,
    requestAttestation: false,
    mcpServerOpenaiFormElicitation: false,
    optOutNotificationMethods: [],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequestId(value: unknown): value is AppServerRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function parseRpcError(value: unknown): AppServerRpcError {
  if (!isRecord(value)) {
    return new AppServerRpcError(-32_000, "The app-server returned an invalid error payload.", value);
  }

  const code = typeof value.code === "number" ? value.code : -32_000;
  const message = typeof value.message === "string" ? value.message : "Unknown app-server error.";
  return new AppServerRpcError(code, message, value.data);
}

function isDefinitivePreWriteError(error: unknown): boolean {
  return error instanceof AppServerClientError
    && isRecord(error.detail)
    && error.detail.phase === "pre-write";
}

function deliveryUnknown(method: string, cause: unknown): AppServerClientError {
  return new AppServerClientError(
    "APP_SERVER_DELIVERY_UNKNOWN",
    `App-server may have accepted mutating request ${method}, but its acknowledgement was not received.`,
    {
      phase: "post-write",
      clientCode: errorCode(cause),
    },
  );
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function requestFailure(pending: PendingRequest, error: unknown): Error {
  if (
    pending.delivery === "mutation"
    && pending.writeStarted
    && !isDefinitivePreWriteError(error)
  ) {
    return error instanceof AppServerClientError && error.code === "APP_SERVER_DELIVERY_UNKNOWN"
      ? error
      : deliveryUnknown(pending.method, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function mergeInitializeParams(
  overrides: Partial<AppServerInitializeParams> | undefined,
): AppServerInitializeParams {
  const defaultCapabilities = DEFAULT_INITIALIZE.capabilities;
  if (defaultCapabilities === null) {
    throw new AppServerClientError("PROTOCOL_ERROR", "Codex Pad initialize defaults are invalid.");
  }
  return {
    clientInfo: {
      ...DEFAULT_INITIALIZE.clientInfo,
      ...overrides?.clientInfo,
    },
    capabilities:
      overrides?.capabilities === null
        ? null
        : {
            experimentalApi:
              overrides?.capabilities?.experimentalApi ?? defaultCapabilities.experimentalApi,
            requestAttestation:
              overrides?.capabilities?.requestAttestation ?? defaultCapabilities.requestAttestation,
            mcpServerOpenaiFormElicitation:
              overrides?.capabilities?.mcpServerOpenaiFormElicitation ??
              defaultCapabilities.mcpServerOpenaiFormElicitation ??
              false,
            optOutNotificationMethods:
              overrides?.capabilities?.optOutNotificationMethods ??
              defaultCapabilities.optOutNotificationMethods ??
              [],
          },
  };
}

export function validateManagedSocketPath(socketPath: string): string {
  if (!isAbsolute(socketPath) || socketPath.includes("\0")) {
    throw new AppServerClientError(
      "INVALID_MANAGED_SOCKET",
      "The managed app-server socket path must be an absolute, NUL-free path.",
    );
  }

  let socketStat: ReturnType<typeof lstatSync>;
  try {
    socketStat = lstatSync(socketPath);
  } catch (error) {
    throw new AppServerClientError(
      "INVALID_MANAGED_SOCKET",
      `No managed app-server socket exists at ${socketPath}.`,
      error,
    );
  }

  if (socketStat.isSymbolicLink() || !socketStat.isSocket()) {
    throw new AppServerClientError(
      "INVALID_MANAGED_SOCKET",
      "The configured path is not a direct Unix domain socket.",
    );
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && socketStat.uid !== currentUid) {
    throw new AppServerClientError(
      "INVALID_MANAGED_SOCKET",
      "The managed app-server socket is not owned by the current user.",
    );
  }

  if ((socketStat.mode & 0o077) !== 0) {
    throw new AppServerClientError(
      "INVALID_MANAGED_SOCKET",
      "The managed app-server socket must not grant group or other permissions.",
    );
  }

  return resolve(socketPath);
}

async function validateCodexBinaryPath(binaryPath: string): Promise<string> {
  if (!isAbsolute(binaryPath) || binaryPath.includes("\0")) {
    throw new AppServerClientError(
      "INVALID_CODEX_BINARY",
      "The Codex binary path must be an absolute, NUL-free path.",
    );
  }

  let binaryStat: ReturnType<typeof statSync>;
  try {
    const directStat = lstatSync(binaryPath);
    if (directStat.isSymbolicLink()) {
      throw new Error("symbolic links are not accepted");
    }
    binaryStat = statSync(binaryPath);
    await access(binaryPath, fsConstants.X_OK);
  } catch (error) {
    throw new AppServerClientError(
      "INVALID_CODEX_BINARY",
      `The configured Codex binary is not a direct executable file: ${binaryPath}.`,
      error,
    );
  }

  if (!binaryStat.isFile()) {
    throw new AppServerClientError(
      "INVALID_CODEX_BINARY",
      `The configured Codex binary is not a regular file: ${binaryPath}.`,
    );
  }

  return resolve(binaryPath);
}

class ManagedSocketJsonlDuplex implements JsonlDuplex {
  readonly readable: AsyncIterable<Uint8Array | string>;
  private readonly websocket: WebSocket;
  private readonly messageStream: Readable;
  private closed = false;

  private constructor(websocket: WebSocket) {
    this.websocket = websocket;
    this.messageStream = new Readable({ read() {} });
    this.readable = this.messageStream;
    websocket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.messageStream.destroy(new AppServerClientError(
          "PROTOCOL_MALFORMED_FRAME",
          "The managed app-server sent a binary WebSocket message.",
        ));
        return;
      }
      this.messageStream.push(`${data.toString()}\n`);
    });
    websocket.on("error", (error) => {
      this.messageStream.destroy(error);
    });
    websocket.on("close", () => {
      this.messageStream.push(null);
    });
  }

  static async connect(codexBinaryPath: string, socketPath: string, maxFrameBytes: number): Promise<ManagedSocketJsonlDuplex> {
    // Keep the installed Codex binary as an explicit verified part of the
    // managed-runtime contract even though the local client connects directly
    // to the daemon's private WebSocket-over-UDS listener.
    await validateCodexBinaryPath(codexBinaryPath);
    const socket = validateManagedSocketPath(socketPath);
    const websocket = new WebSocket("ws://localhost/", {
      createConnection: () => createConnection(socket),
      handshakeTimeout: 5_000,
      maxPayload: maxFrameBytes,
      perMessageDeflate: false,
    });
    const transport = new ManagedSocketJsonlDuplex(websocket);
    await transport.waitForOpen();
    return transport;
  }

  async write(data: string): Promise<void> {
    if (this.closed || this.websocket.readyState !== WebSocket.OPEN) {
      throw new AppServerClientError(
        "APP_SERVER_CLOSED",
        "The managed app-server socket is closed.",
        { phase: "pre-write" },
      );
    }

    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.websocket.send(data.trimEnd(), (error) => {
        if (error) {
          rejectWrite(error);
        } else {
          resolveWrite();
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.websocket.readyState === WebSocket.OPEN) this.websocket.close();
    else if (this.websocket.readyState === WebSocket.CONNECTING) this.websocket.terminate();
    this.messageStream.push(null);
  }

  async verifySocketPeer(expected: ManagedSocketPeerExpectation): Promise<boolean> {
    if (this.closed || this.websocket.readyState !== WebSocket.OPEN) return false;
    return verifyManagedSocketPeerGeneration({
      expected,
      clientPid: process.pid,
      runCommand: runOwnershipCommand,
    });
  }

  verifySocketPeerAtWriteBoundary(expected: ManagedSocketPeerExpectation): boolean {
    if (this.closed || this.websocket.readyState !== WebSocket.OPEN) return false;
    return verifyManagedSocketPeerAtWriteBoundary({ expected, clientPid: process.pid });
  }

  private async waitForOpen(): Promise<void> {
    if (this.websocket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const onOpen = (): void => {
        cleanup();
        resolveOpen();
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectOpen(
          new AppServerClientError(
            "MANAGED_PROXY_EXITED",
            "The managed app-server socket could not be opened.",
            error,
          ),
        );
      };
      const cleanup = (): void => {
        this.websocket.off("open", onOpen);
        this.websocket.off("error", onError);
      };
      this.websocket.once("open", onOpen);
      this.websocket.once("error", onError);
    });
  }
}

export class AppServerClient {
  readonly transportKind: "managed-proxy" | "injected";
  private readonly duplex: JsonlDuplex;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly managedSocket: ManagedSocketJsonlDuplex | undefined;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly protocolErrorListeners = new Set<ProtocolErrorListener>();
  private readonly closeListeners = new Set<CloseListener>();
  readonly #writeAuthorityIssuer: ManagedWriteAuthorityIssuer | undefined;
  private requestSequence = 0;
  private initialized = false;
  private closed = false;
  private initializePromise: Promise<AppServerInitializeResponse> | undefined;
  private readerPromise: Promise<void>;
  private serverInfoValue: AppServerInitializeResponse | undefined;

  constructor(
    duplex: JsonlDuplex,
    options: {
      requestTimeoutMs?: number;
      maxFrameBytes?: number;
      transportKind?: "managed-proxy" | "injected";
    } = {},
  ) {
    this.duplex = duplex;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.transportKind = options.transportKind ?? "injected";
    this.managedSocket = duplex instanceof ManagedSocketJsonlDuplex ? duplex : undefined;
    this.#writeAuthorityIssuer = this.transportKind === "managed-proxy"
      ? new ManagedWriteAuthorityIssuer(this)
      : undefined;
    this.readerPromise = this.readLoop();
  }

  static createOwnedManagedConnection(
    duplex: JsonlDuplex,
    options: { requestTimeoutMs?: number; maxFrameBytes?: number } = {},
  ): ManagedAppServerConnection {
    const client = new AppServerClient(duplex, {
      ...options,
      transportKind: "managed-proxy",
    });
    const writeAuthority = client.#writeAuthorityIssuer;
    if (writeAuthority === undefined) {
      throw new AppServerClientError(
        "APP_SERVER_AUTHORITY_STALE",
        "Managed app-server write authority could not be created.",
        { phase: "pre-write" },
      );
    }
    return Object.freeze({ client, writeAuthority });
  }

  static async connectManaged(options: ManagedProxyOptions): Promise<ManagedAppServerConnection> {
    const duplex = await ManagedSocketJsonlDuplex.connect(
      options.codexBinaryPath,
      options.socketPath,
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    );
    const clientOptions: {
      requestTimeoutMs?: number;
      maxFrameBytes?: number;
      transportKind: "managed-proxy";
    } = {
      transportKind: "managed-proxy",
    };
    if (options.requestTimeoutMs !== undefined) {
      clientOptions.requestTimeoutMs = options.requestTimeoutMs;
    }
    if (options.maxFrameBytes !== undefined) clientOptions.maxFrameBytes = options.maxFrameBytes;
    const connection = AppServerClient.createOwnedManagedConnection(duplex, clientOptions);
    const { client } = connection;

    try {
      await client.initialize(options.initialize);
      return connection;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get serverInfo(): AppServerInitializeResponse | undefined {
    return this.serverInfoValue;
  }

  async verifyManagedSocketPeer(expected: ManagedSocketPeerExpectation): Promise<boolean> {
    if (
      this.transportKind !== "managed-proxy"
      || !this.initialized
      || this.closed
      || this.managedSocket === undefined
    ) {
      return false;
    }
    return this.managedSocket.verifySocketPeer(expected);
  }

  verifyManagedSocketPeerAtWriteBoundary(expected: ManagedSocketPeerExpectation): boolean {
    return this.transportKind === "managed-proxy"
      && this.initialized
      && !this.closed
      && this.managedSocket !== undefined
      && this.managedSocket.verifySocketPeerAtWriteBoundary(expected);
  }

  initialize(
    overrides?: Partial<AppServerInitializeParams>,
  ): Promise<AppServerInitializeResponse> {
    if (this.initializePromise !== undefined) return this.initializePromise;

    this.initializePromise = (async () => {
      const response = await this.#rawRequest<AppServerInitializeResponse>(
        "initialize",
        mergeInitializeParams(overrides),
      );
      if (!isRecord(response) || typeof response.userAgent !== "string") {
        throw new AppServerClientError(
          "PROTOCOL_ERROR",
          "The app-server initialize response did not contain a userAgent.",
          response,
        );
      }
      await this.#notifyInitialized();
      this.serverInfoValue = response as AppServerInitializeResponse;
      this.initialized = true;
      return this.serverInfoValue;
    })();

    return this.initializePromise;
  }

  async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    if (!this.initialized) {
      throw new AppServerClientError(
        "APP_SERVER_NOT_INITIALIZED",
        `Cannot call ${method} before initialize completes.`,
      );
    }
    this.assertAllowedMethod(READ_ONLY_METHODS, "read-only request", method);
    return this.#rawRequest<TResult>(method, params);
  }

  async mutate<TResult = unknown>(
    method: string,
    params?: unknown,
    authority?: AppServerWriteAuthorityToken,
  ): Promise<TResult> {
    if (!this.initialized) {
      throw new AppServerClientError(
        "APP_SERVER_NOT_INITIALIZED",
        `Cannot mutate with ${method} before initialize completes.`,
      );
    }
    this.assertAllowedMethod(MUTATING_METHODS, "mutating request", method);
    return this.#rawRequest<TResult>(method, params, authority);
  }

  async respond(
    id: AppServerRequestId,
    result: unknown,
    authority?: AppServerWriteAuthorityToken,
  ): Promise<void> {
    this.assertOpen();
    const frame = `${JSON.stringify({ id, result })}\n`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(deliveryUnknown(`response:${String(id)}`, new AppServerClientError(
            "APP_SERVER_TIMEOUT",
            `App-server response write timed out after ${this.requestTimeoutMs} ms.`,
          )));
        }, this.requestTimeoutMs);
      });
      this.assertWriteAuthority(authority);
      await Promise.race([Promise.resolve(this.duplex.write(frame)), timeout]);
    } catch (error) {
      if (isDefinitivePreWriteError(error)) throw error;
      if (error instanceof AppServerClientError && error.code === "APP_SERVER_DELIVERY_UNKNOWN") throw error;
      throw deliveryUnknown(`response:${String(id)}`, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Consume an already-issued managed authority without sending a JSONL frame.
   * The managed provider uses this at non-app-server mutation sinks (native CDP)
   * so the same exact ownership proof is checked at that dispatch boundary.
   */
  consumeWriteAuthority(authority: AppServerWriteAuthorityToken): void {
    this.assertOpen();
    this.assertWriteAuthority(authority);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onProtocolError(listener: ProtocolErrorListener): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.readerPromise.catch(() => undefined);
      return;
    }

    this.finishClosed(
      new AppServerClientError("APP_SERVER_CLOSED", "The app-server client was closed."),
    );
    await this.duplex.close();
    await this.readerPromise.catch(() => undefined);
  }

  async #rawRequest<TResult>(
    method: string,
    params?: unknown,
    authority?: AppServerWriteAuthorityToken,
  ): Promise<TResult> {
    this.assertOpen();
    const delivery = method === "initialize" || READ_ONLY_METHODS.has(method)
      ? "query" as const
      : MUTATING_METHODS.has(method)
        ? "mutation" as const
        : undefined;
    if (delivery === undefined) {
      throw new AppServerClientError(
        "APP_SERVER_METHOD_NOT_ALLOWED",
        `App-server request ${method} is not allowlisted.`,
        { phase: "pre-write", method },
      );
    }
    const frame: Record<string, unknown> = { id: this.requestSequence + 1, method };
    if (params !== undefined) frame.params = params;
    // Serialization is intentionally completed before a pending mutation exists:
    // a validation/serialization failure cannot have reached app-server.
    const serialized = `${JSON.stringify(frame)}\n`;
    const id = ++this.requestSequence;

    const resultPromise = new Promise<TResult>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        rejectRequest(requestFailure(
          pending,
          new AppServerClientError(
            "APP_SERVER_TIMEOUT",
            `App-server request ${method} timed out after ${this.requestTimeoutMs} ms.`,
          ),
        ));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        method,
        delivery,
        resolve: (value) => resolveRequest(value as TResult),
        reject: rejectRequest,
        timer,
        writeStarted: false,
      });
    });

    const rejectWrite = (error: unknown): void => {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(requestFailure(pending, error));
      }
    };

    try {
      const pending = this.pending.get(id);
      if (delivery === "mutation") this.assertWriteAuthority(authority);
      if (pending !== undefined) pending.writeStarted = true;
      const write = this.duplex.write(serialized);
      // Do not let a stalled stream callback suppress the request timeout. The
      // response promise owns settlement; a later write failure is ignored once
      // an authoritative response has already arrived.
      void Promise.resolve(write).catch(rejectWrite);
    } catch (error) {
      rejectWrite(error);
    }

    return resultPromise;
  }

  private async readLoop(): Promise<void> {
    const decoder = new StringDecoder("utf8");
    let buffered = "";

    try {
      for await (const chunk of this.duplex.readable) {
        if (this.closed) return;
        buffered += typeof chunk === "string" ? chunk : decoder.write(chunk);

        if (Buffer.byteLength(buffered, "utf8") > this.maxFrameBytes && !buffered.includes("\n")) {
          throw new AppServerClientError(
            "PROTOCOL_ERROR",
            `An app-server frame exceeded ${this.maxFrameBytes} bytes.`,
          );
        }

        let newlineIndex = buffered.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffered.slice(0, newlineIndex).trimEnd();
          buffered = buffered.slice(newlineIndex + 1);
          if (line.length > 0) this.handleLine(line);
          newlineIndex = buffered.indexOf("\n");
        }
      }

      buffered += decoder.end();
      if (buffered.trim().length > 0) this.handleLine(buffered.trim());

      if (!this.closed) {
        this.finishClosed(
          new AppServerClientError(
            "MANAGED_PROXY_EXITED",
            "The app-server transport ended unexpectedly.",
          ),
        );
      }
    } catch (error) {
      const clientError =
        error instanceof AppServerClientError
          ? error
          : new AppServerClientError(
              "MANAGED_PROXY_EXITED",
              "The app-server transport failed.",
              error,
            );
      this.finishClosed(clientError);
      try {
        await this.duplex.close();
      } catch {
        // The original transport/protocol failure is the useful error.
      }
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
      this.emitProtocolError(
        new AppServerClientError(
          "PROTOCOL_ERROR",
          `An app-server frame exceeded ${this.maxFrameBytes} bytes.`,
        ),
      );
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(line) as unknown;
    } catch (error) {
      this.emitProtocolError(
        new AppServerClientError(
          "PROTOCOL_MALFORMED_FRAME",
          "Ignored malformed JSONL from the app-server.",
          error,
        ),
      );
      return;
    }

    if (!isRecord(frame)) {
      this.emitProtocolError(
        new AppServerClientError(
          "PROTOCOL_MALFORMED_FRAME",
          "Ignored a non-object app-server frame.",
          frame,
        ),
      );
      return;
    }

    if (hasRequestId(frame.id) && typeof frame.method === "string") {
      const request: AppServerInboundRequest = { id: frame.id, method: frame.method };
      if (frame.params !== undefined) request.params = frame.params;
      for (const listener of this.serverRequestListeners) listener(request);
      return;
    }

    if (hasRequestId(frame.id) && ("result" in frame || "error" in frame)) {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) {
        this.emitProtocolError(
          new AppServerClientError(
            "PROTOCOL_ERROR",
            `Ignored a response for unknown request id ${String(frame.id)}.`,
          ),
        );
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if ("error" in frame && frame.error !== undefined && frame.error !== null) {
        pending.reject(parseRpcError(frame.error));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    if (typeof frame.method === "string" && frame.id === undefined) {
      const notification: AppServerNotification = { method: frame.method };
      if (frame.params !== undefined) notification.params = frame.params;
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }

    this.emitProtocolError(
      new AppServerClientError(
        "PROTOCOL_MALFORMED_FRAME",
        "Ignored an app-server frame with an unknown shape.",
        frame,
      ),
    );
  }

  private emitProtocolError(error: AppServerClientError): void {
    for (const listener of this.protocolErrorListeners) listener(error);
  }

  private finishClosed(error: AppServerClientError): void {
    if (this.closed) return;
    this.closed = true;
    this.#writeAuthorityIssuer?.revoke();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(requestFailure(pending, error));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppServerClientError("APP_SERVER_CLOSED", "The app-server client is closed.");
    }
  }

  async #notifyInitialized(): Promise<void> {
    this.assertOpen();
    await this.duplex.write(`${JSON.stringify({ method: "initialized" })}\n`);
  }

  private assertAllowedMethod(
    allowlist: ReadonlySet<string>,
    operation: string,
    method: string,
  ): void {
    if (allowlist.has(method)) return;
    throw new AppServerClientError(
      "APP_SERVER_METHOD_NOT_ALLOWED",
      `App-server ${operation} ${method} is not allowlisted.`,
      { phase: "pre-write", method },
    );
  }

  private assertWriteAuthority(authority: AppServerWriteAuthorityToken | undefined): void {
    if (this.transportKind !== "managed-proxy") return;
    const state = authority === undefined ? undefined : WRITE_AUTHORITIES.get(authority);
    if (
      state === undefined
      || state.client !== this
      || !state.issuer.isCurrent(state.epoch)
      || state.used
      || this.closed
      || !this.initialized
    ) {
      throw new AppServerClientError(
        "APP_SERVER_AUTHORITY_STALE",
        "Managed app-server write authority changed before dispatch.",
        { phase: "pre-write" },
      );
    }
    // Consume before calling untrusted validation code. A callback that throws or
    // re-enters mutate/respond must never leave the same authority reusable.
    state.used = true;
    if (authority !== undefined) WRITE_AUTHORITIES.delete(authority);
    try {
      const validationResult = state.assertCurrent();
      if (validationResult !== undefined) {
        throw new Error("write authority validation must complete synchronously");
      }
    } catch {
      throw new AppServerClientError(
        "APP_SERVER_AUTHORITY_STALE",
        "Managed app-server write authority changed before dispatch.",
        { phase: "pre-write" },
      );
    }
  }
}

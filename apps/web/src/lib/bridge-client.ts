import {
  AllSessionsApiResponseSchema,
  CommandAckApiResponseSchema,
  CommandStatusApiResponseSchema,
  ContextRoomStatusApiResponseSchema,
  CodexUsageApiResponseSchema,
  DiagramApiResponseSchema,
  DiagramUpdateRequestSchema,
  DiagramsApiResponseSchema,
  NativeSessionsApiResponseSchema,
  DeviceRevocationApiResponseSchema,
  PairedDevicesApiResponseSchema,
  ProductStateApiResponseSchema,
  ProductStateUpdateRequestSchema,
  RuntimeDiagnosticsApiResponseSchema,
  SavedDrawingApiResponseSchema,
  SavedDrawingCreateRequestSchema,
  SavedDrawingDeleteApiResponseSchema,
  SavedDrawingsApiResponseSchema,
  ServerWsMessageSchema,
  SiteQaActionReceiptSchema,
  SiteAssociationSchema,
  type Command,
  type CommandAck as ProtocolCommandAck,
  type CommandStatusResponse,
  type CodexUsageSnapshot,
  type ContextRoomStatus,
  type DiagramDocument,
  type DiagramUpdateRequest,
  type NativeSessionsResponse,
  type PairedDevicesResponse,
  type ProductState,
  type RuntimeDiagnostics,
  type SavedDrawingCreateRequest,
  type SavedDrawingDetail,
  type SavedDrawingSummary,
  type SendSketchCommand,
  type SessionSummary,
  type SiteQaActionReceipt,
  type SiteQaRecordedAction,
  type SiteAssociation,
} from "@codex-pad/protocol";
import type { BridgeSnapshot, CommandAck, PairResult, SketchRequest } from "./model";
import {
  clearBridgeBearer,
  isBridgeBearer,
  loadBridgeBearer,
  saveBridgeBearer,
} from "./auth-store";
import { normalizeSnapshot } from "./normalize";
import {
  classifySnapshot,
  type SnapshotAcceptance,
  type SnapshotCursor,
} from "./snapshot-order";
import { createUuidV4 } from "./uuid";

const HEARTBEAT_EVERY_MS = 15_000;
const HALF_OPEN_AFTER_MS = 38_000;
const SNAPSHOT_FALLBACK_MS = 12_000;
const WEB_SOCKET_PROTOCOL = "codex-pad.v1";
const WEB_SOCKET_TICKET_PROTOCOL_PREFIX = "codex-pad.ticket.";

export class BridgeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BridgeHttpError";
  }
}

export interface BridgeClientCallbacks {
  readonly onSnapshot: (snapshot: BridgeSnapshot) => void;
  readonly onConnection: (connected: boolean) => void;
  readonly onUnauthorized: () => void;
  readonly onAck?: (ack: CommandAck) => void;
}

export interface CommandStatusResult {
  readonly state: "pending" | "final" | "unknown";
  readonly ack: CommandAck;
}

export type SiteCaptureViewport = "ipad-landscape" | "ipad-portrait" | "mobile-portrait" | "desktop-wide";

export interface SiteCaptureResult {
  readonly siteId: string;
  readonly title: string | null;
  /** Root-relative final route after same-origin redirects; private Mac origins never cross the bridge. */
  readonly finalPath: string;
  readonly viewport: SiteCaptureViewport;
  readonly scroll: { readonly x: number; readonly y: number };
  readonly redirectCount: number;
  readonly pngBase64: string;
  readonly width: number;
  readonly height: number;
}

export interface ManagedSite {
  readonly siteId: string;
  readonly name: string;
  readonly scope: "thread" | "project";
  readonly publicOrigin: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly association: SiteAssociation | null;
}

export interface OpenBrowserTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly controllable: boolean;
  readonly reason: string | null;
}

export interface OpenBrowserTabsResult {
  readonly tabs: readonly OpenBrowserTab[];
  readonly detail: string;
}

export type BrowserTabControl =
  | { readonly type: "tap"; readonly x: number; readonly y: number }
  | { readonly type: "scroll"; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: "insertText"; readonly text: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "key"; readonly key: "Enter" | "Backspace" | "Escape" | "Tab" }
  | { readonly type: "back" | "forward" | "reload" };

export interface BrowserTabFrame {
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly imageBase64: string;
  readonly mimeType: "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly capturedAt: number;
}

export interface RecordedBrowserTabControlResult {
  readonly frame: BrowserTabFrame;
  readonly receipt: SiteQaActionReceipt;
}

export interface PushServerStatus {
  readonly supported: true;
  readonly subscribed: boolean;
  readonly publicKey: string;
}

export interface BrowserPushSubscription {
  readonly endpoint: string;
  readonly expirationTime?: number | null;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

function pushServerStatusFrom(value: unknown): PushServerStatus | null {
  const envelope = sourceRecord(value);
  const data = sourceRecord(envelope.data);
  if (
    envelope.ok !== true
    || data.supported !== true
    || typeof data.subscribed !== "boolean"
    || typeof data.publicKey !== "string"
    || data.publicKey.length < 80
    || data.publicKey.length > 100
    || !/^[A-Za-z0-9_-]+$/u.test(data.publicKey)
  ) return null;
  return { supported: true, subscribed: data.subscribed, publicKey: data.publicKey };
}

const SITE_CAPTURE_VIEWPORTS = new Set<SiteCaptureViewport>([
  "ipad-landscape",
  "ipad-portrait",
  "mobile-portrait",
  "desktop-wide",
]);

function isSafeCaptureFinalPath(value: string): boolean {
  return value.length <= 2_048
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("#")
    && !/[\u0000-\u001f\u007f\\]/u.test(value);
}

function managedSitesFrom(value: unknown): readonly ManagedSite[] | null {
  const data = sourceRecord(sourceRecord(value).data);
  if (!Array.isArray(data.sites) || data.sites.length > 64) return null;
  const sites = data.sites.flatMap((item): ManagedSite[] => {
    const source = sourceRecord(item);
    const association = source.association === null
      ? null
      : SiteAssociationSchema.safeParse(source.association);
    if (
      typeof source.siteId !== "string"
      || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(source.siteId)
      || typeof source.name !== "string"
      || source.name.length < 1
      || source.name.length > 120
      || (source.scope !== "thread" && source.scope !== "project")
      || (source.publicOrigin !== null && typeof source.publicOrigin !== "string")
      || typeof source.createdAt !== "number"
      || typeof source.updatedAt !== "number"
      || (association !== null && !association.success)
    ) return [];
    return [{
      siteId: source.siteId,
      name: source.name,
      scope: source.scope,
      publicOrigin: source.publicOrigin as string | null,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      association: association === null ? null : association.data,
    }];
  });
  return sites.length === data.sites.length ? sites : null;
}

function openBrowserTabsFrom(value: unknown): OpenBrowserTabsResult | null {
  const data = sourceRecord(sourceRecord(value).data);
  if (!Array.isArray(data.tabs) || data.tabs.length > 64 || typeof data.detail !== "string") return null;
  const tabs = data.tabs.flatMap((item): OpenBrowserTab[] => {
    const source = sourceRecord(item);
    if (
      typeof source.id !== "string"
      || !/^tab_[a-z0-9_-]{1,63}$/u.test(source.id)
      || typeof source.title !== "string"
      || source.title.length > 160
      || typeof source.url !== "string"
      || source.url.length > 2_048
      || typeof source.controllable !== "boolean"
      || (source.reason !== null && typeof source.reason !== "string")
    ) return [];
    return [{
      id: source.id,
      title: source.title,
      url: source.url,
      controllable: source.controllable,
      reason: source.reason as string | null,
    }];
  });
  return tabs.length === data.tabs.length ? { tabs, detail: data.detail } : null;
}

function browserTabFrameDataFrom(value: unknown, expectedTabId: string): BrowserTabFrame | null {
  const data = sourceRecord(value);
  if (
    data.tabId !== expectedTabId
    || typeof data.title !== "string"
    || data.title.length > 160
    || typeof data.url !== "string"
    || data.url.length > 2_048
    || typeof data.imageBase64 !== "string"
    || data.imageBase64.length < 16
    || data.imageBase64.length > 16 * 1024 * 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data.imageBase64)
    || data.mimeType !== "image/jpeg"
    || typeof data.width !== "number"
    || !Number.isSafeInteger(data.width)
    || data.width < 1
    || data.width > 8_192
    || typeof data.height !== "number"
    || !Number.isSafeInteger(data.height)
    || data.height < 1
    || data.height > 8_192
    || typeof data.deviceScaleFactor !== "number"
    || data.deviceScaleFactor < 1
    || data.deviceScaleFactor > 4
    || typeof data.scrollX !== "number"
    || typeof data.scrollY !== "number"
    || typeof data.capturedAt !== "number"
  ) return null;
  return data as unknown as BrowserTabFrame;
}

function browserTabFrameFrom(value: unknown, expectedTabId: string): BrowserTabFrame | null {
  return browserTabFrameDataFrom(sourceRecord(value).data, expectedTabId);
}

function recordedBrowserTabControlFrom(value: unknown, expectedTabId: string): RecordedBrowserTabControlResult | null {
  const data = sourceRecord(sourceRecord(value).data);
  const frame = browserTabFrameDataFrom(data.frame, expectedTabId);
  const receipt = SiteQaActionReceiptSchema.safeParse(data.receipt);
  return frame !== null && receipt.success ? { frame, receipt: receipt.data } : null;
}

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function sourceRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function messageFrom(value: unknown, fallback: string): string {
  const source = sourceRecord(value);
  const error = sourceRecord(source.error);
  return typeof source.message === "string"
    ? source.message
    : typeof error.message === "string"
      ? error.message
      : typeof source.error === "string"
        ? source.error
        : fallback;
}

export function commandAckFromProtocol(ack: ProtocolCommandAck): CommandAck {
  const pending = ack.status === "inFlight";
  const ok = ack.status !== "failed";
  return {
    commandId: ack.commandId,
    ok,
    pending,
    sequence: ack.sequence,
    message: ack.error?.message
      ?? (pending ? "Command is in progress on the selected task" : "Command completed"),
  };
}

function ackFromStatus(status: CommandStatusResponse): CommandAck {
  const pending = status.status === "inFlight";
  const unknown = status.status === "unknown";
  const ok = status.status === "succeeded" || pending;
  return {
    commandId: status.commandId,
    ok,
    pending: pending || unknown,
    message: status.error?.message
      ?? status.result?.message
      ?? (pending ? "Command is still in flight" : status.status === "unknown" ? "Command status is unknown" : ok ? "Command completed" : "Command failed"),
  };
}

export function commandStatusResult(status: CommandStatusResponse): CommandStatusResult {
  const state = status.status === "inFlight"
    ? "pending"
    : status.status === "unknown"
      ? "unknown"
      : "final";
  return { state, ack: ackFromStatus(status) };
}

function failedAck(commandId: string, value: unknown, fallback: string): CommandAck {
  return { commandId, ok: false, pending: false, message: messageFrom(value, fallback) };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(20_000, 650 * 2 ** Math.max(0, attempt));
  return Math.round(ceiling * (0.7 + random() * 0.6));
}

/** Origin-isolated bearer client. Permanent credentials never enter cookies, URLs, or localStorage. */
export class BridgeClient {
  private socket: WebSocket | null = null;
  private bearerToken: string | null = null;
  private connecting = false;
  private stopped = true;
  private suspended = false;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private fallbackTimer: number | null = null;
  private attempt = 0;
  private lastServerSignal = 0;
  private latestBridgeInstanceId: string | null = null;
  private latestSeq = -1;
  private snapshotRevision = 0;
  private readonly supersededBridgeInstanceIds = new Set<string>();
  private socketTrusted = false;

  constructor(private readonly callbacks: BridgeClientCallbacks) {}

  async start(): Promise<boolean> {
    if (!this.stopped) return this.bearerToken !== null;
    this.stopped = false;
    this.suspended = false;
    this.bearerToken = await loadBridgeBearer();
    if (this.bearerToken === null) {
      this.callbacks.onUnauthorized();
      return false;
    }
    await this.refreshSnapshot();
    if (this.bearerToken === null) return false;
    if (!this.stopped) this.connect();
    this.scheduleFallback();
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.suspended = false;
    this.connecting = false;
    this.setSocketTrusted(false, true);
    this.clearTimers();
    this.socket?.close(1000, "client stopped");
    this.socket = null;
  }

  setVisible(visible: boolean): void {
    if (this.stopped) return;
    if (!visible) {
      if (this.suspended) return;
      this.suspended = true;
      this.clearTimers();
      this.setSocketTrusted(false, true);
      this.socket?.close(1000, "page hidden");
      return;
    }
    this.suspended = false;
    if (this.bearerToken === null) {
      this.callbacks.onUnauthorized();
      return;
    }
    void this.refreshSnapshot();
    this.connect();
    this.scheduleFallback();
  }

  private invalidateCredential(expectedBearer: string): void {
    if (this.bearerToken !== expectedBearer) return;
    this.bearerToken = null;
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    socket?.close(1000, "credential cleared");
    this.setSocketTrusted(false, true);
    void clearBridgeBearer(expectedBearer);
    this.callbacks.onUnauthorized();
  }

  private async authorizedFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const storedBearer = this.bearerToken ?? await loadBridgeBearer();
    // Pairing may complete while IndexedDB is resolving. In that case the
    // newer in-memory bearer wins over the stale value read above.
    const bearerToken = this.bearerToken ?? storedBearer;
    if (bearerToken === null) {
      this.callbacks.onUnauthorized();
      throw new BridgeHttpError(401, "Pair this device again");
    }
    this.bearerToken = bearerToken;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${bearerToken}`);
    const response = await fetch(input, {
      ...init,
      credentials: "omit",
      headers,
    });
    if (response.status === 401) this.invalidateCredential(bearerToken);
    return response;
  }

  async refreshSnapshot(): Promise<boolean> {
    const requestRevision = this.snapshotRevision;
    try {
      const response = await this.authorizedFetch("/api/snapshot", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = await responseJson(response);
      if (!response.ok) throw new BridgeHttpError(response.status, messageFrom(body, "Snapshot unavailable"));
      return this.acceptSnapshot(body, "http", requestRevision) !== "rejected";
    } catch {
      return false;
    }
  }

  async fetchCapabilities(): Promise<unknown | null> {
    try {
      const response = await this.authorizedFetch("/api/capabilities", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      return await responseJson(response);
    } catch {
      return null;
    }
  }

  async fetchRuntimeDiagnostics(): Promise<RuntimeDiagnostics | null> {
    try {
      const response = await this.authorizedFetch("/api/runtime", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const parsed = RuntimeDiagnosticsApiResponseSchema.safeParse(await responseJson(response));
      return parsed.success && parsed.data.ok ? parsed.data.data : null;
    } catch {
      return null;
    }
  }

  async fetchContextRoomStatus(): Promise<ContextRoomStatus | null> {
    try {
      const response = await this.authorizedFetch("/api/context-room", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const parsed = ContextRoomStatusApiResponseSchema.safeParse(await responseJson(response));
      return parsed.success && parsed.data.ok ? parsed.data.data : null;
    } catch {
      return null;
    }
  }

  async fetchNativeSessions(): Promise<NativeSessionsResponse | null> {
    try {
      const response = await this.authorizedFetch("/api/native-sessions", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const parsed = NativeSessionsApiResponseSchema.safeParse(await responseJson(response));
      return parsed.success && parsed.data.ok ? parsed.data.data : null;
    } catch {
      return null;
    }
  }

  async fetchSessions(): Promise<readonly SessionSummary[] | null> {
    try {
      const response = await this.authorizedFetch("/api/sessions", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const parsed = AllSessionsApiResponseSchema.safeParse(await responseJson(response));
      return parsed.success && parsed.data.ok ? parsed.data.data.sessions : null;
    } catch {
      return null;
    }
  }

  async fetchCodexUsage(): Promise<CodexUsageSnapshot | null> {
    try {
      const response = await this.authorizedFetch("/api/usage", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const parsed = CodexUsageApiResponseSchema.safeParse(await responseJson(response));
      return parsed.success && parsed.data.ok ? parsed.data.data : null;
    } catch {
      return null;
    }
  }

  async fetchProductState(): Promise<ProductState | null> {
    try {
      const response = await this.authorizedFetch("/api/product-state", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const parsed = ProductStateApiResponseSchema.safeParse(await responseJson(response));
      return parsed.success && parsed.data.ok ? parsed.data.data : null;
    } catch {
      return null;
    }
  }

  async fetchPushStatus(): Promise<PushServerStatus | null> {
    try {
      const response = await this.authorizedFetch("/api/push", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      return pushServerStatusFrom(await responseJson(response));
    } catch {
      return null;
    }
  }

  async savePushSubscription(subscription: BrowserPushSubscription): Promise<void> {
    const response = await this.authorizedFetch("/api/push/subscription", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(subscription),
    });
    const body = await responseJson(response);
    const data = sourceRecord(sourceRecord(body).data);
    if (!response.ok || sourceRecord(body).ok !== true || data.subscribed !== true) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Background notifications could not be enabled"));
    }
  }

  async removePushSubscription(): Promise<void> {
    const response = await this.authorizedFetch("/api/push/subscription", {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const body = await responseJson(response);
    const data = sourceRecord(sourceRecord(body).data);
    if (!response.ok || sourceRecord(body).ok !== true || data.subscribed !== false) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Background notifications could not be disabled"));
    }
  }

  async saveProductState(inputValue: unknown): Promise<ProductState> {
    const input = ProductStateUpdateRequestSchema.parse(inputValue);
    const response = await this.authorizedFetch("/api/product-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    });
    const body = await responseJson(response);
    const parsed = ProductStateApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Global product state could not be saved"));
    }
    return parsed.data.data;
  }

  async fetchDevices(): Promise<PairedDevicesResponse | null> {
    try {
      const response = await this.authorizedFetch("/api/devices", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const parsed = PairedDevicesApiResponseSchema.safeParse(await responseJson(response));
      return parsed.success && parsed.data.ok ? parsed.data.data : null;
    } catch {
      return null;
    }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const response = await this.authorizedFetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const body = await responseJson(response);
    const parsed = DeviceRevocationApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok || parsed.data.data.deviceId !== deviceId) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Device could not be disconnected"));
    }
    return true;
  }

  async fetchSavedDrawings(): Promise<readonly SavedDrawingSummary[]> {
    const response = await this.authorizedFetch("/api/saved-drawings", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    const parsed = SavedDrawingsApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Saved Drawings could not be loaded"));
    }
    return parsed.data.data.drawings;
  }

  async fetchSavedDrawing(drawingId: string): Promise<SavedDrawingDetail> {
    const response = await this.authorizedFetch(`/api/saved-drawings/${encodeURIComponent(drawingId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    const parsed = SavedDrawingApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Saved drawing could not be loaded"));
    }
    return parsed.data.data;
  }

  async saveDrawing(inputValue: SavedDrawingCreateRequest): Promise<SavedDrawingDetail> {
    const input = SavedDrawingCreateRequestSchema.parse(inputValue);
    const response = await this.authorizedFetch("/api/saved-drawings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    });
    const body = await responseJson(response);
    const parsed = SavedDrawingApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Drawing could not be kept on the Mac"));
    }
    return parsed.data.data;
  }

  async deleteSavedDrawing(drawingId: string): Promise<void> {
    const response = await this.authorizedFetch(`/api/saved-drawings/${encodeURIComponent(drawingId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const body = await responseJson(response);
    const parsed = SavedDrawingDeleteApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok || parsed.data.data.drawingId !== drawingId) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Saved drawing could not be deleted"));
    }
  }

  async fetchDiagrams(threadId: string): Promise<readonly DiagramDocument[]> {
    const response = await this.authorizedFetch(`/api/diagrams?threadId=${encodeURIComponent(threadId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    const parsed = DiagramsApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Collaborative diagrams could not be loaded"));
    }
    return parsed.data.data.diagrams;
  }

  async updateDiagram(
    diagramId: string,
    threadId: string,
    inputValue: DiagramUpdateRequest,
  ): Promise<DiagramDocument> {
    const input = DiagramUpdateRequestSchema.parse(inputValue);
    const response = await this.authorizedFetch(
      `/api/diagrams/${encodeURIComponent(diagramId)}?threadId=${encodeURIComponent(threadId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
      },
    );
    const body = await responseJson(response);
    const parsed = DiagramApiResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Diagram changes could not be synced to the Mac"));
    }
    return parsed.data.data;
  }

  async fetchManagedSites(threadId: string): Promise<readonly ManagedSite[]> {
    const response = await this.authorizedFetch(`/api/sites?threadId=${encodeURIComponent(threadId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    const sites = managedSitesFrom(body);
    if (!response.ok || sourceRecord(body).ok !== true || sites === null) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Sites could not be loaded"));
    }
    return sites;
  }

  async fetchOpenBrowserTabs(threadId: string): Promise<OpenBrowserTabsResult> {
    const response = await this.authorizedFetch(`/api/browser-tabs?threadId=${encodeURIComponent(threadId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    const result = openBrowserTabsFrom(body);
    if (!response.ok || sourceRecord(body).ok !== true || result === null) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Open Mac tabs could not be loaded"));
    }
    return result;
  }

  async fetchBrowserTabFrame(threadId: string, tabId: string): Promise<BrowserTabFrame> {
    const response = await this.authorizedFetch(`/api/browser-tabs/${encodeURIComponent(tabId)}/frame?threadId=${encodeURIComponent(threadId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    const frame = browserTabFrameFrom(body, tabId);
    if (!response.ok || sourceRecord(body).ok !== true || frame === null) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Browser page could not be captured"));
    }
    return frame;
  }

  async controlBrowserTab(threadId: string, tabId: string, action: BrowserTabControl): Promise<BrowserTabFrame> {
    const response = await this.authorizedFetch(`/api/browser-tabs/${encodeURIComponent(tabId)}/control?threadId=${encodeURIComponent(threadId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(action),
    });
    const body = await responseJson(response);
    const frame = browserTabFrameFrom(body, tabId);
    if (!response.ok || sourceRecord(body).ok !== true || frame === null) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Browser page control failed"));
    }
    return frame;
  }

  async recordBrowserTabAction(
    threadId: string,
    tabId: string,
    action: SiteQaRecordedAction,
  ): Promise<RecordedBrowserTabControlResult> {
    const response = await this.authorizedFetch(`/api/browser-tabs/${encodeURIComponent(tabId)}/recorded-control?threadId=${encodeURIComponent(threadId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(action),
    });
    const body = await responseJson(response);
    const result = recordedBrowserTabControlFrom(body, tabId);
    if (!response.ok || sourceRecord(body).ok !== true || result === null) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Recorded browser action failed"));
    }
    return result;
  }

  async addManagedSite(input: {
    readonly threadId: string;
    readonly name: string;
    readonly url: string;
    readonly scope: "thread" | "project";
  }): Promise<readonly ManagedSite[]> {
    const response = await this.authorizedFetch("/api/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    });
    const body = await responseJson(response);
    const sites = managedSitesFrom(body);
    if (!response.ok || sourceRecord(body).ok !== true || sites === null) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Site could not be linked"));
    }
    return sites;
  }

  async removeManagedSite(threadId: string, siteId: string): Promise<void> {
    const response = await this.authorizedFetch(`/api/sites/${encodeURIComponent(siteId)}?threadId=${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const body = await responseJson(response);
    const data = sourceRecord(sourceRecord(body).data);
    if (!response.ok || sourceRecord(body).ok !== true || data.removed !== true || data.siteId !== siteId) {
      throw new BridgeHttpError(response.status, messageFrom(body, "Site could not be removed"));
    }
  }

  async captureSite(input: {
    readonly siteId: string;
    readonly threadId: string;
    readonly path: string;
    readonly viewport: SiteCaptureViewport;
    readonly scroll: { readonly x: number; readonly y: number };
  }): Promise<SiteCaptureResult> {
    const response = await this.authorizedFetch(`/api/sites/${encodeURIComponent(input.siteId)}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        threadId: input.threadId,
        path: input.path,
        viewport: input.viewport,
        scroll: input.scroll,
      }),
    });
    const body = await responseJson(response);
    const envelope = sourceRecord(body);
    const data = sourceRecord(envelope.data);
    if (!response.ok || envelope.ok !== true) throw new BridgeHttpError(response.status, messageFrom(body, "Site capture is unavailable"));
    if (
      typeof data.siteId !== "string"
      || data.siteId !== input.siteId
      || (data.title !== null && (typeof data.title !== "string" || data.title.length > 512))
      || typeof data.finalPath !== "string"
      || !isSafeCaptureFinalPath(data.finalPath)
      || typeof data.viewport !== "string"
      || !SITE_CAPTURE_VIEWPORTS.has(data.viewport as SiteCaptureViewport)
      || typeof data.pngBase64 !== "string"
      || typeof data.width !== "number"
      || !Number.isSafeInteger(data.width)
      || data.width <= 0
      || typeof data.height !== "number"
      || !Number.isSafeInteger(data.height)
      || data.height <= 0
    ) throw new Error("The bridge returned an invalid site capture.");
    const scroll = sourceRecord(data.scroll);
    return {
      siteId: data.siteId,
      title: data.title as string | null,
      finalPath: data.finalPath,
      viewport: data.viewport as SiteCaptureViewport,
      scroll: {
        x: typeof scroll.x === "number" ? scroll.x : 0,
        y: typeof scroll.y === "number" ? scroll.y : 0,
      },
      redirectCount: typeof data.redirectCount === "number" ? data.redirectCount : 0,
      pngBase64: data.pngBase64,
      width: data.width as number,
      height: data.height as number,
    };
  }

  async pair(nonce: string, deviceName: string): Promise<PairResult> {
    const response = await fetch("/api/pair", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ nonce, deviceName }),
    });
    const body = await responseJson(response);
    if (!response.ok) return { ok: false, message: messageFrom(body, "Pairing failed") };
    const envelope = sourceRecord(body);
    const data = sourceRecord(envelope.data);
    if (envelope.ok !== true || !isBridgeBearer(data.bearerToken)) {
      return { ok: false, message: "The bridge returned an invalid pairing credential" };
    }
    this.bearerToken = data.bearerToken;
    const persisted = await saveBridgeBearer(data.bearerToken);
    return {
      ok: true,
      message: persisted
        ? "This iPad is paired"
        : "This iPad is paired for this open session; private browser storage is unavailable",
    };
  }

  async command(command: Command): Promise<CommandAck> {
    if (
      !this.socketTrusted
      || command.expectedBridgeInstanceId !== this.latestBridgeInstanceId
      || command.expectedSequence !== this.latestSeq
    ) {
      return failedAck(
        command.commandId,
        {},
        "A current bridge snapshot has not been attested on this connection. Nothing was sent.",
      );
    }
    const response = await this.authorizedFetch("/api/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Codex-Pad-Command-Id": command.commandId,
      },
      body: JSON.stringify({ command }),
    });
    const body = await responseJson(response);
    const parsed = CommandAckApiResponseSchema.safeParse(body);
    if (parsed.success && parsed.data.ok) return commandAckFromProtocol(parsed.data.data);
    return failedAck(command.commandId, body, response.ok ? "Bridge returned an invalid acknowledgement" : "Command failed");
  }

  async commandStatus(commandId: string): Promise<CommandStatusResult | null> {
    try {
      const response = await this.authorizedFetch(`/api/commands/${encodeURIComponent(commandId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 404 || response.status === 405 || response.status === 501) return null;
      const body = await responseJson(response);
      const parsed = CommandStatusApiResponseSchema.safeParse(body);
      if (!parsed.success || !parsed.data.ok) return null;
      return commandStatusResult(parsed.data.data);
    } catch {
      return null;
    }
  }

  async sketch(request: SketchRequest): Promise<CommandAck> {
    const threadId = request.threadKey.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0]?.toLowerCase();
    if (!threadId) return failedAck(request.commandId, {}, "Exact target thread is unavailable");
    const command: SendSketchCommand = {
      type: "sendSketch",
      commandId: request.commandId,
      expectedBridgeInstanceId: request.expectedBridgeInstanceId,
      expectedSequence: request.expectedSnapshotSeq,
      expectedThreadId: threadId,
      targetThreadId: threadId,
      instruction: request.instruction,
      png: await blobToBase64(request.png),
    };
    return this.command(command);
  }

  private currentSnapshotCursor(): SnapshotCursor | null {
    return this.latestBridgeInstanceId === null
      ? null
      : { bridgeInstanceId: this.latestBridgeInstanceId, seq: this.latestSeq };
  }

  private setSocketTrusted(trusted: boolean, forceCallback = false): void {
    if (this.socketTrusted === trusted && !forceCallback) return;
    this.socketTrusted = trusted;
    this.callbacks.onConnection(trusted);
  }

  private acceptSnapshot(
    value: unknown,
    source: "http" | "socket",
    requestRevision = this.snapshotRevision,
  ): SnapshotAcceptance {
    const snapshot = normalizeSnapshot(value);
    if (!snapshot) return "rejected";
    const current = this.currentSnapshotCursor();
    if (
      current !== null
      && snapshot.bridgeInstanceId !== current.bridgeInstanceId
      && this.supersededBridgeInstanceIds.has(snapshot.bridgeInstanceId)
    ) return "rejected";
    if (
      source === "http"
      && requestRevision !== this.snapshotRevision
      && current !== null
      && snapshot.bridgeInstanceId !== current.bridgeInstanceId
    ) return "rejected";
    const acceptance = classifySnapshot(current, snapshot);
    if (acceptance === "rejected") return acceptance;
    if (acceptance === "current") return acceptance;
    if (source === "http" && current !== null && current.bridgeInstanceId !== snapshot.bridgeInstanceId) {
      const hadTrustedSocket = this.socketTrusted;
      this.setSocketTrusted(false);
      if (hadTrustedSocket) this.socket?.close(1012, "bridge generation changed");
    }
    if (current !== null && current.bridgeInstanceId !== snapshot.bridgeInstanceId) {
      this.supersededBridgeInstanceIds.add(current.bridgeInstanceId);
    }
    this.latestBridgeInstanceId = snapshot.bridgeInstanceId;
    this.latestSeq = snapshot.seq;
    this.snapshotRevision += 1;
    this.callbacks.onSnapshot(snapshot);
    return acceptance;
  }

  private connect(): void {
    if (this.stopped || this.suspended || this.socket || this.connecting || this.bearerToken === null) return;
    this.setSocketTrusted(false, true);
    this.connecting = true;
    void this.openSocket()
      .catch(() => {
        if (this.bearerToken !== null) this.scheduleReconnect();
      })
      .finally(() => { this.connecting = false; });
  }

  private async issueSocketProtocol(): Promise<string> {
    const response = await this.authorizedFetch("/api/ws-ticket", {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await responseJson(response);
    const envelope = sourceRecord(body);
    const data = sourceRecord(envelope.data);
    if (!response.ok || envelope.ok !== true) {
      throw new BridgeHttpError(response.status, messageFrom(body, "WebSocket ticket unavailable"));
    }
    const ticket = data.ticket;
    const protocol = data.protocol;
    const expiresAt = data.expiresAt;
    if (
      !isBridgeBearer(ticket)
      || protocol !== `${WEB_SOCKET_TICKET_PROTOCOL_PREFIX}${ticket}`
      || typeof expiresAt !== "number"
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= 0
    ) {
      throw new Error("The bridge returned an invalid WebSocket ticket");
    }
    return protocol;
  }

  private async openSocket(): Promise<void> {
    const socketBearer = this.bearerToken;
    if (socketBearer === null) return;
    const ticketProtocol = await this.issueSocketProtocol();
    if (this.stopped || this.suspended || this.socket || this.bearerToken !== socketBearer) return;
    const socket = new WebSocket(wsUrl(), [WEB_SOCKET_PROTOCOL, ticketProtocol]);
    this.socket = socket;
    let attestedBridgeInstanceId: string | null = null;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.setSocketTrusted(false, true);
      this.lastServerSignal = Date.now();
      socket.send(JSON.stringify({
        type: "hello",
        lastBridgeInstanceId: this.latestBridgeInstanceId,
        lastSequence: Math.max(0, this.latestSeq),
      }));
      this.heartbeatTimer = window.setInterval(() => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastServerSignal > HALF_OPEN_AFTER_MS) {
          socket.close(4000, "heartbeat timeout");
          return;
        }
        socket.send(JSON.stringify({ type: "ping", nonce: createUuidV4().replaceAll("-", "").slice(0, 32) }));
      }, HEARTBEAT_EVERY_MS);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.lastServerSignal = Date.now();
      let json: unknown;
      try {
        json = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = ServerWsMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "snapshot") {
        if (attestedBridgeInstanceId !== null && attestedBridgeInstanceId !== message.snapshot.bridgeInstanceId) {
          this.setSocketTrusted(false);
          socket.close(1008, "socket generation changed");
          return;
        }
        const acceptance = this.acceptSnapshot(message.snapshot, "socket");
        if (acceptance !== "rejected" && attestedBridgeInstanceId === null) {
          attestedBridgeInstanceId = message.snapshot.bridgeInstanceId;
          this.attempt = 0;
          this.setSocketTrusted(true);
        }
      }
      if (message.type === "commandResult") this.callbacks.onAck?.(commandAckFromProtocol(message.result));
      if (message.type === "commandStatus") this.callbacks.onAck?.(ackFromStatus(message.command));
      if (message.type === "resyncRequired") {
        this.setSocketTrusted(false);
        void this.refreshSnapshot();
        socket.close(1012, "resync required");
      }
      if (message.type === "error" && message.commandId) {
        this.callbacks.onAck?.({ commandId: message.commandId, ok: false, pending: false, message: message.error.message });
      }
    });
    const disconnected = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.setSocketTrusted(false, true);
      if (event.code === 4401 || event.code === 4403) {
        this.invalidateCredential(socketBearer);
        return;
      }
      this.scheduleReconnect();
    };
    socket.addEventListener("close", disconnected, { once: true });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.setSocketTrusted(false, true);
      socket.close();
    }, { once: true });
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.fallbackTimer !== null) window.clearTimeout(this.fallbackTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.fallbackTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.suspended || this.bearerToken === null || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, reconnectDelay(this.attempt++));
  }

  private scheduleFallback(): void {
    if (this.stopped || this.suspended || this.bearerToken === null || this.fallbackTimer !== null) return;
    this.fallbackTimer = window.setTimeout(async () => {
      this.fallbackTimer = null;
      await this.refreshSnapshot();
      this.scheduleFallback();
    }, SNAPSHOT_FALLBACK_MS);
  }
}

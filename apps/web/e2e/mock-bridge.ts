import type { Page, Route, WebSocketRoute } from "@playwright/test";
import {
  INITIAL_BRIDGE_INSTANCE_ID,
  RESTARTED_BRIDGE_INSTANCE_ID,
  THREADS,
  fixtureCapabilities,
  fixtureContextRoomStatus,
  fixtureRuntimeDiagnostics,
  fixtureSessions,
  fixtureSnapshot,
} from "./fixture-data";

export { THREADS } from "./fixture-data";
export { CATALOG_SESSION } from "./fixture-data";
export { INITIAL_BRIDGE_INSTANCE_ID, RESTARTED_BRIDGE_INSTANCE_ID } from "./fixture-data";

type MockCommand = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly commandId: string;
};

type PairRequest = {
  readonly nonce: string;
  readonly deviceName: string;
};

const FIXTURE_BEARER = "f".repeat(43);
const FIXTURE_BROWSER_TAB_ID = `tab_${"1".repeat(24)}`;
const FIXTURE_RESEARCH_BROWSER_TAB_ID = `tab_${"2".repeat(24)}`;
const FIXTURE_BROWSER_JPEG = "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAKABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCkwFRf/9k=";

function errorEnvelope(code: string, message: string) {
  return {
    ok: false,
    error: { code, message, retryable: false, details: null },
  };
}

async function fulfillJson(route: Route, status: number, value: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
}

/**
 * Test-only bridge boundary for the built PWA. It models the same HTTP and
 * WebSocket contracts as the Mac bridge, records every mutation, and never
 * starts Codex, Chrome capture, or Tailscale.
 */
export class MockBridge {
  readonly commands: MockCommand[] = [];
  readonly commandStatusRequests: string[] = [];
  readonly pairRequests: PairRequest[] = [];
  readonly browserControls: Readonly<Record<string, unknown>>[] = [];
  snapshotRequests = 0;
  capabilitiesRequests = 0;
  nativeSessionsRequests = 0;
  sessionsRequests = 0;
  socketConnections = 0;
  commandRequests = 0;
  socketCommandAttempts = 0;
  productStateSaveRequests = 0;
  diagramUpdateRequests = 0;

  private authorized: boolean;
  private bridgeInstanceId = INITIAL_BRIDGE_INSTANCE_ID;
  private sequence: number;
  private selectedIndex: number;
  private activeThreadIdOverride: string | null = null;
  private readonly reviewMaxImages: 0 | 1 | 12;
  private socket: WebSocketRoute | null = null;
  private socketSnapshotsPaused = false;
  private pendingSocketSnapshot = false;
  private disconnectNextCommandResponse = false;
  private ticketCounter = 0;
  private abandonNextCommandResponse = false;
  private nextCommandFailureMessage: string | null = null;
  private failNextProductStateSave = false;
  private approvalPending = true;
  private capabilitiesAvailable = true;
  private pushSubscribed = false;
  private sessionsFixture: ReturnType<typeof fixtureSessions> | null = null;
  private productState = {
    version: 1 as const,
    revision: 1,
    updatedAt: Date.now(),
    homeLayout: {
      version: 1 as const,
      mode: "manual" as const,
      pinnedThreadIds: THREADS.map((thread) => thread.id),
      manual: { sections: [], looseThreadIds: THREADS.map((thread) => thread.id) },
      automaticOrder: ["needs-approval", "error", "working", "waiting", "completed", "idle"],
    },
    preferences: {
      compactControls: false,
      keepAwake: false,
      allSessionsEnabled: true as const,
      theme: "system" as const,
      cardDensity: "rich" as const,
      motion: "system" as const,
      haptics: true,
      notifications: { needsApproval: true, completed: true, error: true, waiting: true },
      defaultHomeMode: "manual" as const,
      modelReasoningPresets: [] as Array<Readonly<Record<string, unknown>>>,
      siteFavorites: [] as Array<Readonly<Record<string, unknown>>>,
    },
  };
  private savedDrawings: Array<Readonly<Record<string, unknown>>> = [];
  private diagrams: Array<Readonly<Record<string, unknown>>> = [];
  private readonly completedCommands = new Map<string, {
    readonly sequence: number;
    readonly targetThreadId: string | null;
  }>();

  constructor(options: {
    readonly authorized?: boolean;
    readonly initialSequence?: number;
    readonly initialSelectedIndex?: number;
    readonly reviewMaxImages?: 0 | 1 | 12;
  } = {}) {
    this.authorized = options.authorized ?? true;
    this.reviewMaxImages = options.reviewMaxImages ?? 12;
    this.sequence = options.initialSequence ?? 73;
    this.selectedIndex = options.initialSelectedIndex ?? 0;
  }

  get currentBridgeInstanceId(): string {
    return this.bridgeInstanceId;
  }

  get pinnedThreadIds(): readonly string[] {
    return this.productState.homeLayout.pinnedThreadIds;
  }

  get modelReasoningPresets(): readonly Readonly<Record<string, unknown>>[] {
    return this.productState.preferences.modelReasoningPresets;
  }

  get siteFavorites(): readonly Readonly<Record<string, unknown>>[] {
    return this.productState.preferences.siteFavorites;
  }

  setSessionsFixture(
    fixture: ReturnType<typeof fixtureSessions>,
    pinnedThreadIdsOverride?: readonly string[],
  ): void {
    this.sessionsFixture = fixture;
    const pinnedThreadIds = pinnedThreadIdsOverride
      ? [...pinnedThreadIdsOverride]
      : fixture.data.sessions
        .filter((session) => session.microSlot !== null)
        .map((session) => session.threadId);
    this.productState = {
      ...this.productState,
      revision: this.productState.revision + 1,
      updatedAt: Date.now(),
      homeLayout: {
        ...this.productState.homeLayout,
        pinnedThreadIds,
        manual: { sections: [], looseThreadIds: pinnedThreadIds },
      },
    };
  }

  setCatalogFixture(fixture: ReturnType<typeof fixtureSessions>): void {
    this.sessionsFixture = fixture;
  }

  makeNextProductStateSaveFail(): void {
    this.failNextProductStateSave = true;
  }

  setExternalModelReasoningPresets(presets: readonly Readonly<Record<string, unknown>>[]): void {
    this.productState = {
      ...this.productState,
      revision: this.productState.revision + 1,
      updatedAt: Date.now(),
      preferences: {
        ...this.productState.preferences,
        modelReasoningPresets: [...presets],
      },
    };
  }

  setDiagrams(diagrams: readonly Readonly<Record<string, unknown>>[]): void {
    this.diagrams = [...diagrams];
  }

  setCapabilitiesAvailable(available: boolean): void {
    this.capabilitiesAvailable = available;
  }

  selectOnMac(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(THREADS.length - 1, Math.trunc(index)));
    this.activeThreadIdOverride = null;
    this.sequence += 1;
    this.pushSnapshot();
  }

  selectOutsideNativeSixOnMac(threadId: string): void {
    this.activeThreadIdOverride = threadId;
    this.sequence += 1;
    this.pushSnapshot();
  }

  async install(page: Page): Promise<void> {
    await page.route("**/api/**", async (route) => this.handleHttp(route));
    await page.routeWebSocket("**/ws", (socket) => {
      this.socketConnections += 1;
      this.socket = socket;
      socket.onMessage((raw) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.type !== "hello" && message.type !== "ping") this.socketCommandAttempts += 1;
        if (message.type === "hello" && this.authorized) this.pushSnapshot();
        if (message.type === "ping" && typeof message.nonce === "string") {
          socket.send(JSON.stringify({ type: "pong", nonce: message.nonce }));
        }
      });
    });
  }

  async restart(sequence: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Fixture restart sequence must be a non-negative safe integer");
    }
    this.bridgeInstanceId = RESTARTED_BRIDGE_INSTANCE_ID;
    this.sequence = sequence;
    await this.disconnect();
  }

  pauseSocketSnapshots(): void {
    this.socketSnapshotsPaused = true;
  }

  releaseSocketSnapshot(): void {
    this.socketSnapshotsPaused = false;
    if (!this.pendingSocketSnapshot || !this.socket) return;
    this.pendingSocketSnapshot = false;
    this.pushSnapshot();
  }

  makeNextCommandDeliveryUnknown(): void {
    this.disconnectNextCommandResponse = true;
  }

  /** Simulates a connection reset before the bridge can durably record the ID. */
  makeNextCommandOutcomeUnresolved(): void {
    this.abandonNextCommandResponse = true;
  }

  failNextCommand(message: string): void {
    this.nextCommandFailureMessage = message;
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.close({ code: 1012, reason: "Fixture bridge restart" });
  }

  private snapshot() {
    return fixtureSnapshot({
      bridgeInstanceId: this.bridgeInstanceId,
      sequence: this.sequence,
      selectedIndex: this.selectedIndex,
      ...(this.activeThreadIdOverride === null ? {} : { activeThreadId: this.activeThreadIdOverride }),
      approvalPending: this.approvalPending,
    });
  }

  private capabilities() {
    const fixture = fixtureCapabilities();
    if (!this.capabilitiesAvailable) {
      return {
        ...fixture,
        data: {
          ...fixture.data,
          commands: fixture.data.commands.filter((command) => (
            command !== "sendSketch" && command !== "sendReview" && command !== "setModelReasoning"
          )),
          reasoningModes: [],
          currentReasoningMode: null,
          currentModel: null,
          models: [],
          drawing: false,
          review: false,
          reviewMaxImages: 0,
        },
      };
    }
    return {
      ...fixture,
      data: {
        ...fixture.data,
        review: this.reviewMaxImages > 0,
        reviewMaxImages: this.reviewMaxImages,
      },
    };
  }

  private sessions() {
    return this.sessionsFixture ?? fixtureSessions({ sequence: this.sequence, selectedIndex: this.selectedIndex });
  }

  private nativeSessions() {
    const response = this.sessions();
    return {
      ...response,
      data: {
        ...response.data,
        registryGeneration: 1,
        sessions: response.data.sessions.filter((session) => session.microSlot !== null),
      },
    };
  }

  private pushSnapshot(): void {
    if (!this.authorized || !this.socket) return;
    if (this.socketSnapshotsPaused) {
      this.pendingSocketSnapshot = true;
      return;
    }
    this.socket.send(JSON.stringify({ type: "snapshot", snapshot: this.snapshot() }));
  }

  private async handleHttp(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/api/pair" && request.method() === "POST") {
      const body = request.postDataJSON() as PairRequest;
      this.pairRequests.push(body);
      this.authorized = true;
      await fulfillJson(route, 201, {
        ok: true,
        data: {
          paired: true,
          device: { id: "019f7ec2-68eb-7183-bb3a-0e67312a8bc0", name: body.deviceName },
          bearerToken: FIXTURE_BEARER,
        },
      });
      return;
    }

    if (!this.authorized || request.headers().authorization !== `Bearer ${FIXTURE_BEARER}`) {
      await fulfillJson(route, 401, errorEnvelope("UNAUTHENTICATED", "Pair this iPad first."));
      return;
    }

    if (url.pathname === "/api/ws-ticket" && request.method() === "POST") {
      this.ticketCounter += 1;
      const ticket = this.ticketCounter.toString(36).padStart(43, "t");
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          ticket,
          protocol: `codex-pad.ticket.${ticket}`,
          expiresAt: Date.now() + 30_000,
        },
      });
      return;
    }

    if (url.pathname === "/api/snapshot" && request.method() === "GET") {
      this.snapshotRequests += 1;
      await fulfillJson(route, 200, { ok: true, data: this.snapshot() });
      return;
    }
    if (url.pathname === "/api/usage" && request.method() === "GET") {
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          available: true,
          stale: false,
          fetchedAt: Date.now(),
          planType: "pro",
          limitName: "Codex",
          primary: { usedPercent: 28, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 },
          secondary: { usedPercent: 62, windowMinutes: 10_080, resetsAt: Date.now() + 4 * 86_400_000 },
          credits: null,
          rateLimitReached: false,
        },
      });
      return;
    }
    if (url.pathname === "/api/product-state" && request.method() === "GET") {
      await fulfillJson(route, 200, { ok: true, data: this.productState });
      return;
    }
    if (url.pathname === "/api/push" && request.method() === "GET") {
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          supported: true,
          subscribed: this.pushSubscribed,
          publicKey: "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        },
      });
      return;
    }
    if (url.pathname === "/api/push/subscription" && request.method() === "PUT") {
      this.pushSubscribed = true;
      await fulfillJson(route, 200, { ok: true, data: { subscribed: true } });
      return;
    }
    if (url.pathname === "/api/push/subscription" && request.method() === "DELETE") {
      this.pushSubscribed = false;
      await fulfillJson(route, 200, { ok: true, data: { subscribed: false } });
      return;
    }
    if (url.pathname === "/api/product-state" && request.method() === "PUT") {
      this.productStateSaveRequests += 1;
      if (this.failNextProductStateSave) {
        this.failNextProductStateSave = false;
        await fulfillJson(route, 503, errorEnvelope("UNAVAILABLE", "Fixture Product State write failed."));
        return;
      }
      const body = request.postDataJSON() as { expectedRevision: number; homeLayout: typeof this.productState.homeLayout; preferences: typeof this.productState.preferences };
      if (body.expectedRevision !== this.productState.revision) {
        await fulfillJson(route, 409, errorEnvelope("CONFLICT", "Product state changed."));
        return;
      }
      this.productState = { version: 1, revision: this.productState.revision + 1, updatedAt: Date.now(), homeLayout: body.homeLayout, preferences: body.preferences };
      await fulfillJson(route, 200, { ok: true, data: this.productState });
      return;
    }
    if (url.pathname === "/api/devices" && request.method() === "GET") {
      await fulfillJson(route, 200, { ok: true, data: { currentDeviceId: "019f7ec2-68eb-7183-bb3a-0e67312a8bc0", devices: [{ id: "019f7ec2-68eb-7183-bb3a-0e67312a8bc0", name: "QA iPad", createdAt: "2026-07-20T10:00:00.000Z", revokedAt: null }] } });
      return;
    }
    if (url.pathname === "/api/saved-drawings" && request.method() === "GET") {
      await fulfillJson(route, 200, { ok: true, data: { drawings: this.savedDrawings.map(({ pngBase64: _png, sceneJson: _scene, ...summary }) => summary) } });
      return;
    }
    if (url.pathname === "/api/saved-drawings" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const drawing = {
        ...body,
        id: crypto.randomUUID(),
        byteLength: Math.max(1, Math.floor(String(body.pngBase64 ?? "").length * .75)),
        createdAt: Date.now(),
        thumbnailBase64: body.pngBase64,
      };
      this.savedDrawings = [drawing, ...this.savedDrawings];
      await fulfillJson(route, 201, { ok: true, data: drawing });
      return;
    }
    if (url.pathname.startsWith("/api/saved-drawings/") && request.method() === "GET") {
      const drawingId = decodeURIComponent(url.pathname.slice("/api/saved-drawings/".length));
      const drawing = this.savedDrawings.find((candidate) => candidate.id === drawingId);
      await fulfillJson(route, drawing ? 200 : 404, drawing ? { ok: true, data: drawing } : errorEnvelope("NOT_FOUND", "Saved drawing not found."));
      return;
    }
    if (url.pathname.startsWith("/api/saved-drawings/") && request.method() === "DELETE") {
      const drawingId = decodeURIComponent(url.pathname.slice("/api/saved-drawings/".length));
      this.savedDrawings = this.savedDrawings.filter((candidate) => candidate.id !== drawingId);
      await fulfillJson(route, 200, { ok: true, data: { deleted: true, drawingId } });
      return;
    }
    if (url.pathname === "/api/diagrams" && request.method() === "GET") {
      const threadId = url.searchParams.get("threadId");
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          diagrams: this.diagrams
            .filter((diagram) => diagram.threadId === threadId)
            .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt)),
        },
      });
      return;
    }
    if (url.pathname.startsWith("/api/diagrams/") && request.method() === "PUT") {
      const diagramId = decodeURIComponent(url.pathname.slice("/api/diagrams/".length));
      const threadId = url.searchParams.get("threadId");
      const current = this.diagrams.find((diagram) => (
        diagram.diagramId === diagramId && diagram.threadId === threadId
      ));
      if (!current) {
        await fulfillJson(route, 404, errorEnvelope("NOT_FOUND", "Diagram not found."));
        return;
      }
      const input = request.postDataJSON() as Readonly<Record<string, unknown>>;
      if (input.expectedRevision !== current.revision) {
        await fulfillJson(route, 409, errorEnvelope("CONFLICT", "Diagram changed."));
        return;
      }
      const { expectedRevision: _expectedRevision, ...editable } = input;
      const next = {
        ...current,
        ...editable,
        revision: Number(current.revision) + 1,
        updatedAt: Date.now(),
        lastEditedBy: "ipad",
      };
      this.diagrams = [
        next,
        ...this.diagrams.filter((diagram) => diagram.diagramId !== diagramId),
      ];
      this.diagramUpdateRequests += 1;
      await fulfillJson(route, 200, { ok: true, data: next });
      return;
    }
    if (url.pathname === "/api/capabilities" && request.method() === "GET") {
      this.capabilitiesRequests += 1;
      await fulfillJson(route, 200, this.capabilities());
      return;
    }
    if (url.pathname === "/api/runtime" && request.method() === "GET") {
      await fulfillJson(route, 200, fixtureRuntimeDiagnostics(this.sequence));
      return;
    }
    if (url.pathname === "/api/context-room" && request.method() === "GET") {
      await fulfillJson(route, 200, fixtureContextRoomStatus());
      return;
    }
    if (url.pathname === "/api/native-sessions" && request.method() === "GET") {
      this.nativeSessionsRequests += 1;
      await fulfillJson(route, 200, this.nativeSessions());
      return;
    }
    if (url.pathname === "/api/sessions" && request.method() === "GET") {
      this.sessionsRequests += 1;
      await fulfillJson(route, 200, this.sessions());
      return;
    }
    if (url.pathname === "/api/browser-tabs" && request.method() === "GET") {
      const threadId = url.searchParams.get("threadId");
      const tabs = threadId === THREADS[0]?.id
        ? [{
            id: FIXTURE_BROWSER_TAB_ID,
            title: "Component lab",
            url: "http://127.0.0.1:8787/",
            controllable: true,
            reason: null,
          }]
        : threadId === THREADS[2]?.id
          ? [{
              id: FIXTURE_RESEARCH_BROWSER_TAB_ID,
              title: "Research preview",
              url: "https://research.example.test/",
              controllable: true,
              reason: null,
            }]
          : [];
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          detail: "Open pages attached to this Codex task. Choose one to browse and annotate.",
          tabs,
        },
      });
      return;
    }
    if (url.pathname === `/api/browser-tabs/${FIXTURE_BROWSER_TAB_ID}/frame` && request.method() === "GET") {
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          tabId: FIXTURE_BROWSER_TAB_ID,
          title: "Component lab",
          url: "http://127.0.0.1:8787/",
          imageBase64: FIXTURE_BROWSER_JPEG,
          mimeType: "image/jpeg",
          width: 1_180,
          height: 760,
          deviceScaleFactor: 1,
          scrollX: 0,
          scrollY: 0,
          capturedAt: Date.now(),
        },
      });
      return;
    }
    if (url.pathname === `/api/browser-tabs/${FIXTURE_BROWSER_TAB_ID}/control` && request.method() === "POST") {
      this.browserControls.push(request.postDataJSON() as Readonly<Record<string, unknown>>);
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          tabId: FIXTURE_BROWSER_TAB_ID,
          title: "Component lab",
          url: "http://127.0.0.1:8787/",
          imageBase64: FIXTURE_BROWSER_JPEG,
          mimeType: "image/jpeg",
          width: 1_180,
          height: 760,
          deviceScaleFactor: 1,
          scrollX: 0,
          scrollY: 120,
          capturedAt: Date.now(),
        },
      });
      return;
    }
    if (url.pathname === `/api/browser-tabs/${FIXTURE_BROWSER_TAB_ID}/recorded-control` && request.method() === "POST") {
      const action = request.postDataJSON() as Readonly<Record<string, unknown>>;
      this.browserControls.push({ ...action, recorded: true });
      const safeAction = action.type === "insertText" || action.type === "navigate" ? { type: action.type } : action;
      const recordedAt = Date.now();
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          frame: {
            tabId: FIXTURE_BROWSER_TAB_ID,
            title: "Component lab",
            url: "http://127.0.0.1:8787/",
            imageBase64: FIXTURE_BROWSER_JPEG,
            mimeType: "image/jpeg",
            width: 1_180,
            height: 760,
            deviceScaleFactor: 1,
            scrollX: 0,
            scrollY: action.type === "scroll" ? 120 : 0,
            capturedAt: recordedAt,
          },
          receipt: {
            receiptId: crypto.randomUUID(),
            threadId: THREADS[0]!.id,
            tabId: FIXTURE_BROWSER_TAB_ID,
            action: safeAction,
            target: null,
            input: action.type === "insertText" ? { mode: "literal", value: String(action.text ?? "") } : { mode: "none" },
            beforeUrl: "http://127.0.0.1:8787/",
            afterUrl: "http://127.0.0.1:8787/",
            beforeScroll: { x: 0, y: 0 },
            afterScroll: { x: 0, y: action.type === "scroll" ? 120 : 0 },
            outcome: "applied",
            confidence: "coordinate-only",
            recordedAt,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/command" && request.method() === "POST") {
      this.commandRequests += 1;
      const body = request.postDataJSON() as { readonly command?: MockCommand };
      if (!body.command) {
        await fulfillJson(route, 400, errorEnvelope("INVALID_REQUEST", "Missing command."));
        return;
      }
      if (
        body.command.expectedBridgeInstanceId !== this.bridgeInstanceId
        || body.command.expectedSequence !== this.sequence
      ) {
        await fulfillJson(route, 409, errorEnvelope("STALE_SNAPSHOT", "Command snapshot identity is stale."));
        return;
      }
      this.commands.push(body.command);
      if (this.nextCommandFailureMessage !== null) {
        const message = this.nextCommandFailureMessage;
        this.nextCommandFailureMessage = null;
        await fulfillJson(route, 409, errorEnvelope("APP_SERVER_UNAVAILABLE", message));
        return;
      }
      if (body.command.type === "selectAgent" && typeof body.command.slot === "number") {
        this.selectedIndex = Math.max(0, Math.min(THREADS.length - 1, Math.trunc(body.command.slot)));
        this.sequence += 1;
      }
      if (body.command.type === "openSession" && typeof body.command.targetThreadId === "string") {
        const targetIndex = THREADS.findIndex((thread) => thread.id === body.command.targetThreadId);
        if (targetIndex >= 0) {
          this.selectedIndex = targetIndex;
        }
        this.activeThreadIdOverride = body.command.targetThreadId;
        this.sequence += 1;
      }
      if (body.command.type === "respondToApproval") {
        this.approvalPending = false;
        this.sequence += 1;
      }
      const targetThreadId = typeof body.command.expectedThreadId === "string"
        ? body.command.expectedThreadId
        : null;
      if (this.abandonNextCommandResponse) {
        this.abandonNextCommandResponse = false;
        await route.abort("connectionreset");
        return;
      }
      this.completedCommands.set(body.command.commandId, {
        sequence: this.sequence,
        targetThreadId,
      });
      if (this.disconnectNextCommandResponse) {
        this.disconnectNextCommandResponse = false;
        this.pushSnapshot();
        await route.abort("connectionreset");
        return;
      }
      await fulfillJson(route, 200, {
        ok: true,
        data: {
          commandId: body.command.commandId,
          disposition: "accepted",
          status: "succeeded",
          sequence: this.sequence,
          targetThreadId,
          error: null,
        },
      });
      this.pushSnapshot();
      return;
    }
    if (url.pathname.startsWith("/api/commands/") && request.method() === "GET") {
      const commandId = decodeURIComponent(url.pathname.slice("/api/commands/".length));
      this.commandStatusRequests.push(commandId);
      const completed = this.completedCommands.get(commandId);
      await fulfillJson(route, 200, {
        ok: true,
        data: completed ? {
          commandId,
          status: "succeeded",
          sequence: completed.sequence,
          targetThreadId: completed.targetThreadId,
          result: {
            sequence: completed.sequence,
            targetThreadId: completed.targetThreadId,
            message: "Fixture command completed",
          },
          error: null,
          updatedAt: Date.now(),
        } : {
          commandId,
          status: "unknown",
          sequence: this.sequence,
          targetThreadId: null,
          result: null,
          error: null,
          updatedAt: Date.now(),
        },
      });
      return;
    }

    await fulfillJson(route, 404, errorEnvelope("NOT_FOUND", "Unknown fixture route."));
  }
}

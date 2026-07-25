import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import {
  INITIAL_BRIDGE_INSTANCE_ID,
  RESTARTED_BRIDGE_INSTANCE_ID,
  fixtureSessions,
  fixtureSnapshot,
} from "../../e2e/fixture-data";
import { BridgeClient, commandStatusResult } from "./bridge-client";
import { loadBridgeBearer, saveBridgeBearer } from "./auth-store";

class ControlledWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: ControlledWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = ControlledWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<{
    readonly callback: EventListener;
    readonly once: boolean;
  }>>();

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    ControlledWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const callback: EventListener = typeof listener === "function"
      ? listener
      : (event) => listener.handleEvent(event);
    const records = this.listeners.get(type) ?? [];
    records.push({ callback, once: typeof options === "object" && options.once === true });
    this.listeners.set(type, records);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(String(data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === ControlledWebSocket.CLOSED) return;
    this.readyState = ControlledWebSocket.CLOSED;
    this.emit("close", new CloseEvent("close", { code, reason }));
  }

  open(): void {
    this.readyState = ControlledWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  receive(value: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  private emit(type: string, event: Event): void {
    const records = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(type, records.filter((record) => !record.once));
    for (const record of records) record.callback(event);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  ControlledWebSocket.instances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BridgeClient site capture", () => {
  it("preserves an opaque project-scoped site association from the session API", async () => {
    await saveBridgeBearer("p".repeat(43));
    const sessions = fixtureSessions({
      bridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
      sequence: 7,
      selectedIndex: 0,
    });
    const first = sessions.data.sessions[0]!;
    const projectSite = {
      associationId: "project_preview",
      threadId: first.threadId,
      projectId: first.projectId,
      name: "Registered project site",
      origin: "https://preview.example-tail.ts.net:5173",
      createdAt: 1_750_000_000_000,
      updatedAt: 1_750_000_000_001,
      capabilities: {
        state: "unavailable" as const,
        canCaptureFrames: false,
        canSendReview: false,
        supportsInlinePng: true,
        supportsUploadRefs: false,
        maxFrames: 12,
        maxFrameBytes: 8 * 1024 * 1024,
        maxTotalBytes: 24 * 1024 * 1024,
        reason: "Capture unavailable",
      },
      interactionModes: {
        selected: "none" as const,
        direct: {
          status: "unavailable" as const,
          reason: "same-host-storage-boundary" as const,
          detail: "Live preview requires a separately verified browser storage boundary.",
        },
        remoteBrowser: {
          status: "unavailable" as const,
          reason: "thread-tab-mapping-unproven" as const,
          detail: "Exact task-to-tab mapping has not been proven.",
          association: {
            status: "unavailable" as const,
            reason: "thread-tab-mapping-unproven" as const,
            detail: "Exact task-to-tab mapping has not been proven.",
          },
        },
      },
    };
    const payload = {
      ...sessions,
      data: {
        ...sessions.data,
        sessions: sessions.data.sessions.map((session, index) => index === 0
          ? { ...session, siteAssociations: [projectSite], siteAssociation: projectSite }
          : { ...session, siteAssociations: [] }),
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection: vi.fn(),
      onUnauthorized: vi.fn(),
    });

    const listed = await client.fetchSessions();
    expect(listed?.[0]?.siteAssociation).toMatchObject({
      threadId: first.threadId,
      projectId: first.projectId,
      name: "Registered project site",
    });
    expect(listed?.[0]?.siteAssociations).toEqual([listed?.[0]?.siteAssociation]);
    expect(JSON.stringify(listed)).not.toContain("/workspace/");
  });

  it("parses the bounded native-session envelope with its registry generation", async () => {
    await saveBridgeBearer("n".repeat(43));
    const sessions = fixtureSessions({ sequence: 8, selectedIndex: 0 });
    const payload = {
      ...sessions,
      data: {
        ...sessions.data,
        registryGeneration: 4,
        sessions: sessions.data.sessions
          .filter((session) => session.microSlot !== null)
          .map((session) => ({ ...session, siteAssociations: [] })),
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection: vi.fn(),
      onUnauthorized: vi.fn(),
    });

    const listed = await client.fetchNativeSessions();
    expect(listed?.registryGeneration).toBe(4);
    expect(listed?.sessions).toHaveLength(6);
    expect(listed?.sessions.every((session) => session.microSlot !== null)).toBe(true);
  });

  it("rejects a capture response for a different registered site", async () => {
    await saveBridgeBearer("a".repeat(43));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${"a".repeat(43)}`);
      return new Response(JSON.stringify({
      ok: true,
      data: {
        siteId: "different-site",
        title: "Wrong site",
        finalPath: "/dashboard",
        viewport: "ipad-landscape",
        scroll: { x: 0, y: 0 },
        redirectCount: 0,
        pngBase64: "iVBORw0KGgo=",
        width: 1_366,
        height: 1_024,
      },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection: vi.fn(),
      onUnauthorized: vi.fn(),
    });

    await expect(client.captureSite({
      siteId: "approved-site",
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      path: "/dashboard",
      viewport: "ipad-landscape",
      scroll: { x: 0, y: 0 },
    })).rejects.toThrow("invalid site capture");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears the origin-scoped bearer after a bridge 401", async () => {
    await saveBridgeBearer("b".repeat(43));
    const unauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "revoked", retryable: false, details: null },
    }), { status: 401, headers: { "Content-Type": "application/json" } })));
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection: vi.fn(),
      onUnauthorized: unauthorized,
    });
    await expect(client.refreshSnapshot()).resolves.toBe(false);
    await expect.poll(() => loadBridgeBearer()).toBeNull();
    expect(unauthorized).toHaveBeenCalled();
  });
});

describe("BridgeClient command reconciliation", () => {
  it("sends no mutation before socket attestation, then includes the pre-body admission header", async () => {
    const bearerToken = "h".repeat(43);
    const ticket = "i".repeat(43);
    const commandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb2";
    const snapshot = fixtureSnapshot({
      bridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
      sequence: 1,
      selectedIndex: 0,
    });
    await saveBridgeBearer(bearerToken);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "/api/snapshot") return Response.json({ ok: true, data: snapshot });
      if (String(input) === "/api/ws-ticket") {
        return Response.json({
          ok: true,
          data: { ticket, protocol: `codex-pad.ticket.${ticket}`, expiresAt: 1 },
        });
      }
      return Response.json({
        ok: false,
        error: { code: "RATE_LIMITED", message: "busy", retryable: true, details: null },
      }, { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const onConnection = vi.fn();
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection,
      onUnauthorized: vi.fn(),
    });
    await expect(client.start()).resolves.toBe(true);
    await vi.waitFor(() => expect(ControlledWebSocket.instances).toHaveLength(1));
    const socket = ControlledWebSocket.instances[0]!;
    socket.open();

    const command = {
      type: "selectAgent",
      commandId,
      expectedBridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
      expectedSequence: 1,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      slot: 0,
    } as const;
    await expect(client.command(command)).resolves.toMatchObject({ ok: false, pending: false });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/command")).toHaveLength(0);
    expect(onConnection).not.toHaveBeenCalledWith(true);

    socket.receive({ type: "snapshot", snapshot });
    expect(onConnection).toHaveBeenLastCalledWith(true);
    await client.command(command);

    const commandCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/command");
    const init = commandCall?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${bearerToken}`);
    expect(headers.get("X-Codex-Pad-Command-Id")).toBe(commandId);
    client.stop();
  });

  it("never switches back when delayed HTTP and superseded-socket snapshots carry the old generation", async () => {
    const bearerToken = "j".repeat(43);
    const ticket = "k".repeat(43);
    let serverSnapshot = fixtureSnapshot({
      bridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
      sequence: 2,
      selectedIndex: 0,
    });
    let snapshotRequestCount = 0;
    let resolveDelayedSnapshot: ((response: Response) => void) | undefined;
    const delayedSnapshot = new Promise<Response>((resolve) => { resolveDelayedSnapshot = resolve; });
    await saveBridgeBearer(bearerToken);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/snapshot") {
        snapshotRequestCount += 1;
        if (snapshotRequestCount === 2) return delayedSnapshot;
        return Response.json({ ok: true, data: serverSnapshot });
      }
      if (String(input) === "/api/ws-ticket") {
        return Response.json({
          ok: true,
          data: { ticket, protocol: `codex-pad.ticket.${ticket}`, expiresAt: 1 },
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const snapshots: string[] = [];
    const onConnection = vi.fn();
    const client = new BridgeClient({
      onSnapshot: (snapshot) => snapshots.push(snapshot.bridgeInstanceId),
      onConnection,
      onUnauthorized: vi.fn(),
    });

    await expect(client.start()).resolves.toBe(true);
    await vi.waitFor(() => expect(ControlledWebSocket.instances).toHaveLength(1));
    const oldSocket = ControlledWebSocket.instances[0]!;
    oldSocket.open();
    oldSocket.receive({ type: "snapshot", snapshot: serverSnapshot });
    expect(onConnection).toHaveBeenLastCalledWith(true);

    const delayedOldHttp = client.refreshSnapshot();
    await vi.waitFor(() => expect(snapshotRequestCount).toBe(2));
    client.setVisible(false);
    serverSnapshot = fixtureSnapshot({
      bridgeInstanceId: RESTARTED_BRIDGE_INSTANCE_ID,
      sequence: 2,
      selectedIndex: 0,
    });
    client.setVisible(true);
    await vi.waitFor(() => expect(snapshots).toContain(RESTARTED_BRIDGE_INSTANCE_ID));
    await vi.waitFor(() => expect(ControlledWebSocket.instances).toHaveLength(2));
    const currentSocket = ControlledWebSocket.instances[1]!;
    currentSocket.open();
    expect(onConnection).toHaveBeenLastCalledWith(false);
    currentSocket.receive({ type: "snapshot", snapshot: serverSnapshot });
    expect(onConnection).toHaveBeenLastCalledWith(true);

    await expect(client.command({
      type: "createTask",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb3",
      expectedBridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
      expectedSequence: 2,
      expectedThreadId: null,
      instruction: null,
    })).resolves.toMatchObject({ ok: false, pending: false });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/command")).toHaveLength(0);

    const snapshotCount = snapshots.length;
    resolveDelayedSnapshot?.(Response.json({
      ok: true,
      data: fixtureSnapshot({
        bridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
        sequence: 99,
        selectedIndex: 0,
      }),
    }));
    await expect(delayedOldHttp).resolves.toBe(false);
    oldSocket.receive({
      type: "snapshot",
      snapshot: fixtureSnapshot({
        bridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
        sequence: 99,
        selectedIndex: 0,
      }),
    });
    serverSnapshot = fixtureSnapshot({
      bridgeInstanceId: INITIAL_BRIDGE_INSTANCE_ID,
      sequence: 99,
      selectedIndex: 0,
    });
    await expect(client.refreshSnapshot()).resolves.toBe(false);

    expect(snapshots).toHaveLength(snapshotCount);
    expect(snapshots.at(-1)).toBe(RESTARTED_BRIDGE_INSTANCE_ID);
    expect(onConnection).toHaveBeenLastCalledWith(true);
    client.stop();
  });

  it("keeps a bridge-unknown command unresolved instead of treating it as a rejection", () => {
    const result = commandStatusResult({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb1",
      status: "unknown",
      sequence: 73,
      targetThreadId: null,
      result: null,
      error: null,
      updatedAt: Date.now(),
    });

    expect(result).toMatchObject({
      state: "unknown",
      ack: { ok: false, pending: true },
    });
  });
});

describe("BridgeClient bearer authentication", () => {
  it("persists the pairing bearer and attaches it only as an Authorization header", async () => {
    const bearerToken = "c".repeat(43);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/pair") {
        return Response.json({
          ok: true,
          data: {
            paired: true,
            device: { id: "019f7ec2-68eb-7183-bb3a-0e67312a8bc0", name: "iPad" },
            bearerToken,
          },
        }, { status: 201 });
      }
      return Response.json({ ok: true, data: { commands: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection: vi.fn(),
      onUnauthorized: vi.fn(),
    });

    await expect(client.pair("pairing-nonce", "Test iPad")).resolves.toMatchObject({ ok: true });
    await expect(loadBridgeBearer()).resolves.toBe(bearerToken);
    await client.fetchCapabilities();

    const pairInit = fetchMock.mock.calls[0]?.[1];
    expect(pairInit?.credentials).toBe("omit");
    expect(new Headers(pairInit?.headers).get("Authorization")).toBeNull();
    const authenticatedInit = fetchMock.mock.calls[1]?.[1];
    expect(authenticatedInit?.credentials).toBe("omit");
    expect(new Headers(authenticatedInit?.headers).get("Authorization")).toBe(`Bearer ${bearerToken}`);
  });

  it("mints a ticket before WebSocket construction and offers base plus ticket protocols", async () => {
    const bearerToken = "d".repeat(43);
    const ticket = "e".repeat(43);
    await saveBridgeBearer(bearerToken);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, _init) => {
      if (String(input) === "/api/ws-ticket") {
        return Response.json({
          ok: true,
          // The bridge enforces expiry; the client must tolerate Mac/iPad
          // clock skew while still validating the typed ticket envelope.
          data: { ticket, protocol: `codex-pad.ticket.${ticket}`, expiresAt: 1 },
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly instances: FakeWebSocket[] = [];
      readonly readyState = 0;
      constructor(
        readonly url: string | URL,
        readonly protocols?: string | string[],
      ) {
        FakeWebSocket.instances.push(this);
      }
      addEventListener(): void {}
      close(): void {}
      send(): void {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection: vi.fn(),
      onUnauthorized: vi.fn(),
    });

    await expect(client.start()).resolves.toBe(true);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.instances[0]?.protocols).toEqual([
      "codex-pad.v1",
      `codex-pad.ticket.${ticket}`,
    ]);
    expect(String(FakeWebSocket.instances[0]?.url)).toMatch(/\/ws$/u);
    for (const [input, init] of fetchMock.mock.calls) {
      if (String(input) === "/api/snapshot" || String(input) === "/api/ws-ticket") {
        expect(init?.credentials).toBe("omit");
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${bearerToken}`);
      }
    }
    client.stop();
  });

  it("keeps a newly paired bearer when an old authenticated request rejects late", async () => {
    const rejectedBearer = "f".repeat(43);
    const replacementBearer = "g".repeat(43);
    await saveBridgeBearer(rejectedBearer);
    let resolveLateSnapshot: ((response: Response) => void) | undefined;
    const lateSnapshot = new Promise<Response>((resolve) => { resolveLateSnapshot = resolve; });
    const unauthorized = vi.fn();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
      const path = String(input);
      if (path === "/api/capabilities") {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${rejectedBearer}`);
        return Response.json({ ok: true, data: { commands: [] } });
      }
      if (path === "/api/snapshot") {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${rejectedBearer}`);
        return lateSnapshot;
      }
      if (path === "/api/pair") {
        return Response.json({
          ok: true,
          data: {
            paired: true,
            device: { id: "019f7ec2-68eb-7183-bb3a-0e67312a8bc1", name: "Replacement iPad" },
            bearerToken: replacementBearer,
          },
        }, { status: 201 });
      }
      return Response.json({ ok: false }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BridgeClient({
      onSnapshot: vi.fn(),
      onConnection: vi.fn(),
      onUnauthorized: unauthorized,
    });

    await expect(client.fetchCapabilities()).resolves.toEqual({ ok: true, data: { commands: [] } });
    const staleRequest = client.refreshSnapshot();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(client.pair("replacement-nonce", "Replacement iPad")).resolves.toMatchObject({ ok: true });
    resolveLateSnapshot?.(Response.json({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "revoked", retryable: false, details: null },
    }, { status: 401 }));

    await expect(staleRequest).resolves.toBe(false);
    await expect(loadBridgeBearer()).resolves.toBe(replacementBearer);
    expect(unauthorized).not.toHaveBeenCalled();
  });
});

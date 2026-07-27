import { connect as connectTcp, createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexDesktopAdapterError,
  type AdapterState,
  type CodexDesktopAdapter,
  type DesktopProcessIdentity,
  type SemanticCommand,
} from "@codex-pad/codex-desktop";
import { createApiFailureEnvelopeSchema } from "@codex-pad/protocol";
import { CredentialStore, WEB_SOCKET_PROTOCOL } from "../src/auth.js";
import { PairingStore, pairingNonceFromUrl } from "../src/pairing.js";
import { defaultDataPaths } from "../src/paths.js";
import { startBridge, WebSocketAdmissionGate, type BridgeHandle } from "../src/server.js";
import {
  ThreadTransportError,
  type NativeMutationAuthorityToken,
  type ThreadTransport,
} from "../src/thread-transport.js";
import { addSite, removeSite } from "../src/site-registry.js";
import type { SiteCaptureService } from "../src/site-capture.js";
import { AppServerClientError } from "../src/app-server-client.js";
import { projectCwdIdentifier } from "@codex-pad/site-review";
import { DOCTOR_WSS_SUBPROTOCOL } from "../src/wss-probe.js";
import { BridgeLifetimeLeaseError } from "../src/lifetime-lease.js";
import { listUnresolvedCommands } from "../src/idempotency.js";
import type { BrowserTabRuntime } from "../src/browser-tab-runtime.js";
import { PushSubscriptionStore } from "../src/push-notifications.js";
import { DiagramStore } from "../src/diagram-store.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const temporaryRoots: string[] = [];
const handles: BridgeHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function rawHeaderOnlyRequest(port: number, lines: readonly string[]): Promise<string> {
  const socket = connectTcp(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  return new Promise<string>((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Bridge waited for a request body before applying pre-body admission"));
    }, 2_000);
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (!received.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(received);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write([...lines, "", ""].join("\r\n"));
  });
}

function adapterState(): AdapterState {
  const slots = [0, 1, 2, 3, 4, 5].map((index) => ({
    index,
    key: `AG0${index}`,
    threadId: index === 0 ? THREAD_ID : null,
    title: index === 0 ? "Bridge test" : null,
    status: index === 0 ? "idle" : "off",
    nativeStatus: index === 0 ? "idle" : "off",
    selected: index === 0,
    activityAt: null,
    activityLabel: index === 0 ? "Dictated prompt: publish the private draft" : null,
  })) as unknown as NonNullable<AdapterState["snapshot"]>["slots"];
  return {
    stale: false,
    health: { status: "ready", reasons: [], changedAt: 1 },
    snapshot: {
      slots,
      activeThreadId: THREAD_ID,
      agentSource: "pinned",
      actionLayout: ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"].map((slot, index) => ({
        slot,
        keycapId: index === 0 ? "FAST" : `KEY${index}`,
        commandId: `command-${index}`,
      })) as unknown as NonNullable<NonNullable<AdapterState["snapshot"]>["actionLayout"]>,
      joystickLayout: {
        up: { direction: "up", type: "command", commandId: "plan" },
        right: { direction: "right", type: "command", commandId: "forward" },
        down: { direction: "down", type: "command", commandId: "sidebar" },
        left: { direction: "left", type: "command", commandId: "back" },
      },
      reasoning: { effort: "high", adjustable: true },
      theme: "dark",
      capabilities: {
        activeThread: true,
        activity: true,
        agentSource: true,
        composerAttachment: true,
        actionLayout: true,
        actionControl: true,
        joystickLayout: true,
        joystickControl: true,
        reasoning: true,
        reasoningControl: true,
        theme: true,
      },
      observedAt: 1,
    },
  };
}

function mocks() {
  const state = adapterState();
  const desktopIdentity: DesktopProcessIdentity = {
    pid: 42,
    startedAt: "2026-07-20T00:00:00.000Z",
    appPath: "/Applications/Codex.app",
    executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
    bundleId: "com.openai.codex",
  };
  const nativePermits = new WeakSet<object>();
  const execute = vi.fn(async (_command: SemanticCommand) => state);
  const attachImageToComposer = vi.fn(async () => state);
  const adapter = {
    refresh: vi.fn(async () => state),
    snapshot: vi.fn(() => state),
    execute,
    attachImageToComposer,
    close: vi.fn(),
  } as unknown as CodexDesktopAdapter;
  const threadSnapshot = {
    threadId: THREAD_ID,
    status: "idle" as const,
    activeTurnId: null,
    cwd: "/workspace/secret/acme",
    refreshedAt: new Date().toISOString(),
    raw: {},
  };
  const transport: ThreadTransport = {
    acquireNativeMutationAuthority: vi.fn(async (guard) => {
      await guard?.(desktopIdentity);
      const authority = Object.freeze({});
      nativePermits.add(authority);
      return { authority: authority as NativeMutationAuthorityToken, desktopIdentity };
    }),
    consumeNativeMutationAuthority: vi.fn((authority) => {
      if (!nativePermits.delete(authority as object)) throw new Error("stale test native permit");
    }),
    health: vi.fn(async () => ({
      mode: "injected-test-transport" as const,
      connected: true,
      initialized: true,
      selectedThreadId: THREAD_ID,
      localImageSteerVerified: true,
      multiImageInputVerified: true,
      desktopOwnershipVerified: true,
      serverUserAgent: "test",
      queuedSketches: 0,
    })),
    selectThread: vi.fn(async () => threadSnapshot),
    clearSelectedThread: vi.fn(),
    threadRead: vi.fn(async () => threadSnapshot),
    resumeThread: vi.fn(async () => threadSnapshot),
    listSessions: vi.fn(async () => [{ threadId: THREAD_ID, title: "Bridge test", cwd: "/workspace/secret/acme", updatedAt: 1, status: "idle" as const }]),
    sendSketch: vi.fn(),
    sendReview: vi.fn(),
    runLibraryCommand: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    newThread: vi.fn(async () => threadSnapshot),
    forkThread: vi.fn(async () => threadSnapshot),
    setReasoning: vi.fn(),
    setModelReasoning: vi.fn(),
    listModels: vi.fn(async () => [{
      model: "gpt-test",
      displayName: "GPT Test",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      isDefault: true,
    }]),
    readCodexUsage: vi.fn(async () => ({
      fetchedAt: 1_750_000_000_000,
      planType: "pro",
      limitName: "Codex",
      primary: { usedPercent: 23, windowMinutes: 300, resetsAt: 1_750_003_600_000 },
      secondary: { usedPercent: 51, windowMinutes: 10_080, resetsAt: 1_750_604_800_000 },
      credits: null,
      rateLimitReached: false,
    })),
    listSkills: vi.fn(async () => []),
    invokeSkill: vi.fn(),
    listPendingApprovals: vi.fn(() => []),
    approve: vi.fn(),
    reject: vi.fn(),
  };
  return { adapter, execute, attachImageToComposer, transport };
}

async function setup(
  siteCaptureService: SiteCaptureService | null = null,
  maxWebSocketConnections?: number,
  webRoot?: string,
  browserTabRuntime?: BrowserTabRuntime,
) {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-server-test-"));
  temporaryRoots.push(root);
  const paths = defaultDataPaths(root);
  const pairing = new PairingStore({ paths });
  const info = await pairing.rotate({ publicOrigin: "https://pad.example.test" });
  const nonce = pairingNonceFromUrl(info.qrPayload) ?? "";
  const site = await addSite({
    targetKind: "thread",
    targetId: THREAD_ID,
    loopbackUrl: "http://127.0.0.1:5173",
    publicOrigin: "https://mac.example.ts.net:5173",
    name: "Preview",
  }, { paths, publicBridgeOrigin: "https://mac.example.ts.net" });
  const port = await freePort();
  const { adapter, execute, attachImageToComposer, transport } = mocks();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const handle = await startBridge({
    port,
    paths,
    publicOrigin: "https://pad.example.test",
    adapter,
    transport,
    codexVersion: "codex-cli 0.145.0-test",
    openExactThread: vi.fn(async () => undefined),
    refreshIntervalMs: 60_000,
    heartbeatIntervalMs: 30,
    ...(maxWebSocketConnections === undefined ? {} : { maxWebSocketConnections }),
    ...(webRoot === undefined ? {} : { webRoot }),
    siteCaptureService,
    ...(browserTabRuntime === undefined ? {} : { browserTabRuntime }),
    openBrowserTabs: async (_threadId) => ({
      tabs: [],
      detail: "Open Mac tabs are unavailable in the injected bridge fixture.",
      capabilities: {
        discovery: { available: true, reason: null },
        open: { available: true, reason: null },
        control: { available: true, reason: null },
      },
    }),
    logger,
  });
  handles.push(handle);
  await handle.state.refresh();
  const pair = await handle.app.inject({
    method: "POST",
    url: "/api/pair",
    headers: { host: "pad.example.test", origin: "https://pad.example.test", "user-agent": "Safari" },
    payload: { nonce, deviceName: "Test iPad" },
  });
  expect(pair.statusCode).toBe(201);
  const paired = pair.json() as { data: { device: { id: string }; bearerToken: string } };
  const legacyCookieClears = Array.isArray(pair.headers["set-cookie"])
    ? pair.headers["set-cookie"].join("\n")
    : String(pair.headers["set-cookie"] ?? "");
  expect(legacyCookieClears).toContain("Max-Age=0");
  expect(legacyCookieClears).not.toContain(paired.data.bearerToken);
  const authorization = `Bearer ${paired.data.bearerToken}`;
  return { handle, paths, authorization, deviceId: paired.data.device.id, port, execute, attachImageToComposer, transport, site, logger };
}

describe("WebSocketAdmissionGate", () => {
  it("atomically counts pending doctor and ticket handshakes until explicit release", async () => {
    const gate = new WebSocketAdmissionGate(3);
    const doctor = { kind: "doctor" };
    const owners = Array.from({ length: 100 }, (_, index) => ({ kind: "ticket", index }));
    expect(gate.tryReserve(doctor)).toBe(true);
    const admitted = await Promise.all(owners.map(async (owner) => gate.tryReserve(owner)));
    expect(admitted.filter(Boolean)).toHaveLength(2);
    expect(gate.count).toBe(3);
    expect(gate.tryReserve(doctor)).toBe(false);

    gate.release(doctor);
    expect(gate.count).toBe(2);
    expect(gate.tryReserve(owners.at(-1)!)).toBe(true);
    expect(gate.count).toBe(3);
    gate.release(doctor);
    expect(gate.count).toBe(3);
  });
});

describe("bridge routes", () => {
  it("registers and removes a private Web Push subscription only for the authenticated paired device", async () => {
    const { handle, paths, authorization, deviceId } = await setup();
    const authenticated = { host: "pad.example.test", authorization };
    const mutationHeaders = { ...authenticated, origin: "https://pad.example.test" };
    const pushSubscription = {
      endpoint: "https://web.push.apple.com/Qserver-test",
      expirationTime: null,
      keys: {
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"),
        auth: Buffer.alloc(16, 2).toString("base64url"),
      },
    };

    const unauthenticated = await handle.app.inject({ method: "GET", url: "/api/push", headers: { host: "pad.example.test" } });
    expect(unauthenticated.statusCode).toBe(401);

    const initial = await handle.app.inject({ method: "GET", url: "/api/push", headers: authenticated });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toMatchObject({ supported: true, subscribed: false });
    expect(Buffer.from(initial.json().data.publicKey, "base64url")).toHaveLength(65);
    expect(initial.body).not.toContain("privateKey");

    const missingOrigin = await handle.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers: authenticated,
      payload: pushSubscription,
    });
    expect(missingOrigin.statusCode).toBe(403);

    const registered = await handle.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers: mutationHeaders,
      payload: pushSubscription,
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json().data).toEqual({ subscribed: true });
    expect((await handle.app.inject({ method: "GET", url: "/api/push", headers: authenticated })).json().data.subscribed).toBe(true);

    await expect(handle.revokeDevice(deviceId)).resolves.toBe(true);
    await vi.waitFor(async () => {
      expect(await new PushSubscriptionStore({ paths }).hasDevice(deviceId)).toBe(false);
    });
  });

  it("rejects an untrusted push-service endpoint and supports explicit opt-out", async () => {
    const { handle, authorization } = await setup();
    const headers = { host: "pad.example.test", origin: "https://pad.example.test", authorization };
    const keys = {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"),
      auth: Buffer.alloc(16, 2).toString("base64url"),
    };
    const rejected = await handle.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers,
      payload: { endpoint: "https://private.example.test/push", expirationTime: null, keys },
    });
    expect(rejected.statusCode).toBe(400);

    const registered = await handle.app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers,
      payload: { endpoint: "https://web.push.apple.com/Qopt-out", expirationTime: null, keys },
    });
    expect(registered.statusCode).toBe(200);
    const removed = await handle.app.inject({ method: "DELETE", url: "/api/push/subscription", headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ subscribed: false });
  });

  it("returns authenticated Codex usage and keeps the last good reading during a transient failure", async () => {
    const { handle, authorization, transport } = await setup();
    const headers = { host: "pad.example.test", authorization };

    const unauthenticated = await handle.app.inject({ method: "GET", url: "/api/usage", headers: { host: "pad.example.test" } });
    expect(unauthenticated.statusCode).toBe(401);

    const live = await handle.app.inject({ method: "GET", url: "/api/usage", headers });
    expect(live.statusCode).toBe(200);
    expect(live.json().data).toMatchObject({
      available: true,
      stale: false,
      planType: "pro",
      primary: { usedPercent: 23, windowMinutes: 300 },
      secondary: { usedPercent: 51, windowMinutes: 10_080 },
    });

    vi.mocked(transport.readCodexUsage!).mockRejectedValueOnce(new ThreadTransportError(
      "APP_SERVER_UNAVAILABLE",
      "temporary private transport failure",
    ));
    const stale = await handle.app.inject({ method: "GET", url: "/api/usage", headers });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().data).toMatchObject({
      available: true,
      stale: true,
      primary: { usedPercent: 23 },
    });
    expect(stale.body).not.toContain("temporary private transport failure");
  });

  it("lists and manages multiple exact-context sites without exposing Mac loopback origins", async () => {
    const { handle, authorization, site } = await setup();
    const headers = { host: "pad.example.test", authorization };
    const listed = await handle.app.inject({
      method: "GET",
      url: `/api/sites?threadId=${THREAD_ID}`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.sites).toMatchObject([{
      siteId: site.associationId,
      name: "Preview",
      scope: "thread",
      publicOrigin: "https://mac.example.ts.net:5173",
      association: { associationId: site.associationId, threadId: THREAD_ID },
    }]);
    expect(listed.body).not.toContain("127.0.0.1");

    const missingOrigin = await handle.app.inject({
      method: "POST",
      url: "/api/sites",
      headers,
      payload: { threadId: THREAD_ID, name: "Docs", url: "http://127.0.0.1:3000", scope: "thread" },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const created = await handle.app.inject({
      method: "POST",
      url: "/api/sites",
      headers: { ...headers, origin: "https://pad.example.test" },
      payload: { threadId: THREAD_ID, name: "Docs", url: "http://127.0.0.1:3000/docs?private=1", scope: "thread" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.sites).toHaveLength(2);
    const createdSite = created.json().data.sites.find((candidate: { name: string }) => candidate.name === "Docs");
    expect(createdSite).toMatchObject({ scope: "thread", publicOrigin: null, association: null });
    expect(created.body).not.toContain("127.0.0.1");
    expect(created.body).not.toContain("private=1");

    const disallowedPort = await handle.app.inject({
      method: "POST",
      url: "/api/sites",
      headers: { ...headers, origin: "https://pad.example.test" },
      payload: { threadId: THREAD_ID, name: "Unsafe port", url: "http://127.0.0.1:9999", scope: "thread" },
    });
    expect(disallowedPort.statusCode).toBe(400);
    expect(disallowedPort.json().error).toMatchObject({ code: "INVALID_REQUEST" });

    const browserTabs = await handle.app.inject({
      method: "GET",
      url: `/api/browser-tabs?threadId=${THREAD_ID}`,
      headers,
    });
    expect(browserTabs.statusCode).toBe(200);
    expect(browserTabs.json().data).toMatchObject({ tabs: [], detail: expect.stringMatching(/injected bridge fixture/i) });

    const removed = await handle.app.inject({
      method: "DELETE",
      url: `/api/sites/${site.associationId}?threadId=${THREAD_ID}`,
      headers: { ...headers, origin: "https://pad.example.test" },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ removed: true, siteId: site.associationId });
  });

  it("captures and controls one explicitly selected Codex Browser page without exposing its debugger", async () => {
    const frame = {
      tabId: `tab_${"1".repeat(24)}`,
      title: "Component lab",
      url: "http://127.0.0.1:8787/",
      imageBase64: "YWJjZGVmZ2hpamtsbW5vcA==",
      mimeType: "image/jpeg" as const,
      width: 1_180,
      height: 760,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      capturedAt: 1_750_000_000_000,
    };
    const browserTabRuntime: BrowserTabRuntime = {
      frame: vi.fn(async () => frame),
      control: vi.fn(async () => ({ ...frame, scrollY: 240 })),
      recordedControl: vi.fn(async (_threadId, _tabId, action) => ({
        frame: { ...frame, scrollY: action.type === "scroll" ? 240 : 0 },
        receipt: {
          receiptId: "77777777-7777-4777-8777-777777777777",
          threadId: THREAD_ID,
          tabId: frame.tabId,
          action: action.type === "insertText"
            ? { type: "insertText" as const }
            : action.type === "navigate"
              ? { type: "navigate" as const }
              : action,
          target: null,
          input: { mode: "none" as const },
          beforeUrl: frame.url,
          afterUrl: frame.url,
          beforeScroll: { x: 0, y: 0 },
          afterScroll: { x: 0, y: action.type === "scroll" ? 240 : 0 },
          outcome: "applied" as const,
          confidence: "high" as const,
          recordedAt: frame.capturedAt,
        },
      })),
    };
    const { handle, authorization } = await setup(null, undefined, undefined, browserTabRuntime);
    const headers = { host: "pad.example.test", authorization };

    const captured = await handle.app.inject({
      method: "GET",
      url: `/api/browser-tabs/${frame.tabId}/frame?threadId=${THREAD_ID}`,
      headers,
    });
    expect(captured.statusCode).toBe(200);
    expect(captured.json().data).toMatchObject({ tabId: frame.tabId, title: "Component lab", width: 1_180 });
    expect(captured.body).not.toContain("webSocketDebuggerUrl");
    expect(browserTabRuntime.frame).toHaveBeenCalledWith(THREAD_ID, frame.tabId);

    const action = { type: "scroll" as const, x: 520, y: 380, deltaX: 12, deltaY: 360 };
    const controlled = await handle.app.inject({
      method: "POST",
      url: `/api/browser-tabs/${frame.tabId}/control?threadId=${THREAD_ID}`,
      headers: { ...headers, origin: "https://pad.example.test" },
      payload: action,
    });
    expect(controlled.statusCode).toBe(200);
    expect(controlled.json().data).toMatchObject({ tabId: frame.tabId, scrollY: 240 });
    expect(browserTabRuntime.control).toHaveBeenCalledWith(THREAD_ID, frame.tabId, action);

    const recorded = await handle.app.inject({
      method: "POST",
      url: `/api/browser-tabs/${frame.tabId}/recorded-control?threadId=${THREAD_ID}`,
      headers: { ...headers, origin: "https://pad.example.test" },
      payload: action,
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().data).toMatchObject({
      frame: { tabId: frame.tabId, scrollY: 240 },
      receipt: { threadId: THREAD_ID, tabId: frame.tabId, outcome: "applied" },
    });
  });

  it("serves content-hashed assets added after bridge startup and keeps the SPA fallback", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "codex-pad-web-test-"));
    temporaryRoots.push(webRoot);
    await writeFile(join(webRoot, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");

    const prepared = await setup(null, undefined, webRoot);
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "assets", "index-newhash.js"), "globalThis.__CODEX_PAD_LOADED__ = true;", "utf8");

    const asset = await prepared.handle.app.inject({
      method: "GET",
      url: "/assets/index-newhash.js",
      headers: { host: "pad.example.test" },
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/javascript/u);
    expect(asset.body).toContain("__CODEX_PAD_LOADED__");

    const spaRoute = await prepared.handle.app.inject({
      method: "GET",
      url: "/sessions/example",
      headers: { host: "pad.example.test" },
    });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.headers["content-type"]).toMatch(/text\/html/u);
    expect(spaRoute.body).toContain("id=\"root\"");
  });

  it("releases the data-root lease after a cleanly handled startup failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-startup-failure-"));
    temporaryRoots.push(root);
    const paths = defaultDataPaths(root);
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => occupied.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = occupied.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const failed = mocks();
    await expect(startBridge({
      port,
      paths,
      publicOrigin: "https://pad.example.test",
      adapter: failed.adapter,
      transport: failed.transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));

    const recovered = mocks();
    const handle = await startBridge({
      port,
      paths,
      publicOrigin: "https://pad.example.test",
      adapter: recovered.adapter,
      transport: recovered.transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    handles.push(handle);
  });

  it("holds one data-root lifetime lease across different ports until close completes", async () => {
    const prepared = await setup();
    const secondPort = await freePort();
    const second = mocks();
    await expect(startBridge({
      port: secondPort,
      paths: prepared.paths,
      publicOrigin: "https://pad.example.test",
      adapter: second.adapter,
      transport: second.transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    })).rejects.toBeInstanceOf(BridgeLifetimeLeaseError);
    expect(second.adapter.refresh).not.toHaveBeenCalled();
    expect(second.transport.health).not.toHaveBeenCalled();

    await prepared.handle.close();
    const restarted = await startBridge({
      port: secondPort,
      paths: prepared.paths,
      publicOrigin: "https://pad.example.test",
      adapter: second.adapter,
      transport: second.transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    handles.push(restarted);
    expect(restarted.url).toBe(`http://127.0.0.1:${secondPort}`);
  });

  it("refuses offline ledger administration while a bridge owns the data root", async () => {
    const prepared = await setup();
    await expect(listUnresolvedCommands({ paths: prepared.paths }))
      .rejects.toBeInstanceOf(BridgeLifetimeLeaseError);
    await prepared.handle.close();
    await expect(listUnresolvedCommands({ paths: prepared.paths })).resolves.toEqual([]);
  });

  it("keeps commandId authority and status across revoke, re-pair, and restart", async () => {
    const prepared = await setup();
    const command = {
      type: "createTask",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8c01",
      expectedBridgeInstanceId: prepared.handle.state.current().bridgeInstanceId,
      expectedSequence: prepared.handle.state.current().sequence,
      expectedThreadId: null,
      instruction: null,
    };
    const first = await prepared.handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization: prepared.authorization,
        "x-codex-pad-command-id": command.commandId,
      },
      payload: { command },
    });
    expect(first.json().data).toMatchObject({ status: "succeeded", targetThreadId: THREAD_ID });
    expect(prepared.transport.newThread).toHaveBeenCalledTimes(1);

    await expect(prepared.handle.revokeDevice(prepared.deviceId)).resolves.toBe(true);
    const pairing = await prepared.handle.createPairing("https://pad.example.test");
    const nonce = pairingNonceFromUrl(pairing.qrPayload) ?? "";
    const repaired = await prepared.handle.app.inject({
      method: "POST",
      url: "/api/pair",
      headers: { host: "pad.example.test", origin: "https://pad.example.test" },
      payload: { nonce, deviceName: "Re-paired iPad" },
    });
    expect(repaired.statusCode).toBe(201);
    const repairedAuthorization = `Bearer ${(repaired.json() as { data: { bearerToken: string } }).data.bearerToken}`;
    const statusAfterRepair = await prepared.handle.app.inject({
      method: "GET",
      url: `/api/commands/${command.commandId}`,
      headers: { host: "pad.example.test", authorization: repairedAuthorization },
    });
    expect(statusAfterRepair.json().data).toMatchObject({ status: "succeeded" });

    await prepared.handle.close();
    const port = await freePort();
    const restarted = mocks();
    const restartedHandle = await startBridge({
      port,
      paths: prepared.paths,
      publicOrigin: "https://pad.example.test",
      adapter: restarted.adapter,
      transport: restarted.transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    handles.push(restartedHandle);
    await restartedHandle.state.refresh();
    const retry = await restartedHandle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization: repairedAuthorization,
        "x-codex-pad-command-id": command.commandId,
      },
      payload: { command },
    });
    expect(retry.json().data).toMatchObject({ status: "succeeded", disposition: "duplicate" });
    expect(restarted.transport.newThread).not.toHaveBeenCalled();
  });

  it("returns a bearer only in the pairing response, serves snapshots, and deduplicates commands", async () => {
    const { handle, authorization, execute } = await setup();
    const healthResponse = await handle.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "pad.example.test" },
    });
    expect(healthResponse.json().data.multiImageInputVerified).toBe(true);
    const snapshotResponse = await handle.app.inject({
      method: "GET",
      url: "/api/snapshot",
      headers: { host: "pad.example.test", authorization },
    });
    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.headers["content-security-policy"]).toContain("frame-src 'self'");
    expect(snapshotResponse.headers["content-security-policy"]).not.toContain("https://mac.example.ts.net:5173");
    expect(snapshotResponse.headers["content-security-policy"]).not.toContain("unregistered.ts.net");
    expect(snapshotResponse.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(snapshotResponse.headers["content-security-policy"]).not.toContain("connect-src 'self' ws: wss:");
    expect(snapshotResponse.headers["content-security-policy"]).toContain("media-src 'self' blob:");
    expect(snapshotResponse.headers["permissions-policy"]).toContain("microphone=(self)");
    expect(snapshotResponse.headers["permissions-policy"]).toContain("camera=(self)");
    const snapshot = snapshotResponse.json().data;
    expect(snapshot.codexVersion).toBe("codex-cli 0.145.0-test");
    expect(snapshot.bridgeInstanceId).toBe(handle.state.current().bridgeInstanceId);
    expect(snapshot.bridgeInstanceId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
    expect(snapshot.slots).toHaveLength(6);
    expect(snapshot.slots[0].activityLabel).toBeNull();
    expect(snapshotResponse.body).not.toContain("publish the private draft");
    const capabilitiesResponse = await handle.app.inject({
      method: "GET",
      url: "/api/capabilities",
      headers: { host: "pad.example.test", authorization },
    });
    expect(capabilitiesResponse.json().data).toMatchObject({
      codexVersion: "codex-cli 0.145.0-test",
      review: true,
      reviewMaxImages: 12,
      multiImageInputVerified: true,
      commands: expect.arrayContaining(["sendReview"]),
    });
    const runtimeResponse = await handle.app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { host: "pad.example.test", authorization },
    });
    expect(runtimeResponse.statusCode).toBe(200);
    expect(runtimeResponse.json().data).toMatchObject({
      protocolVersion: 1,
      bridgeVersion: "0.1.0",
      codexVersion: "codex-cli 0.145.0-test",
      snapshotSequence: expect.any(Number),
      schemaCompatibility: { state: "unknown" },
    });
    expect(runtimeResponse.json().data.checks).toHaveLength(6);
    expect(runtimeResponse.json().data.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sessions", state: "available" }),
      expect.objectContaining({ id: "composerAttachment", state: "available" }),
      expect.objectContaining({ id: "skillsAndModels", state: "available" }),
    ]));
    expect(runtimeResponse.body).not.toContain("/workspace/secret");
    expect(runtimeResponse.body).not.toContain("publish the private draft");
    const sessions = await handle.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { host: "pad.example.test", authorization },
    });
    expect(sessions.body).not.toContain("/workspace/secret");
    expect(sessions.body).not.toContain("publish the private draft");
    expect(sessions.body).not.toContain("127.0.0.1:5173");
    expect(sessions.json().data.sessions[0].projectId).toBe(projectCwdIdentifier("/workspace/secret/acme"));
    expect(sessions.json().data.sessions[0].projectLabel).toBe("acme");
    expect(sessions.json().data.sessions[0].siteAssociation.origin).toBe("https://mac.example.ts.net:5173");
    expect(sessions.json().data.sessions[0].siteAssociation.capabilities.maxFrames).toBe(12);
    expect(sessions.json().data.sessions[0].siteAssociation.capabilities).toMatchObject({
      state: "unavailable",
      canCaptureFrames: false,
      canSendReview: false,
    });
    expect(sessions.json().data.sessions[0].siteAssociation.interactionModes).toMatchObject({
      selected: "none",
      direct: {
        status: "unavailable",
        reason: "same-host-storage-boundary",
      },
      remoteBrowser: {
        status: "unavailable",
        reason: "thread-tab-mapping-unproven",
        association: {
          status: "unavailable",
          reason: "thread-tab-mapping-unproven",
        },
      },
    });
    const nativeSessions = await handle.app.inject({
      method: "GET",
      url: "/api/native-sessions",
      headers: { host: "pad.example.test", authorization },
    });
    expect(nativeSessions.statusCode).toBe(200);
    expect(nativeSessions.json().data).toMatchObject({
      registryGeneration: 1,
      sessions: [{
        threadId: THREAD_ID,
        microSlot: 0,
        projectId: projectCwdIdentifier("/workspace/secret/acme"),
        siteAssociation: { associationId: expect.any(String) },
      }],
    });

    const command = {
      type: "selectAgent",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb1",
      expectedBridgeInstanceId: snapshot.bridgeInstanceId,
      expectedSequence: snapshot.sequence,
      expectedThreadId: THREAD_ID,
      slot: 0,
    };
    const send = () => handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command },
    });
    const first = await send();
    const second = await send();
    expect(first.json().data.status).toBe("succeeded");
    expect(second.json().data.disposition).toBe("duplicate");
    expect(execute).toHaveBeenCalledTimes(1);
    const collision = await handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: {
        command: {
          ...command,
          slot: 1,
          expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
        },
      },
    });
    expect(collision.json().data).toMatchObject({
      status: "failed",
      error: { code: "COMMAND_ID_COLLISION" },
    });

    const status = await handle.app.inject({
      method: "GET",
      url: `/api/commands/${command.commandId}`,
      headers: { host: "pad.example.test", authorization },
    });
    expect(status.json().data.status).toBe("succeeded");
  });

  it("persists authenticated global product state with origin and revision checks", async () => {
    const { handle, authorization } = await setup();
    const unauthenticated = await handle.app.inject({
      method: "GET",
      url: "/api/product-state",
      headers: { host: "pad.example.test" },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const initialResponse = await handle.app.inject({
      method: "GET",
      url: "/api/product-state",
      headers: { host: "pad.example.test", authorization },
    });
    expect(initialResponse.statusCode).toBe(200);
    const initial = initialResponse.json().data;
    expect(initial).toMatchObject({ revision: 0, homeLayout: { pinnedThreadIds: [] } });
    const payload = {
      expectedRevision: initial.revision,
      homeLayout: {
        ...initial.homeLayout,
        pinnedThreadIds: [THREAD_ID],
        manual: { sections: [], looseThreadIds: [THREAD_ID] },
      },
      preferences: { ...initial.preferences, theme: "light" },
    };

    const missingOrigin = await handle.app.inject({
      method: "PUT",
      url: "/api/product-state",
      headers: { host: "pad.example.test", authorization },
      payload,
    });
    expect(missingOrigin.statusCode).toBe(403);

    const saved = await handle.app.inject({
      method: "PUT",
      url: "/api/product-state",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ revision: 1, preferences: { theme: "light" } });

    const stale = await handle.app.inject({
      method: "PUT",
      url: "/api/product-state",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "CONFLICT", details: { currentRevision: 1 } });

    const current = await handle.app.inject({
      method: "GET",
      url: "/api/product-state",
      headers: { host: "pad.example.test", authorization },
    });
    expect(current.json().data.homeLayout.manual.looseThreadIds).toEqual([THREAD_ID]);
  });

  it("keeps and manually deletes authenticated Saved Drawings on the Mac", async () => {
    const { handle, authorization } = await setup();
    const png = await sharp({
      create: { width: 20, height: 16, channels: 4, background: "#ffffff" },
    }).png().toBuffer();
    const payload = {
      sourceThreadId: THREAD_ID,
      sourceThreadTitle: "Saved drawing route",
      instruction: "Use this calmer control shape",
      pngBase64: png.toString("base64"),
      sceneJson: JSON.stringify({ version: 1, elements: [] }),
      background: "white",
      width: 20,
      height: 16,
    };

    const missingOrigin = await handle.app.inject({
      method: "POST",
      url: "/api/saved-drawings",
      headers: { host: "pad.example.test", authorization },
      payload,
    });
    expect(missingOrigin.statusCode).toBe(403);

    const created = await handle.app.inject({
      method: "POST",
      url: "/api/saved-drawings",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const drawingId = created.json().data.id as string;
    expect(created.json().data).toMatchObject({ sourceThreadId: THREAD_ID, width: 20, height: 16 });

    const list = await handle.app.inject({
      method: "GET",
      url: "/api/saved-drawings",
      headers: { host: "pad.example.test", authorization },
    });
    expect(list.json().data.drawings).toHaveLength(1);
    expect(list.json().data.drawings[0]).not.toHaveProperty("pngBase64");

    const detail = await handle.app.inject({
      method: "GET",
      url: `/api/saved-drawings/${drawingId}`,
      headers: { host: "pad.example.test", authorization },
    });
    expect(detail.json().data.sceneJson).toContain("elements");

    const deleted = await handle.app.inject({
      method: "DELETE",
      url: `/api/saved-drawings/${drawingId}`,
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
    });
    expect(deleted.json().data).toEqual({ deleted: true, drawingId });
  });

  it("lists exact-task agent diagrams and saves one optimistic iPad revision", async () => {
    const { handle, paths, authorization } = await setup();
    const published = await new DiagramStore({ paths }).publish({
      threadId: THREAD_ID,
      title: "Bridge diagram",
      nodes: [
        {
          id: "codex",
          label: "Codex",
          x: 100,
          y: 100,
          width: 220,
          height: 96,
          shape: "rectangle",
          tone: "blue",
        },
      ],
      edges: [],
    });
    const authenticated = { host: "pad.example.test", authorization };
    const listed = await handle.app.inject({
      method: "GET",
      url: `/api/diagrams?threadId=${THREAD_ID}`,
      headers: authenticated,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.diagrams).toHaveLength(1);
    expect(listed.json().data.diagrams[0]).toMatchObject({
      diagramId: published.diagramId,
      revision: 0,
      threadId: THREAD_ID,
    });

    const missingOrigin = await handle.app.inject({
      method: "PUT",
      url: `/api/diagrams/${published.diagramId}?threadId=${THREAD_ID}`,
      headers: authenticated,
      payload: {
        expectedRevision: 0,
        title: "iPad revision",
        nodes: published.nodes,
        edges: published.edges,
      },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const saved = await handle.app.inject({
      method: "PUT",
      url: `/api/diagrams/${published.diagramId}?threadId=${THREAD_ID}`,
      headers: { ...authenticated, origin: "https://pad.example.test" },
      payload: {
        expectedRevision: 0,
        title: "iPad revision",
        nodes: published.nodes,
        edges: published.edges,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({
      diagramId: published.diagramId,
      revision: 1,
      lastEditedBy: "ipad",
      title: "iPad revision",
    });

    const stale = await handle.app.inject({
      method: "PUT",
      url: `/api/diagrams/${published.diagramId}?threadId=${THREAD_ID}`,
      headers: { ...authenticated, origin: "https://pad.example.test" },
      payload: {
        expectedRevision: 0,
        title: "Stale revision",
        nodes: published.nodes,
        edges: published.edges,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: "CONFLICT",
      details: { currentRevision: 1 },
    });
  });

  it("rate-limits failed bearer authentication without charging valid snapshot polling", async () => {
    const { handle, authorization, logger } = await setup();
    const invalidAuthorization = `Bearer ${"A".repeat(43)}`;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const rejected = await handle.app.inject({
        method: "GET",
        url: "/api/snapshot",
        headers: { host: "pad.example.test", authorization: invalidAuthorization, "user-agent": "Rate test" },
      });
      expect(rejected.statusCode).toBe(401);
    }
    const limited = await handle.app.inject({
      method: "GET",
      url: "/api/snapshot",
      headers: { host: "pad.example.test", authorization: invalidAuthorization, "user-agent": "Rate test" },
    });
    expect(limited.statusCode).toBe(429);
    const failure = createApiFailureEnvelopeSchema().parse(limited.json());
    expect(failure.error).toMatchObject({ code: "RATE_LIMITED", retryable: true, details: null });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    // Reach the independent bridge-wide invalid-guess ceiling with unrelated
    // credential fingerprints. A legitimate bearer must still be verified.
    for (let attempt = 0; attempt < 228; attempt += 1) {
      const guessedToken = attempt.toString(36).padStart(6, "0").repeat(8).slice(0, 43);
      const rejected = await handle.app.inject({
        method: "GET",
        url: "/api/snapshot",
        headers: {
          host: "pad.example.test",
          authorization: `Bearer ${guessedToken}`,
          "user-agent": "Global rate test",
        },
      });
      expect(rejected.statusCode).toBe(401);
    }
    const globallyLimited = await handle.app.inject({
      method: "GET",
      url: "/api/snapshot",
      headers: {
        host: "pad.example.test",
        authorization: `Bearer ${"Z".repeat(43)}`,
        "user-agent": "Global rate test",
      },
    });
    expect(globallyLimited.statusCode).toBe(429);
    const validAfterFlood = await handle.app.inject({
      method: "GET",
      url: "/api/snapshot",
      headers: { host: "pad.example.test", authorization },
    });
    expect(validAfterFlood.statusCode).toBe(200);

    for (let poll = 0; poll < 125; poll += 1) {
      const snapshot = await handle.app.inject({
        method: "GET",
        url: "/api/snapshot",
        headers: { host: "pad.example.test", authorization },
      });
      expect(snapshot.statusCode).toBe(200);
    }
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("authenticates and rate-limits commands and WebSocket tickets before reading request bodies", async () => {
    const { handle, authorization, execute, logger, port } = await setup();
    const invalidAuthorization = `Bearer ${"U".repeat(43)}`;
    const oversized = await rawHeaderOnlyRequest(port, [
      "POST /api/command HTTP/1.1",
      "Host: pad.example.test",
      "Origin: https://pad.example.test",
      `Authorization: ${invalidAuthorization}`,
      "User-Agent: Prebody command test",
      "Content-Type: application/json",
      `Content-Length: ${40 * 1024 * 1024}`,
      "Connection: close",
    ]);
    expect(oversized).toMatch(/^HTTP\/1\.1 401 /u);

    for (let attempt = 1; attempt < 12; attempt += 1) {
      const rejected = await handle.app.inject({
        method: "POST",
        url: "/api/command",
        headers: {
          host: "pad.example.test",
          origin: "https://pad.example.test",
          authorization: invalidAuthorization,
          "user-agent": "Prebody command test",
        },
      });
      expect(rejected.statusCode).toBe(401);
    }
    const chunkedLimited = await rawHeaderOnlyRequest(port, [
      "POST /api/command HTTP/1.1",
      "Host: pad.example.test",
      "Origin: https://pad.example.test",
      `Authorization: ${invalidAuthorization}`,
      "User-Agent: Prebody command test",
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
    ]);
    expect(chunkedLimited).toMatch(/^HTTP\/1\.1 429 /u);
    expect(chunkedLimited.toLowerCase()).toContain("retry-after:");
    expect(execute).not.toHaveBeenCalled();

    const invalidTicket = await rawHeaderOnlyRequest(port, [
      "POST /api/ws-ticket HTTP/1.1",
      "Host: pad.example.test",
      "Origin: https://pad.example.test",
      `Authorization: Bearer ${"V".repeat(43)}`,
      "User-Agent: Prebody ticket test",
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
    ]);
    expect(invalidTicket).toMatch(/^HTTP\/1\.1 401 /u);

    const oversizedValidTicket = await handle.app.inject({
      method: "POST",
      url: "/api/ws-ticket",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization,
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect(oversizedValidTicket.statusCode).toBe(413);
    expect(createApiFailureEnvelopeSchema().parse(oversizedValidTicket.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    const ticket = await handle.app.inject({
      method: "POST",
      url: "/api/ws-ticket",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
    });
    expect(ticket.statusCode).toBe(200);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("binds a pairing code to its QR origin even when a development origin is allowlisted", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    let prepared: Awaited<ReturnType<typeof setup>>;
    try {
      prepared = await setup();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    const info = await prepared.handle.createPairing("https://pad.example.test");
    const nonce = pairingNonceFromUrl(info.qrPayload) ?? "";
    const fromDevelopmentOrigin = await prepared.handle.app.inject({
      method: "POST",
      url: "/api/pair",
      headers: {
        host: "127.0.0.1:5173",
        origin: "http://127.0.0.1:5173",
        "user-agent": "Development Safari",
      },
      payload: { nonce, deviceName: "Wrong origin" },
    });
    expect(fromDevelopmentOrigin.statusCode).toBe(401);
    expect(fromDevelopmentOrigin.body).not.toContain("bearerToken");

    const fromQrOrigin = await prepared.handle.app.inject({
      method: "POST",
      url: "/api/pair",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        "user-agent": "Development Safari",
      },
      payload: { nonce, deviceName: "Correct origin" },
    });
    expect(fromQrOrigin.statusCode).toBe(201);
    expect(fromQrOrigin.json().data.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("rate-limits authenticated mutations without reserving a rejected command or blocking reconciliation", async () => {
    const { handle, authorization, execute, logger } = await setup();
    const command = {
      type: "selectAgent",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8be0",
      expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
      expectedSequence: handle.state.current().sequence,
      expectedThreadId: THREAD_ID,
      slot: 0,
    };
    const send = (nextCommand: typeof command) => handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command: nextCommand },
    });

    expect((await send(command)).statusCode).toBe(200);
    let lastDuplicate;
    for (let attempt = 1; attempt < 120; attempt += 1) lastDuplicate = await send(command);
    expect(lastDuplicate?.json().data.disposition).toBe("duplicate");

    const rejectedCommand = { ...command, commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8be1" };
    const limited = await send(rejectedCommand);
    expect(limited.statusCode).toBe(429);
    const failure = createApiFailureEnvelopeSchema().parse(limited.json());
    expect(failure.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(execute).toHaveBeenCalledTimes(1);

    const completedStatus = await handle.app.inject({
      method: "GET",
      url: `/api/commands/${command.commandId}`,
      headers: { host: "pad.example.test", authorization },
    });
    expect(completedStatus.statusCode).toBe(200);
    expect(completedStatus.json().data.status).toBe("succeeded");
    const rejectedStatus = await handle.app.inject({
      method: "GET",
      url: `/api/commands/${rejectedCommand.commandId}`,
      headers: { host: "pad.example.test", authorization },
    });
    expect(rejectedStatus.statusCode).toBe(200);
    expect(rejectedStatus.json().data.status).toBe("unknown");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("admits one command before parsing and leaves concurrent IDs safely reconcilable", async () => {
    const { handle, authorization, execute, logger } = await setup();
    let finishDispatch: ((state: AdapterState) => void) | undefined;
    execute.mockImplementationOnce(() => new Promise<AdapterState>((resolve) => { finishDispatch = resolve; }));
    const baseCommand = {
      type: "selectAgent" as const,
      expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
      expectedSequence: handle.state.current().sequence,
      expectedThreadId: THREAD_ID,
      slot: 0,
    };
    const send = (commandId: string, expectedSequence = baseCommand.expectedSequence) => handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization,
        "x-codex-pad-command-id": commandId,
      },
      payload: { command: { ...baseCommand, expectedSequence, commandId } },
    });

    const firstPending = send("019f7ec2-68eb-7183-bb3a-0e67312a8be8");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const inFlightCollision = await handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization,
        "x-codex-pad-command-id": "019f7ec2-68eb-7183-bb3a-0e67312a8be8",
      },
      payload: {
        command: {
          ...baseCommand,
          commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8be8",
          slot: 1,
        },
      },
    });
    expect(inFlightCollision.statusCode).toBe(200);
    expect(inFlightCollision.json().data).toMatchObject({
      status: "failed",
      error: { code: "COMMAND_ID_COLLISION", retryable: false },
    });
    const duplicateWhileActive = send("019f7ec2-68eb-7183-bb3a-0e67312a8be8");
    let duplicateSettled = false;
    void duplicateWhileActive.then(() => { duplicateSettled = true; });
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);
    const distinct = await send("019f7ec2-68eb-7183-bb3a-0e67312a8be9");
    expect(distinct.statusCode).toBe(429);
    expect(createApiFailureEnvelopeSchema().parse(distinct.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const activeStatus = await handle.app.inject({
      method: "GET",
      url: "/api/commands/019f7ec2-68eb-7183-bb3a-0e67312a8be8",
      headers: { host: "pad.example.test", authorization },
    });
    expect(activeStatus.statusCode).toBe(200);
    expect(activeStatus.json().data.status).toBe("inFlight");
    const rejectedStatus = await handle.app.inject({
      method: "GET",
      url: "/api/commands/019f7ec2-68eb-7183-bb3a-0e67312a8be9",
      headers: { host: "pad.example.test", authorization },
    });
    expect(rejectedStatus.statusCode).toBe(200);
    expect(rejectedStatus.json().data.status).toBe("unknown");

    finishDispatch?.(adapterState());
    const first = await firstPending;
    const coalesced = await duplicateWhileActive;
    expect(first.json().data.status).toBe("succeeded");
    expect(coalesced.json().data).toMatchObject({ status: "succeeded", disposition: "duplicate" });
    const reconciledDuplicate = await send("019f7ec2-68eb-7183-bb3a-0e67312a8be8");
    expect(reconciledDuplicate.json().data).toMatchObject({ status: "succeeded", disposition: "duplicate" });
    expect(execute).toHaveBeenCalledTimes(1);

    const afterRelease = await send(
      "019f7ec2-68eb-7183-bb3a-0e67312a8bea",
      handle.state.current().sequence,
    );
    expect(afterRelease.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("persists ambiguous composer attachment and never replays it after a bridge restart", async () => {
    const { handle, paths, authorization, attachImageToComposer } = await setup();
    const png = (await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer()).toString("base64");
    attachImageToComposer.mockRejectedValue(
      new CodexDesktopAdapterError(
        "delivery-unknown",
        "The exact composer may have accepted the image before acknowledgement was lost.",
      ),
    );
    const command = {
      type: "sendSketch",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb9",
      expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
      expectedSequence: handle.state.current().sequence,
      expectedThreadId: THREAD_ID,
      targetThreadId: THREAD_ID,
      instruction: "Inspect this frame",
      png,
    };
    const send = () => handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command },
    });
    const first = await send();
    expect(first.json().data).toMatchObject({
      status: "inFlight",
      error: { code: "DELIVERY_UNKNOWN", retryable: true },
    });
    const duplicate = await send();
    expect(duplicate.json().data).toMatchObject({
      disposition: "duplicate",
      status: "inFlight",
      error: { code: "DELIVERY_UNKNOWN", retryable: true },
    });
    expect(attachImageToComposer).toHaveBeenCalledTimes(1);

    await handle.close();
    const port = await freePort();
    const restarted = mocks();
    const restartedHandle = await startBridge({
      port,
      paths,
      publicOrigin: "https://pad.example.test",
      adapter: restarted.adapter,
      transport: restarted.transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    handles.push(restartedHandle);
    await restartedHandle.state.refresh();
    const replay = await restartedHandle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command },
    });
    expect(replay.json().data).toMatchObject({
      disposition: "duplicate",
      status: "inFlight",
      error: { code: "DELIVERY_UNKNOWN", retryable: true },
    });
    expect(restarted.attachImageToComposer).not.toHaveBeenCalled();

    const status = await restartedHandle.app.inject({
      method: "GET",
      url: `/api/commands/${command.commandId}`,
      headers: { host: "pad.example.test", authorization },
    });
    expect(status.json().data).toMatchObject({
      status: "inFlight",
      error: { code: "DELIVERY_UNKNOWN", retryable: true },
    });
  });

  it("keeps definite pre-attachment native unavailability retryable without creating an unresolved ledger entry", async () => {
    const { handle, authorization, attachImageToComposer } = await setup();
    const png = (await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer()).toString("base64");
    attachImageToComposer.mockRejectedValue(new CodexDesktopAdapterError(
      "cdp-connection-failed",
      "The exact Codex composer renderer is reconnecting.",
    ));
    const baseCommand = {
      type: "sendSketch",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bd0",
      expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
      expectedSequence: handle.state.current().sequence,
      expectedThreadId: THREAD_ID,
      targetThreadId: THREAD_ID,
      instruction: "Inspect this frame",
      png,
    };
    const send = (commandId: string) => handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command: { ...baseCommand, commandId } },
    });

    expect((await send(baseCommand.commandId)).json().data).toMatchObject({
      status: "failed",
      error: { code: "CDP_CONNECTION_FAILED", retryable: true },
    });
    expect((await send(baseCommand.commandId)).json().data).toMatchObject({
      disposition: "duplicate",
      status: "failed",
      error: { code: "CDP_CONNECTION_FAILED", retryable: true },
    });
    expect((await send("019f7ec2-68eb-7183-bb3a-0e67312a8bd1")).json().data).toMatchObject({
      status: "failed",
      error: { code: "CDP_CONNECTION_FAILED", retryable: true },
    });
    attachImageToComposer.mockRejectedValue(new CodexDesktopAdapterError(
      "mutation-authority-stale",
      "Exact native authority changed before attachment.",
    ));
    expect((await send("019f7ec2-68eb-7183-bb3a-0e67312a8bd3")).json().data).toMatchObject({
      status: "failed",
      error: { code: "MUTATION_AUTHORITY_STALE", retryable: true },
    });
    expect(attachImageToComposer).toHaveBeenCalledTimes(3);
  });

  it("does not classify a pre-attachment target change as delivered", async () => {
    const { handle, authorization, attachImageToComposer } = await setup();
    const png = (await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer()).toString("base64");
    attachImageToComposer.mockRejectedValue(
      new CodexDesktopAdapterError("thread-changed", "The exact composer changed before attachment."),
    );
    const response = await handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: {
        command: {
          type: "sendSketch",
          commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bd2",
          expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
          expectedSequence: handle.state.current().sequence,
          expectedThreadId: THREAD_ID,
          targetThreadId: THREAD_ID,
          instruction: "Inspect this frame",
          png,
        },
      },
    });
    expect(response.json().data).toMatchObject({
      status: "failed",
      error: { code: "THREAD_CHANGED", retryable: true },
    });
  });

  it("persists an ambiguous native CDP dispatch and never reruns it after restart", async () => {
    const { handle, paths, authorization, execute } = await setup();
    execute.mockRejectedValueOnce(new CodexDesktopAdapterError(
      "delivery-unknown",
      "Runtime.evaluate may have dispatched before CDP disconnected.",
    ));
    const command = {
      type: "selectAgent",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bc9",
      expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
      expectedSequence: handle.state.current().sequence,
      expectedThreadId: THREAD_ID,
      slot: 0,
    };
    const send = () => handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command },
    });

    expect((await send()).json().data).toMatchObject({
      status: "inFlight",
      error: { code: "DELIVERY_UNKNOWN", retryable: true },
    });
    expect((await send()).json().data).toMatchObject({
      disposition: "duplicate",
      status: "inFlight",
      error: { code: "DELIVERY_UNKNOWN", retryable: true },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    await handle.close();
    const restarted = mocks();
    const restartedHandle = await startBridge({
      port: await freePort(),
      paths,
      publicOrigin: "https://pad.example.test",
      adapter: restarted.adapter,
      transport: restarted.transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    handles.push(restartedHandle);
    await restartedHandle.state.refresh();
    const replay = await restartedHandle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command },
    });
    expect(replay.json().data).toMatchObject({
      disposition: "duplicate",
      status: "inFlight",
      error: { code: "DELIVERY_UNKNOWN", retryable: true },
    });
    expect(restarted.execute).not.toHaveBeenCalled();
  });

  it("returns a durable createTask result after restart without creating a second task", async () => {
    const { handle, paths, authorization, transport } = await setup();
    const command = {
      type: "createTask",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bc0",
      expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
      expectedSequence: handle.state.current().sequence,
      expectedThreadId: null,
      instruction: null,
    };
    const first = await handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command },
    });
    expect(first.json().data).toMatchObject({ status: "succeeded", targetThreadId: THREAD_ID });
    expect(transport.newThread).toHaveBeenCalledTimes(1);

    await handle.close();
    const port = await freePort();
    const restarted = mocks();
    const restartedHandle = await startBridge({
      port,
      paths,
      publicOrigin: "https://pad.example.test",
      adapter: restarted.adapter,
      transport: restarted.transport,
      openExactThread: vi.fn(async () => undefined),
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      siteCaptureService: null,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    handles.push(restartedHandle);
    await restartedHandle.state.refresh();
    const replay = await restartedHandle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command },
    });
    expect(replay.json().data).toMatchObject({
      disposition: "duplicate",
      status: "succeeded",
      targetThreadId: THREAD_ID,
    });
    expect(restarted.transport.newThread).not.toHaveBeenCalled();
  });

  it("exposes an explicit unavailable capture state and rejects client-supplied origins", async () => {
    const { handle, authorization, site } = await setup();
    const validBody = {
      threadId: THREAD_ID,
      path: "/dashboard",
      viewport: "ipad-landscape",
      scroll: { x: 0, y: 120 },
    };
    const unavailable = await handle.app.inject({
      method: "POST",
      url: `/api/sites/${site.associationId}/capture`,
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: validBody,
    });
    expect(unavailable.statusCode).toBe(501);
    expect(unavailable.json().error.code).toBe("UNSUPPORTED");

    const injectedOrigin = await handle.app.inject({
      method: "POST",
      url: `/api/sites/${site.associationId}/capture`,
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { ...validBody, origin: "http://127.0.0.1:5173" },
    });
    expect(injectedOrigin.statusCode).toBe(400);

    const forgedProject = await handle.app.inject({
      method: "POST",
      url: `/api/sites/${site.associationId}/capture`,
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: {
        ...validBody,
        projectId: projectCwdIdentifier("/workspace/secret/acme"),
      },
    });
    expect(forgedProject.statusCode).toBe(400);
  });

  it("increments native registry generation and drops a revoked association immediately", async () => {
    const { handle, authorization, paths, site } = await setup();
    const initial = await handle.app.inject({
      method: "GET",
      url: "/api/native-sessions",
      headers: { host: "pad.example.test", authorization },
    });
    expect(initial.json().data).toMatchObject({
      registryGeneration: 1,
      sessions: [{ siteAssociation: { associationId: site.associationId } }],
    });

    await expect(removeSite(site.associationId, { paths })).resolves.toBe(true);
    const revoked = await handle.app.inject({
      method: "GET",
      url: "/api/native-sessions",
      headers: { host: "pad.example.test", authorization },
    });
    expect(revoked.json().data).toMatchObject({
      registryGeneration: 2,
      sessions: [{ siteAssociation: null }],
    });
    expect(revoked.headers["content-security-policy"]).not.toContain("https://mac.example.ts.net:5173");
  });

  it("never broadens frame-src for context-only registered origins", async () => {
    const { handle, authorization } = await setup();
    const response = await handle.app.inject({
      method: "GET",
      url: "/api/native-sessions",
      headers: { host: "pad.example.test", authorization },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("frame-src 'self'");
    expect(response.headers["content-security-policy"]).not.toContain("https://mac.example.ts.net:5173");
  });

  it("resolves an old pinned native task independently of the bounded session catalog", async () => {
    const { handle, authorization, transport, site } = await setup();
    vi.mocked(transport.listSessions).mockResolvedValue([]);
    vi.mocked(transport.threadRead).mockClear();

    const request = () => handle.app.inject({
      method: "GET",
      url: "/api/native-sessions",
      headers: { host: "pad.example.test", authorization },
    });
    const [response, concurrent] = await Promise.all([request(), request()]);

    expect(response.statusCode).toBe(200);
    expect(concurrent.statusCode).toBe(200);
    expect(response.body).not.toContain("/workspace/");
    expect(response.json().data.sessions).toMatchObject([{
      threadId: THREAD_ID,
      microSlot: 0,
      projectId: projectCwdIdentifier("/workspace/secret/acme"),
      siteAssociation: {
        associationId: site.associationId,
        interactionModes: {
          selected: "none",
          direct: { status: "unavailable", reason: "same-host-storage-boundary" },
        },
      },
    }]);
    expect(transport.listSessions).not.toHaveBeenCalled();
    expect(transport.threadRead).toHaveBeenCalledWith(THREAD_ID);

    const repeated = await request();
    expect(repeated.statusCode).toBe(200);
    expect(transport.threadRead).toHaveBeenCalledTimes(1);
  });

  it("returns only safe capture metadata and PNG bytes from an active capture service", async () => {
    const capture = vi.fn(async () => ({
      siteId: "capture-site",
      sourceUrl: "http://127.0.0.1:5173/dashboard",
      finalUrl: "http://127.0.0.1:5173/dashboard/redirected?tab=preview",
      finalPath: "/dashboard/redirected?tab=preview",
      title: "Dashboard",
      viewport: "ipad-landscape" as const,
      scroll: { x: 0, y: 120 },
      redirectCount: 0,
      png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      width: 1366,
      height: 1024,
    }));
    const service = { capture } as unknown as SiteCaptureService;
    const { handle, authorization, site } = await setup(service);
    const response = await handle.app.inject({
      method: "POST",
      url: `/api/sites/${site.associationId}/capture`,
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: {
        threadId: THREAD_ID,
        path: "/dashboard",
        viewport: "ipad-landscape",
        scroll: { x: 0, y: 120 },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      width: 1366,
      height: 1024,
      pngBase64: "iVBORw0KGgo=",
      finalPath: "/dashboard/redirected?tab=preview",
      title: "Dashboard",
    });
    expect(response.body).not.toMatch(/loopback|sourceUrl|finalUrl|127\.0\.0\.1/u);
    expect(capture).toHaveBeenCalledWith(
      {
        threadId: THREAD_ID,
        projectId: projectCwdIdentifier("/workspace/secret/acme"),
      },
      expect.objectContaining({ siteId: site.associationId, path: "/dashboard" }),
    );
  });

  it("rejects concurrent site capture before launching a second driver and restores capacity", async () => {
    const captured = {
      siteId: "capture-site",
      finalPath: "/dashboard",
      title: "Dashboard",
      viewport: "ipad-landscape" as const,
      scroll: { x: 0, y: 0 },
      redirectCount: 0,
      png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      width: 1366,
      height: 1024,
    };
    let finishFirstCapture: (() => void) | undefined;
    const capture = vi.fn(async () => captured);
    capture.mockImplementationOnce(() => new Promise<typeof captured>((resolve) => {
      finishFirstCapture = () => resolve(captured);
    }));
    const { handle, authorization, site, logger } = await setup({ capture } as unknown as SiteCaptureService);
    const request = () => handle.app.inject({
      method: "POST",
      url: `/api/sites/${site.associationId}/capture`,
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: {
        threadId: THREAD_ID,
        path: "/dashboard",
        viewport: "ipad-landscape",
        scroll: { x: 0, y: 0 },
      },
    });

    const firstPending = request();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const limited = await request();
    expect(limited.statusCode).toBe(429);
    expect(createApiFailureEnvelopeSchema().parse(limited.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(Number(limited.headers["retry-after"])).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);

    finishFirstCapture?.();
    expect((await firstPending).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(200);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("rejects concurrent image normalization before a second composer attachment and restores capacity", async () => {
    const { handle, authorization, attachImageToComposer, logger } = await setup();
    const png = (await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer()).toString("base64");
    let finishFirstSend: (() => void) | undefined;
    attachImageToComposer
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirstSend = () => resolve(adapterState());
      }))
      .mockImplementation(async () => adapterState());
    const baseCommand = {
      type: "sendSketch" as const,
      expectedBridgeInstanceId: handle.state.current().bridgeInstanceId,
      expectedSequence: handle.state.current().sequence,
      expectedThreadId: THREAD_ID,
      targetThreadId: THREAD_ID,
      instruction: "Inspect this frame",
      png,
    };
    const send = (commandId: string) => handle.app.inject({
      method: "POST",
      url: "/api/command",
      headers: { host: "pad.example.test", origin: "https://pad.example.test", authorization },
      payload: { command: { ...baseCommand, commandId } },
    });

    const firstPending = send("019f7ec2-68eb-7183-bb3a-0e67312a8bf0");
    await vi.waitFor(() => expect(attachImageToComposer).toHaveBeenCalledTimes(1));
    const limited = await send("019f7ec2-68eb-7183-bb3a-0e67312a8bf1");
    expect(limited.statusCode).toBe(429);
    expect(createApiFailureEnvelopeSchema().parse(limited.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(Number(limited.headers["retry-after"])).toBe(1);
    expect(attachImageToComposer).toHaveBeenCalledTimes(1);

    finishFirstSend?.();
    expect((await firstPending).statusCode).toBe(200);
    expect((await send("019f7ec2-68eb-7183-bb3a-0e67312a8bf2")).statusCode).toBe(200);
    expect(attachImageToComposer).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("reserves WebSocket capacity before asynchronous ticket validation and releases it on close", async () => {
    const { handle, authorization, port } = await setup(null, 1);
    const issueProtocol = async (): Promise<string> => {
      const response = await handle.app.inject({
        method: "POST",
        url: "/api/ws-ticket",
        headers: {
          host: "pad.example.test",
          origin: "https://pad.example.test",
          authorization,
        },
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as { data: { protocol: string } }).data.protocol;
    };
    const protocols = await Promise.all([issueProtocol(), issueProtocol()]);

    type Attempt =
      | { outcome: "open"; protocol: string; socket: WebSocket }
      | { outcome: "rejected"; protocol: string; statusCode: number };
    const connect = (protocol: string): Promise<Attempt> => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws`,
        [WEB_SOCKET_PROTOCOL, protocol],
        { origin: "https://pad.example.test" },
      );
      socket.on("error", () => undefined);
      return new Promise<Attempt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket admission attempt timed out")), 2_000);
        socket.once("open", () => {
          clearTimeout(timer);
          resolve({ outcome: "open", protocol, socket });
        });
        socket.once("unexpected-response", (_request, response) => {
          clearTimeout(timer);
          response.resume();
          resolve({ outcome: "rejected", protocol, statusCode: response.statusCode ?? 0 });
        });
      });
    };

    const attempts = await Promise.all(protocols.map(connect));
    const opened = attempts.find((attempt): attempt is Extract<Attempt, { outcome: "open" }> => attempt.outcome === "open");
    const rejected = attempts.find((attempt): attempt is Extract<Attempt, { outcome: "rejected" }> => attempt.outcome === "rejected");
    expect(opened).toBeDefined();
    expect(rejected).toMatchObject({ statusCode: 429 });
    await new Promise<void>((resolve) => {
      opened!.socket.once("close", () => resolve());
      opened!.socket.close(1000, "release admission");
    });

    // Capacity rejection occurs before ticket consumption, so retrying the
    // same ticket after release remains a single legitimate use.
    const retried = await connect(rejected!.protocol);
    expect(retried.outcome).toBe("open");
    if (retried.outcome === "open") {
      await new Promise<void>((resolve) => {
        retried.socket.once("close", () => resolve());
        retried.socket.close(1000, "test complete");
      });
    }
  });

  it("counts a credential-free doctor upgrade against the same admission ceiling", async () => {
    const { handle, authorization, port } = await setup(null, 1);
    const doctorSocket = connectTcp(port, "127.0.0.1");
    const upgrade = new Promise<string>((resolve, reject) => {
      let received = "";
      doctorSocket.on("data", (chunk) => {
        received += chunk.toString("latin1");
        if (received.includes("\r\n\r\n")) resolve(received);
      });
      doctorSocket.once("error", reject);
    });
    await new Promise<void>((resolve) => doctorSocket.once("connect", resolve));
    doctorSocket.write([
      "GET /ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Protocol: ${DOCTOR_WSS_SUBPROTOCOL}`,
      "Origin: https://pad.example.test",
      "",
      "",
    ].join("\r\n"));
    await expect(upgrade).resolves.toContain("101 Switching Protocols");

    const ticketResponse = await handle.app.inject({
      method: "POST",
      url: "/api/ws-ticket",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization,
      },
    });
    const ticketProtocol = (ticketResponse.json() as { data: { protocol: string } }).data.protocol;
    const rejected = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      [WEB_SOCKET_PROTOCOL, ticketProtocol],
      { origin: "https://pad.example.test" },
    );
    rejected.on("error", () => undefined);
    const rejectedStatus = await new Promise<number>((resolve, rejectAttempt) => {
      const timer = setTimeout(() => rejectAttempt(new Error("ticket upgrade did not answer")), 2_000);
      rejected.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      rejected.once("open", () => {
        clearTimeout(timer);
        rejectAttempt(new Error("ticket bypassed doctor admission"));
      });
    });
    expect(rejectedStatus).toBe(429);

    // Complete the close handshake manually so the raw client proves that the
    // doctor reservation is released only when the socket actually closes.
    const mask = [1, 2, 3, 4];
    const closeCode = [0x03, 0xe8];
    doctorSocket.write(Buffer.from([
      0x88,
      0x82,
      ...mask,
      closeCode[0]! ^ mask[0]!,
      closeCode[1]! ^ mask[1]!,
    ]));
    await new Promise<void>((resolve) => doctorSocket.once("close", () => resolve()));

    const retried = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      [WEB_SOCKET_PROTOCOL, ticketProtocol],
      { origin: "https://pad.example.test" },
    );
    await new Promise<void>((resolve, rejectAttempt) => {
      retried.once("open", resolve);
      retried.once("error", rejectAttempt);
    });
    await new Promise<void>((resolve) => {
      retried.once("close", () => resolve());
      retried.close(1000, "test complete");
    });
  });

  it("accepts a WebSocket ticket exactly once and rejects bearer or legacy-cookie upgrades", async () => {
    const { handle, authorization, port } = await setup();
    const ticketResponse = await handle.app.inject({
      method: "POST",
      url: "/api/ws-ticket",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization,
      },
    });
    expect(ticketResponse.statusCode).toBe(200);
    const ticketProtocol = (ticketResponse.json() as { data: { protocol: string } }).data.protocol;
    expect(ticketProtocol).toMatch(/^codex-pad\.ticket\.[A-Za-z0-9_-]{43}$/u);

    const first = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      [WEB_SOCKET_PROTOCOL, ticketProtocol],
      { origin: "https://pad.example.test" },
    );
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });
    expect(first.protocol).toBe(WEB_SOCKET_PROTOCOL);
    await new Promise<void>((resolve) => {
      first.once("close", () => resolve());
      first.close(1000, "test complete");
    });

    const rejectedStatus = async (socket: WebSocket): Promise<number> => {
      socket.on("error", () => undefined);
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("unauthenticated upgrade did not answer")), 2_000);
        socket.once("unexpected-response", (_request, response) => {
          clearTimeout(timer);
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        socket.once("open", () => {
          clearTimeout(timer);
          reject(new Error("unauthenticated WebSocket upgraded"));
        });
      });
    };

    expect(await rejectedStatus(new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      [WEB_SOCKET_PROTOCOL, ticketProtocol],
      { origin: "https://pad.example.test" },
    ))).toBe(401);
    expect(await rejectedStatus(new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      WEB_SOCKET_PROTOCOL,
      {
        origin: "https://pad.example.test",
        headers: {
          Authorization: authorization,
          Cookie: "__Host-codex_pad_device=legacy-cookie-value",
        },
      },
    ))).toBe(401);
  });

  it("notices an external CLI revocation and closes the active WebSocket", async () => {
    const { handle, paths, authorization, deviceId, port } = await setup();
    const ticketResponse = await handle.app.inject({
      method: "POST",
      url: "/api/ws-ticket",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization,
      },
    });
    expect(ticketResponse.statusCode).toBe(200);
    const ticketProtocol = (ticketResponse.json() as { data: { protocol: string } }).data.protocol;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      [WEB_SOCKET_PROTOCOL, ticketProtocol],
      { origin: "https://pad.example.test" },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close after external revoke")), 2_000);
      socket.once("close", (closeCode) => { clearTimeout(timer); resolve(closeCode); });
    });
    await new CredentialStore({ paths }).revoke(deviceId);
    const code = await closed;
    expect(code).toBe(4401);
  });

  it("allows the bounded doctor upgrade probe but closes it before application data", async () => {
    const { port } = await setup();
    const messages: unknown[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      DOCTOR_WSS_SUBPROTOCOL,
      { origin: "https://pad.example.test" },
    );
    socket.on("message", (message) => messages.push(message));
    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("doctor probe did not close")), 2_000);
      socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    await opened;
    const closeCode = await closed;

    expect(socket.protocol).toBe(DOCTOR_WSS_SUBPROTOCOL);
    expect(closeCode).toBe(4401);
    expect(messages).toEqual([]);

    const rejected = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      DOCTOR_WSS_SUBPROTOCOL,
      { origin: "https://wrong.example.test" },
    );
    rejected.on("error", () => undefined);
    const statusCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("wrong-origin probe did not answer")), 2_000);
      rejected.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      rejected.once("open", () => {
        clearTimeout(timer);
        reject(new Error("wrong-origin doctor probe upgraded"));
      });
    });
    rejected.terminate();
    expect(statusCode).toBe(403);
  });
});

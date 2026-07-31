import { readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import sharp from "sharp";
import {
  THREADS,
  fixtureCapabilities,
  fixtureContextRoomStatus,
  fixtureRuntimeDiagnostics,
  fixtureSessions,
  fixtureSnapshot,
} from "./fixture-data";

const DIST_ROOT = resolve(process.env.CODEX_PAD_FIXTURE_WEB_ROOT ?? resolve(process.cwd(), "apps/web/dist"));
const DIST_ASSETS = snapshotDistAssets(DIST_ROOT);
const requestedPort = Number(process.env.CODEX_PAD_FIXTURE_PORT ?? 0);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535
  ? requestedPort
  : 0;
const bridgeInstanceId = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
let sequence = 73;
let selectedIndex = 0;
let approvalPending = true;
let productState = {
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
    modelReasoningPresets: [],
    siteFavorites: [],
  },
};
const sockets = new Set<WebSocket>();
const fixtureBearer = "f".repeat(43);
const fixtureDeviceId = "019f7ec2-68eb-7183-bb3a-0e67312a8bc0";
let fixtureDevices = [{ id: fixtureDeviceId, name: "Design QA iPad", createdAt: "2026-07-20T10:00:00.000Z", revokedAt: null as string | null }];
let savedDrawings: Array<Readonly<Record<string, unknown>>> = [];
let diagrams: Array<Readonly<Record<string, unknown>>> = [{
  version: 1,
  diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
  threadId: THREADS[0]!.id,
  revision: 0,
  title: "Agent collaboration loop",
  nodes: [
    { id: "brief", label: "User explains the goal", x: 90, y: 150, width: 270, height: 110, shape: "rectangle", tone: "neutral" },
    { id: "codex", label: "Codex creates a structured diagram", x: 570, y: 120, width: 320, height: 140, shape: "rectangle", tone: "blue" },
    { id: "nerva", label: "Edit blocks and annotate with Pencil", x: 1_040, y: 150, width: 300, height: 110, shape: "ellipse", tone: "violet" },
    { id: "revision", label: "Codex continues the exact revision", x: 570, y: 570, width: 320, height: 130, shape: "rectangle", tone: "green" },
  ],
  edges: [
    { id: "brief_codex", from: "brief", to: "codex", label: "prompt", style: "solid" },
    { id: "codex_nerva", from: "codex", to: "nerva", label: "publish", style: "solid" },
    { id: "nerva_revision", from: "nerva", to: "revision", label: "sync revision", style: "solid" },
    { id: "revision_codex", from: "revision", to: "codex", label: "continue", style: "dashed" },
  ],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: "codex",
  lastEditedBy: "codex",
  sourceLabel: "Fixture agent",
}];
let pushSubscribed = false;
let ticketCounter = 0;
const webSocketTickets = new Map<string, { readonly origin: string; readonly expiresAt: number }>();

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function snapshotDistAssets(root: string): ReadonlyMap<string, Buffer> {
  const assets = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      assets.set(path, readFileSync(path));
    }
  };
  visit(root);
  const indexPath = resolve(root, "index.html");
  if (!assets.has(indexPath)) {
    throw new Error(`Fixture web build is missing ${indexPath}`);
  }
  return assets;
}

function state() {
  return { bridgeInstanceId, sequence, selectedIndex, approvalPending } as const;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function broadcastSnapshot(): void {
  const message = JSON.stringify({ type: "snapshot", snapshot: fixtureSnapshot(state()) });
  sockets.forEach((socket) => {
    if (socket.readyState === socket.OPEN) socket.send(message);
  });
}

async function body(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 36 * 1024 * 1024) throw new Error("Fixture request is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function serveAsset(pathname: string, response: ServerResponse): void {
  let decoded = "/";
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Bad path");
    return;
  }
  const candidate = resolve(DIST_ROOT, `.${decoded}`);
  const insideRoot = candidate === DIST_ROOT || candidate.startsWith(`${DIST_ROOT}${sep}`);
  const file = insideRoot && DIST_ASSETS.has(candidate)
    ? candidate
    : resolve(DIST_ROOT, "index.html");
  const asset = DIST_ASSETS.get(file);
  if (!asset) {
    response.writeHead(500).end("Fixture asset snapshot is incomplete");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
    "cache-control": extname(file) === ".html" ? "no-store" : "public, max-age=60",
    "content-length": asset.byteLength,
  });
  response.end(asset);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (request.method === "POST" && url.pathname === "/api/pair") {
      const payload = await body(request) as { readonly deviceName?: unknown };
      const deviceName = typeof payload.deviceName === "string" ? payload.deviceName.slice(0, 80) : "Fixture iPad";
      json(response, 201, {
        ok: true,
        data: {
          paired: true,
          device: { id: fixtureDeviceId, name: deviceName },
          bearerToken: fixtureBearer,
        },
      });
      return;
    }
    if (url.pathname.startsWith("/api/") && request.headers.authorization !== `Bearer ${fixtureBearer}`) {
      json(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "Pair this fixture iPad first.", retryable: false, details: null } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ws-ticket") {
      const origin = request.headers.origin ?? "";
      ticketCounter += 1;
      const ticket = ticketCounter.toString(36).padStart(43, "t");
      const expiresAt = Date.now() + 30_000;
      webSocketTickets.set(ticket, { origin, expiresAt });
      json(response, 200, {
        ok: true,
        data: { ticket, protocol: `codex-pad.ticket.${ticket}`, expiresAt },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      json(response, 200, { ok: true, data: fixtureSnapshot(state()) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      json(response, 200, {
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
    if (request.method === "GET" && url.pathname === "/api/product-state") {
      json(response, 200, { ok: true, data: productState });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/push") {
      json(response, 200, {
        ok: true,
        data: {
          supported: true,
          subscribed: pushSubscribed,
          publicKey: "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        },
      });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/push/subscription") {
      await body(request);
      pushSubscribed = true;
      json(response, 200, { ok: true, data: { subscribed: true } });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/push/subscription") {
      pushSubscribed = false;
      json(response, 200, { ok: true, data: { subscribed: false } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/devices") {
      json(response, 200, { ok: true, data: { currentDeviceId: fixtureDeviceId, devices: fixtureDevices } });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/devices/")) {
      const deviceId = decodeURIComponent(url.pathname.slice("/api/devices/".length));
      const device = fixtureDevices.find((candidate) => candidate.id === deviceId && candidate.revokedAt === null);
      if (!device) {
        json(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Fixture device was not found.", retryable: false, details: null } });
        return;
      }
      fixtureDevices = fixtureDevices.map((candidate) => candidate.id === deviceId ? { ...candidate, revokedAt: new Date().toISOString() } : candidate);
      json(response, 200, { ok: true, data: { revoked: true, deviceId } });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/product-state") {
      const payload = await body(request) as {
        readonly expectedRevision?: unknown;
        readonly homeLayout?: unknown;
        readonly preferences?: unknown;
      };
      if (payload.expectedRevision !== productState.revision) {
        json(response, 409, { ok: false, error: { code: "CONFLICT", message: "Fixture product state changed.", retryable: false, details: { currentRevision: productState.revision } } });
        return;
      }
      productState = {
        version: 1,
        revision: productState.revision + 1,
        updatedAt: Date.now(),
        homeLayout: payload.homeLayout as typeof productState.homeLayout,
        preferences: payload.preferences as typeof productState.preferences,
      };
      json(response, 200, { ok: true, data: productState });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/saved-drawings") {
      json(response, 200, {
        ok: true,
        data: { drawings: savedDrawings.map(({ pngBase64: _png, sceneJson: _scene, ...summary }) => summary) },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/saved-drawings") {
      const payload = await body(request) as Record<string, unknown>;
      const pngBase64 = String(payload.pngBase64 ?? "");
      const png = Buffer.from(pngBase64, "base64");
      const thumbnailBase64 = (await sharp(png).resize({ width: 360, height: 260, fit: "inside" }).webp({ quality: 74 }).toBuffer()).toString("base64");
      const drawing = {
        ...payload,
        id: randomUUID(),
        byteLength: png.byteLength,
        createdAt: Date.now(),
        thumbnailBase64,
      };
      savedDrawings = [drawing, ...savedDrawings];
      json(response, 201, { ok: true, data: drawing });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/saved-drawings/")) {
      const drawingId = decodeURIComponent(url.pathname.slice("/api/saved-drawings/".length));
      const drawing = savedDrawings.find((candidate) => candidate.id === drawingId);
      if (!drawing) {
        json(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Saved drawing was not found.", retryable: false, details: null } });
        return;
      }
      json(response, 200, { ok: true, data: drawing });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/saved-drawings/")) {
      const drawingId = decodeURIComponent(url.pathname.slice("/api/saved-drawings/".length));
      if (!savedDrawings.some((candidate) => candidate.id === drawingId)) {
        json(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Saved drawing was not found.", retryable: false, details: null } });
        return;
      }
      savedDrawings = savedDrawings.filter((candidate) => candidate.id !== drawingId);
      json(response, 200, { ok: true, data: { deleted: true, drawingId } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/diagrams") {
      const threadId = url.searchParams.get("threadId");
      json(response, 200, {
        ok: true,
        data: {
          diagrams: diagrams
            .filter((diagram) => diagram.threadId === threadId)
            .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt)),
        },
      });
      return;
    }
    if (request.method === "PUT" && url.pathname.startsWith("/api/diagrams/")) {
      const diagramId = decodeURIComponent(url.pathname.slice("/api/diagrams/".length));
      const threadId = url.searchParams.get("threadId");
      const current = diagrams.find((diagram) => diagram.diagramId === diagramId && diagram.threadId === threadId);
      if (!current) {
        json(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Diagram was not found.", retryable: false, details: null } });
        return;
      }
      const payload = await body(request) as Readonly<Record<string, unknown>>;
      if (payload.expectedRevision !== current.revision) {
        json(response, 409, { ok: false, error: { code: "CONFLICT", message: "Diagram changed.", retryable: false, details: { currentRevision: current.revision } } });
        return;
      }
      const { expectedRevision: _expectedRevision, ...editable } = payload;
      const next = {
        ...current,
        ...editable,
        revision: Number(current.revision) + 1,
        updatedAt: Date.now(),
        lastEditedBy: "ipad",
      };
      diagrams = [next, ...diagrams.filter((diagram) => diagram.diagramId !== diagramId)];
      json(response, 200, { ok: true, data: next });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/capabilities") {
      json(response, 200, fixtureCapabilities());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/runtime") {
      json(response, 200, fixtureRuntimeDiagnostics(sequence));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/context-room") {
      json(response, 200, fixtureContextRoomStatus());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/native-sessions") {
      const sessions = fixtureSessions(state());
      json(response, 200, {
        ...sessions,
        data: {
          ...sessions.data,
          registryGeneration: 1,
          sessions: sessions.data.sessions.filter((session) => session.microSlot !== null),
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      json(response, 200, fixtureSessions(state()));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/command") {
      const payload = await body(request) as { readonly command?: Readonly<Record<string, unknown>> };
      const command = payload.command;
      if (!command || typeof command.commandId !== "string") {
        json(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: "Missing command.", retryable: false, details: null } });
        return;
      }
      if (command.type === "selectAgent" && typeof command.slot === "number") {
        selectedIndex = Math.max(0, Math.min(THREADS.length - 1, Math.trunc(command.slot)));
        sequence += 1;
      }
      if (command.type === "openSession" && typeof command.targetThreadId === "string") {
        const targetIndex = THREADS.findIndex((thread) => thread.id === command.targetThreadId);
        if (targetIndex >= 0) {
          selectedIndex = targetIndex;
          sequence += 1;
        }
      }
      if (command.type === "respondToApproval") {
        approvalPending = false;
        sequence += 1;
      }
      json(response, 200, {
        ok: true,
        data: {
          commandId: command.commandId,
          disposition: "accepted",
          status: "succeeded",
          sequence,
          targetThreadId: typeof command.expectedThreadId === "string" ? command.expectedThreadId : null,
          error: null,
        },
      });
      broadcastSnapshot();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Unknown fixture route.", retryable: false, details: null } });
      return;
    }
    serveAsset(url.pathname, response);
  } catch (error) {
    json(response, 500, {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Fixture error",
        retryable: false,
        details: null,
      },
    });
  }
});

const webSockets = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols) {
    return protocols.has("codex-pad.v1") ? "codex-pad.v1" : false;
  },
});
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((protocol) => protocol.trim());
  const ticketProtocol = protocols.find((protocol) => protocol.startsWith("codex-pad.ticket."));
  const ticket = ticketProtocol?.slice("codex-pad.ticket.".length) ?? "";
  const record = webSocketTickets.get(ticket);
  webSocketTickets.delete(ticket);
  if (
    !protocols.includes("codex-pad.v1")
    || record === undefined
    || record.expiresAt <= Date.now()
    || record.origin !== (request.headers.origin ?? "")
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
});
webSockets.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "hello") socket.send(JSON.stringify({ type: "snapshot", snapshot: fixtureSnapshot(state()) }));
      if (message.type === "ping" && typeof message.nonce === "string") {
        socket.send(JSON.stringify({ type: "pong", nonce: message.nonce }));
      }
    } catch {
      // The fixture ignores malformed client frames; production validation lives in the bridge.
    }
  });
  socket.on("close", () => sockets.delete(socket));
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port");
  process.stdout.write(`Codex Pad synthetic fixture: http://127.0.0.1:${address.port}\n`);
  process.stdout.write("Test-only data; no Codex Desktop or Tailscale connection is active.\n");
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  sockets.forEach((socket) => socket.terminate());
  webSockets.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

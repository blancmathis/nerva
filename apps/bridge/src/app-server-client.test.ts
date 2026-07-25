import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  AppServerClient,
  AppServerClientError,
  validateManagedSocketPath,
  type AppServerWriteAuthorityIssuer,
  type JsonlDuplex,
} from "./app-server-client.js";

class FakeJsonlDuplex implements JsonlDuplex {
  readonly writes: UnknownFrame[] = [];
  readonly readable: AsyncIterable<Uint8Array | string>;
  onWrite: (frame: UnknownFrame) => void = () => undefined;
  writeError: Error | null = null;
  rejectWriteAsynchronously = false;
  hangWrite = false;
  private readonly chunks: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;

  constructor() {
    const self = this;
    this.readable = {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        while (true) {
          if (self.chunks.length > 0) {
            const chunk = self.chunks.shift();
            if (chunk !== undefined) yield chunk;
            continue;
          }
          if (self.ended) return;
          await new Promise<void>((resolve) => self.waiters.push(resolve));
        }
      },
    };
  }

  write(data: string): Promise<void> | void {
    for (const line of data.split("\n")) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as UnknownFrame;
      this.writes.push(frame);
      this.onWrite(frame);
    }
    if (this.writeError !== null) {
      if (this.rejectWriteAsynchronously) return Promise.reject(this.writeError);
      throw this.writeError;
    }
    if (this.hangWrite) return new Promise<void>(() => undefined);
  }

  close(): void {
    this.ended = true;
    this.wake();
  }

  push(frame: unknown): void {
    this.pushRaw(`${JSON.stringify(frame)}\n`);
  }

  pushRaw(data: string): void {
    this.chunks.push(data);
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiters.shift();
    waiter?.();
  }
}

type UnknownFrame = Record<string, unknown>;

function initializedFake(
  timeoutMs = 100,
  transportKind: "managed-proxy" | "injected" = "injected",
): {
  fake: FakeJsonlDuplex;
  client: AppServerClient;
  writeAuthority?: AppServerWriteAuthorityIssuer;
  initialize: Promise<unknown>;
} {
  const fake = new FakeJsonlDuplex();
  fake.onWrite = (frame) => {
    if (frame.method === "initialize") {
      fake.push({ id: frame.id, result: { userAgent: "codex-test/0.145.0" } });
    }
  };
  if (transportKind === "managed-proxy") {
    const connection = AppServerClient.createOwnedManagedConnection(fake, {
      requestTimeoutMs: timeoutMs,
    });
    return {
      fake,
      client: connection.client,
      writeAuthority: connection.writeAuthority,
      initialize: connection.client.initialize(),
    };
  }
  const client = new AppServerClient(fake, { requestTimeoutMs: timeoutMs });
  return { fake, client, initialize: client.initialize() };
}

describe("AppServerClient", () => {
  it("initializes with supported capabilities and correlates responses", async () => {
    const { fake, client, initialize } = initializedFake();
    await expect(initialize).resolves.toMatchObject({ userAgent: "codex-test/0.145.0" });

    fake.onWrite = (frame) => {
      if (frame.method === "thread/read") {
        fake.push({ id: frame.id, result: { thread: { id: "exact" } } });
      }
    };
    await expect(client.call("thread/read", { threadId: "exact" })).resolves.toEqual({
      thread: { id: "exact" },
    });

    expect(fake.writes[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "codex-pad", title: "Codex Pad" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
    expect(fake.writes[1]).toEqual({ method: "initialized" });
    await client.close();
  });

  it("ignores malformed frames, reports them, and keeps parsing", async () => {
    const { fake, client, initialize } = initializedFake();
    await initialize;
    const protocolErrors: AppServerClientError[] = [];
    const notifications: string[] = [];
    client.onProtocolError((error) => protocolErrors.push(error));
    client.onNotification((notification) => notifications.push(notification.method));

    fake.pushRaw("{ definitely-not-json\n");
    fake.push({ method: "thread/status/changed", params: { threadId: "still-alive" } });

    await vi.waitFor(() => {
      expect(protocolErrors).toHaveLength(1);
      expect(notifications).toEqual(["thread/status/changed"]);
    });
    expect(protocolErrors[0]?.code).toBe("PROTOCOL_MALFORMED_FRAME");
    await client.close();
  });

  it("rejects requests at the bounded timeout", async () => {
    const { client, initialize } = initializedFake(25);
    await initialize;
    await expect(client.call("thread/read", { threadId: "no-response" })).rejects.toMatchObject({
      code: "APP_SERVER_TIMEOUT",
    });
    await client.close();
  });

  it("marks a mutating request timeout as delivery-unknown after write", async () => {
    const { client, initialize } = initializedFake(25);
    await initialize;
    await expect(client.mutate("turn/start", { threadId: "exact" })).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { phase: "post-write", clientCode: "APP_SERVER_TIMEOUT" },
    });
    await client.close();
  });

  it("does not let a stalled stream callback suppress mutation and approval-response timeouts", async () => {
    const mutation = initializedFake(25);
    await mutation.initialize;
    mutation.fake.hangWrite = true;
    await expect(mutation.client.mutate("turn/start", { threadId: "exact" })).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { clientCode: "APP_SERVER_TIMEOUT" },
    });
    await mutation.client.close();

    const approval = initializedFake(25);
    await approval.initialize;
    approval.fake.hangWrite = true;
    await expect(approval.client.respond(22, { decision: "decline" })).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { clientCode: "APP_SERVER_TIMEOUT" },
    });
    await approval.client.close();
  });

  it("marks an asynchronous mutation write failure as delivery-unknown but keeps query failures definitive", async () => {
    const mutation = initializedFake();
    await mutation.initialize;
    mutation.fake.writeError = new Error("stream callback failed after buffering");
    mutation.fake.rejectWriteAsynchronously = true;
    await expect(mutation.client.mutate("turn/start", { threadId: "exact" })).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { phase: "post-write" },
    });
    await mutation.client.close();

    const query = initializedFake();
    await query.initialize;
    const definitive = new Error("query write failed");
    query.fake.writeError = definitive;
    query.fake.rejectWriteAsynchronously = true;
    await expect(query.client.call("thread/read", { threadId: "exact" })).rejects.toBe(definitive);
    await query.client.close();
  });

  it("marks an approval response write failure as delivery-unknown", async () => {
    const { client, fake, initialize } = initializedFake();
    await initialize;
    fake.writeError = new Error("approval response callback failed");
    fake.rejectWriteAsynchronously = true;
    await expect(client.respond(17, { decision: "accept" })).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { phase: "post-write" },
    });
    await client.close();
  });

  it("keeps closed and serialization failures definitive before a mutation write", async () => {
    const closed = initializedFake();
    await closed.initialize;
    await closed.client.close();
    await expect(closed.client.mutate("turn/start", {})).rejects.toMatchObject({
      code: "APP_SERVER_CLOSED",
    });

    const serialization = initializedFake();
    await serialization.initialize;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(serialization.client.mutate("turn/start", cyclic)).rejects.not.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
    });
    await serialization.client.close();
  });

  it("requires a current one-shot authority token at the exact managed stream-write boundary", async () => {
    const { fake, client, writeAuthority, initialize } = initializedFake(100, "managed-proxy");
    await initialize;
    expect(writeAuthority).toBeDefined();
    const mutationWrites = (): UnknownFrame[] => fake.writes.filter((frame) =>
      frame.method === "turn/start"
    );

    await expect(client.mutate("turn/start", { threadId: "exact" })).rejects.toMatchObject({
      code: "APP_SERVER_AUTHORITY_STALE",
      detail: { phase: "pre-write" },
    });
    expect(mutationWrites()).toHaveLength(0);

    const revoked = writeAuthority!.issue(() => undefined);
    writeAuthority!.revoke();
    await expect(
      client.mutate("turn/start", { threadId: "exact" }, revoked),
    ).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    expect(mutationWrites()).toHaveLength(0);

    let topologyCurrent = true;
    const staleTopology = writeAuthority!.issue(() => {
      if (!topologyCurrent) throw new Error("topology changed during target refresh");
    });
    topologyCurrent = false;
    await expect(
      client.mutate("turn/start", { threadId: "exact" }, staleTopology),
    ).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    expect(mutationWrites()).toHaveLength(0);

    fake.onWrite = (frame) => {
      if (frame.method === "turn/start") {
        fake.push({ id: frame.id, result: { turn: { id: "turn-exact" } } });
      }
    };
    const current = writeAuthority!.issue(() => undefined);
    await expect(
      client.mutate("turn/start", { threadId: "exact" }, current),
    ).resolves.toMatchObject({ turn: { id: "turn-exact" } });
    expect(mutationWrites()).toHaveLength(1);
    await expect(
      client.mutate("turn/start", { threadId: "exact" }, current),
    ).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    expect(mutationWrites()).toHaveLength(1);
    await client.close();
  });

  it("checks approval-response authority synchronously before writing a managed response", async () => {
    const { fake, client, writeAuthority, initialize } = initializedFake(100, "managed-proxy");
    await initialize;
    expect(writeAuthority).toBeDefined();
    const writesBefore = fake.writes.length;
    const token = writeAuthority!.issue(() => undefined);
    writeAuthority!.revoke();

    await expect(client.respond(17, { decision: "accept" }, token)).rejects.toMatchObject({
      code: "APP_SERVER_AUTHORITY_STALE",
      detail: { phase: "pre-write" },
    });
    expect(fake.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it("rejects caller-classified or unknown methods and exposes no public notification sender", async () => {
    const { fake, client, initialize } = initializedFake(100, "managed-proxy");
    await initialize;
    const writesBefore = fake.writes.length;

    await expect(client.call("turn/start", { threadId: "exact" })).rejects.toMatchObject({
      code: "APP_SERVER_METHOD_NOT_ALLOWED",
      detail: { phase: "pre-write", method: "turn/start" },
    });
    await expect(client.mutate("thread/read", { threadId: "exact" })).rejects.toMatchObject({
      code: "APP_SERVER_METHOD_NOT_ALLOWED",
      detail: { phase: "pre-write", method: "thread/read" },
    });
    expect((client as unknown as Record<string, unknown>).notify).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).rawRequest).toBeUndefined();

    expect(fake.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it("does not expose authority issuance or revocation to a managed client holder", async () => {
    const { client, initialize } = initializedFake(100, "managed-proxy");
    await initialize;

    expect((client as unknown as Record<string, unknown>).issueWriteAuthority).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).revokeWriteAuthorities).toBeUndefined();
    await client.close();
  });

  it("consumes authority before a validation callback can re-enter or throw", async () => {
    const { fake, client, writeAuthority, initialize } = initializedFake(100, "managed-proxy");
    await initialize;
    expect(writeAuthority).toBeDefined();
    fake.onWrite = (frame) => {
      if (frame.method === "turn/start") {
        fake.push({ id: frame.id, result: { turn: { id: "turn-exact" } } });
      }
    };

    let nested: Promise<unknown> | undefined;
    let reentrantToken: Parameters<AppServerClient["mutate"]>[2];
    reentrantToken = writeAuthority!.issue(() => {
      nested = client.mutate("turn/start", { threadId: "nested" }, reentrantToken);
    });
    await expect(
      client.mutate("turn/start", { threadId: "outer" }, reentrantToken),
    ).resolves.toMatchObject({ turn: { id: "turn-exact" } });
    await expect(nested).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    expect(fake.writes.filter((frame) => frame.method === "turn/start")).toHaveLength(1);

    const throwing = writeAuthority!.issue(() => {
      throw new Error("topology changed");
    });
    await expect(
      client.mutate("turn/start", { threadId: "throwing" }, throwing),
    ).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    await expect(
      client.mutate("turn/start", { threadId: "retry" }, throwing),
    ).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });

    const asynchronous = writeAuthority!.issue(async () => undefined);
    await expect(
      client.mutate("turn/start", { threadId: "async-check" }, asynchronous),
    ).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    expect(fake.writes.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
    await client.close();
  });

  it("fails closed when the configured managed socket does not exist", () => {
    const missing = `/private/tmp/codex-pad-missing-${process.pid}.sock`;
    expect(() => validateManagedSocketPath(missing)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANAGED_SOCKET" }),
    );
  });

  it("uses the managed daemon's WebSocket protocol over its private Unix socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-managed-websocket-"));
    const binaryPath = join(root, "codex");
    const socketPath = join(root, "app-server.sock");
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n");
    await chmod(binaryPath, 0o700);
    const server = createServer();
    const websocketServer = new WebSocketServer({ server });
    const methods: string[] = [];
    websocketServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as UnknownFrame;
        if (typeof frame.method === "string") methods.push(frame.method);
        if (frame.method === "initialize") {
          socket.send(JSON.stringify({ id: frame.id, result: { userAgent: "codex-test/managed-websocket" } }));
        }
        if (frame.method === "model/list") {
          socket.send(JSON.stringify({ id: frame.id, result: { data: [], nextCursor: null } }));
        }
      });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    await chmod(socketPath, 0o600);

    try {
      const { client } = await AppServerClient.connectManaged({
        codexBinaryPath: binaryPath,
        socketPath,
        requestTimeoutMs: 1_000,
      });
      await expect(client.call("model/list", { limit: 1 })).resolves.toEqual({
        data: [],
        nextCursor: null,
      });
      expect(methods).toEqual(["initialize", "initialized", "model/list"]);
      await client.close();
    } finally {
      for (const socket of websocketServer.clients) socket.terminate();
      await new Promise<void>((resolveClose) => websocketServer.close(() => resolveClose()));
      await rm(root, { recursive: true, force: true });
    }
  });
});

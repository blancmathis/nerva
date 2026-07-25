import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppServerClient,
  AppServerClientError,
  type AppServerWriteAuthorityIssuer,
  type ManagedAppServerConnection,
} from "../src/app-server-client.js";
import {
  managedRetryDelay,
  ReconnectingManagedTransport,
} from "../src/managed-transport-provider.js";
import { createExactTargetAuthorityDomain } from "../src/exact-target-authority.js";
import type { NativeMutationAuthorityToken } from "../src/thread-transport.js";

const THREAD_ID = "019f7ec2-68eb-7183-8b3a-0e67312a8ba1";

function ownershipEvidence(listenerGeneration = "20") {
  return {
    socket: {
      path: "/private/tmp/codex-pad-managed.sock",
      device: "1",
      inode: "2",
      uid: process.getuid?.() ?? 501,
      listenerAddress: "b0",
      listenerKernelInode: "b1",
      listenerGeneration,
    },
    daemon: { pid: 201, startedAt: "Mon Jul 20 10:00:00 2026" },
    desktop: {
      pid: 101,
      startedAt: "Mon Jul 20 09:59:00 2026",
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      bundleId: "com.openai.codex",
      appVersion: "26.test",
      buildVersion: "5591",
    },
    desktopClient: {
      kind: "managed-proxy" as const,
      pid: 301,
      startedAt: "Mon Jul 20 10:01:00 2026",
      serverEndpointAddress: "b2",
      serverEndpointGeneration: "22",
      clientEndpointAddress: "b3",
      clientEndpointGeneration: "21",
    },
    codex: {
      binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      binaryVersion: "codex-cli test",
    },
  };
}

function verifiedOwnership(listenerGeneration = "20") {
  return {
    verifyDesktopProcessAtWriteBoundary: vi.fn(() => true),
    verify: vi.fn(async () => ({
      verified: true as const,
      canCreate: false as const,
      code: "verified" as const,
      summary: "verified test ownership",
      currentEvidence: ownershipEvidence(listenerGeneration),
    })),
  };
}

interface FakeManagedClient {
  readonly client: AppServerClient;
  readonly connection: ManagedAppServerConnection;
  readonly streamWrites: readonly string[];
  close(): void;
  onIssue(listener: () => void): void;
  setConnectedListenerGeneration(generation: string): void;
}

function fakeManagedClient(connectedListenerGeneration = "20"): FakeManagedClient {
  const closeListeners: Array<(error: AppServerClientError) => void> = [];
  const streamWrites: string[] = [];
  let authorityEpoch = 0;
  let currentListenerGeneration = connectedListenerGeneration;
  let issueListener = (): void => undefined;
  type FakeAuthority = {
    readonly epoch: number;
    readonly assertCurrent: () => void;
    used: boolean;
  };
  const consumeAuthority = (authority: FakeAuthority | undefined): void => {
    if (authority === undefined || authority.epoch !== authorityEpoch || authority.used) {
      throw new AppServerClientError(
        "APP_SERVER_AUTHORITY_STALE",
        "Managed app-server write authority changed before dispatch.",
        { phase: "pre-write" },
      );
    }
    authority.used = true;
    try {
      authority.assertCurrent();
    } catch {
      throw new AppServerClientError(
        "APP_SERVER_AUTHORITY_STALE",
        "Managed app-server write authority changed before dispatch.",
        { phase: "pre-write" },
      );
    }
  };
  const value = {
    isInitialized: true,
    isClosed: false,
    transportKind: "managed-proxy",
    serverInfo: { userAgent: "codex-test/1.0" },
    onNotification: vi.fn(),
    onServerRequest: vi.fn(),
    onClose: vi.fn((listener: (error: AppServerClientError) => void) => closeListeners.push(listener)),
    close: vi.fn(async () => undefined),
    call: vi.fn(async (method: string) => {
      if (method !== "thread/read") return { data: [] };
      return {
        thread: {
          id: THREAD_ID,
          status: { type: "idle" },
          cwd: "/private/tmp/codex-pad-test",
          turns: [],
        },
      };
    }),
    mutate: vi.fn(async (method: string, _params: unknown, authority?: FakeAuthority) => {
      consumeAuthority(authority);
      streamWrites.push(method);
      if (method === "thread/settings/update") return {};
      return {
        thread: {
          id: THREAD_ID,
          status: { type: "idle" },
          cwd: "/private/tmp/codex-pad-test",
          turns: [],
        },
      };
    }),
    consumeWriteAuthority: vi.fn((authority: FakeAuthority) => consumeAuthority(authority)),
  };
  const writeAuthority = {
    revoke: vi.fn(() => { authorityEpoch += 1; }),
    issue: vi.fn((assertCurrent: () => void) => {
      const token = { epoch: authorityEpoch, assertCurrent, used: false };
      issueListener();
      return token;
    }),
  } as unknown as AppServerWriteAuthorityIssuer;
  Object.assign(value, {
    verifyManagedSocketPeer: vi.fn(async (expected: {
      socket: { listenerGeneration: string };
    }) => expected.socket.listenerGeneration === currentListenerGeneration),
    verifyManagedSocketPeerAtWriteBoundary: vi.fn((expected: {
      socket: { listenerGeneration: string };
    }) => expected.socket.listenerGeneration === currentListenerGeneration),
  });
  const client = value as unknown as AppServerClient;
  const connection = { client, writeAuthority };
  return {
    client,
    connection,
    streamWrites,
    close: () => {
      value.isClosed = true;
      const error = new AppServerClientError(
        "MANAGED_PROXY_EXITED",
        "The fake managed transport closed.",
      );
      for (const listener of closeListeners) listener(error);
    },
    onIssue: (listener) => { issueListener = listener; },
    setConnectedListenerGeneration: (generation) => {
      currentListenerGeneration = generation;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReconnectingManagedTransport", () => {
  it("computes bounded exponential delays with deterministic equal jitter", () => {
    expect(managedRetryDelay(1, 100, 800, () => 0)).toBe(50);
    expect(managedRetryDelay(2, 100, 800, () => 1)).toBe(200);
    expect(managedRetryDelay(20, 100, 800, () => 1)).toBe(800);
    expect(managedRetryDelay(20, 100, 800, () => 0)).toBe(400);
  });

  it("backs failed connection attempts off exponentially without a timer loop", async () => {
    let now = 0;
    const connect = vi.spyOn(AppServerClient, "connectManaged")
      .mockRejectedValue(new Error("managed daemon unavailable"));
    const transport = new ReconnectingManagedTransport({
      now: () => now,
      random: () => 1,
      retryDelayMs: 100,
      retryMaxDelayMs: 400,
    });

    const firstHealth = await transport.health();
    expect(firstHealth).toMatchObject({
      connected: false,
      detail: "Managed app-server connection failed",
    });
    expect(firstHealth.detail).not.toContain("managed daemon unavailable");
    expect(connect).toHaveBeenCalledTimes(1);

    now = 99;
    await transport.health();
    expect(connect).toHaveBeenCalledTimes(1);

    now = 100;
    await transport.health();
    expect(connect).toHaveBeenCalledTimes(2);

    now = 299;
    await transport.health();
    expect(connect).toHaveBeenCalledTimes(2);

    now = 300;
    await transport.health();
    expect(connect).toHaveBeenCalledTimes(3);

    now = 699;
    await transport.health();
    expect(connect).toHaveBeenCalledTimes(3);

    now = 700;
    await transport.health();
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("resets the failure count after success and uses the initial delay after disconnect", async () => {
    let now = 0;
    const firstClient = fakeManagedClient();
    const secondClient = fakeManagedClient();
    const connect = vi.spyOn(AppServerClient, "connectManaged")
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce(firstClient.connection)
      .mockResolvedValueOnce(secondClient.connection);
    const transport = new ReconnectingManagedTransport({
      now: () => now,
      random: () => 1,
      retryDelayMs: 100,
      retryMaxDelayMs: 800,
      ownershipVerifier: verifiedOwnership(),
    });

    await transport.health();
    now = 100;
    await expect(transport.health()).resolves.toMatchObject({ connected: true });
    expect(connect).toHaveBeenCalledTimes(2);

    firstClient.close();
    now = 199;
    await expect(transport.health()).resolves.toMatchObject({ connected: false });
    expect(connect).toHaveBeenCalledTimes(2);

    now = 200;
    await expect(transport.health()).resolves.toMatchObject({ connected: true });
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("allows only exact-target writes when ownership is unattested", async () => {
    const managed = fakeManagedClient();
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managed.connection);
    const targetAuthority = createExactTargetAuthorityDomain();
    const verifier = {
      verify: vi.fn(async () => ({
        verified: false as const,
        canCreate: false as const,
        code: "attestation-missing" as const,
        summary: "Shared Desktop ownership has not been attested; app-server mutations are disabled.",
      })),
    };
    const transport = new ReconnectingManagedTransport({
      ownershipVerifier: verifier,
      targetAuthorityConsumer: targetAuthority.providerConsumer,
    });

    await expect(transport.health()).resolves.toMatchObject({
      connected: true,
      initialized: true,
      desktopOwnershipVerified: false,
      detail: "Shared Desktop ownership has not been attested; app-server mutations are disabled.",
    });
    await expect(
      transport.newThread({ commandId: "command-provider-guard-0001" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const exactTargetGuard = async () => targetAuthority.stateIssuer.issue(() => undefined);
    await expect(transport.selectThread(THREAD_ID, exactTargetGuard)).resolves.toMatchObject({
      threadId: THREAD_ID,
      status: "idle",
    });
    await expect(transport.setReasoning({
      commandId: "command-provider-target-0001",
      threadId: THREAD_ID,
      effort: "high",
      assertTargetAuthority: exactTargetGuard,
    })).resolves.toMatchObject({ threadId: THREAD_ID });
    expect(managed.streamWrites).toEqual(["thread/resume", "thread/settings/update"]);
    await transport.close();
  });

  it("returns the exact verified Desktop identity for native reads without minting write authority", async () => {
    const managed = fakeManagedClient();
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managed.connection);
    const transport = new ReconnectingManagedTransport({ ownershipVerifier: verifiedOwnership() });

    await expect(transport.health()).resolves.toMatchObject({
      connected: true,
      desktopOwnershipVerified: true,
    });
    await expect(transport.refreshDesktopOwnershipIdentity()).resolves.toEqual({
      pid: 101,
      startedAt: "Mon Jul 20 09:59:00 2026",
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      bundleId: "com.openai.codex",
    });
    expect(managed.connection.writeAuthority.issue).not.toHaveBeenCalled();
    expect(managed.streamWrites).toEqual([]);
    await transport.close();
  });

  it("closes socket-A delegate without dispatch when attestation resolves replacement socket B", async () => {
    const managedOnSocketA = fakeManagedClient("10");
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managedOnSocketA.connection);
    const transport = new ReconnectingManagedTransport({
      ownershipVerifier: verifiedOwnership("20"),
      retryDelayMs: 60_000,
    });

    await expect(transport.health()).resolves.toMatchObject({
      connected: false,
      desktopOwnershipVerified: false,
      detail: "Managed app-server connection failed",
    });
    await expect(
      transport.newThread({ commandId: "command-socket-generation-0001" }),
    ).rejects.toMatchObject({ code: "APP_SERVER_UNAVAILABLE" });
    expect(managedOnSocketA.client.verifyManagedSocketPeer).toHaveBeenCalledTimes(1);
    expect(managedOnSocketA.client.close).toHaveBeenCalledTimes(1);
    expect(managedOnSocketA.client.mutate).not.toHaveBeenCalled();
    await transport.close();
  });

  it("revokes an issued topology token before stream write when a concurrent health probe begins", async () => {
    const managed = fakeManagedClient();
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managed.connection);
    const transport = new ReconnectingManagedTransport({ ownershipVerifier: verifiedOwnership() });
    await expect(transport.health()).resolves.toMatchObject({
      connected: true,
      desktopOwnershipVerified: true,
    });

    let concurrentRefresh: Promise<unknown> | undefined;
    managed.onIssue(() => {
      queueMicrotask(() => {
        concurrentRefresh = transport.health();
      });
    });
    await expect(
      transport.newThread({ commandId: "command-provider-token-race-0001" }),
    ).rejects.toMatchObject({
      code: "APP_SERVER_AUTHORITY_STALE",
      detail: { phase: "pre-write" },
    });
    await concurrentRefresh;
    expect(managed.streamWrites).toEqual([]);
    await transport.close();
  });

  it("rechecks the exact listener synchronously when its generation changes after token issue", async () => {
    const managed = fakeManagedClient();
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managed.connection);
    const transport = new ReconnectingManagedTransport({ ownershipVerifier: verifiedOwnership() });
    await expect(transport.health()).resolves.toMatchObject({
      connected: true,
      desktopOwnershipVerified: true,
    });
    managed.onIssue(() => managed.setConnectedListenerGeneration("30"));

    await expect(
      transport.newThread({ commandId: "command-provider-sync-generation-0001" }),
    ).rejects.toMatchObject({
      code: "APP_SERVER_AUTHORITY_STALE",
      detail: { phase: "pre-write" },
    });
    expect(managed.streamWrites).toEqual([]);
    await transport.close();
  });

  it("rejects an app-server write when the attested Desktop process generation changes after issue", async () => {
    const managed = fakeManagedClient();
    const verifier = verifiedOwnership();
    let desktopProcessCurrent = true;
    verifier.verifyDesktopProcessAtWriteBoundary.mockImplementation(() => desktopProcessCurrent);
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managed.connection);
    const transport = new ReconnectingManagedTransport({ ownershipVerifier: verifier });
    await transport.health();
    managed.onIssue(() => { desktopProcessCurrent = false; });

    await expect(
      transport.newThread({ commandId: "command-provider-desktop-generation-0001" }),
    ).rejects.toMatchObject({
      code: "APP_SERVER_AUTHORITY_STALE",
      detail: { phase: "pre-write" },
    });
    expect(managed.streamWrites).toEqual([]);
    await transport.close();
  });

  it("consumes a paired exact-target and ownership permit once at the native dispatch boundary", async () => {
    const managed = fakeManagedClient();
    const targetAuthority = createExactTargetAuthorityDomain();
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managed.connection);
    const transport = new ReconnectingManagedTransport({
      ownershipVerifier: verifiedOwnership(),
      targetAuthorityConsumer: targetAuthority.providerConsumer,
    });
    await expect(transport.health()).resolves.toMatchObject({
      connected: true,
      desktopOwnershipVerified: true,
    });

    let targetCurrent = true;
    let guardedIdentity: unknown;
    const permit = await transport.acquireNativeMutationAuthority(async (desktopIdentity) => {
      guardedIdentity = desktopIdentity;
      return targetAuthority.stateIssuer.issue(() => {
        if (!targetCurrent) throw new Error("native target changed");
      });
    });
    expect(guardedIdentity).toEqual(permit.desktopIdentity);
    targetCurrent = false;

    expect(permit.desktopIdentity).toEqual({
      pid: 101,
      startedAt: "Mon Jul 20 09:59:00 2026",
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      bundleId: "com.openai.codex",
    });
    expect(() => transport.consumeNativeMutationAuthority(permit.authority)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_AUTHORITY_STALE" }),
    );
    expect(() => transport.consumeNativeMutationAuthority(permit.authority)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_AUTHORITY_STALE" }),
    );
    expect(() => transport.consumeNativeMutationAuthority(
      Object.freeze({}) as NativeMutationAuthorityToken,
    )).toThrowError(expect.objectContaining({ code: "APP_SERVER_AUTHORITY_STALE" }));
    expect(managed.streamWrites).toEqual([]);
    await transport.close();
  });

  it("rechecks listener generation when a native permit reaches its dispatch sink", async () => {
    const managed = fakeManagedClient();
    const targetAuthority = createExactTargetAuthorityDomain();
    vi.spyOn(AppServerClient, "connectManaged").mockResolvedValueOnce(managed.connection);
    const transport = new ReconnectingManagedTransport({
      ownershipVerifier: verifiedOwnership(),
      targetAuthorityConsumer: targetAuthority.providerConsumer,
    });
    await transport.health();
    const permit = await transport.acquireNativeMutationAuthority(async () =>
      targetAuthority.stateIssuer.issue(() => undefined)
    );
    managed.setConnectedListenerGeneration("30");

    expect(() => transport.consumeNativeMutationAuthority(permit.authority)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_AUTHORITY_STALE" }),
    );
    expect(managed.streamWrites).toEqual([]);
    await transport.close();
  });

  it("never reconnects after explicit close", async () => {
    let now = 0;
    const connect = vi.spyOn(AppServerClient, "connectManaged")
      .mockRejectedValue(new Error("managed daemon unavailable"));
    const transport = new ReconnectingManagedTransport({
      now: () => now,
      random: () => 1,
      retryDelayMs: 100,
    });

    await transport.health();
    await transport.close();
    now = 10_000;
    await expect(transport.health()).resolves.toMatchObject({ connected: false });
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterState,
  CodexDesktopAdapter,
  DesktopProcessIdentity,
} from "@codex-pad/codex-desktop";

import { createExactTargetAuthorityDomain } from "../src/exact-target-authority.js";
import { defaultDataPaths } from "../src/paths.js";
import { SessionsService } from "../src/sessions.js";
import { BridgeStateService } from "../src/state.js";
import {
  ThreadTransportError,
  type NativeMutationAuthorityToken,
  type ThreadTransport,
  type TransportHealth,
} from "../src/thread-transport.js";

const THREAD_A = "019f7ec2-68eb-7183-8b3a-0e67312a8ba1";
const THREAD_B = "019f7ec2-68eb-7183-9b3a-0e67312a8ba2";
const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 42,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/Codex.app",
  executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  bundleId: "com.openai.codex",
};

function nativeState(activeThreadId: string): AdapterState {
  return {
    stale: false,
    health: { status: "ready", reasons: [], changedAt: 1 },
    snapshot: {
      // THREAD_B deliberately remains outside the six Micro slots. A deep-link
      // postcondition is the exact active Desktop task, not slot membership.
      slots: [0, 1, 2, 3, 4, 5].map((index) => ({
        index,
        key: `AG0${index}`,
        threadId: index === 0 ? THREAD_A : null,
        title: index === 0 ? "Task A" : null,
        status: index === 0 ? "idle" : "off",
        nativeStatus: index === 0 ? "idle" : "off",
        selected: index === 0 && activeThreadId === THREAD_A,
        activityAt: null,
        activityLabel: null,
      })) as unknown as NonNullable<AdapterState["snapshot"]>["slots"],
      activeThreadId,
      agentSource: "pinned",
      actionLayout: [
        { slot: "ACT06", keycapId: "FAST", commandId: "mode.fast" },
        { slot: "ACT07", keycapId: "SPLIT", commandId: "thread.fork" },
        { slot: "ACT08", keycapId: "MIC", commandId: "dictation.toggle" },
        { slot: "ACT09", keycapId: "CODEX", commandId: "composer.submit" },
        { slot: "ACT10_ACT11", keycapId: "FAST", commandId: "mode.fast" },
        { slot: "ACT12", keycapId: "SPLIT", commandId: "thread.fork" },
      ],
      joystickLayout: {
        up: { direction: "up", type: "command", commandId: "mode.plan" },
        right: { direction: "right", type: "command", commandId: "nav.forward" },
        down: { direction: "down", type: "command", commandId: "skill.one" },
        left: { direction: "left", type: "command", commandId: "nav.back" },
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

function slottedNativeState(activeThreadId: string): AdapterState {
  const state = nativeState(activeThreadId);
  if (state.snapshot === null) throw new Error("Expected a native snapshot");
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      slots: state.snapshot.slots.map((slot, index) => {
        const threadId = index === 0 ? THREAD_A : index === 1 ? THREAD_B : null;
        return {
          ...slot,
          threadId,
          title: threadId === null ? null : `Task ${index === 0 ? "A" : "B"}`,
          status: threadId === null ? "off" : "idle",
          nativeStatus: threadId === null ? "off" : "idle",
          selected: threadId === activeThreadId,
        };
      }) as unknown as NonNullable<AdapterState["snapshot"]>["slots"],
    },
  };
}

function transportFixture(): {
  transport: ThreadTransport;
  consume: ReturnType<typeof vi.fn>;
} {
  const permits = new WeakSet<object>();
  const health: TransportHealth = {
    mode: "managed-control-socket",
    connected: true,
    initialized: true,
    selectedThreadId: null,
    localImageSteerVerified: true,
    multiImageInputVerified: true,
    desktopOwnershipVerified: true,
    serverUserAgent: "codex-test/0.145.0",
    queuedSketches: 0,
  };
  const consume = vi.fn((authority: NativeMutationAuthorityToken) => {
    if (!permits.delete(authority as object)) throw new Error("stale native mutation permit");
  });
  const transport = {
    health: vi.fn(async () => health),
    listSkills: vi.fn(async () => []),
    listPendingApprovals: vi.fn(() => []),
    clearSelectedThread: vi.fn(),
    listSessions: vi.fn(async () => [{
      threadId: THREAD_A,
      title: "Task A",
      cwd: "/workspace/task-a",
      updatedAt: 1,
      status: "idle" as const,
    }]),
    acquireNativeMutationAuthority: vi.fn(async () => {
      const authority = Object.freeze({});
      permits.add(authority);
      return {
        authority: authority as NativeMutationAuthorityToken,
        desktopIdentity: DESKTOP_IDENTITY,
      };
    }),
    consumeNativeMutationAuthority: consume,
  } as unknown as ThreadTransport;
  return { transport, consume };
}

describe("SessionsService exact deep-link selection", () => {
  it("restores the last Mac session catalog after a bridge restart while app-server is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-session-catalog-"));
    try {
      const adapter = {
        refresh: vi.fn(async () => nativeState(THREAD_A)),
        close: vi.fn(),
      } as unknown as CodexDesktopAdapter;
      const { transport } = transportFixture();
      const listSessions = vi.mocked(transport.listSessions);
      listSessions.mockResolvedValueOnce([{
        threadId: THREAD_B,
        title: "Pinned task B",
        cwd: "/workspace/task-b",
        updatedAt: 2,
        status: "idle",
      }]);
      const state = new BridgeStateService({ adapter, transport });
      await state.refresh();
      const paths = defaultDataPaths(root);

      const firstBridge = new SessionsService({ transport, state, paths });
      await expect(firstBridge.list()).resolves.toMatchObject({
        sessions: [expect.objectContaining({ threadId: THREAD_B, title: "Pinned task B" })],
      });
      const cachePath = join(paths.cache, "session-catalog.json");
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
      expect(await readFile(cachePath, "utf8")).not.toContain("/workspace/task-b");

      listSessions.mockRejectedValue(new ThreadTransportError(
        "APP_SERVER_UNAVAILABLE",
        "Managed app-server reconnect is backing off after a failed attempt",
      ));
      const restartedBridge = new SessionsService({ transport, state, paths });

      await expect(restartedBridge.list()).resolves.toMatchObject({
        sessions: [expect.objectContaining({
          threadId: THREAD_B,
          title: "Pinned task B",
          nativeStatus: "degraded",
          visualStatus: "degraded",
          selected: false,
          microSlot: null,
        })],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens a session from the last successful catalog while app-server reconnects", async () => {
    const adapter = {
      refresh: vi.fn(async () => nativeState(THREAD_A)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const { transport } = transportFixture();
    const listSessions = vi.mocked(transport.listSessions);
    listSessions.mockResolvedValueOnce([{
      threadId: THREAD_B,
      title: "Task B",
      cwd: "/workspace/task-b",
      updatedAt: 2,
      status: "idle",
    }]).mockRejectedValueOnce(new ThreadTransportError(
      "APP_SERVER_UNAVAILABLE",
      "Managed app-server reconnect is backing off after a failed attempt",
    ));
    const state = new BridgeStateService({ adapter, transport });
    await state.refresh();
    const openExactThread = vi.fn(async () => undefined);
    const sessions = new SessionsService({
      transport,
      state,
      paths: defaultDataPaths("/tmp/codex-pad-catalogued-navigation-test"),
      openExactThread,
    });

    await expect(sessions.list()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: THREAD_B })],
    });
    await expect(sessions.openSession(THREAD_B)).resolves.toBeUndefined();
    expect(openExactThread).toHaveBeenCalledWith(THREAD_B);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("opens an existing session as navigation without app-server mutation authority", async () => {
    const adapter = {
      refresh: vi.fn(async () => nativeState(THREAD_A)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const { transport } = transportFixture();
    vi.mocked(transport.listSessions).mockRejectedValue(new ThreadTransportError(
      "APP_SERVER_UNAVAILABLE",
      "Managed app-server reconnect is backing off after a failed attempt",
    ));
    delete (transport as Partial<ThreadTransport>).acquireNativeMutationAuthority;
    delete (transport as Partial<ThreadTransport>).consumeNativeMutationAuthority;
    const state = new BridgeStateService({ adapter, transport });
    await state.refresh();
    const openExactThread = vi.fn(async () => undefined);
    const sessions = new SessionsService({
      transport,
      state,
      paths: defaultDataPaths("/tmp/codex-pad-navigation-only-open-test"),
      openExactThread,
    });

    await expect(sessions.openSession(THREAD_A)).resolves.toBeUndefined();
    expect(openExactThread).toHaveBeenCalledWith(THREAD_A);
    expect(transport.listSessions).not.toHaveBeenCalled();
  });

  it("revokes old target proofs at dispatch and confirms the exact active task twice", async () => {
    const targetAuthority = createExactTargetAuthorityDomain();
    let observedThreadId = THREAD_A;
    const adapter = {
      refresh: vi.fn(async (identity?: DesktopProcessIdentity) => {
        if (identity !== undefined) expect(identity).toEqual(DESKTOP_IDENTITY);
        return nativeState(observedThreadId);
      }),
      supersedePendingTargetTransition: vi.fn(),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const { transport, consume } = transportFixture();
    const state = new BridgeStateService({
      adapter,
      transport,
      targetAuthorityIssuer: targetAuthority.stateIssuer,
      selectionConfirmAttempts: 2,
      selectionConfirmPollMs: 0,
    });
    await state.refresh();
    const oldAuthority = await state.revalidateExactTarget(THREAD_A, 0, true, DESKTOP_IDENTITY);

    let releaseOpen!: () => void;
    const openExactThread = vi.fn(async () => new Promise<void>((resolve) => {
      releaseOpen = resolve;
    }));
    const sessions = new SessionsService({
      transport,
      state,
      paths: defaultDataPaths("/tmp/codex-pad-session-selection-test"),
      openExactThread,
      invalidateTargetAuthority: (threadId, desktopIdentity) =>
        state.invalidateTargetAuthority(threadId, desktopIdentity),
    });

    const pending = sessions.openCreatedThread(THREAD_B);
    await vi.waitFor(() => expect(openExactThread).toHaveBeenCalledWith(THREAD_B));
    expect(consume).toHaveBeenCalledOnce();
    expect(adapter.supersedePendingTargetTransition).toHaveBeenCalledOnce();
    let staleTargetError: unknown;
    try {
      targetAuthority.providerConsumer(oldAuthority);
    } catch (error) {
      staleTargetError = error;
    }
    expect(staleTargetError).toMatchObject({ code: "APP_SERVER_TARGET_STALE" });

    observedThreadId = THREAD_B;
    releaseOpen();
    await expect(pending).resolves.toBeUndefined();
    expect(adapter.refresh).toHaveBeenCalledTimes(4);
    expect(adapter.refresh).toHaveBeenNthCalledWith(3, DESKTOP_IDENTITY);
    expect(adapter.refresh).toHaveBeenNthCalledWith(4, DESKTOP_IDENTITY);
    expect(state.capabilities().commands).not.toEqual(expect.arrayContaining([
      "runMicroAction",
      "runJoystickAction",
      "adjustReasoning",
    ]));
    expect(state.capabilities().reasoningModes).toEqual([]);
    expect(state.current().actionAssignments.micro.ACT06.enabled).toBe(false);
    expect(state.current().actionAssignments.joystick.up.enabled).toBe(false);
  });

  it("keeps target authority closed after timeout, then recovers from two identity-bound periodic observations", async () => {
    const targetAuthority = createExactTargetAuthorityDomain();
    let observedThreadId = THREAD_A;
    const adapter = {
      refresh: vi.fn(async () => nativeState(observedThreadId)),
      supersedePendingTargetTransition: vi.fn(),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const { transport } = transportFixture();
    const state = new BridgeStateService({
      adapter,
      transport,
      targetAuthorityIssuer: targetAuthority.stateIssuer,
      selectionConfirmAttempts: 2,
      selectionConfirmPollMs: 0,
    });
    await state.refresh();
    const sessions = new SessionsService({
      transport,
      state,
      paths: defaultDataPaths("/tmp/codex-pad-session-selection-failure-test"),
      openExactThread: vi.fn(async () => undefined),
      invalidateTargetAuthority: (threadId, desktopIdentity) =>
        state.invalidateTargetAuthority(threadId, desktopIdentity),
    });

    await expect(sessions.openCreatedThread(THREAD_B)).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      retryable: true,
      detail: { phase: "post-dispatch" },
    });
    expect(adapter.supersedePendingTargetTransition).toHaveBeenCalledOnce();
    await expect(
      state.revalidateExactTarget(THREAD_A, 0, true, DESKTOP_IDENTITY),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });

    // Once the late target settles, periodic recovery deliberately binds both
    // observations to the identity captured by the deep-link permit.
    observedThreadId = THREAD_B;
    const adapterRefresh = vi.mocked(adapter.refresh);
    const refreshCountBeforeRecovery = adapterRefresh.mock.calls.length;
    await expect(state.refresh()).resolves.toBeDefined();
    expect(adapterRefresh).toHaveBeenCalledTimes(refreshCountBeforeRecovery + 2);
    expect(adapterRefresh).toHaveBeenNthCalledWith(
      refreshCountBeforeRecovery + 1,
      DESKTOP_IDENTITY,
    );
    expect(adapterRefresh).toHaveBeenNthCalledWith(
      refreshCountBeforeRecovery + 2,
      DESKTOP_IDENTITY,
    );
    observedThreadId = THREAD_A;
    await expect(
      state.revalidateExactTarget(THREAD_A, 0, true, DESKTOP_IDENTITY),
    ).resolves.toBeDefined();
  });

  it("does not count a late unbound observation toward timed-out selection recovery", async () => {
    const targetAuthority = createExactTargetAuthorityDomain();
    let observedThreadId = THREAD_A;
    let delayNextUnbound = false;
    let resolveLateUnbound: ((state: AdapterState) => void) | undefined;
    const adapter = {
      refresh: vi.fn((identity?: DesktopProcessIdentity) => {
        if (identity === undefined && delayNextUnbound) {
          delayNextUnbound = false;
          return new Promise<AdapterState>((resolve) => {
            resolveLateUnbound = resolve;
          });
        }
        return Promise.resolve(slottedNativeState(observedThreadId));
      }),
      supersedePendingTargetTransition: vi.fn(),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const { transport } = transportFixture();
    const state = new BridgeStateService({
      adapter,
      transport,
      targetAuthorityIssuer: targetAuthority.stateIssuer,
      selectionConfirmAttempts: 2,
      selectionConfirmPollMs: 0,
    });
    await state.refresh();
    delayNextUnbound = true;
    const lateUnboundRefresh = state.refresh();
    expect(resolveLateUnbound).toBeTypeOf("function");
    const sessions = new SessionsService({
      transport,
      state,
      paths: defaultDataPaths("/tmp/codex-pad-session-selection-delayed-recovery-test"),
      openExactThread: vi.fn(async () => undefined),
      invalidateTargetAuthority: (threadId, desktopIdentity) =>
        state.invalidateTargetAuthority(threadId, desktopIdentity),
    });

    await expect(sessions.openCreatedThread(THREAD_B)).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      detail: { phase: "post-dispatch" },
    });
    expect(adapter.supersedePendingTargetTransition).toHaveBeenCalledOnce();

    observedThreadId = THREAD_B;
    resolveLateUnbound?.(slottedNativeState(THREAD_B));
    await lateUnboundRefresh;

    const otherDesktopIdentity: DesktopProcessIdentity = {
      ...DESKTOP_IDENTITY,
      pid: DESKTOP_IDENTITY.pid + 1,
    };
    await expect(
      state.revalidateExactTarget(THREAD_B, 1, true, otherDesktopIdentity),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    await expect(
      state.revalidateExactTarget(THREAD_A, 0, false, DESKTOP_IDENTITY),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });

    await expect(
      state.revalidateExactTarget(THREAD_B, 1, true, DESKTOP_IDENTITY),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    const recoveredAuthority = await state.revalidateExactTarget(
      THREAD_B,
      1,
      true,
      DESKTOP_IDENTITY,
    );
    expect(() => targetAuthority.providerConsumer(recoveredAuthority)).not.toThrow();
  });

  it("rejects an older identity-bound observation that resolves after another poll recovers the latch", async () => {
    const targetAuthority = createExactTargetAuthorityDomain();
    let observedThreadId = THREAD_A;
    let delayNextThreadAObservation = false;
    let resolveLateThreadA: ((state: AdapterState) => void) | undefined;
    const adapter = {
      refresh: vi.fn((_identity?: DesktopProcessIdentity) => {
        if (delayNextThreadAObservation && observedThreadId === THREAD_A) {
          delayNextThreadAObservation = false;
          return new Promise<AdapterState>((resolve) => {
            resolveLateThreadA = resolve;
          });
        }
        return Promise.resolve(slottedNativeState(observedThreadId));
      }),
      supersedePendingTargetTransition: vi.fn(),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const { transport } = transportFixture();
    const state = new BridgeStateService({
      adapter,
      transport,
      targetAuthorityIssuer: targetAuthority.stateIssuer,
      selectionConfirmAttempts: 2,
      selectionConfirmPollMs: 0,
    });
    await state.refresh();
    const sessions = new SessionsService({
      transport,
      state,
      paths: defaultDataPaths("/tmp/codex-pad-session-selection-late-observation-test"),
      openExactThread: vi.fn(async () => undefined),
      invalidateTargetAuthority: (threadId, desktopIdentity) =>
        state.invalidateTargetAuthority(threadId, desktopIdentity),
    });
    await expect(sessions.openCreatedThread(THREAD_B)).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      detail: { phase: "post-dispatch" },
    });

    delayNextThreadAObservation = true;
    const lateThreadARevalidation = state.revalidateExactTarget(
      THREAD_A,
      0,
      true,
      DESKTOP_IDENTITY,
    );
    expect(resolveLateThreadA).toBeTypeOf("function");

    observedThreadId = THREAD_B;
    await expect(
      state.confirmSelectedThread(THREAD_B, DESKTOP_IDENTITY),
    ).resolves.toBeDefined();
    resolveLateThreadA?.(slottedNativeState(THREAD_A));
    await expect(lateThreadARevalidation).rejects.toMatchObject({
      code: "ADAPTER_DEGRADED",
    });

    const freshThreadBAuthority = await state.revalidateExactTarget(
      THREAD_B,
      1,
      true,
      DESKTOP_IDENTITY,
    );
    expect(() => targetAuthority.providerConsumer(freshThreadBAuthority)).not.toThrow();
  });

  it("keeps selected-task authority closed when Desktop ownership changes during final confirmation", async () => {
    const changedDesktopIdentity: DesktopProcessIdentity = {
      ...DESKTOP_IDENTITY,
      pid: DESKTOP_IDENTITY.pid + 1,
    };
    let observedThreadId = THREAD_A;
    const adapter = {
      refresh: vi.fn(async (identity?: DesktopProcessIdentity) => {
        if (identity !== undefined) expect(identity).toEqual(DESKTOP_IDENTITY);
        return slottedNativeState(observedThreadId);
      }),
      supersedePendingTargetTransition: vi.fn(),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const { transport } = transportFixture();
    const refreshDesktopOwnershipIdentity = vi.fn()
      .mockResolvedValueOnce(DESKTOP_IDENTITY)
      .mockResolvedValueOnce(DESKTOP_IDENTITY)
      .mockResolvedValueOnce(DESKTOP_IDENTITY)
      .mockResolvedValueOnce(DESKTOP_IDENTITY)
      .mockResolvedValueOnce(changedDesktopIdentity);
    transport.refreshDesktopOwnershipIdentity = refreshDesktopOwnershipIdentity;
    const state = new BridgeStateService({
      adapter,
      transport,
      selectionConfirmAttempts: 2,
      selectionConfirmPollMs: 0,
    });
    await state.refresh();
    state.invalidateTargetAuthority(THREAD_B, DESKTOP_IDENTITY);
    observedThreadId = THREAD_B;

    await expect(
      state.confirmSelectedThread(THREAD_B, DESKTOP_IDENTITY),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });

    expect(refreshDesktopOwnershipIdentity).toHaveBeenCalledTimes(5);
    expect(state.current().selectedThreadId).toBeNull();
    expect(state.current().actionAssignments.micro.ACT06.enabled).toBe(false);
  });
});

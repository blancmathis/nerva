import { describe, expect, it, vi } from "vitest";
import type {
  AdapterState,
  CodexDesktopAdapter,
  DesktopProcessIdentity,
  ReasoningEffort,
} from "@codex-pad/codex-desktop";
import type {
  NativeMutationAuthorityToken,
  TargetAuthorityGuard,
  ThreadTransport,
  TransportHealth,
} from "../src/thread-transport.js";
import { createExactTargetAuthorityDomain } from "../src/exact-target-authority.js";
import { BridgeStateService } from "../src/state.js";

const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
const TURN_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba3";
const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 42,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/Codex.app",
  executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  bundleId: "com.openai.codex",
};

function nativeAuthorityMethods() {
  const permits = new WeakSet<object>();
  return {
    acquireNativeMutationAuthority: vi.fn(async (guard: TargetAuthorityGuard) => {
      await guard(DESKTOP_IDENTITY);
      const permit = Object.freeze({});
      permits.add(permit);
      return {
        authority: permit as NativeMutationAuthorityToken,
        desktopIdentity: DESKTOP_IDENTITY,
      };
    }),
    consumeNativeMutationAuthority: vi.fn((permit: NativeMutationAuthorityToken) => {
      if (!permits.delete(permit as object)) throw new Error("stale test native permit");
    }),
  };
}

function nativeState(
  stale: boolean,
  aliases = false,
  reasoningEffort: ReasoningEffort | null = null,
  threadId = THREAD_ID,
): AdapterState {
  return {
    stale,
    health: {
      status: stale ? "degraded" : "ready",
      reasons: stale ? [{ code: "snapshot-stale", message: "CDP disconnected" }] : [],
      changedAt: stale ? 2 : 1,
    },
    snapshot: {
      slots: [0, 1, 2, 3, 4, 5].map((index) => ({
        index,
        key: `AG0${index}`,
        threadId: index === 0 ? threadId : null,
        title: index === 0 ? "Cached task" : null,
        status: index === 0 ? (aliases ? "working" : "idle") : index === 1 && aliases ? "awaiting-response" : "off",
        nativeStatus: index === 0 ? (aliases ? "running" : "idle") : index === 1 && aliases ? "input" : "off",
        selected: index === 0,
        activityAt: null,
        activityLabel: null,
      })) as unknown as NonNullable<AdapterState["snapshot"]>["slots"],
      activeThreadId: threadId,
      agentSource: "pinned",
      actionLayout: null,
      joystickLayout: null,
      reasoning: reasoningEffort === null ? null : { effort: reasoningEffort, adjustable: true },
      theme: "dark",
      capabilities: {
        activeThread: true,
        activity: true,
        agentSource: true,
        composerAttachment: true,
        actionLayout: false,
        actionControl: false,
        joystickLayout: false,
        joystickControl: false,
        reasoning: reasoningEffort !== null,
        reasoningControl: reasoningEffort !== null,
        theme: true,
      },
      observedAt: 1,
    },
  };
}

function twoThreadNativeState(selectedThreadId: string): AdapterState {
  const base = nativeState(false);
  if (base.snapshot === null) throw new Error("Expected a native snapshot");
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      slots: base.snapshot.slots.map((slot, index) => {
        const threadId = index === 0 ? THREAD_ID : index === 1 ? OTHER_THREAD_ID : null;
        return {
          ...slot,
          threadId,
          title: threadId === null ? null : `Task ${index}`,
          status: threadId === null ? "off" : "idle",
          nativeStatus: threadId === null ? "off" : "idle",
          selected: threadId === selectedThreadId,
        };
      }) as unknown as NonNullable<AdapterState["snapshot"]>["slots"],
      activeThreadId: selectedThreadId,
    },
  };
}

describe("BridgeStateService stale snapshots", () => {
  it("publishes the exact active Mac task without granting selected-task authority", async () => {
    const observed = nativeState(false);
    if (observed.snapshot === null) throw new Error("Expected a native snapshot");
    const navigationOnly: AdapterState = {
      ...observed,
      snapshot: {
        ...observed.snapshot,
        slots: observed.snapshot.slots.map((slot) => ({ ...slot, selected: false })) as unknown as typeof observed.snapshot.slots,
      },
    };
    const adapter = {
      refresh: vi.fn(async () => navigationOnly),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async (): Promise<TransportHealth> => ({
        mode: "injected-test-transport",
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: false,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });

    const snapshot = await service.refresh();

    expect(snapshot.activeThreadId).toBe(THREAD_ID);
    expect(snapshot.selectedThreadId).toBeNull();
    expect(snapshot.slots.every((slot) => !slot.selected)).toBe(true);
    expect(() => service.assertExactTarget(snapshot.sequence, THREAD_ID, true)).toThrow(/selected native Codex thread/u);
  });

  it("emits schema-valid visual states while preserving known native aliases", async () => {
    const adapter = {
      refresh: vi.fn(async () => nativeState(false, true)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport, codexVersion: " codex-cli 0.145.0-test " });

    const snapshot = await service.refresh();

    expect(snapshot.codexVersion).toBe("codex-cli 0.145.0-test");
    expect(service.capabilities().codexVersion).toBe("codex-cli 0.145.0-test");
    expect(snapshot.slots[0]).toMatchObject({ nativeStatus: "running", visualStatus: "working" });
    expect(snapshot.slots[1]).toMatchObject({ nativeStatus: "input", visualStatus: "needsInput" });
    expect(service.assertSnapshotIdentity(snapshot.bridgeInstanceId, snapshot.sequence)).toBe(snapshot);
    expect(() => service.assertSnapshotIdentity(BRIDGE_INSTANCE_ID, snapshot.sequence)).toThrow(/generation changed/u);
  });

  it("preserves last-good display fields but marks every cached slot degraded and non-authoritative", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce(nativeState(false))
      .mockResolvedValueOnce(nativeState(true));
    const adapter = { refresh, close: vi.fn() } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport, bridgeInstanceId: BRIDGE_INSTANCE_ID });
    const fresh = await service.refresh();
    const stale = await service.refresh();

    expect(fresh.bridgeInstanceId).toBe(BRIDGE_INSTANCE_ID);
    expect(stale.bridgeInstanceId).toBe(BRIDGE_INSTANCE_ID);
    expect(stale.sequence).toBeGreaterThan(fresh.sequence);
    expect(stale.slots[0]).toMatchObject({
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      nativeStatus: "bridge-stale",
      visualStatus: "degraded",
      selected: false,
    });
    expect(stale.selectedThreadId).toBeNull();
    expect(stale.bridgeHealth.lastSuccessfulRefreshAt).not.toBeNull();
    expect(() => service.assertExactTarget(stale.sequence, stale.slots[0].threadId ?? "", true)).toThrow(/not authoritative/u);
  });

  it("uses a non-coalesced adapter-only observation for exact-target revalidation", async () => {
    let releaseSkills: (() => void) | undefined;
    const delayedSkills = new Promise<[]>(resolve => { releaseSkills = () => resolve([]); });
    const adapter = {
      refresh: vi.fn()
        .mockResolvedValueOnce(nativeState(false))
        .mockResolvedValueOnce(nativeState(false))
        .mockResolvedValueOnce(nativeState(false, false, null, OTHER_THREAD_ID)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(async () => delayedSkills),
      threadRead: vi.fn(async () => ({
        threadId: THREAD_ID,
        status: "idle" as const,
        activeTurnId: null,
        cwd: "/tmp/project",
        refreshedAt: new Date(0).toISOString(),
        raw: {},
      })),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport, skillsRefreshIntervalMs: 0 });
    await service.refresh();

    const backgroundRefresh = service.refresh();
    await vi.waitFor(() => expect(transport.listSkills).toHaveBeenCalledTimes(2));
    await expect(service.revalidateExactTarget(THREAD_ID, 0, true, DESKTOP_IDENTITY)).rejects.toMatchObject({
      code: "TARGET_MISMATCH",
    });
    expect(adapter.refresh).toHaveBeenCalledTimes(3);
    releaseSkills?.();
    await backgroundRefresh;
  });

  it("bounds task and Skills catalog reads while invalidating immediately on task change", async () => {
    let now = 1_000;
    let selectedThreadId = THREAD_ID;
    const adapter = {
      refresh: vi.fn(async () => nativeState(false, false, null, selectedThreadId)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      threadRead: vi.fn(async (threadId: string) => ({
        threadId,
        status: "idle" as const,
        activeTurnId: null,
        cwd: `/tmp/${threadId}`,
        refreshedAt: new Date(now).toISOString(),
        raw: {},
      })),
      listSkills: vi.fn(async () => []),
      listModels: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({
      adapter,
      transport,
      now: () => now,
      skillsRefreshIntervalMs: 10_000,
    });

    await service.refresh();
    now = 5_000;
    await service.refresh();
    expect(transport.threadRead).toHaveBeenCalledTimes(1);
    expect(transport.listSkills).toHaveBeenCalledTimes(1);

    selectedThreadId = OTHER_THREAD_ID;
    await service.refresh();
    expect(transport.threadRead).toHaveBeenCalledTimes(2);
    expect(transport.listSkills).toHaveBeenCalledTimes(2);

    now = 14_999;
    await service.refresh();
    expect(transport.threadRead).toHaveBeenCalledTimes(2);
    now = 15_000;
    await service.refresh();
    expect(transport.threadRead).toHaveBeenCalledTimes(3);
    expect(transport.listSkills).toHaveBeenCalledTimes(3);
    expect(transport.listModels).toHaveBeenCalledTimes(1);
  });

  it("falls back to the global skill catalog when the selected Desktop task is not readable yet", async () => {
    const adapter = {
      refresh: vi.fn(async () => nativeState(false)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const fallbackSkill = {
      name: "visual-review",
      description: "Review the current interface",
      path: "/skills/visual-review/SKILL.md",
      cwd: "/skills/visual-review",
      enabled: true,
    };
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: false,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      threadRead: vi.fn(async () => { throw new Error("task not loaded"); }),
      listSkills: vi.fn(async () => [fallbackSkill]),
      listModels: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });

    await service.refresh();

    expect(transport.listSkills).toHaveBeenCalledWith();
    expect(service.capabilities().skills).toEqual([{
      id: fallbackSkill.name,
      label: fallbackSkill.name,
      description: fallbackSkill.description,
      enabled: true,
      group: "project",
    }]);
  });

  it("revokes an exact-target proof as soon as a new native snapshot resolves while health is stalled", async () => {
    let releaseHealth: (() => void) | undefined;
    const stalledHealth = new Promise<TransportHealth>((resolve) => {
      releaseHealth = () => resolve({
        mode: "injected-test-transport",
        connected: true,
        initialized: true,
        selectedThreadId: THREAD_ID,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      });
    });
    const adapter = {
      refresh: vi.fn()
        .mockResolvedValueOnce(twoThreadNativeState(THREAD_ID))
        .mockResolvedValueOnce(twoThreadNativeState(THREAD_ID))
        .mockResolvedValueOnce(twoThreadNativeState(OTHER_THREAD_ID)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const health = {
      mode: "injected-test-transport" as const,
      connected: true,
      initialized: true,
      selectedThreadId: THREAD_ID,
      localImageSteerVerified: false,
      multiImageInputVerified: false,
      desktopOwnershipVerified: true,
      serverUserAgent: "test",
      queuedSketches: 0,
    };
    const transport = {
      health: vi.fn()
        .mockResolvedValueOnce(health)
        .mockImplementationOnce(async () => stalledHealth),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
      clearSelectedThread: vi.fn(),
    } as unknown as ThreadTransport;
    const authorityDomain = createExactTargetAuthorityDomain();
    const service = new BridgeStateService({
      adapter,
      transport,
      targetAuthorityIssuer: authorityDomain.stateIssuer,
    });
    await service.refresh();
    const authority = await service.revalidateExactTarget(THREAD_ID, 0, true, DESKTOP_IDENTITY);

    const stalledRefresh = service.refresh();
    await vi.waitFor(() => expect(adapter.refresh).toHaveBeenCalledTimes(3));
    expect(() => authorityDomain.providerConsumer(authority)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_TARGET_STALE" }),
    );

    releaseHealth?.();
    await stalledRefresh;
  });

  it("rechecks native slot identity after ownership and dispatches no select action when it changed", async () => {
    const execute = vi.fn(async () => nativeState(false));
    const adapter = {
      refresh: vi.fn()
        .mockResolvedValueOnce(nativeState(false))
        .mockResolvedValueOnce(nativeState(false, false, null, OTHER_THREAD_ID)),
      execute,
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const selectThread = vi.fn();
    const transport = {
      ...nativeAuthorityMethods(),
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
      selectThread,
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });
    const snapshot = await service.refresh();

    await expect(service.selectSlot(snapshot.sequence, 0, THREAD_ID)).rejects.toMatchObject({
      code: "TARGET_MISMATCH",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(selectThread).not.toHaveBeenCalled();
  });

  it("does not misclassify the expected selectAgent handoff as an external reselection", async () => {
    let nativeSelectedThreadId = THREAD_ID;
    let transportSelectedThreadId = THREAD_ID;
    const adapter = {
      refresh: vi.fn(async () => twoThreadNativeState(nativeSelectedThreadId)),
      execute: vi.fn(async (_command, assertDispatchAuthority?: () => void) => {
        assertDispatchAuthority?.();
        nativeSelectedThreadId = OTHER_THREAD_ID;
        return twoThreadNativeState(nativeSelectedThreadId);
      }),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const clearSelectedThread = vi.fn();
    const transport = {
      ...nativeAuthorityMethods(),
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: transportSelectedThreadId,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
      clearSelectedThread,
      selectThread: vi.fn(async (threadId, guard) => {
        expect(threadId).toBe(OTHER_THREAD_ID);
        expect(clearSelectedThread).not.toHaveBeenCalled();
        await guard?.();
        transportSelectedThreadId = threadId;
        return undefined as never;
      }),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });
    const snapshot = await service.refresh();

    await expect(
      service.selectSlot(snapshot.sequence, 1, OTHER_THREAD_ID),
    ).resolves.toMatchObject({ selectedThreadId: OTHER_THREAD_ID });
    expect(clearSelectedThread).not.toHaveBeenCalled();
  });

  it("keeps mono review available while advertising multi-frame only after runtime verification", async () => {
    const adapter = {
      refresh: vi.fn(async () => nativeState(false)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const health = vi.fn()
      .mockResolvedValueOnce({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "codex-test/0.145.0",
        queuedSketches: 0,
      })
      .mockResolvedValueOnce({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: true,
        desktopOwnershipVerified: true,
        serverUserAgent: "codex-test/0.145.0",
        queuedSketches: 0,
      });
    const transport = {
      health,
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });

    await service.refresh();
    expect(service.capabilities()).toMatchObject({
      drawing: true,
      review: true,
      reviewMaxImages: 1,
      multiImageInputVerified: false,
    });
    expect(service.capabilities().commands).toContain("sendSketch");
    expect(service.capabilities().commands).toContain("sendReview");

    await service.refresh();
    expect(service.capabilities()).toMatchObject({
      drawing: true,
      review: true,
      reviewMaxImages: 12,
      multiImageInputVerified: true,
    });
    expect(service.capabilities().commands).toContain("sendReview");
  });

  it("projects bounded selected-thread approvals while permissions remain read-only", async () => {
    const adapter = {
      refresh: vi.fn(async () => nativeState(false)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    let pending = [
      {
        requestId: 77,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "command-item",
        kind: "commandExecution" as const,
        actionable: true,
        summary: "Run tests",
        raw: { command: "private raw payload" },
      },
      {
        requestId: 78,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "permissions-item",
        kind: "permissions" as const,
        actionable: false,
        summary: "Permissions",
        raw: {},
      },
      {
        requestId: 79,
        threadId: OTHER_THREAD_ID,
        turnId: TURN_ID,
        itemId: "other-thread-item",
        kind: "fileChange" as const,
        actionable: true,
        summary: "Other thread",
        raw: {},
      },
    ];
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: THREAD_ID,
        localImageSteerVerified: false,
        multiImageInputVerified: true,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => pending),
      clearSelectedThread: vi.fn(),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });

    const withApproval = await service.refresh();
    expect(withApproval.pendingApprovals).toEqual([
      {
        requestId: 77,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "command-item",
        kind: "commandExecution",
        actionable: true,
        summary: "Run tests",
      },
      {
        requestId: 78,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "permissions-item",
        kind: "permissions",
        actionable: false,
        summary: "Permissions",
      },
    ]);
    expect(withApproval.pendingApprovals[0]).not.toHaveProperty("raw");
    expect(withApproval.pendingApprovals[1]).not.toHaveProperty("raw");
    expect(service.capabilities().commands).toContain("respondToApproval");

    pending = pending.filter((approval) => approval.kind === "permissions");
    const permissionsOnly = await service.refresh();
    expect(permissionsOnly.pendingApprovals).toEqual([expect.objectContaining({
      requestId: 78,
      kind: "permissions",
      actionable: false,
    })]);
    expect(service.capabilities().commands).not.toContain("respondToApproval");

    pending = [];
    const resolved = await service.refresh();
    expect(resolved.pendingApprovals).toEqual([]);
    expect(resolved.sequence).toBeGreaterThan(withApproval.sequence);
    expect(service.capabilities().commands).not.toContain("respondToApproval");
  });

  it("keeps exact-target controls available without claiming shared Desktop ownership", async () => {
    const execute = vi.fn(async () => nativeState(false));
    const adapter = {
      refresh: vi.fn(async () => nativeState(false, false, "high")),
      execute,
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: true,
        desktopOwnershipVerified: false,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });
    const snapshot = await service.refresh();

    expect(service.capabilities()).toMatchObject({
      drawing: true,
      review: true,
      desktopOwnershipVerified: false,
    });
    expect(service.capabilities().commands).toEqual(expect.arrayContaining([
      "openSession",
      "refreshSnapshot",
      "sendSketch",
      "sendReview",
      "runLibraryCommand",
      "runSkill",
      "adjustReasoning",
    ]));
    expect(service.capabilities().commands).not.toContain("createTask");
    await service.invokeNative(snapshot.sequence, THREAD_ID, "reasoning-decrease");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps Drawing attachment available while the managed app-server is offline", async () => {
    const native = nativeState(false);
    const attachImageToComposer = vi.fn(async () => native);
    const appendTextToComposer = vi.fn(async () => native);
    const attachFilesToComposer = vi.fn(async () => native);
    const adapter = {
      refresh: vi.fn(async () => native),
      attachImageToComposer,
      appendTextToComposer,
      attachFilesToComposer,
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "managed-control-socket" as const,
        connected: false,
        initialized: false,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: false,
        serverUserAgent: null,
        queuedSketches: 0,
      })),
      listPendingApprovals: vi.fn(() => []),
      clearSelectedThread: vi.fn(),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });
    const snapshot = await service.refresh();

    expect(service.capabilities()).toMatchObject({ drawing: true, review: false });
    expect(service.capabilities().commands).toContain("sendSketch");
    expect(service.capabilities().commands).not.toContain("sendReview");
    await service.attachImageToComposer(
      THREAD_ID,
      0,
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XqZ8WQAAAABJRU5ErkJggg==",
    );
    expect(attachImageToComposer).toHaveBeenCalledWith({
      expectedThreadId: THREAD_ID,
      fileName: "Codex Pad Drawing.png",
      pngBase64: expect.stringMatching(/^iVBOR/u),
    });
    await service.appendTextToComposer(
      snapshot.sequence,
      THREAD_ID,
      0,
      "\n\nUse the following skills for this task: github:github.",
    );
    expect(appendTextToComposer).toHaveBeenCalledWith({
      expectedThreadId: THREAD_ID,
      text: "\n\nUse the following skills for this task: github:github.",
    });
    await service.attachFilesToComposer(
      service.current().sequence,
      THREAD_ID,
      0,
      [{
        expectedThreadId: THREAD_ID,
        fileName: "context.txt",
        mimeType: "text/plain",
        dataBase64: "aGVsbG8=",
      }],
    );
    expect(attachFilesToComposer).toHaveBeenCalledWith({
      expectedThreadId: THREAD_ID,
      files: [{
        expectedThreadId: THREAD_ID,
        fileName: "context.txt",
        mimeType: "text/plain",
        dataBase64: "aGVsbG8=",
      }],
    });
  });

  it("blocks generic approval HID assignments before native action or joystick dispatch", async () => {
    const base = nativeState(false);
    if (base.snapshot === null) throw new Error("Expected a native snapshot");
    const approvalState: AdapterState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        actionLayout: [
          { slot: "ACT06", keycapId: "FAST", commandId: "mode.fast" },
          { slot: "ACT07", keycapId: "APPR", commandId: "native:approve" },
          { slot: "ACT08", keycapId: "A8", commandId: "action.8" },
          { slot: "ACT09", keycapId: "A9", commandId: "action.9" },
          { slot: "ACT10_ACT11", keycapId: "A10", commandId: "action.10" },
          { slot: "ACT12", keycapId: "A12", commandId: "action.12" },
        ],
        joystickLayout: {
          up: { direction: "up", type: "command", commandId: "native:reject" },
          right: { direction: "right", type: "command", commandId: "nav.forward" },
          down: { direction: "down", type: "command", commandId: "down" },
          left: { direction: "left", type: "command", commandId: "left" },
        },
        capabilities: {
          ...base.snapshot.capabilities,
          actionLayout: true,
          actionControl: true,
          joystickLayout: true,
          joystickControl: true,
        },
      },
    };
    const execute = vi.fn(async () => approvalState);
    const adapter = {
      refresh: vi.fn(async () => approvalState),
      execute,
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: THREAD_ID,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
      clearSelectedThread: vi.fn(),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });
    const snapshot = await service.refresh();
    expect(snapshot.actionAssignments.micro.ACT06.enabled).toBe(true);
    expect(snapshot.actionAssignments.micro.ACT07.enabled).toBe(false);
    expect(snapshot.actionAssignments.joystick.up.enabled).toBe(false);
    expect(snapshot.actionAssignments.joystick.right.enabled).toBe(true);

    await expect(
      service.invokeActionSlot(
        snapshot.sequence,
        THREAD_ID,
        0,
        "ACT07",
        "APPR",
        "native:approve",
      ),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    await expect(
      service.invokeJoystick(
        snapshot.sequence,
        THREAD_ID,
        "up",
        { type: "command", commandId: "native:reject" },
      ),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks opaque and otherwise-safe HID while an exact approval is pending", async () => {
    const base = nativeState(false, false, "high");
    if (base.snapshot === null) throw new Error("Expected a native snapshot");
    const pendingState: AdapterState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        slots: base.snapshot.slots.map((slot, index) => index === 0
          ? { ...slot, status: "awaiting-approval", nativeStatus: "approval" }
          : slot) as unknown as NonNullable<AdapterState["snapshot"]>["slots"],
        actionLayout: [
          { slot: "ACT06", keycapId: "MYSTERY", commandId: "mystery.v2" },
          { slot: "ACT07", keycapId: "FAST", commandId: "mode.fast" },
          { slot: "ACT08", keycapId: "SPLIT", commandId: "thread.fork" },
          { slot: "ACT09", keycapId: "MIC", commandId: "dictation.toggle" },
          { slot: "ACT10_ACT11", keycapId: "CODEX", commandId: "composer.submit" },
          { slot: "ACT12", keycapId: "FAST", commandId: "mode.fast" },
        ],
        joystickLayout: {
          up: { direction: "up", type: "command", commandId: "mode.plan" },
          right: { direction: "right", type: "command", commandId: "nav.forward" },
          down: { direction: "down", type: "command", commandId: "skill.one" },
          left: { direction: "left", type: "command", commandId: "nav.back" },
        },
        capabilities: {
          ...base.snapshot.capabilities,
          actionLayout: true,
          actionControl: true,
          joystickLayout: true,
          joystickControl: true,
        },
      },
    };
    const execute = vi.fn(async () => pendingState);
    const adapter = {
      refresh: vi.fn(async () => pendingState),
      execute,
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: THREAD_ID,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => [{
        requestId: 99,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "opaque-approval",
        kind: "commandExecution" as const,
        actionable: true,
        summary: "Opaque approval",
        raw: {},
      }]),
      clearSelectedThread: vi.fn(),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });
    const snapshot = await service.refresh();
    expect(snapshot.pendingApprovals).toHaveLength(1);
    expect(snapshot.actionAssignments.micro.ACT07.enabled).toBe(false);
    expect(snapshot.actionAssignments.joystick.up.enabled).toBe(false);
    expect(service.capabilities().commands).not.toContain("runMicroAction");
    expect(service.capabilities().commands).not.toContain("runJoystickAction");
    expect(service.capabilities().commands).not.toContain("adjustReasoning");
    expect(service.capabilities().reasoningModes).toEqual([]);
    expect(service.capabilities().currentReasoningMode).toBeNull();

    await expect(
      service.invokeActionSlot(snapshot.sequence, THREAD_ID, 0, "ACT06", "MYSTERY", "mystery.v2"),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    await expect(
      service.invokeJoystick(snapshot.sequence, THREAD_ID, "up", { type: "command", commandId: "mode.plan" }),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    await expect(
      service.invokeNative(snapshot.sequence, THREAD_ID, "reasoning-increase"),
    ).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("emits a new authoritative snapshot when the observed reasoning effort changes", async () => {
    const execute = vi.fn(async (_command, assertDispatchAuthority?: () => void) => {
      assertDispatchAuthority?.();
      return nativeState(false, false, "medium");
    });
    const adapter = {
      refresh: vi.fn(async () => nativeState(false, false, "high")),
      execute,
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      ...nativeAuthorityMethods(),
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ThreadTransport;
    const service = new BridgeStateService({ adapter, transport });
    const before = await service.refresh();

    expect(before.reasoning).toEqual({ effort: "high", adjustable: true });
    expect(service.capabilities().currentReasoningMode).toBe("high");

    const after = await service.invokeNative(
      before.sequence,
      "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      "reasoning-decrease",
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(after.sequence).toBe(before.sequence + 1);
    expect(after.reasoning).toEqual({ effort: "medium", adjustable: true });
    expect(service.capabilities().currentReasoningMode).toBe("medium");
  });
});

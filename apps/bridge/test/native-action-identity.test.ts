import { describe, expect, it, vi } from "vitest";
import type {
  AdapterState,
  CodexDesktopAdapter,
  DesktopProcessIdentity,
  NativeActionLayout,
  NativeJoystickLayout,
} from "@codex-pad/codex-desktop";

import { BridgeStateService } from "../src/state.js";
import type {
  NativeMutationAuthorityToken,
  TargetAuthorityGuard,
  ThreadTransport,
  TransportHealth,
} from "../src/thread-transport.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 42,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/Codex.app",
  executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  bundleId: "com.openai.codex",
};

function nativeState(): AdapterState {
  const actionLayout = [
    { slot: "ACT06", keycapId: "FAST", commandId: "mode.fast" },
    { slot: "ACT07", keycapId: "APPR", commandId: "native:approve" },
    { slot: "ACT08", keycapId: "REJ", commandId: "native:reject" },
    { slot: "ACT09", keycapId: "SPLIT", commandId: "thread.fork" },
    { slot: "ACT10_ACT11", keycapId: "MIC", commandId: "dictation.toggle" },
    { slot: "ACT12", keycapId: "CODEX", commandId: "composer.submit" },
  ] as NativeActionLayout;
  const joystickLayout = {
    up: { direction: "up", type: "command", commandId: "mode.plan" },
    right: { direction: "right", type: "command", commandId: "nav.forward" },
    down: { direction: "down", type: "command", commandId: "skill.one" },
    left: { direction: "left", type: "command", commandId: "nav.back" },
  } as NativeJoystickLayout;
  return {
    stale: false,
    health: { status: "ready", reasons: [], changedAt: 1 },
    snapshot: {
      slots: [0, 1, 2, 3, 4, 5].map((index) => ({
        index,
        key: `AG0${index}`,
        threadId: index === 0 ? THREAD_ID : null,
        title: index === 0 ? "Exact task" : null,
        status: index === 0 ? "idle" : "off",
        nativeStatus: index === 0 ? "idle" : "off",
        selected: index === 0,
        activityAt: null,
        activityLabel: null,
      })) as unknown as NonNullable<AdapterState["snapshot"]>["slots"],
      activeThreadId: THREAD_ID,
      agentSource: "pinned",
      actionLayout,
      joystickLayout,
      reasoning: null,
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
        reasoning: false,
        reasoningControl: false,
        theme: true,
      },
      observedAt: 1,
    },
  };
}

function harness(state = nativeState(), desktopOwnershipVerified = true) {
  const execute = vi.fn(async (_command, assertDispatchAuthority?: () => void) => {
    assertDispatchAuthority?.();
    return state;
  });
  const adapter = {
    refresh: vi.fn(async () => state),
    execute,
    close: vi.fn(),
  } as unknown as CodexDesktopAdapter;
  const health: TransportHealth = {
    mode: "injected-test-transport",
    connected: true,
    initialized: true,
    selectedThreadId: THREAD_ID,
    localImageSteerVerified: true,
    multiImageInputVerified: true,
    desktopOwnershipVerified,
    serverUserAgent: "codex-test/0.145.0",
    queuedSketches: 0,
  };
  const transport = {
    acquireNativeMutationAuthority: vi.fn(async (guard: TargetAuthorityGuard) => {
      await guard(DESKTOP_IDENTITY);
      return {
        authority: Object.freeze({}) as NativeMutationAuthorityToken,
        desktopIdentity: DESKTOP_IDENTITY,
      };
    }),
    consumeNativeMutationAuthority: vi.fn((_permit: NativeMutationAuthorityToken) => undefined),
    health: vi.fn(async () => health),
    listSkills: vi.fn(async () => []),
    listPendingApprovals: vi.fn(() => []),
    clearSelectedThread: vi.fn(),
  } as unknown as ThreadTransport;
  return { execute, transport, service: new BridgeStateService({ adapter, transport }) };
}

describe("BridgeStateService exact native assignment identity", () => {
  it("exposes and dispatches an exact current native key without shared app-server ownership", async () => {
    const originalState = nativeState();
    if (!originalState.snapshot?.actionLayout) throw new Error("fixture action layout missing");
    const actionLayout = originalState.snapshot.actionLayout.map((assignment) => ({
      ...assignment,
      commandId: assignment.slot === "ACT06" || assignment.slot === "ACT09"
        || assignment.slot === "ACT10_ACT11" || assignment.slot === "ACT12"
        ? null
        : assignment.commandId,
    })) as unknown as NativeActionLayout;
    const state: AdapterState = {
      ...originalState,
      snapshot: { ...originalState.snapshot, actionLayout },
    };
    const { execute, transport, service } = harness(state, false);
    const snapshot = await service.refresh();

    expect(service.capabilities()).toMatchObject({
      commands: expect.arrayContaining(["runMicroAction", "sendSketch"]),
      drawing: true,
    });
    await service.invokeActionSlot(snapshot.sequence, THREAD_ID, 0, "ACT10_ACT11", "MIC", null);
    expect(execute).toHaveBeenCalledWith({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT10_ACT11",
      expectedKeycapId: "MIC",
      expectedNativeCommandId: null,
      expectedThreadId: THREAD_ID,
    });
    expect(transport.acquireNativeMutationAuthority).not.toHaveBeenCalled();
  });

  it("passes both exact identities through to the live adapter", async () => {
    const { execute, service } = harness();
    const snapshot = await service.refresh();

    await service.invokeActionSlot(snapshot.sequence, THREAD_ID, 0, "ACT06", "FAST", "mode.fast");
    expect(execute).toHaveBeenCalledWith({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.fast",
      expectedThreadId: THREAD_ID,
    }, expect.any(Function), DESKTOP_IDENTITY);
  });

  it("rejects a command-id rebind hidden behind the same action keycap", async () => {
    const { execute, service } = harness();
    const snapshot = await service.refresh();

    await expect(service.invokeActionSlot(
      snapshot.sequence,
      THREAD_ID,
      0,
      "ACT06",
      "FAST",
      "mode.fast.v1",
    )).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes the exact layout-v1 joystick identity through to the live adapter", async () => {
    const { execute, service } = harness();
    const snapshot = await service.refresh();

    await service.invokeJoystick(
      snapshot.sequence,
      THREAD_ID,
      "up",
      { type: "command", commandId: "mode.plan" },
    );
    expect(execute).toHaveBeenCalledWith({
      action: "invoke-joystick",
      direction: "up",
      expectedAssignment: { type: "command", commandId: "mode.plan" },
      expectedThreadId: THREAD_ID,
    }, expect.any(Function), DESKTOP_IDENTITY);
  });

  it("rejects a changed joystick command identity", async () => {
    const { execute, service } = harness();
    const snapshot = await service.refresh();

    await expect(service.invokeJoystick(
      snapshot.sequence,
      THREAD_ID,
      "up",
      { type: "command", commandId: "mode.plan.v1" },
    )).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not advertise or dispatch exact-match unknown future assignments", async () => {
    const base = nativeState();
    if (base.snapshot === null) throw new Error("Expected native state");
    const opaque: AdapterState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        actionLayout: base.snapshot.actionLayout === null
          ? null
          : base.snapshot.actionLayout.map((assignment) => assignment.slot === "ACT06"
            ? { ...assignment, keycapId: "FUTURE", commandId: "future.action" }
            : assignment) as unknown as NativeActionLayout,
        joystickLayout: base.snapshot.joystickLayout === null ? null : {
          ...base.snapshot.joystickLayout,
          up: { direction: "up", type: "command", commandId: "future.joystick" },
        },
      },
    };
    const { execute, service } = harness(opaque);
    const snapshot = await service.refresh();
    expect(snapshot.actionAssignments.micro.ACT06.enabled).toBe(false);
    expect(snapshot.actionAssignments.joystick.up.enabled).toBe(false);
    await expect(service.invokeActionSlot(
      snapshot.sequence,
      THREAD_ID,
      0,
      "ACT06",
      "FUTURE",
      "future.action",
    )).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
    await expect(service.invokeJoystick(
      snapshot.sequence,
      THREAD_ID,
      "up",
      { type: "command", commandId: "future.joystick" },
    )).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never sends a generic approval-like native assignment to the adapter", async () => {
    const { execute, service } = harness();
    const snapshot = await service.refresh();

    await expect(service.invokeActionSlot(
      snapshot.sequence,
      THREAD_ID,
      0,
      "ACT07",
      "APPR",
      "native:approve",
    )).rejects.toMatchObject({ code: "ADAPTER_DEGRADED" });
    expect(execute).not.toHaveBeenCalled();
  });
});

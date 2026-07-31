import { describe, expect, it } from "vitest";
import { buildJoystickCommand, buildMicroActionCommand, isGenericApprovalBinding } from "./control-commands";
import { emptySlot, type BridgeSnapshot } from "./model";

const THREAD = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

function snapshot(sequence: number, commandId = "mode.plan"): BridgeSnapshot {
  const slots = Array.from({ length: 6 }, (_, index) => emptySlot(index));
  slots[0] = { ...slots[0]!, threadKey: THREAD, threadId: THREAD, suffix: THREAD.slice(-8), title: "Task", status: "idle", selected: true };
  return {
    bridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
    bridgeVersion: "0.1.0",
    buildRevision: "0000000000000000",
    apiContractVersion: 1,
    seq: sequence,
    capturedAt: new Date(sequence).toISOString(),
    theme: "dark",
    health: "ready",
    healthDetail: null,
    slots,
    activeThreadKey: THREAD,
    selectedSlotId: "AG00",
    selectedThreadKey: THREAD,
    pendingApprovals: [],
    capabilities: {
      commands: ["runJoystickAction"],
      microActions: [],
      joystickActions: [
        { direction: "up", type: "command", commandId, label: "Plan", enabled: true },
      ],
      reasoningModes: [],
      currentReasoningMode: null,
      skills: [],
      drawing: false,
      review: false,
      reviewMaxImages: 0,
      siteCapture: { available: false, reason: null },
      libraries: [],
    },
  };
}

describe("buildJoystickCommand", () => {
  it("fails closed until the live joystick assignment matches a verified safe identity", () => {
    const first = buildJoystickCommand(snapshot(10, "mode.plan.v1"), THREAD, "up", "00000000-0000-4000-8000-000000000001");
    const reassigned = buildJoystickCommand(snapshot(11, "mode.plan"), THREAD, "up", "00000000-0000-4000-8000-000000000002");
    expect(first).toBeNull();
    expect(reassigned?.expectedAssignment).toEqual({ type: "command", commandId: "mode.plan" });
    expect(reassigned?.expectedBridgeInstanceId).toBe("7d35b974-62cc-4db8-9b4e-5a8dc8a4d812");
    expect(reassigned?.expectedSequence).toBe(11);
  });
});

describe("approval HID exclusion", () => {
  it.each([
    { keycapId: "APPR", nativeCommandId: "native.approve", label: "Approve" },
    { keycapId: "REJ", nativeCommandId: "native-reject", label: "Reject" },
  ])("recognizes $keycapId as a generic approval binding", (binding) => {
    expect(isGenericApprovalBinding(binding)).toBe(true);
  });

  it("never builds a generic HID command for an approval key", () => {
    const current = snapshot(12, "UP") as BridgeSnapshot;
    const approval = {
      actionSlot: "ACT07" as const,
      keycapId: "APPR",
      nativeCommandId: "native.approve",
      label: "Approve",
      enabled: true,
    };
    const guarded = {
      ...current,
      capabilities: { ...current.capabilities, microActions: [approval] },
    };
    expect(buildMicroActionCommand(
      guarded,
      THREAD,
      "ACT07",
      "APPR",
      "native.approve",
      "00000000-0000-4000-8000-000000000003",
    )).toBeNull();
  });

  it("builds only an exactly allowlisted non-approval action", () => {
    const current = snapshot(13, "PLAN");
    const safe = {
      ...current,
      capabilities: {
        ...current.capabilities,
        microActions: [{
          actionSlot: "ACT06" as const,
          keycapId: "FAST",
          nativeCommandId: "mode.fast",
          label: "Fast",
          enabled: true,
        }],
      },
    };
    expect(buildMicroActionCommand(
      safe,
      THREAD,
      "ACT06",
      "FAST",
      "mode.fast",
      "00000000-0000-4000-8000-000000000005",
    )).toMatchObject({
      expectedBridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.fast",
    });
  });

  it("supports the current exact Codex key positions when command IDs are omitted", () => {
    const current = snapshot(14, "PLAN");
    const safe = {
      ...current,
      capabilities: {
        ...current.capabilities,
        commands: ["runMicroAction"],
        microActions: [{
          actionSlot: "ACT10_ACT11" as const,
          keycapId: "MIC",
          nativeCommandId: null,
          label: "Mic",
          enabled: true,
        }],
      },
    };
    expect(buildMicroActionCommand(
      safe,
      THREAD,
      "ACT10_ACT11",
      "MIC",
      null,
      "00000000-0000-4000-8000-000000000006",
    )).toMatchObject({
      actionSlot: "ACT10_ACT11",
      expectedKeycapId: "MIC",
      expectedNativeCommandId: null,
    });
  });

  it("freezes selected Skills only into the exact native Send Prompt command", () => {
    const current = snapshot(15, "PLAN");
    const send = {
      ...current,
      capabilities: {
        ...current.capabilities,
        commands: ["runMicroAction"],
        microActions: [{
          actionSlot: "ACT12" as const,
          keycapId: "CODEX",
          nativeCommandId: "composer.submit",
          label: "Send",
          enabled: true,
        }],
      },
    };
    expect(buildMicroActionCommand(
      send,
      THREAD,
      "ACT12",
      "CODEX",
      "composer.submit",
      "00000000-0000-4000-8000-000000000007",
      "tap",
      null,
      ["visual-review", "openai-docs"],
    )).toMatchObject({ skillNames: ["visual-review", "openai-docs"] });
  });

  it("rejects a Micro action rebound behind the same keycap identity", () => {
    const current = snapshot(13, "UP");
    const bound = {
      ...current,
      capabilities: {
        ...current.capabilities,
        microActions: [{
          actionSlot: "ACT06" as const,
          keycapId: "FAST",
          nativeCommandId: "mode.fast",
          label: "Fast",
          enabled: true,
        }],
      },
    };
    expect(buildMicroActionCommand(
      bound,
      THREAD,
      "ACT06",
      "FAST",
      "mode.fast.v1",
      "00000000-0000-4000-8000-000000000004",
    )).toBeNull();
  });
});

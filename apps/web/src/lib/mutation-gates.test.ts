import { describe, expect, it } from "vitest";
import { emptySlot, type AgentSlot, type BridgeSnapshot } from "./model";
import {
  hasExactSelectedTarget,
  liveMutationSnapshot,
  supportsBridgeCommand,
  supportsSelectedTargetCommand,
  supportsSlotSelection,
  type MutationGateState,
} from "./mutation-gates";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const THREAD_KEY = `local:${THREAD_ID}`;

function selectedSlot(): AgentSlot {
  return {
    slotId: "AG00",
    index: 0,
    title: "Exact task",
    threadKey: THREAD_KEY,
    threadId: THREAD_ID,
    suffix: THREAD_ID.slice(-8),
    status: "idle",
    selected: true,
    activityLabel: null,
    activityAt: null,
  };
}

function degradedSnapshot(commands: readonly string[]): BridgeSnapshot {
  const selected = selectedSlot();
  return {
    bridgeInstanceId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
    seq: 17,
    capturedAt: new Date(1_000).toISOString(),
    theme: "dark",
    health: "degraded",
    healthDetail: "Reasoning metadata is unavailable.",
    slots: [selected, ...Array.from({ length: 5 }, (_, index) => emptySlot(index + 1))],
    activeThreadKey: THREAD_ID,
    selectedSlotId: selected.slotId,
    selectedThreadKey: selected.threadKey,
    pendingApprovals: [],
    capabilities: {
      commands,
      microActions: [{
        actionSlot: "ACT06",
        keycapId: "FAST",
        nativeCommandId: "mode.fast",
        label: "Fast",
        enabled: true,
      }],
      joystickActions: [],
      reasoningModes: [],
      currentReasoningMode: null,
      skills: [],
      drawing: true,
      review: false,
      reviewMaxImages: 0,
      siteCapture: { available: false, reason: null },
      libraries: [],
    },
  };
}

function gate(snapshot: BridgeSnapshot, overrides: Partial<MutationGateState> = {}): MutationGateState {
  return { phase: "online", cached: false, snapshot, ...overrides };
}

describe("operation-scoped mutation gates", () => {
  it("allows exact advertised operations when only independent metadata is degraded", () => {
    const snapshot = degradedSnapshot(["selectAgent", "sendSketch", "runMicroAction"]);
    const state = gate(snapshot);
    const selected = snapshot.slots[0]!;

    expect(liveMutationSnapshot(state)).toBe(snapshot);
    expect(hasExactSelectedTarget(snapshot, selected)).toBe(true);
    expect(supportsSlotSelection(state, selected)).toBe(true);
    expect(supportsSelectedTargetCommand(state, "sendSketch", selected)).toBe(true);
    expect(supportsSelectedTargetCommand(state, "runMicroAction", selected)).toBe(true);
  });

  it("blocks an operation whose exact capability is absent", () => {
    const snapshot = degradedSnapshot(["selectAgent"]);
    const state = gate(snapshot);
    const selected = snapshot.slots[0]!;

    expect(supportsSlotSelection(state, selected)).toBe(true);
    expect(supportsSelectedTargetCommand(state, "sendSketch", selected)).toBe(false);
    expect(supportsSelectedTargetCommand(state, "runMicroAction", selected)).toBe(false);
  });

  it("keeps offline, cached, and non-authoritative targets display-only", () => {
    const snapshot = degradedSnapshot(["selectAgent", "sendSketch"]);
    const selected = snapshot.slots[0]!;

    expect(supportsBridgeCommand(gate(snapshot, { phase: "offline" }), "selectAgent")).toBe(false);
    expect(supportsBridgeCommand(gate(snapshot, { cached: true }), "selectAgent")).toBe(false);
    expect(supportsSelectedTargetCommand(
      gate(snapshot),
      "sendSketch",
      { ...selected, selected: false },
    )).toBe(false);
    expect(supportsBridgeCommand(
      gate({ ...snapshot, health: "offline" }),
      "selectAgent",
    )).toBe(false);
  });
});

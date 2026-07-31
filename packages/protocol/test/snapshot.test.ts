import { describe, expect, it } from "vitest";

import { MicroSnapshotSchema, type MicroSnapshot } from "../src/index.js";

const THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e626";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";

function assignment() {
  return { keycapId: null, nativeCommandId: null, label: null, enabled: false };
}

function joystickAssignment() {
  return { type: null, commandId: null, label: null, enabled: false } as const;
}

function snapshot(): MicroSnapshot {
  return {
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    sequence: 12,
    timestamp: 1_750_000_000_000,
    codexVersion: "1.2.3",
    bridgeHealth: {
      state: "live",
      reason: null,
      changedAt: 1_750_000_000_000,
      lastSuccessfulRefreshAt: 1_750_000_000_000,
    },
    agentSource: "recent",
    slots: [
      {
        slot: 0,
        threadId: THREAD_ID,
        title: "Selected task",
        activityLabel: null,
        nativeStatus: "working",
        visualStatus: "working",
        selected: true,
        activityAt: 1_750_000_000_000,
        ownedByHost: true,
      },
      ...Array.from({ length: 5 }, (_, offset) => ({
        slot: offset + 1,
        threadId: null,
        title: null,
        activityLabel: null,
        nativeStatus: "off",
        visualStatus: "empty" as const,
        selected: false,
        activityAt: null,
        ownedByHost: false,
      })),
    ] as MicroSnapshot["slots"],
    actionAssignments: {
      micro: {
        ACT06: assignment(),
        ACT07: assignment(),
        ACT08: assignment(),
        ACT09: assignment(),
        ACT10_ACT11: assignment(),
        ACT12: assignment(),
      },
      joystick: {
        up: joystickAssignment(),
        right: joystickAssignment(),
        down: joystickAssignment(),
        left: joystickAssignment(),
      },
    },
    activeThreadId: THREAD_ID,
    selectedThreadId: THREAD_ID,
    pendingApprovals: [],
    reasoning: { effort: "high", adjustable: true },
    theme: "dark",
  };
}

describe("MicroSnapshotSchema", () => {
  it("accepts exactly six ordered agent slots", () => {
    const parsed = MicroSnapshotSchema.parse(snapshot());
    expect(parsed.bridgeInstanceId).toBe(BRIDGE_INSTANCE_ID);
    expect(parsed.slots).toHaveLength(6);
  });

  it("validates runtime identity while accepting one legacy snapshot without it", () => {
    expect(MicroSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    expect(MicroSnapshotSchema.safeParse({
      ...snapshot(),
      bridgeVersion: "0.1.0",
      buildRevision: "5023b3c5fa66180087d841fed55864b099867b9c",
      apiContractVersion: 1,
    }).success).toBe(true);
    expect(MicroSnapshotSchema.safeParse({
      ...snapshot(),
      bridgeVersion: "0.1.0",
      buildRevision: "not a safe revision",
      apiContractVersion: 1,
    }).success).toBe(false);
  });

  it("requires a canonical bridge generation ID", () => {
    const missing = { ...snapshot(), bridgeInstanceId: undefined };
    expect(MicroSnapshotSchema.safeParse(missing).success).toBe(false);
    expect(MicroSnapshotSchema.safeParse({ ...snapshot(), bridgeInstanceId: "bridge-1" }).success).toBe(false);
  });

  it("rejects five or seven slots", () => {
    const five = snapshot() as unknown as { slots: unknown[] };
    five.slots = five.slots.slice(0, 5);
    expect(MicroSnapshotSchema.safeParse(five).success).toBe(false);

    const seven = snapshot() as unknown as { slots: unknown[] };
    seven.slots = [...seven.slots, seven.slots[5]];
    expect(MicroSnapshotSchema.safeParse(seven).success).toBe(false);
  });

  it("rejects reordered slot indexes", () => {
    const invalid = snapshot();
    invalid.slots[3] = { ...invalid.slots[3], slot: 4 };
    expect(MicroSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a selectedThreadId that does not identify the selected slot", () => {
    const invalid = snapshot();
    invalid.selectedThreadId = "019f6de7-44c2-7fe2-9d17-9322c952e627";
    expect(MicroSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps active Desktop navigation separate from selected mutation authority", () => {
    const observed = snapshot();
    observed.slots[0] = { ...observed.slots[0], selected: false };
    observed.selectedThreadId = null;

    const parsed = MicroSnapshotSchema.parse(observed);

    expect(parsed.activeThreadId).toBe(THREAD_ID);
    expect(parsed.selectedThreadId).toBeNull();
    expect(parsed.slots.every((slot) => !slot.selected)).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(MicroSnapshotSchema.safeParse({ ...snapshot(), transcript: "must not cross the API" }).success).toBe(false);
  });

  it("rejects transcript-like activity text", () => {
    const unsafe = snapshot() as unknown as { slots: Array<Record<string, unknown>> };
    unsafe.slots[0]!.activityLabel = "Dictated prompt: publish the private draft";
    expect(MicroSnapshotSchema.safeParse(unsafe).success).toBe(false);
  });

  it("accepts the installed Codex reasoning efforts", () => {
    expect(MicroSnapshotSchema.parse(snapshot()).reasoning).toEqual({ effort: "high", adjustable: true });
    expect(MicroSnapshotSchema.safeParse({
      ...snapshot(),
      reasoning: { effort: "ultra", adjustable: true },
    }).success).toBe(true);
    expect(MicroSnapshotSchema.safeParse({
      ...snapshot(),
      reasoning: { effort: "extreme", adjustable: true },
    }).success).toBe(false);
  });

  it("exposes only bounded exact approval identities", () => {
    const pending = snapshot();
    pending.pendingApprovals = [{
      requestId: 991,
      threadId: THREAD_ID,
      turnId: "019f6de7-44c2-7fe2-9d17-9322c952e627",
      itemId: "approval-item-a",
      kind: "commandExecution",
      actionable: true,
      summary: "npm test",
    }];
    expect(MicroSnapshotSchema.safeParse(pending).success).toBe(true);
    expect(MicroSnapshotSchema.safeParse({
      ...pending,
      pendingApprovals: [{ ...pending.pendingApprovals[0], requestId: null }],
    }).success).toBe(false);
    expect(MicroSnapshotSchema.safeParse({
      ...pending,
      pendingApprovals: [{ ...pending.pendingApprovals[0], itemId: "x".repeat(257) }],
    }).success).toBe(false);
    expect(MicroSnapshotSchema.safeParse({
      ...pending,
      pendingApprovals: [{
        ...pending.pendingApprovals[0],
        threadId: "019f6de7-44c2-7fe2-9d17-9322c952e628",
      }],
    }).success).toBe(false);
  });

  it("requires an unknown native status to remain visibly degraded", () => {
    const safe = snapshot();
    safe.slots[1] = { ...safe.slots[1], nativeStatus: "future-native-state", visualStatus: "degraded" };
    expect(MicroSnapshotSchema.safeParse(safe).success).toBe(true);

    const unsafe = snapshot();
    unsafe.slots[1] = { ...unsafe.slots[1], nativeStatus: "future-native-state", visualStatus: "idle" };
    expect(MicroSnapshotSchema.safeParse(unsafe).success).toBe(false);
  });

  it.each([
    ["running", "working"],
    ["input", "needsInput"],
  ] as const)("accepts the known native %s alias with canonical visual status %s", (nativeStatus, visualStatus) => {
    const aliased = snapshot();
    aliased.slots[1] = { ...aliased.slots[1], nativeStatus, visualStatus };

    expect(MicroSnapshotSchema.safeParse(aliased).success).toBe(true);
  });
});

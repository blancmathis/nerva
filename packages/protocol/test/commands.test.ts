import { describe, expect, it } from "vitest";

import {
  CommandAckSchema,
  CommandSchema,
  CommandStatusResponseSchema,
  type Command,
} from "../src/index.js";

const COMMAND_ID = "73cc8a00-9160-48be-b1df-4efccd58ac22";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
const THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e626";
const TURN_ID = "019f6de7-44c2-7fe2-9d17-9322c952e627";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const metadata = {
  commandId: COMMAND_ID,
  expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
  expectedSequence: 42,
  expectedThreadId: THREAD_ID,
} as const;

const commands: Command[] = [
  { ...metadata, type: "selectAgent", slot: 2 },
  {
    ...metadata,
    type: "runMicroAction",
    slot: 2,
    actionSlot: "ACT06",
    expectedKeycapId: "approve",
    expectedNativeCommandId: "native.approve",
  },
  {
    ...metadata,
    type: "runJoystickAction",
    direction: "up",
    expectedAssignment: { type: "command", commandId: "workflow.up" },
  },
  { ...metadata, type: "adjustReasoning", adjustment: "increase" },
  { ...metadata, type: "setModelReasoning", model: "gpt-test", effort: "high" },
  {
    ...metadata,
    type: "respondToApproval",
    requestId: 991,
    turnId: TURN_ID,
    itemId: "approval-item-a",
    approvalKind: "commandExecution",
    decision: "accept",
  },
  { ...metadata, type: "createTask", instruction: null },
  { ...metadata, type: "sendSketch", targetThreadId: THREAD_ID, instruction: "Review this layout", png: PNG_1X1 },
  { ...metadata, type: "acknowledgeCompletion", targetThreadId: THREAD_ID, completionRevision: null },
  {
    ...metadata,
    type: "runLibraryCommand",
    targetThreadId: THREAD_ID,
    snapshotSeq: 42,
    libraryId: "review-copy",
    libraryCommandId: "review-copy-v1",
    prompt: "Review this copy for clarity.",
  },
  { ...metadata, type: "openSession", targetThreadId: THREAD_ID },
  { ...metadata, type: "runSkill", targetThreadId: THREAD_ID, skillName: "browser:control-in-app-browser" },
  { ...metadata, type: "refreshSnapshot", lastKnownSequence: 42 },
];

describe("CommandSchema", () => {
  it.each(commands)("parses $type with idempotency and optimistic context", (command) => {
    expect(CommandSchema.parse(command)).toEqual(command);
  });

  it("requires a canonical commandId", () => {
    expect(CommandSchema.safeParse({ ...commands[0], commandId: "not-unique" }).success).toBe(false);
  });

  it("requires expected sequence and expected thread context", () => {
    const { expectedSequence: _sequence, ...missingSequence } = commands[0]!;
    expect(CommandSchema.safeParse(missingSequence).success).toBe(false);

    const { expectedThreadId: _thread, ...missingThread } = commands[0]!;
    expect(CommandSchema.safeParse(missingThread).success).toBe(false);
  });

  it("requires authority to name one canonical bridge generation", () => {
    const { expectedBridgeInstanceId: _instanceId, ...missingInstanceId } = commands[0]!;
    expect(CommandSchema.safeParse(missingInstanceId).success).toBe(false);
    expect(CommandSchema.safeParse({ ...commands[0], expectedBridgeInstanceId: "bridge-old" }).success).toBe(false);
  });

  it("rejects an out-of-range agent slot and arbitrary action", () => {
    expect(CommandSchema.safeParse({ ...commands[0], slot: 6 }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...commands[1], actionSlot: "shell" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...commands[1], expectedKeycapId: "bad\u0000id" }).success).toBe(false);
  });

  it("requires the exact native assignment identity for action and joystick commands", () => {
    const { expectedNativeCommandId: _nativeCommandId, ...missingActionCommandId } = commands[1] as Extract<Command, { type: "runMicroAction" }>;
    const { expectedAssignment: _assignment, ...missingJoystickAssignment } = commands[2] as Extract<Command, { type: "runJoystickAction" }>;
    expect(CommandSchema.safeParse(missingActionCommandId).success).toBe(false);
    expect(CommandSchema.safeParse(missingJoystickAssignment).success).toBe(false);
  });

  it("accepts only a paired Dictation begin/end gesture", () => {
    const beginId = "63cc8a00-9160-48be-b1df-4efccd58ac23";
    const begin = {
      ...commands[1],
      commandId: beginId,
      actionSlot: "ACT10_ACT11",
      expectedKeycapId: "MIC",
      expectedNativeCommandId: "dictation.toggle",
      gesture: "begin",
      gestureId: beginId,
    };
    expect(CommandSchema.safeParse(begin).success).toBe(true);
    expect(CommandSchema.safeParse({
      ...begin,
      commandId: "53cc8a00-9160-48be-b1df-4efccd58ac24",
      gesture: "end",
      gestureId: beginId,
    }).success).toBe(true);
    expect(CommandSchema.safeParse({ ...begin, actionSlot: "ACT06" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...begin, expectedKeycapId: "FAST" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...begin, gesture: "end", gestureId: null }).success).toBe(false);
  });

  it("bounds and strictly types expected native assignment identities", () => {
    expect(CommandSchema.safeParse({ ...commands[1], expectedNativeCommandId: "x".repeat(257) }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...commands[1], expectedNativeCommandId: "bad\u0000id" }).success).toBe(false);
    expect(CommandSchema.safeParse({
      ...commands[2],
      expectedAssignment: { type: "command", commandId: "x".repeat(257) },
    }).success).toBe(false);
    expect(CommandSchema.safeParse({
      ...commands[2],
      expectedAssignment: { type: "keycap", commandId: "workflow.up" },
    }).success).toBe(false);
    expect(CommandSchema.safeParse({
      ...commands[2],
      expectedAssignment: { type: "command", commandId: "workflow.up", keycapId: "SYNTHETIC" },
    }).success).toBe(false);
  });

  it("rejects a sketch routed to a thread other than the expected thread", () => {
    expect(
      CommandSchema.safeParse({
        ...commands[5],
        targetThreadId: "019f6de7-44c2-7fe2-9d17-9322c952e627",
      }).success,
    ).toBe(false);
  });

  it("rejects non-PNG and data-URL sketch bodies", () => {
    expect(CommandSchema.safeParse({ ...commands[5], png: "bm90IGEgcG5n" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...commands[5], png: `data:image/png;base64,${PNG_1X1}` }).success).toBe(false);
  });

  it("rejects unknown command fields", () => {
    expect(CommandSchema.safeParse({ ...commands[2], evaluate: "alert(1)" }).success).toBe(false);
  });

  it("binds approval decisions to one exact bounded app-server tuple", () => {
    const command = commands.find((candidate) => candidate.type === "respondToApproval")!;
    expect(CommandSchema.safeParse(command).success).toBe(true);
    expect(CommandSchema.safeParse({ ...command, requestId: null }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, turnId: THREAD_ID }).success).toBe(true);
    expect(CommandSchema.safeParse({ ...command, itemId: "" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, approvalKind: "labelGuess" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, decision: "alwaysAccept" }).success).toBe(false);
  });

  it("keeps library actions text-only and bound to the expected thread", () => {
    const command = commands.find((candidate) => candidate.type === "runLibraryCommand")!;
    expect(CommandSchema.safeParse({ ...command, shell: "rm -rf /" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, libraryId: "../../template" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, libraryCommandId: "../../template" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, libraryCommandId: `x${"y".repeat(64)}` }).success).toBe(false);
    expect(
      CommandSchema.safeParse({
        ...command,
        targetThreadId: "019f6de7-44c2-7fe2-9d17-9322c952e627",
      }).success,
    ).toBe(false);
    expect(CommandSchema.safeParse({ ...command, snapshotSeq: 41 }).success).toBe(false);
  });

  it("opens only an exact UUID session without a Micro slot mutation", () => {
    const command = commands.find((candidate) => candidate.type === "openSession")!;
    expect(CommandSchema.safeParse(command).success).toBe(true);
    expect(CommandSchema.safeParse({ ...command, targetThreadId: "codex://threads/new" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, slot: 0 }).success).toBe(false);
  });

  it("runs only a bounded skill name against the expected thread", () => {
    const command = commands.find((candidate) => candidate.type === "runSkill")!;
    expect(CommandSchema.safeParse(command).success).toBe(true);
    expect(CommandSchema.safeParse({ ...command, skillName: "../../unsafe" }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...command, skillName: "https://example.test/skill" }).success).toBe(false);
    expect(
      CommandSchema.safeParse({
        ...command,
        targetThreadId: "019f6de7-44c2-7fe2-9d17-9322c952e627",
      }).success,
    ).toBe(false);
  });
});

describe("command acknowledgement and reconciliation", () => {
  it("accepts an idempotent duplicate acknowledgement", () => {
    expect(
      CommandAckSchema.safeParse({
        commandId: COMMAND_ID,
        disposition: "duplicate",
        status: "succeeded",
        sequence: 43,
        targetThreadId: THREAD_ID,
        error: null,
      }).success,
    ).toBe(true);
  });

  it.each(["inFlight", "succeeded", "failed", "unknown"] as const)("supports reconnect status %s", (status) => {
    const failed = status === "failed";
    expect(
      CommandStatusResponseSchema.safeParse({
        commandId: COMMAND_ID,
        status,
        sequence: 43,
        targetThreadId: THREAD_ID,
        result: status === "unknown" ? null : { sequence: 43, targetThreadId: THREAD_ID, message: null },
        error: failed ? { code: "AGENT_BUSY", message: "Agent is busy", retryable: true } : null,
        updatedAt: 1_750_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("requires failure details for a failed reconnect status", () => {
    expect(
      CommandStatusResponseSchema.safeParse({
        commandId: COMMAND_ID,
        status: "failed",
        sequence: 43,
        targetThreadId: THREAD_ID,
        result: null,
        error: null,
        updatedAt: 1_750_000_000_000,
      }).success,
    ).toBe(false);
  });
});

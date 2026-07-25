import type { RunJoystickActionCommand, RunMicroActionCommand } from "@codex-pad/protocol";
import type { BridgeSnapshot, NativeActionBinding, NativeJoystickBinding } from "./model";

const APPROVAL_BINDING_TOKENS = new Set([
  "appr",
  "approve",
  "accept",
  "allow",
  "rej",
  "reject",
  "decline",
  "deny",
]);

const VERIFIED_NON_APPROVAL_BINDINGS = new Set([
  "ACT06\u0000FAST\u0000mode.fast",
  "ACT06\u0000FAST\u0000",
  "ACT09\u0000SPLIT\u0000thread.fork",
  "ACT09\u0000SPLIT\u0000",
  "ACT10_ACT11\u0000MIC\u0000dictation.toggle",
  "ACT10_ACT11\u0000MIC\u0000",
  "ACT12\u0000CODEX\u0000composer.submit",
  "ACT12\u0000CODEX\u0000",
]);

const VERIFIED_JOYSTICK_BINDINGS = new Set([
  "command\u0000mode.plan",
  "command\u0000nav.forward",
  "command\u0000skill.one",
  "command\u0000nav.back",
]);

const CODEX_DICTATION_KEYCAP_ID = "MIC";
const CODEX_DICTATION_COMMAND_ID = "dictation.toggle";
const CODEX_SUBMIT_KEYCAP_ID = "CODEX";
const CODEX_SUBMIT_COMMAND_ID = "composer.submit";

function bindingToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Generic native approval keys never carry the exact app-server request identity. */
export function isGenericApprovalBinding(
  binding: Pick<NativeActionBinding, "keycapId" | "nativeCommandId" | "label">,
): boolean {
  return [binding.keycapId, binding.nativeCommandId, binding.label]
    .filter((value): value is string => Boolean(value))
    .some((value) => {
      const token = bindingToken(value);
      const withoutNativePrefix = token.startsWith("native") ? token.slice("native".length) : token;
      return APPROVAL_BINDING_TOKENS.has(token) || APPROVAL_BINDING_TOKENS.has(withoutNativePrefix);
    });
}

/** Positive allowlist of native identities observed and verified as non-approval actions. */
export function isVerifiedNonApprovalBinding(
  binding: Pick<NativeActionBinding, "actionSlot" | "keycapId" | "nativeCommandId">,
): boolean {
  if (binding.keycapId === null) return false;
  return VERIFIED_NON_APPROVAL_BINDINGS.has(
    `${binding.actionSlot}\u0000${binding.keycapId}\u0000${binding.nativeCommandId ?? ""}`,
  );
}

/** Positive allowlist for exact layout-v1 joystick command identities. */
export function isVerifiedJoystickBinding(binding: NativeJoystickBinding): boolean {
  if (binding.type !== "command" || binding.commandId === null) return false;
  return VERIFIED_JOYSTICK_BINDINGS.has(
    `${binding.type}\u0000${binding.commandId}`,
  );
}

export function isGenericApprovalJoystickBinding(binding: NativeJoystickBinding): boolean {
  if (binding.commandId === null) return false;
  const token = bindingToken(binding.commandId);
  const withoutNativePrefix = token.startsWith("native") ? token.slice("native".length) : token;
  return APPROVAL_BINDING_TOKENS.has(token) || APPROVAL_BINDING_TOKENS.has(withoutNativePrefix);
}

/** Exact native Codex Micro identity for the Mac microphone dictation gesture. */
export function isCodexDictationBinding(
  binding: Pick<NativeActionBinding, "actionSlot" | "keycapId" | "nativeCommandId">,
): boolean {
  return binding.actionSlot === "ACT10_ACT11"
    && binding.keycapId === CODEX_DICTATION_KEYCAP_ID
    && (binding.nativeCommandId === CODEX_DICTATION_COMMAND_ID || binding.nativeCommandId === null);
}

/** Exact native Codex Micro identity for submitting the visible Mac composer. */
export function isCodexSubmitBinding(
  binding: Pick<NativeActionBinding, "actionSlot" | "keycapId" | "nativeCommandId">,
): boolean {
  return binding.actionSlot === "ACT12"
    && binding.keycapId === CODEX_SUBMIT_KEYCAP_ID
    && (binding.nativeCommandId === CODEX_SUBMIT_COMMAND_ID || binding.nativeCommandId === null);
}

/** Opaque UI action reference bound to both live native identities; empty final segment means null. */
export function microActionReference(binding: NativeActionBinding): string | null {
  if (!binding.enabled || !binding.keycapId || !isVerifiedNonApprovalBinding(binding)) return null;
  const nativeCommandId = binding.nativeCommandId === null
    ? ""
    : encodeURIComponent(binding.nativeCommandId);
  return `micro:${binding.actionSlot}:${encodeURIComponent(binding.keycapId)}:${nativeCommandId}`;
}

/** Resolve a Micro action from the current snapshot and fail closed for approval-like HID keys. */
export function buildMicroActionCommand(
  snapshot: BridgeSnapshot,
  targetThreadId: string,
  actionSlot: NativeActionBinding["actionSlot"],
  expectedKeycapId: string,
  expectedNativeCommandId: string | null,
  commandId: string,
  gesture: "tap" | "begin" | "end" = "tap",
  gestureId: string | null = null,
): RunMicroActionCommand | null {
  const selected = snapshot.slots.find((slot) => slot.selected && slot.threadId === targetThreadId);
  const assignment = snapshot.capabilities.microActions.find((candidate) => (
    candidate.actionSlot === actionSlot
    && candidate.enabled
    && candidate.keycapId === expectedKeycapId
    && candidate.nativeCommandId === expectedNativeCommandId
  ));
  if (!selected || !assignment?.keycapId || !isVerifiedNonApprovalBinding(assignment)) return null;
  return {
    type: "runMicroAction",
    commandId,
    expectedBridgeInstanceId: snapshot.bridgeInstanceId,
    expectedSequence: snapshot.seq,
    expectedThreadId: targetThreadId,
    slot: selected.index as 0 | 1 | 2 | 3 | 4 | 5,
    actionSlot,
    expectedKeycapId: assignment.keycapId,
    expectedNativeCommandId: assignment.nativeCommandId,
    ...(gesture === "tap" ? {} : { gesture, gestureId }),
  };
}

/** Resolve a direction from the current snapshot only; a reassignment replaces the exact command expectation. */
export function buildJoystickCommand(
  snapshot: BridgeSnapshot,
  targetThreadId: string,
  direction: NativeJoystickBinding["direction"],
  commandId: string,
): RunJoystickActionCommand | null {
  const selected = snapshot.slots.find((slot) => slot.selected && slot.threadId === targetThreadId);
  const assignment = snapshot.capabilities.joystickActions.find((candidate) => candidate.direction === direction);
  if (
    !selected
    || !assignment?.enabled
    || assignment.type !== "command"
    || assignment.commandId === null
    || !isVerifiedJoystickBinding(assignment)
    || isGenericApprovalJoystickBinding(assignment)
  ) return null;
  return {
    type: "runJoystickAction",
    commandId,
    expectedBridgeInstanceId: snapshot.bridgeInstanceId,
    expectedSequence: snapshot.seq,
    expectedThreadId: targetThreadId,
    direction,
    expectedAssignment: { type: "command", commandId: assignment.commandId },
  };
}

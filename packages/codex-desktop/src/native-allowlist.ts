import type { NativeActionSlot, JoystickDirection } from "./types.js";

interface NativeActionIdentity {
  readonly slot: NativeActionSlot;
  readonly keycapId: string;
  readonly commandId: string | null;
}

interface NativeJoystickIdentity {
  readonly type: "command";
  readonly commandId: string;
  readonly label: string;
}

export const ALLOWLISTED_NATIVE_ACTIONS = [
  { slot: "ACT06", keycapId: "FAST", commandId: "mode.fast" },
  { slot: "ACT06", keycapId: "FAST", commandId: null },
  { slot: "ACT09", keycapId: "SPLIT", commandId: "thread.fork" },
  { slot: "ACT09", keycapId: "SPLIT", commandId: null },
  { slot: "ACT10_ACT11", keycapId: "MIC", commandId: "dictation.toggle" },
  { slot: "ACT10_ACT11", keycapId: "MIC", commandId: null },
  { slot: "ACT12", keycapId: "CODEX", commandId: "composer.submit" },
  { slot: "ACT12", keycapId: "CODEX", commandId: null },
] as const satisfies readonly NativeActionIdentity[];

export const ALLOWLISTED_NATIVE_JOYSTICK_ACTIONS = [
  { type: "command", commandId: "mode.plan", label: "Plan" },
  { type: "command", commandId: "nav.forward", label: "Forward" },
  { type: "command", commandId: "skill.one", label: "Skill one" },
  { type: "command", commandId: "nav.back", label: "Back" },
] as const satisfies readonly NativeJoystickIdentity[];

function exactIdentity(
  allowlist: readonly NativeActionIdentity[],
  slot: NativeActionSlot,
  keycapId: string,
  commandId: string | null,
): boolean {
  return allowlist.some((entry) => (
    entry.slot === slot && entry.keycapId === keycapId && entry.commandId === commandId
  ));
}

export function isAllowlistedNativeAction(
  slot: NativeActionSlot,
  keycapId: string,
  commandId: string | null,
): boolean {
  return exactIdentity(ALLOWLISTED_NATIVE_ACTIONS, slot, keycapId, commandId);
}

export function isAllowlistedNativeJoystickAction(
  _direction: JoystickDirection,
  type: string,
  commandId: string,
): boolean {
  return ALLOWLISTED_NATIVE_JOYSTICK_ACTIONS.some((entry) => (
    entry.type === type && entry.commandId === commandId
  ));
}

export function nativeJoystickLabel(type: string, commandId: string): string | null {
  return ALLOWLISTED_NATIVE_JOYSTICK_ACTIONS.find((entry) => (
    entry.type === type && entry.commandId === commandId
  ))?.label ?? null;
}

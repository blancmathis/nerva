import { CodexDesktopAdapterError } from "./errors.js";
import {
  JOYSTICK_DIRECTIONS,
  MICRO_SLOT_KEYS,
  NATIVE_ACTION_SLOTS,
  type AgentSource,
  type HealthReason,
  type JoystickDirection,
  type NativeActionAssignment,
  type NativeActionLayout,
  type NativeAssignment,
  type NativeJoystickAssignment,
  type NativeJoystickLayout,
  type NativeReasoningState,
  type NativeTheme,
  type MicroSlot,
  type MicroSlotIndex,
  type MicroSlotKey,
  type MicroSnapshot,
  type MicroStatus,
  type ReasoningEffort,
  type SixMicroSlots
} from "./types.js";

const UUID = /(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^0-9a-f])/i;

interface RecordValue {
  readonly [key: string]: unknown;
}

export interface ParsedNativeSnapshot {
  readonly snapshot: MicroSnapshot;
  readonly warnings: readonly HealthReason[];
  readonly routingKeys: ReadonlyMap<MicroSlotKey, string>;
}

export function extractThreadId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  return value.match(UUID)?.[1]?.toLowerCase() ?? null;
}

export function projectNativeStatus(value: unknown): { status: MicroStatus; known: boolean; nativeStatus: string } {
  const nativeStatus = typeof value === "string" ? value.trim().toLowerCase().slice(0, 64) : "unknown";
  switch (nativeStatus) {
    case "off":
    case "empty":
      return { status: "off", known: true, nativeStatus };
    case "idle":
      return { status: "idle", known: true, nativeStatus };
    case "working":
    case "thinking":
    case "running":
      return { status: "working", known: true, nativeStatus };
    case "unread":
    case "complete":
    case "completed":
    case "done":
      return { status: "unread", known: true, nativeStatus };
    case "approval":
    case "awaiting-approval":
      return { status: "awaiting-approval", known: true, nativeStatus };
    case "input":
    case "awaiting-response":
      return { status: "awaiting-response", known: true, nativeStatus };
    case "error":
    case "failed":
      return { status: "error", known: true, nativeStatus };
    default:
      return { status: "degraded", known: false, nativeStatus };
  }
}

export function parseNativeSnapshot(value: unknown, observedAt: number): ParsedNativeSnapshot {
  if (!isRecord(value) || !Array.isArray(value.slots) || value.slots.length !== 6) {
    throw new CodexDesktopAdapterError("invalid-slot-count", "Codex Desktop did not expose exactly six Micro slots.");
  }

  const slotsByIndex = new Map<MicroSlotIndex, MicroSlot>();
  const routingKeys = new Map<MicroSlotKey, string>();
  const warnings: HealthReason[] = [];

  for (const rawSlot of value.slots) {
    if (!isRecord(rawSlot)) {
      throw new CodexDesktopAdapterError("invalid-slot-key", "A Codex Desktop Micro slot was not an object.");
    }
    const index = readSlotIndex(rawSlot);
    if (index === null || slotsByIndex.has(index)) {
      throw new CodexDesktopAdapterError("invalid-slot-key", "Codex Desktop Micro slot keys were not AG00 through AG05 exactly once.");
    }

    const key = MICRO_SLOT_KEYS[index];
    const rawThreadKey = rawSlot.threadKey ?? rawSlot.threadId ?? null;
    const threadId = rawThreadKey == null || rawThreadKey === "" ? null : extractThreadId(rawThreadKey);
    if (rawThreadKey != null && rawThreadKey !== "" && threadId === null) {
      throw new CodexDesktopAdapterError("invalid-thread-key", `Codex Desktop ${key} did not expose a valid thread UUID.`);
    }
    if (threadId !== null) routingKeys.set(key, threadId);

    const projected = projectNativeStatus(rawSlot.status);
    if (!projected.known) {
      warnings.push({
        code: "unknown-status",
        message: `Codex Desktop ${key} reported an unrecognized status (${projected.nativeStatus}).`,
        slotKey: key
      });
    }

    slotsByIndex.set(index, {
      index,
      key,
      threadId,
      title: typeof rawSlot.title === "string" ? rawSlot.title.slice(0, 240) : null,
      status: projected.status,
      nativeStatus: projected.nativeStatus,
      selected: rawSlot.selected === true,
      activityAt: parseActivityAt(rawSlot.activityAt),
      activityLabel: null
    });
  }

  const ordered = MICRO_SLOT_KEYS.map((_, index) => slotsByIndex.get(index as MicroSlotIndex));
  if (ordered.some((slot) => slot === undefined)) {
    throw new CodexDesktopAdapterError("invalid-slot-key", "Codex Desktop Micro slot keys were incomplete.");
  }
  if (ordered.filter((slot) => slot?.selected).length > 1) {
    throw new CodexDesktopAdapterError("invalid-selection", "Codex Desktop reported more than one selected Micro slot.");
  }
  const activityObserved = ordered.every((slot) => slot?.activityAt !== null);
  if (!activityObserved) {
    warnings.push({ code: "activity-unavailable", message: "One or more native slot activity timestamps were not observable." });
  }

  const activeRaw = value.activeThreadKey ?? value.activeThreadId ?? null;
  const activeThreadId = activeRaw == null || activeRaw === "" ? null : extractThreadId(activeRaw);
  if (activeRaw != null && activeRaw !== "" && activeThreadId === null) {
    throw new CodexDesktopAdapterError("invalid-thread-key", "Codex Desktop reported an invalid active thread UUID.");
  }

  const activeThreadObserved = value.activeThreadObserved === true;
  if (!activeThreadObserved) {
    warnings.push({ code: "active-thread-unavailable", message: "The native active-thread signal was not observable." });
  }

  const agentSource = parseAgentSource(value.agentSource);
  if (agentSource === null) {
    warnings.push({ code: "agent-source-unavailable", message: "The live Codex Micro agent source was not observable." });
  }

  const actionLayout = parseActionLayout(value.actionLayout);
  if (actionLayout === null) {
    warnings.push({ code: "action-layout-unavailable", message: "The complete live Codex Micro action layout was not observable." });
  }
  const actionControl = isRecord(value.handlers) && value.handlers.hid === true;
  if (!actionControl) {
    warnings.push({ code: "action-handler-unavailable", message: "The native Micro action event handler was not proven live." });
  }
  const composerAttachment = isRecord(value.handlers) && value.handlers.composerAttachment === true;
  if (!composerAttachment) {
    warnings.push({
      code: "composer-attachment-unavailable",
      message: "The native Codex composer image attachment handler was not proven live.",
    });
  }

  const joystickLayout = parseJoystickLayout(value.joystickLayout);
  if (joystickLayout === null) {
    warnings.push({ code: "joystick-layout-unavailable", message: "All four live joystick assignments were not observable." });
  }
  const joystickControl = isRecord(value.handlers) && value.handlers.joystick === true;
  if (!joystickControl) {
    warnings.push({ code: "joystick-handler-unavailable", message: "The native Micro joystick event handler was not proven live." });
  }

  const reasoning = parseReasoning(value.reasoning);
  if (reasoning === null) {
    warnings.push({ code: "reasoning-unavailable", message: "The live reasoning effort and encoder capability were not observable." });
  }
  if (reasoning !== null && !reasoning.adjustable) {
    warnings.push({ code: "reasoning-control-unavailable", message: "Reasoning effort is visible, but the native encoder handler is not live." });
  }

  const theme = value.theme === "light" || value.theme === "dark" ? value.theme : null;
  if (theme === null) {
    warnings.push({ code: "theme-unavailable", message: "The live Codex Desktop theme was not observable." });
  }

  return {
    snapshot: {
      slots: ordered as unknown as SixMicroSlots,
      activeThreadId,
      agentSource,
      actionLayout,
      joystickLayout,
      reasoning,
      theme,
      capabilities: {
        activeThread: activeThreadObserved,
        activity: activityObserved,
        agentSource: agentSource !== null,
        composerAttachment,
        actionLayout: actionLayout !== null,
        actionControl,
        joystickLayout: joystickLayout !== null,
        joystickControl,
        reasoning: reasoning !== null,
        reasoningControl: reasoning?.adjustable === true,
        theme: theme !== null
      },
      observedAt
    },
    warnings,
    routingKeys
  };
}

function parseAgentSource(value: unknown): AgentSource | null {
  return value === "pinned" || value === "recent" || value === "priority" || value === "custom" ? value : null;
}

function parseActionLayout(value: unknown): NativeActionLayout | null {
  if (!Array.isArray(value) || value.length !== NATIVE_ACTION_SLOTS.length) return null;
  const bySlot = new Map<string, NativeActionAssignment>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !NATIVE_ACTION_SLOTS.includes(candidate.slot as never)) return null;
    const assignment = parseAssignment(candidate);
    if (!assignment || bySlot.has(candidate.slot as string)) return null;
    const slot = candidate.slot as NativeActionAssignment["slot"];
    bySlot.set(slot, { slot, ...assignment });
  }
  const ordered = NATIVE_ACTION_SLOTS.map((slot) => bySlot.get(slot));
  return ordered.some((assignment) => assignment === undefined) ? null : ordered as unknown as NativeActionLayout;
}

function parseJoystickLayout(value: unknown): NativeJoystickLayout | null {
  if (!isRecord(value)) return null;
  const parsed = {} as Record<JoystickDirection, NativeJoystickAssignment>;
  for (const direction of JOYSTICK_DIRECTIONS) {
    const candidate = value[direction];
    if (!isRecord(candidate)) return null;
    const assignment = parseJoystickAssignment(candidate);
    if (!assignment || (candidate.direction !== undefined && candidate.direction !== direction)) return null;
    parsed[direction] = { direction, ...assignment };
  }
  return parsed;
}

function parseJoystickAssignment(
  value: RecordValue,
): Pick<NativeJoystickAssignment, "type" | "commandId"> | null {
  if (
    !Object.prototype.hasOwnProperty.call(value, "type")
    || !Object.prototype.hasOwnProperty.call(value, "commandId")
    || value.type !== "command"
    || typeof value.commandId !== "string"
    || !isSafeIdentifier(value.commandId)
  ) {
    return null;
  }
  return { type: "command", commandId: value.commandId };
}

function parseAssignment(value: RecordValue): NativeAssignment | null {
  if (typeof value.keycapId !== "string" || !isSafeIdentifier(value.keycapId)) return null;
  if (value.commandId != null && (typeof value.commandId !== "string" || !isSafeIdentifier(value.commandId))) return null;
  return {
    keycapId: value.keycapId,
    commandId: typeof value.commandId === "string" ? value.commandId : null
  };
}

function parseReasoning(value: unknown): NativeReasoningState | null {
  if (!isRecord(value) || typeof value.adjustable !== "boolean") return null;
  const allowed = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);
  return typeof value.effort === "string" && allowed.has(value.effort as ReasoningEffort)
    ? { effort: value.effort as ReasoningEffort, adjustable: value.adjustable }
    : null;
}

function parseActivityAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 100_000_000_000 ? Math.trunc(value * 1_000) : Math.trunc(value);
  }
  if (typeof value === "string" && value.length <= 64) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function isSafeIdentifier(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/.test(value);
}

function readSlotIndex(value: RecordValue): MicroSlotIndex | null {
  const numeric = value.index ?? value.id;
  if (Number.isInteger(numeric) && typeof numeric === "number" && numeric >= 0 && numeric <= 5) {
    const expected = MICRO_SLOT_KEYS[numeric];
    const suppliedKey = value.key ?? value.slotKey;
    if (suppliedKey !== undefined && suppliedKey !== expected) return null;
    return numeric as MicroSlotIndex;
  }

  const key = value.key ?? value.slotKey;
  if (typeof key !== "string") return null;
  const index = MICRO_SLOT_KEYS.indexOf(key as MicroSlotKey);
  return index >= 0 ? (index as MicroSlotIndex) : null;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

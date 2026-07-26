import { BridgeInstanceIdSchema, MicroSnapshotSchema, type MicroSnapshot } from "@codex-pad/protocol";
import {
  SLOT_COUNT,
  emptySlot,
  threadIdFromKey,
  type AgentSlot,
  type BridgeCapabilities,
  type BridgeHealth,
  type BridgeSnapshot,
  type LibraryCapability,
  type SkillCapability,
  type SlotStatus,
} from "./model";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reviewImageLimit(value: unknown, reviewAvailable: boolean, multiImageVerified = false): 0 | 1 | 12 {
  if (!reviewAvailable) return 0;
  const explicit = finiteNumber(value);
  if (explicit !== null) {
    if (explicit >= 12) return 12;
    if (explicit >= 1) return 1;
    return 0;
  }
  // An older bridge may omit the bounded limit. Default to the proven
  // single-image path unless it explicitly reports the legacy multi probe.
  return multiImageVerified ? 12 : 1;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const STATUS_ALIASES: Record<string, SlotStatus> = {
  off: "off",
  empty: "off",
  unassigned: "off",
  idle: "idle",
  ready: "idle",
  working: "working",
  running: "working",
  thinking: "working",
  executing: "working",
  unread: "unread",
  complete: "unread",
  completed: "unread",
  "completed-unread": "unread",
  "awaiting-approval": "awaiting-approval",
  awaitingapproval: "awaiting-approval",
  approval: "awaiting-approval",
  waiting: "awaiting-response",
  "awaiting-response": "awaiting-response",
  awaitingresponse: "awaiting-response",
  needsinput: "awaiting-response",
  "needs-input": "awaiting-response",
  input: "awaiting-response",
  error: "error",
  failed: "error",
  degraded: "degraded",
  unknown: "degraded",
};

export function normalizeStatus(value: unknown): SlotStatus {
  const raw = text(value)?.toLowerCase().replaceAll("_", "-") ?? "unknown";
  return STATUS_ALIASES[raw] ?? STATUS_ALIASES[raw.replaceAll("-", "")] ?? "degraded";
}

function normalizeHealth(value: unknown): BridgeHealth {
  const raw = text(value)?.toLowerCase() ?? "degraded";
  if (["ready", "healthy", "online", "connected"].includes(raw)) return "ready";
  if (["offline", "disconnected", "unavailable"].includes(raw)) return "offline";
  return "degraded";
}

function slotIndex(slot: JsonRecord, fallback: number): number {
  const direct = finiteNumber(slot.index) ?? finiteNumber(slot.position) ?? finiteNumber(slot.slot);
  if (direct !== null && direct >= 0 && direct < SLOT_COUNT) return Math.trunc(direct);
  const id = text(slot.slotId) ?? text(slot.id) ?? text(slot.nativeSlotId);
  const match = id?.match(/([0-5])$/);
  return match?.[1] ? Number(match[1]) : fallback;
}

function normalizeSlot(value: unknown, fallbackIndex: number, activeThreadKey: string | null): AgentSlot {
  const slot = record(value);
  const index = slotIndex(slot, fallbackIndex);
  const slotId = text(slot.slotId) ?? text(slot.id) ?? text(slot.nativeSlotId) ?? `AG0${index}`;
  const threadKey = text(slot.threadKey) ?? text(slot.threadId) ?? text(record(slot.thread).id);
  const threadId = threadIdFromKey(threadKey);
  const statusSource = slot.status
    ?? (text(slot.nativeStatus)?.toLowerCase().includes("approval") ? "awaiting-approval" : null)
    ?? slot.visualStatus
    ?? slot.nativeStatus;
  const selected = bool(slot.selected) ?? bool(slot.isSelected) ?? (threadKey !== null && threadKey === activeThreadKey);

  const nativeStatus = text(slot.nativeStatus);
  const updatedAt = text(slot.updatedAt)
    ?? (finiteNumber(slot.activityAt) !== null ? new Date(finiteNumber(slot.activityAt) ?? 0).toISOString() : null);
  return {
    slotId,
    index,
    title: text(slot.title) ?? text(slot.name) ?? (threadKey ? "Untitled task" : "Open channel"),
    threadKey,
    threadId,
    suffix: threadId?.slice(-8) ?? null,
    status: threadKey ? normalizeStatus(statusSource) : "off",
    selected,
    activityLabel: null,
    activityAt: finiteNumber(slot.activityAt),
    ...(nativeStatus ? { nativeStatus } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function commandsFrom(value: unknown): ReadonlySet<string> {
  if (Array.isArray(value)) {
    return new Set(value.map((item) => (typeof item === "string" ? item : text(record(item).id))).filter((item): item is string => Boolean(item)));
  }
  const source = record(value);
  return new Set(Object.entries(source).filter(([, enabled]) => enabled === true).map(([name]) => name));
}

function skillsFrom(value: unknown): SkillCapability[] {
  return array(value).slice(0, 128).map((item, index) => {
    if (typeof item === "string") return { id: item, label: item, enabled: true };
    const skill = record(item);
    const description = text(skill.description);
    const group = text(skill.group);
    return {
      id: text(skill.id) ?? text(skill.command) ?? `skill-${index + 1}`,
      label: text(skill.label) ?? text(skill.name) ?? `Skill ${index + 1}`,
      ...(description ? { description } : {}),
      ...(group ? { group } : {}),
      enabled: bool(skill.enabled) ?? true,
    };
  });
}

function modelsFrom(value: unknown) {
  return array(value).slice(0, 100).flatMap((item) => {
    const model = record(item);
    const modelId = text(model.model);
    const displayName = text(model.displayName);
    const defaultReasoningEffort = text(model.defaultReasoningEffort);
    const supportedReasoningEfforts = array(model.supportedReasoningEfforts)
      .map(text)
      .filter((effort): effort is string => effort !== null);
    if (!modelId || !displayName || !defaultReasoningEffort || supportedReasoningEfforts.length === 0) return [];
    return [{
      model: modelId,
      displayName,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      isDefault: bool(model.isDefault) ?? false,
    }];
  });
}

function normalizeCapabilities(root: JsonRecord): BridgeCapabilities {
  const source = record(root.capabilities);
  const config = record(root.config);
  const assignments = array(root.actionAssignments);
  const commandSet = commandsFrom(source.commands ?? source.actions ?? root.actions ?? config.actions ?? assignments);
  const reasoning = record(source.reasoning);
  const reasoningModes = array(source.reasoningModes ?? reasoning.modes ?? config.reasoningModes)
    .map(text)
    .filter((item): item is string => item !== null);
  const skills = skillsFrom(source.skills ?? config.skills ?? root.skills);
  const review = bool(source.review) ?? false;
  return {
    commands: [...commandSet],
    microActions: [],
    joystickActions: [],
    reasoningModes,
    currentReasoningMode: text(source.currentReasoningMode) ?? text(reasoning.current) ?? text(root.reasoningMode),
    currentModel: text(source.currentModel),
    models: modelsFrom(source.models),
    skills,
    drawing: bool(source.drawing) ?? commandSet.has("send-sketch") ?? commandSet.has("sketch"),
    review,
    reviewMaxImages: reviewImageLimit(
      source.reviewMaxImages,
      review,
      bool(source.multiImageInputVerified) ?? false,
    ),
    composerAttachmentMaxImages: source.composerAttachmentMaxImages === 12 ? 12 : 1,
    siteCapture: { available: false, reason: null },
    libraries: [],
  };
}

function fromProtocol(snapshot: MicroSnapshot): BridgeSnapshot {
  const slots: AgentSlot[] = snapshot.slots.map((slot) => ({
    slotId: `AG0${slot.slot}`,
    index: slot.slot,
    title: slot.title ?? (slot.threadId ? "Untitled task" : "Open channel"),
    threadKey: slot.threadId,
    threadId: slot.threadId,
    suffix: slot.threadId?.slice(-8) ?? null,
    status: slot.threadId
      ? normalizeStatus(
          slot.nativeStatus.toLowerCase().includes("approval")
            ? "awaiting-approval"
            : slot.visualStatus,
        )
      : "off",
    selected: slot.selected,
    activityLabel: null,
    activityAt: slot.activityAt,
    nativeStatus: slot.nativeStatus,
    ...(slot.activityAt === null ? {} : { updatedAt: new Date(slot.activityAt).toISOString() }),
  }));
  const selected = slots.find((slot) => slot.selected) ?? null;
  const microActions = Object.entries(snapshot.actionAssignments.micro).map(([actionSlot, assignment]) => ({
    actionSlot: actionSlot as "ACT06" | "ACT07" | "ACT08" | "ACT09" | "ACT10_ACT11" | "ACT12",
    keycapId: assignment.keycapId,
    nativeCommandId: assignment.nativeCommandId,
    label: assignment.label,
    enabled: assignment.enabled,
  }));
  const joystickActions = Object.entries(snapshot.actionAssignments.joystick).map(([direction, assignment]) => ({
    direction: direction as "up" | "right" | "down" | "left",
    type: assignment.type,
    commandId: assignment.commandId,
    label: assignment.label,
    enabled: assignment.enabled,
  }));

  return {
    bridgeInstanceId: snapshot.bridgeInstanceId,
    codexVersion: snapshot.codexVersion,
    seq: snapshot.sequence,
    capturedAt: new Date(snapshot.timestamp).toISOString(),
    theme: snapshot.theme,
    health: snapshot.bridgeHealth.state === "live"
      ? "ready"
      : snapshot.bridgeHealth.state === "offline"
        ? "offline"
        : "degraded",
    healthDetail: snapshot.bridgeHealth.reason,
    slots,
    activeThreadKey: snapshot.activeThreadId,
    selectedSlotId: selected?.slotId ?? null,
    selectedThreadKey: snapshot.selectedThreadId,
    pendingApprovals: snapshot.pendingApprovals,
    capabilities: {
      commands: snapshot.pendingApprovals.some((approval) => approval.actionable)
        ? ["respondToApproval"]
        : [],
      microActions,
      joystickActions,
      reasoningModes: snapshot.reasoning?.adjustable ? ["minimal", "low", "medium", "high", "xhigh", "ultra", "max"] : [],
      currentReasoningMode: snapshot.reasoning?.effort ?? null,
      skills: [],
      drawing: false,
      review: false,
      reviewMaxImages: 0,
      composerAttachmentMaxImages: 1,
      siteCapture: { available: false, reason: null },
      libraries: [],
    },
  };
}

function librariesFrom(value: unknown): LibraryCapability[] {
  return array(value).flatMap((item) => {
    const library = record(item);
    const libraryId = text(library.libraryId);
    const label = text(library.label);
    const prompt = text(library.prompt);
    return libraryId && label && prompt ? [{ libraryId, label, prompt }] : [];
  });
}

export function normalizeSecondaryCapabilities(input: unknown): Omit<BridgeCapabilities, "microActions" | "joystickActions"> | null {
  const envelope = record(input);
  const root = envelope.ok === true ? record(envelope.data) : envelope;
  if (Object.keys(root).length === 0) return null;
  const commands = array(root.commands).map(text).filter((item): item is string => item !== null);
  const reasoningModes = array(root.reasoningModes).map(text).filter((item): item is string => item !== null);
  const review = bool(root.review) ?? false;
  return {
    commands,
    reasoningModes,
    currentReasoningMode: text(root.currentReasoningMode),
    currentModel: text(root.currentModel),
    models: modelsFrom(root.models),
    skills: skillsFrom(root.skills),
    drawing: bool(root.drawing) ?? false,
    review,
    reviewMaxImages: reviewImageLimit(
      root.reviewMaxImages,
      review,
      bool(root.multiImageInputVerified) ?? false,
    ),
    composerAttachmentMaxImages: root.composerAttachmentMaxImages === 12 ? 12 : 1,
    siteCapture: {
      available: bool(record(root.siteCapture).available) ?? false,
      reason: text(record(root.siteCapture).reason),
    },
    libraries: librariesFrom(root.libraries),
  };
}

export function mergeSecondaryCapabilities(
  snapshot: BridgeSnapshot,
  secondary: Omit<BridgeCapabilities, "microActions" | "joystickActions"> | null,
): BridgeSnapshot {
  if (!secondary) return snapshot;
  return {
    ...snapshot,
    capabilities: {
      ...secondary,
      microActions: snapshot.capabilities.microActions,
      joystickActions: snapshot.capabilities.joystickActions,
      // Sequence-bound commands must survive an older secondary-capabilities
      // response that completed after this snapshot.
      commands: [...new Set([...secondary.commands, ...snapshot.capabilities.commands])],
      // Native reasoning is part of the sequenced snapshot. Never let an older
      // secondary-capabilities request overwrite a newer observed dial state.
      reasoningModes: snapshot.capabilities.reasoningModes,
      currentReasoningMode: snapshot.capabilities.currentReasoningMode,
    },
  };
}

/**
 * Translate versioned bridge payloads at one boundary. Unknown fields are ignored;
 * missing authority fails closed by yielding degraded health and no capabilities.
 */
export function normalizeSnapshot(input: unknown): BridgeSnapshot | null {
  const envelope = record(input);
  const candidate = envelope.ok === true && Object.keys(record(envelope.data)).length
    ? envelope.data
    : Object.keys(record(envelope.snapshot)).length
      ? envelope.snapshot
      : input;
  const protocol = MicroSnapshotSchema.safeParse(candidate);
  if (protocol.success) return fromProtocol(protocol.data);
  const root = record(candidate);
  const seq = finiteNumber(root.seq) ?? finiteNumber(root.sequence);
  if (seq === null || seq < 0) return null;
  const bridgeInstanceId = BridgeInstanceIdSchema.safeParse(root.bridgeInstanceId);
  if (!bridgeInstanceId.success) return null;

  const native = record(root.native);
  const healthObject = Object.keys(record(root.bridgeHealth)).length ? record(root.bridgeHealth) : record(root.health);
  const selectedThreadKey = text(root.selectedThreadKey)
    ?? text(root.selectedThreadId);
  const activeThreadKey = text(root.activeThreadKey)
    ?? text(root.activeThreadId)
    ?? text(native.activeThreadKey)
    ?? text(native.activeThreadId)
    ?? selectedThreadKey;
  const sourceSlots = array(root.slots ?? native.slots ?? record(root.micro).slots);
  const byIndex = new Map<number, AgentSlot>();
  for (const [fallbackIndex, value] of sourceSlots.entries()) {
    const slot = normalizeSlot(value, fallbackIndex, selectedThreadKey);
    if (slot.index >= 0 && slot.index < SLOT_COUNT && !byIndex.has(slot.index)) byIndex.set(slot.index, slot);
  }
  const slots = Array.from({ length: SLOT_COUNT }, (_, index) => byIndex.get(index) ?? emptySlot(index));
  const selected = slots.find((slot) => slot.selected)
    ?? slots.find((slot) => slot.threadKey !== null && slot.threadKey === activeThreadKey)
    ?? null;
  const healthValue = typeof root.health === "string"
    ? root.health
    : healthObject.status ?? healthObject.state ?? native.health ?? root.status;

  return {
    bridgeInstanceId: bridgeInstanceId.data,
    codexVersion: text(root.codexVersion),
    seq,
    capturedAt: text(root.capturedAt)
      ?? text(root.updatedAt)
      ?? (finiteNumber(root.timestamp) !== null ? new Date(finiteNumber(root.timestamp) ?? 0).toISOString() : new Date().toISOString()),
    theme: text(root.theme) === "light" ? "light" : "dark",
    health: normalizeHealth(healthValue),
    healthDetail: text(healthObject.detail) ?? text(healthObject.reason) ?? text(root.healthDetail) ?? null,
    slots,
    activeThreadKey,
    selectedSlotId: selected?.slotId ?? text(root.selectedSlotId),
    selectedThreadKey: selected?.threadKey ?? selectedThreadKey,
    // Legacy snapshots cannot prove an app-server request tuple. Never infer
    // approval authority from native status text or button labels.
    pendingApprovals: [],
    capabilities: normalizeCapabilities(root),
  };
}

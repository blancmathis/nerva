export interface DrawingTarget {
  bridgeInstanceId: string;
  slotId: string;
  threadId: string;
  /** Native slot identity, when the adapter exposes it separately. */
  threadKey?: string;
  title: string;
  snapshotSeq: number;
}

export interface SendGuardInput {
  connected: boolean;
  displayedTarget: DrawingTarget | null;
  currentTarget: DrawingTarget | null;
  instruction: string;
  hasContent: boolean;
  readOnly?: boolean;
  sending?: boolean;
}

export type SendBlockReason =
  | "offline"
  | "read-only"
  | "sending"
  | "no-target"
  | "invalid-target"
  | "target-changed"
  | "empty-drawing";

export interface SendGuard {
  allowed: boolean;
  reason?: SendBlockReason;
  message?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_SUFFIX_PATTERN =
  /(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function threadIdFromDrawingKey(threadKey: string): string | null {
  if (/[\\/?#]/.test(threadKey)) return null;
  return threadKey.trim().match(UUID_SUFFIX_PATTERN)?.[1]?.toLowerCase() ?? null;
}

export function isExactDrawingTarget(target: DrawingTarget | null): target is DrawingTarget {
  return Boolean(
    target &&
      target.slotId.trim() &&
      UUID_PATTERN.test(target.bridgeInstanceId) &&
      UUID_PATTERN.test(target.threadId) &&
      (target.threadKey === undefined ||
        threadIdFromDrawingKey(target.threadKey) === target.threadId.toLowerCase()) &&
      Number.isSafeInteger(target.snapshotSeq) &&
      target.snapshotSeq >= 0,
  );
}

export function drawingTargetIdentity(target: DrawingTarget | null): string | null {
  if (!isExactDrawingTarget(target)) return null;
  return `${target.bridgeInstanceId}:${target.slotId}:${target.threadId}:${target.snapshotSeq}`;
}

export function sameDrawingTarget(
  first: DrawingTarget | null,
  second: DrawingTarget | null,
): boolean {
  if (!isExactDrawingTarget(first) || !isExactDrawingTarget(second)) return false;
  // A newer snapshot can describe the same binding. The original sequence is
  // still sent as the bridge's optimistic-concurrency token; only a slot/thread
  // rebind is a routing change that must lock the editor.
  return first.bridgeInstanceId === second.bridgeInstanceId
    && first.slotId === second.slotId
    && first.threadId === second.threadId;
}

export function evaluateSendGuard(input: SendGuardInput): SendGuard {
  if (input.readOnly) {
    return { allowed: false, reason: "read-only", message: "Drawing is read-only." };
  }
  if (!input.connected) {
    return {
      allowed: false,
      reason: "offline",
      message: "Reconnect to the Mac before attaching this image.",
    };
  }
  if (input.sending) {
    return { allowed: false, reason: "sending", message: "Sketch is being attached." };
  }
  if (!input.displayedTarget) {
    return {
      allowed: false,
      reason: "no-target",
      message: "Choose an exact Codex task before drawing.",
    };
  }
  if (!isExactDrawingTarget(input.displayedTarget)) {
    return {
      allowed: false,
      reason: "invalid-target",
      message: "The selected task has no verified thread identity.",
    };
  }
  if (!sameDrawingTarget(input.displayedTarget, input.currentTarget)) {
    return {
      allowed: false,
      reason: "target-changed",
      message: "The dashboard selection changed. Close and reopen the canvas to confirm the new task.",
    };
  }
  if (!input.hasContent) {
    return {
      allowed: false,
      reason: "empty-drawing",
      message: "Add a mark, shape, label, or image first.",
    };
  }
  return { allowed: true };
}

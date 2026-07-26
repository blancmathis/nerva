import type { SlotStatus } from "./model";
import type { ProductSession } from "./session-presentation";

export interface SessionActivityEvent {
  readonly id: string;
  readonly threadId: string;
  readonly status: SlotStatus;
  readonly at: number;
  readonly title: string;
  readonly detail: string;
}

const STATUS_COPY: Readonly<Record<SlotStatus, readonly [string, string]>> = {
  "awaiting-approval": ["Approval requested", "An exact Codex approval is waiting."],
  "awaiting-response": ["Waiting for your answer", "The agent paused for user input."],
  working: ["Work started", "Codex is actively working on this task."],
  unread: ["Result completed", "A new result is ready to inspect."],
  error: ["Agent error", "This task needs attention on the Mac."],
  idle: ["Task is idle", "No active turn is running."],
  off: ["Task unavailable", "The native task is not currently exposed."],
  degraded: ["Proof degraded", "Nerva is preserving display state while reconnecting."],
};

export function activityEventForSession(
  session: ProductSession,
  previousStatus: SlotStatus | null,
  observedAt = Date.now(),
): SessionActivityEvent | null {
  if (previousStatus === session.status) return null;
  const [title, detail] = STATUS_COPY[session.status];
  const at = session.activityAt ?? observedAt;
  return {
    id: `${session.threadId}:${session.status}:${at}`,
    threadId: session.threadId,
    status: session.status,
    at,
    title,
    detail: previousStatus === null ? `Current state observed. ${detail}` : detail,
  };
}

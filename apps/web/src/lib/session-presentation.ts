import type { SessionSummary } from "@codex-pad/protocol";
import type { AgentSlot, SlotStatus } from "./model";
import { normalizeStatus } from "./normalize";

export interface ProductSession {
  readonly threadId: string;
  readonly threadKey: string;
  readonly title: string;
  readonly status: SlotStatus;
  readonly nativeStatus: string;
  readonly activityAt: number | null;
  readonly projectId: string | null;
  readonly project: string | null;
  readonly selected: boolean;
  readonly activeOnMac: boolean;
  readonly nativeSlot: AgentSlot | null;
  readonly ownedByHost: boolean;
  readonly siteAssociations: SessionSummary["siteAssociations"];
}

function sessionStatus(session: Pick<SessionSummary, "nativeStatus" | "visualStatus">): SlotStatus {
  return normalizeStatus(
    session.nativeStatus.toLocaleLowerCase().includes("approval")
      ? "awaiting-approval"
      : session.visualStatus,
  );
}

export function buildProductSessions(
  slots: readonly AgentSlot[],
  nativeSessions: readonly SessionSummary[],
  allSessions: readonly SessionSummary[],
  activeThreadId: string | null,
): readonly ProductSession[] {
  const summaries = new Map<string, SessionSummary>();
  for (const session of allSessions) summaries.set(session.threadId, session);
  for (const session of nativeSessions) summaries.set(session.threadId, session);

  const sessions = new Map<string, ProductSession>();
  for (const slot of slots) {
    if (!slot.threadId) continue;
    const summary = summaries.get(slot.threadId);
    sessions.set(slot.threadId, {
      threadId: slot.threadId,
      threadKey: slot.threadKey ?? slot.threadId,
      title: summary?.title ?? slot.title ?? "Untitled task",
      status: summary ? sessionStatus(summary) : slot.status,
      nativeStatus: summary?.nativeStatus ?? slot.nativeStatus ?? slot.status,
      activityAt: summary?.activityAt ?? slot.activityAt,
      projectId: summary?.projectId ?? null,
      project: summary?.projectLabel ?? null,
      selected: slot.selected,
      activeOnMac: slot.threadId === activeThreadId,
      nativeSlot: slot,
      ownedByHost: summary?.ownedByHost ?? true,
      siteAssociations: summary?.siteAssociations ?? [],
    });
  }

  for (const summary of summaries.values()) {
    const existing = sessions.get(summary.threadId);
    if (existing) continue;
    sessions.set(summary.threadId, {
      threadId: summary.threadId,
      threadKey: summary.threadId,
      title: summary.title ?? "Untitled task",
      status: sessionStatus(summary),
      nativeStatus: summary.nativeStatus,
      activityAt: summary.activityAt,
      projectId: summary.projectId,
      project: summary.projectLabel,
      selected: summary.selected,
      activeOnMac: summary.threadId === activeThreadId,
      nativeSlot: null,
      ownedByHost: summary.ownedByHost,
      siteAssociations: summary.siteAssociations,
    });
  }

  return [...sessions.values()].sort((left, right) => {
    if (left.activeOnMac !== right.activeOnMac) return left.activeOnMac ? -1 : 1;
    const activity = (right.activityAt ?? 0) - (left.activityAt ?? 0);
    return activity !== 0 ? activity : left.title.localeCompare(right.title);
  });
}

export function sessionStatusLabel(status: SlotStatus): string {
  switch (status) {
    case "awaiting-approval": return "Needs approval";
    case "awaiting-response": return "Waiting for your answer";
    case "working": return "Working";
    case "unread": return "Completed";
    case "error": return "Error";
    case "idle": return "Idle";
    case "off": return "Unavailable";
    case "degraded": return "Status unavailable";
  }
}

export function relativeSessionActivity(
  session: Pick<ProductSession, "status" | "activityAt">,
  now = Date.now(),
): string {
  if (session.status === "awaiting-approval") return "Waiting for your approval";
  if (session.status === "awaiting-response") return "Waiting for your answer";
  if (session.activityAt === null) return sessionStatusLabel(session.status);
  const elapsed = Math.max(0, now - session.activityAt);
  const minutes = Math.max(1, Math.floor(elapsed / 60_000));
  const age = minutes < 60
    ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
    : minutes < 1_440
      ? `${Math.floor(minutes / 60)} ${Math.floor(minutes / 60) === 1 ? "hour" : "hours"}`
      : `${Math.floor(minutes / 1_440)} ${Math.floor(minutes / 1_440) === 1 ? "day" : "days"}`;
  if (session.status === "working") return `Active ${age} ago`;
  if (session.status === "unread") return `Completed ${age} ago`;
  if (session.status === "error") return `Error detected ${age} ago`;
  return `Last active ${age} ago`;
}

export function searchProductSession(session: ProductSession, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [session.title, session.project, session.threadId, session.nativeStatus, sessionStatusLabel(session.status)]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

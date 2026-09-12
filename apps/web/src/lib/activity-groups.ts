import type { SlotStatus } from "./model";
import type { ProductSession } from "./session-presentation";

export type ActivityState = "in-progress" | "ready-for-review";

export interface ActivityRecentGroup {
  readonly id: string;
  readonly label: string;
  readonly sessions: readonly ProductSession[];
}

export interface ActivitySessionGroups {
  readonly inProgress: readonly ProductSession[];
  readonly readyForReview: readonly ProductSession[];
  readonly recent: readonly ActivityRecentGroup[];
}

export function activityState(status: SlotStatus): ActivityState | null {
  if (status === "working") return "in-progress";
  if (
    status === "unread"
    || status === "awaiting-approval"
    || status === "awaiting-response"
    || status === "error"
  ) {
    return "ready-for-review";
  }
  return null;
}

export function activityPriorityCount(sessions: readonly ProductSession[]): number {
  return sessions.filter((session) => activityState(session.status) !== null).length;
}

function byRecentActivity(left: ProductSession, right: ProductSession): number {
  const activity = (right.activityAt ?? 0) - (left.activityAt ?? 0);
  return activity !== 0 ? activity : left.title.localeCompare(right.title);
}

function localCalendarDayIndex(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function activityDayGroup(timestamp: number | null, now: number): Pick<ActivityRecentGroup, "id" | "label"> {
  if (timestamp === null) return { id: "earlier", label: "Earlier" };
  const date = new Date(timestamp);
  const nowDate = new Date(now);
  const ageInDays = localCalendarDayIndex(now) - localCalendarDayIndex(timestamp);
  const id = `day-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

  if (ageInDays <= 0) return { id, label: "Today" };
  if (ageInDays === 1) return { id, label: "Yesterday" };
  if (ageInDays <= 6) {
    return { id, label: new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date) };
  }
  return {
    id,
    label: new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      ...(date.getFullYear() === nowDate.getFullYear() ? {} : { year: "numeric" }),
    }).format(date),
  };
}

export function groupActivitySessions(
  sessions: readonly ProductSession[],
  now = Date.now(),
): ActivitySessionGroups {
  const inProgress = sessions
    .filter((session) => activityState(session.status) === "in-progress")
    .sort(byRecentActivity);
  const readyForReview = sessions
    .filter((session) => activityState(session.status) === "ready-for-review")
    .sort(byRecentActivity);
  const recentGroups = new Map<string, { label: string; sessions: ProductSession[] }>();

  for (const session of sessions
    .filter((item) => activityState(item.status) === null)
    .sort(byRecentActivity)) {
    const group = activityDayGroup(session.activityAt, now);
    const existing = recentGroups.get(group.id);
    if (existing) existing.sessions.push(session);
    else recentGroups.set(group.id, { label: group.label, sessions: [session] });
  }

  return {
    inProgress,
    readyForReview,
    recent: Array.from(recentGroups, ([id, group]) => ({ id, ...group })),
  };
}

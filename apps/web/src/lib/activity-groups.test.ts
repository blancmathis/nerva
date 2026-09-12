import { describe, expect, it } from "vitest";
import type { ProductSession } from "./session-presentation";
import { activityPriorityCount, activityState, groupActivitySessions } from "./activity-groups";

function session(
  threadId: string,
  status: ProductSession["status"],
  activityAt: number | null,
  title = threadId,
): ProductSession {
  return {
    threadId,
    threadKey: threadId,
    title,
    status,
    nativeStatus: status,
    activityAt,
    projectId: null,
    project: null,
    selected: false,
    activeOnMac: false,
    nativeSlot: null,
    ownedByHost: true,
    siteAssociations: [],
  };
}

describe("Activity session groups", () => {
  it("separates priority from recent history without duplicating sessions", () => {
    const now = new Date(2026, 7, 26, 14).getTime();
    const sessions = [
      session("working", "working", now - 1_000),
      session("review", "unread", now - 2_000),
      session("approval", "awaiting-approval", now - 3_000),
      session("idle", "idle", now - 4_000),
    ];
    const groups = groupActivitySessions(sessions, now);

    expect(groups.inProgress.map((item) => item.threadId)).toEqual(["working"]);
    expect(groups.readyForReview.map((item) => item.threadId)).toEqual(["review", "approval"]);
    expect(groups.recent).toHaveLength(1);
    expect(groups.recent[0]).toMatchObject({ label: "Today" });
    expect(groups.recent[0]!.sessions.map((item) => item.threadId)).toEqual(["idle"]);
    expect(activityPriorityCount(sessions)).toBe(3);
  });

  it("keeps each state in recent activity order", () => {
    const groups = groupActivitySessions([
      session("working-old", "working", 1_000),
      session("working-new", "working", 3_000),
      session("review-old", "error", 2_000),
      session("review-new", "awaiting-response", 4_000),
    ]);

    expect(groups.inProgress.map((item) => item.threadId)).toEqual(["working-new", "working-old"]);
    expect(groups.readyForReview.map((item) => item.threadId)).toEqual(["review-new", "review-old"]);
  });

  it("groups complete history by friendly local day labels", () => {
    const now = new Date(2026, 7, 26, 14).getTime();
    const groups = groupActivitySessions([
      session("today", "idle", new Date(2026, 7, 26, 9).getTime()),
      session("yesterday", "idle", new Date(2026, 7, 25, 18).getTime()),
      session("monday", "off", new Date(2026, 7, 24, 12).getTime()),
      session("this-year", "idle", new Date(2026, 6, 12, 12).getTime()),
      session("last-year", "idle", new Date(2025, 11, 3, 12).getTime()),
      session("unknown", "degraded", null),
    ], now);

    expect(groups.recent.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      "Monday",
      "July 12",
      "December 3, 2025",
      "Earlier",
    ]);
  });

  it("exposes only the two Activity states", () => {
    expect(activityState("working")).toBe("in-progress");
    expect(activityState("unread")).toBe("ready-for-review");
    expect(activityState("awaiting-approval")).toBe("ready-for-review");
    expect(activityState("awaiting-response")).toBe("ready-for-review");
    expect(activityState("error")).toBe("ready-for-review");
    expect(activityState("idle")).toBeNull();
  });
});

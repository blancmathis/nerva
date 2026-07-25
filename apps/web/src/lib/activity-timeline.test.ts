import { describe, expect, it } from "vitest";

import type { ProductSession } from "./session-presentation";
import { activityEventForSession, appendSessionActivity } from "./activity-timeline";

function session(status: ProductSession["status"], activityAt = 100): ProductSession {
  return {
    threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    threadKey: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    title: "Private prompt must never cross",
    status,
    nativeStatus: status,
    activityAt,
    projectId: null,
    project: null,
    selected: true,
    activeOnMac: true,
    nativeSlot: null,
    ownedByHost: true,
    siteAssociations: [],
  };
}

describe("privacy-safe activity projection", () => {
  it("emits status categories without session title or prompt content", () => {
    const event = activityEventForSession(session("working"), "idle");
    expect(event).toMatchObject({ title: "Work started", status: "working", at: 100 });
    expect(JSON.stringify(event)).not.toContain("Private prompt");
  });

  it("deduplicates and bounds the recent timeline", () => {
    const event = activityEventForSession(session("unread", 200), "working")!;
    expect(appendSessionActivity(appendSessionActivity([], event), event)).toHaveLength(1);
    const many = Array.from({ length: 12 }, (_, index) => ({ ...event, id: String(index), at: index }));
    expect(many.reduce((current, next) => appendSessionActivity(current, next), [] as readonly typeof event[])).toHaveLength(8);
  });
});

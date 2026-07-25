import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@codex-pad/protocol";
import { emptySlot } from "./model";
import { buildProductSessions, relativeSessionActivity } from "./session-presentation";

const threadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    threadId,
    title: "Premium interface",
    nativeStatus: "working",
    visualStatus: "working",
    activityLabel: null,
    activityAt: 1_000,
    projectId: null,
    projectLabel: null,
    selected: true,
    microSlot: 0,
    ownedByHost: true,
    siteAssociations: [],
    siteAssociation: null,
    ...overrides,
  };
}

describe("session presentation", () => {
  it("merges native and catalog state by exact thread identity", () => {
    const slot = { ...emptySlot(0), threadId, threadKey: threadId, title: "Old title", selected: true, status: "working" as const };
    const sessions = buildProductSessions([slot], [summary()], [], threadId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ title: "Premium interface", activeOnMac: true, nativeSlot: slot });
  });

  it("uses reliable freshness wording instead of claiming a start time", () => {
    expect(relativeSessionActivity({ status: "working", activityAt: 1_000 }, 121_000)).toBe("Active 2 minutes ago");
    expect(relativeSessionActivity({ status: "awaiting-response", activityAt: null }, 121_000)).toBe("Waiting for your answer");
  });
});

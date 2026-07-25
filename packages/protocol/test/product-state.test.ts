import { describe, expect, it } from "vitest";

import { HomeLayoutSchema, ProductStateUpdateRequestSchema } from "../src/index.js";

const layout = {
  version: 1 as const,
  mode: "manual" as const,
  pinnedThreadIds: ["thread-a", "thread-b"],
  manual: {
    sections: [{
      id: "section-1",
      name: "Shipping",
      color: "amber" as const,
      cases: [{ id: "case-1", name: "Active", color: "cobalt" as const, threadIds: ["thread-a"] }],
    }],
    looseThreadIds: ["thread-b"],
  },
  automaticOrder: ["needs-approval", "error", "working", "waiting", "completed", "idle"] as const,
};

describe("product state", () => {
  it("accepts one exact manual placement per pinned session", () => {
    expect(HomeLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it("rejects duplicate, missing, or unpinned placements", () => {
    expect(HomeLayoutSchema.safeParse({ ...layout, manual: { ...layout.manual, looseThreadIds: ["thread-a"] } }).success).toBe(false);
    expect(HomeLayoutSchema.safeParse({ ...layout, manual: { ...layout.manual, looseThreadIds: [] } }).success).toBe(false);
    expect(HomeLayoutSchema.safeParse({ ...layout, manual: { ...layout.manual, looseThreadIds: ["thread-c"] } }).success).toBe(false);
  });

  it("rejects stale or structurally incomplete product updates", () => {
    const valid = {
      expectedRevision: 4,
      homeLayout: layout,
      preferences: {
        compactControls: false,
        keepAwake: false,
        allSessionsEnabled: true as const,
        theme: "system" as const,
        cardDensity: "rich" as const,
        motion: "system" as const,
        haptics: true,
        notifications: { needsApproval: true, completed: true, error: true, waiting: false },
        defaultHomeMode: "manual" as const,
        modelReasoningPresets: [],
        siteFavorites: [],
      },
    };
    expect(ProductStateUpdateRequestSchema.safeParse(valid).success).toBe(true);
    expect(ProductStateUpdateRequestSchema.safeParse({ ...valid, preferences: { theme: "dark" } }).success).toBe(false);
  });
});

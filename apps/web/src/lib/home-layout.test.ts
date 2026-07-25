import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_STATUS_ORDER,
  MAX_PINNED_SESSIONS,
  automaticStatusForSession,
  createInitialHomeLayout,
  homeLayoutReducer,
  migrateHomeLayout,
  migrateLegacySpatialLayout,
} from "./home-layout";

const ids = Array.from({ length: 14 }, (_, index) => `thread-${index + 1}`);

describe("home layout", () => {
  it("keeps 0–12 pinned sessions and places new pins directly on Home", () => {
    let layout = createInitialHomeLayout([]);
    for (const threadId of ids) layout = homeLayoutReducer(layout, { type: "pin", threadId });
    expect(layout.pinnedThreadIds).toHaveLength(MAX_PINNED_SESSIONS);
    expect(layout.manual.looseThreadIds).toEqual(ids.slice(0, MAX_PINNED_SESSIONS));
  });

  it("atomically replaces one pinned session at the twelve-session limit", () => {
    const original = ids.slice(0, MAX_PINNED_SESSIONS);
    const replacement = ids[MAX_PINNED_SESSIONS]!;
    const removed = original[4]!;
    const layout = homeLayoutReducer(createInitialHomeLayout(original), {
      type: "replace-pin",
      unpinThreadId: removed,
      pinThreadId: replacement,
    });

    expect(layout.pinnedThreadIds).toHaveLength(MAX_PINNED_SESSIONS);
    expect(layout.pinnedThreadIds).not.toContain(removed);
    expect(layout.pinnedThreadIds).toContain(replacement);
    expect(layout.manual.looseThreadIds).not.toContain(removed);
    expect(layout.manual.looseThreadIds).toContain(replacement);
  });

  it("preserves the complete manual arrangement while automatic mode is active", () => {
    let layout = createInitialHomeLayout(ids.slice(0, 3));
    layout = homeLayoutReducer(layout, {
      type: "create-section",
      section: { id: "section-a", name: "Launch", color: "amber" },
    });
    layout = homeLayoutReducer(layout, {
      type: "create-case",
      sectionId: "section-a",
      homeCase: { id: "case-a", name: "Interface", color: "cobalt" },
    });
    layout = homeLayoutReducer(layout, { type: "move-session", threadId: ids[0]!, targetCaseId: "case-a" });
    const manual = layout.manual;
    layout = homeLayoutReducer(layout, { type: "set-mode", mode: "automatic" });
    layout = homeLayoutReducer(layout, { type: "set-automatic-order", order: [...AUTOMATIC_STATUS_ORDER].reverse() });
    layout = homeLayoutReducer(layout, { type: "set-mode", mode: "manual" });
    expect(layout.manual).toEqual(manual);
    expect(layout.automaticOrder).toEqual([...AUTOMATIC_STATUS_ORDER].reverse());
  });

  it("returns sessions to direct Home cards when a case or section is deleted", () => {
    let layout = createInitialHomeLayout(ids.slice(0, 2));
    layout = homeLayoutReducer(layout, { type: "create-section", section: { id: "s", name: "Section", color: "sage" } });
    layout = homeLayoutReducer(layout, { type: "create-case", sectionId: "s", homeCase: { id: "c", name: "Case", color: "coral" } });
    layout = homeLayoutReducer(layout, { type: "move-session", threadId: ids[0]!, targetCaseId: "c" });
    layout = homeLayoutReducer(layout, { type: "delete-case", caseId: "c" });
    expect(layout.pinnedThreadIds).toContain(ids[0]);
    expect(layout.manual.looseThreadIds).toContain(ids[0]);
  });

  it("sanitizes duplicate placements without losing pinned identities", () => {
    const layout = migrateHomeLayout({
      mode: "manual",
      pinnedThreadIds: [ids[0], ids[1], ids[0]],
      manual: {
        looseThreadIds: [ids[0], ids[1]],
        sections: [{
          id: "section",
          name: "Section",
          color: "amber",
          cases: [{ id: "case", name: "Case", color: "cobalt", threadIds: [ids[0], ids[1]] }],
        }],
      },
      automaticOrder: AUTOMATIC_STATUS_ORDER,
    });
    expect(layout.pinnedThreadIds).toEqual([ids[0], ids[1]]);
    expect(layout.manual.sections[0]?.cases[0]?.threadIds).toEqual([ids[0], ids[1]]);
    expect(layout.manual.looseThreadIds).toEqual([]);
  });

  it("imports the previous spatial boxes as one visible section", () => {
    const layout = migrateLegacySpatialLayout({
      version: 2,
      boxes: [{ id: "today", name: "Today", color: "amber", size: "wide", threadIds: [ids[1]!] }],
      unassignedThreadIds: [ids[0]!],
    });
    expect(layout.pinnedThreadIds).toEqual([ids[0], ids[1]]);
    expect(layout.manual.sections[0]?.name).toBe("Workspace");
    expect(layout.manual.sections[0]?.cases[0]?.name).toBe("Today");
    expect(layout.manual.looseThreadIds).toEqual([ids[0]]);
  });

  it("uses the six canonical automatic buckets without inventing a seventh status", () => {
    expect(automaticStatusForSession({ status: "awaiting-approval" })).toBe("needs-approval");
    expect(automaticStatusForSession({ status: "degraded", nativeStatus: "unknown-state" })).toBe("idle");
    expect(automaticStatusForSession({ status: "unread" })).toBe("completed");
  });

});

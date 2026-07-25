import { describe, expect, it } from "vitest";
import { fixtureSnapshot, THREADS } from "../../e2e/fixture-data";
import {
  mergeSecondaryCapabilities,
  normalizeSecondaryCapabilities,
  normalizeSnapshot,
} from "./normalize";

const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";

describe("native reasoning snapshot normalization", () => {
  it("keeps the active Mac task separate from selected command authority", () => {
    const observed = fixtureSnapshot({ bridgeInstanceId: BRIDGE_INSTANCE_ID, sequence: 2, selectedIndex: 0 });
    const snapshot = normalizeSnapshot({
      ok: true,
      data: {
        ...observed,
        slots: observed.slots.map((slot) => ({ ...slot, selected: false })),
        selectedThreadId: null,
        activeThreadId: THREADS[0].id,
      },
    });

    expect(snapshot?.activeThreadKey).toBe(THREADS[0].id);
    expect(snapshot?.selectedThreadKey).toBeNull();
    expect(snapshot?.slots.every((slot) => !slot.selected)).toBe(true);
  });

  it("drops transcript-like activity text from legacy and cached payloads", () => {
    const unsafe = fixtureSnapshot({
      bridgeInstanceId: BRIDGE_INSTANCE_ID,
      sequence: 3,
      selectedIndex: 0,
    }) as unknown as { slots: Array<Record<string, unknown>> };
    unsafe.slots[0]!.activityLabel = "Dictated prompt: publish the private draft";

    const snapshot = normalizeSnapshot({ ok: true, data: unsafe });

    expect(snapshot?.slots[0]?.activityLabel).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("publish the private draft");
  });

  it("projects the observed effort and adjustment capability from the sequenced snapshot", () => {
    const snapshot = normalizeSnapshot({
      ok: true,
      data: fixtureSnapshot({ bridgeInstanceId: BRIDGE_INSTANCE_ID, sequence: 4, selectedIndex: 0 }),
    });

    expect(snapshot?.capabilities.currentReasoningMode).toBe("high");
    expect(snapshot?.capabilities.reasoningModes).toEqual(["minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);
  });

  it("shows a visible but non-adjustable native effort without enabling the dial", () => {
    const observed = fixtureSnapshot({ bridgeInstanceId: BRIDGE_INSTANCE_ID, sequence: 4, selectedIndex: 0 });
    const snapshot = normalizeSnapshot({
      ok: true,
      data: { ...observed, reasoning: { effort: "high", adjustable: false } },
    });

    expect(snapshot?.capabilities.currentReasoningMode).toBe("high");
    expect(snapshot?.capabilities.reasoningModes).toEqual([]);
  });

  it("does not overwrite a sequenced native effort with a stale capabilities response", () => {
    const snapshot = normalizeSnapshot({
      ok: true,
      data: fixtureSnapshot({ bridgeInstanceId: BRIDGE_INSTANCE_ID, sequence: 5, selectedIndex: 0 }),
    });
    const stale = normalizeSecondaryCapabilities({
      ok: true,
      data: {
        commands: ["adjustReasoning"],
        reasoningModes: ["low", "medium", "high"],
        currentReasoningMode: "low",
      },
    });

    expect(snapshot).not.toBeNull();
    expect(mergeSecondaryCapabilities(snapshot!, stale).capabilities.currentReasoningMode).toBe("high");
  });

  it("does not erase exact pending-approval authority with stale secondary capabilities", () => {
    const snapshot = normalizeSnapshot({
      ok: true,
      data: fixtureSnapshot({
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        sequence: 7,
        selectedIndex: 3,
        approvalPending: true,
      }),
    });
    const stale = normalizeSecondaryCapabilities({
      ok: true,
      data: {
        commands: ["selectAgent"],
        reasoningModes: [],
        currentReasoningMode: null,
      },
    });

    expect(snapshot?.pendingApprovals).toHaveLength(1);
    expect(mergeSecondaryCapabilities(snapshot!, stale).capabilities.commands).toEqual(
      expect.arrayContaining(["selectAgent", "respondToApproval"]),
    );
  });
});

describe("review delivery capability normalization", () => {
  it("defaults an older review-capable bridge to the mono-image path", () => {
    const capabilities = normalizeSecondaryCapabilities({
      ok: true,
      data: { review: true },
    });

    expect(capabilities?.review).toBe(true);
    expect(capabilities?.reviewMaxImages).toBe(1);
  });

  it("accepts only the bounded verified multi-image limit", () => {
    expect(normalizeSecondaryCapabilities({
      ok: true,
      data: { review: true, reviewMaxImages: 12 },
    })?.reviewMaxImages).toBe(12);
    expect(normalizeSecondaryCapabilities({
      ok: true,
      data: { review: true, reviewMaxImages: 7 },
    })?.reviewMaxImages).toBe(1);
    expect(normalizeSecondaryCapabilities({
      ok: true,
      data: { review: false, reviewMaxImages: 12 },
    })?.reviewMaxImages).toBe(0);
  });
});

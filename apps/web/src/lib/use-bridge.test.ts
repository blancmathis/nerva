import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@codex-pad/protocol";
import { emptySlot, type BridgeSnapshot } from "./model";
import {
  chooseLiveSnapshot,
  fetchAllSessionsWithoutOverlap,
  fetchNativeSessionsWithoutOverlap,
  fetchSecondaryData,
  mergeLastGoodSessions,
  markCodexUsageStale,
  refreshSnapshotAfterCommand,
  shouldApplyNativeSessions,
  shouldPollNativeSessions,
} from "./use-bridge";
import { fixtureSessions } from "../../e2e/fixture-data";

function snapshot(seq: number, bridgeInstanceId = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812"): BridgeSnapshot {
  return {
    bridgeInstanceId,
    bridgeVersion: "0.1.0",
    buildRevision: "0000000000000000",
    apiContractVersion: 1,
    seq,
    capturedAt: new Date(seq).toISOString(),
    theme: "dark",
    health: "ready",
    healthDetail: null,
    slots: Array.from({ length: 6 }, (_, index) => emptySlot(index)),
    activeThreadKey: null,
    selectedSlotId: null,
    selectedThreadKey: null,
    pendingApprovals: [],
    capabilities: {
      commands: [],
      microActions: [],
      joystickActions: [],
      reasoningModes: [],
      currentReasoningMode: null,
      skills: [],
      drawing: false,
      review: false,
      reviewMaxImages: 0,
      siteCapture: { available: false, reason: null },
      libraries: [],
    },
  };
}

describe("chooseLiveSnapshot", () => {
  it("replaces a higher-sequence cache with the first snapshot from a restarted bridge", () => {
    const restarted = snapshot(1, "0bb7bb32-f477-4792-ad7b-06fef8287138");
    expect(chooseLiveSnapshot(snapshot(50), restarted, false)).toBe(restarted);
  });

  it("keeps sequence ordering after the live generation is established", () => {
    expect(chooseLiveSnapshot(snapshot(2), snapshot(1), true).seq).toBe(2);
  });

  it("keeps sequence ordering before the first live update when the cache is from the same generation", () => {
    expect(chooseLiveSnapshot(snapshot(50), snapshot(1), false).seq).toBe(50);
  });
});

describe("refreshSnapshotAfterCommand", () => {
  const commandId = "75b15f2f-cd3b-49f5-b941-99eb871a59e5";
  const expectedBridgeInstanceId = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
  const expectedThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

  it("reloads authoritative native state after an acknowledged reasoning adjustment", async () => {
    const refresh = vi.fn(async () => true);

    await refreshSnapshotAfterCommand({
      type: "adjustReasoning",
      commandId,
      expectedBridgeInstanceId,
      expectedSequence: 7,
      expectedThreadId,
      adjustment: "increase",
    }, {
      commandId,
      ok: true,
      pending: false,
      message: "Native reasoning effort adjusted",
    }, refresh);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reloads authoritative pending requests after an acknowledged approval response", async () => {
    const refresh = vi.fn(async () => true);

    await refreshSnapshotAfterCommand({
      type: "respondToApproval",
      commandId,
      expectedBridgeInstanceId,
      expectedSequence: 7,
      expectedThreadId,
      requestId: 991,
      turnId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      itemId: "approval-item-a",
      approvalKind: "commandExecution",
      decision: "decline",
    }, {
      commandId,
      ok: true,
      pending: false,
      message: "Exact approval request declined",
    }, refresh);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reloads the native sequence after an acknowledged Micro action", async () => {
    const refresh = vi.fn(async () => true);

    await refreshSnapshotAfterCommand({
      type: "runMicroAction",
      commandId,
      expectedBridgeInstanceId,
      expectedSequence: 7,
      expectedThreadId,
      slot: 0,
      actionSlot: "ACT10_ACT11",
      expectedKeycapId: "MIC",
      expectedNativeCommandId: "dictation.toggle",
      gesture: "end",
      gestureId: "d5d7a7fa-faf1-4e32-b06b-e9c12680194b",
    }, {
      commandId,
      ok: true,
      pending: false,
      sequence: 8,
      message: "Mac Dictation stopped",
    }, refresh);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh for failed, pending, or unrelated commands", async () => {
    const refresh = vi.fn(async () => true);
    const reasoning = {
      type: "adjustReasoning" as const,
      commandId,
      expectedBridgeInstanceId,
      expectedSequence: 7,
      expectedThreadId,
      adjustment: "increase" as const,
    };

    await refreshSnapshotAfterCommand(reasoning, { commandId, ok: false, pending: false, message: "Failed" }, refresh);
    await refreshSnapshotAfterCommand(reasoning, { commandId, ok: true, pending: true, message: "Pending" }, refresh);
    await refreshSnapshotAfterCommand({
      type: "refreshSnapshot",
      commandId,
      expectedBridgeInstanceId,
      expectedSequence: 7,
      expectedThreadId: null,
      lastKnownSequence: 7,
    }, { commandId, ok: true, pending: false, message: "Refreshed" }, refresh);

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("all-session catalog privacy", () => {
  it("marks a confirmed usage reading as last-known when the bridge becomes unavailable", () => {
    const usage = {
      available: true as const,
      stale: false,
      fetchedAt: 1,
      planType: "pro",
      limitName: "Codex",
      primary: { usedPercent: 40, windowMinutes: 300, resetsAt: 2 },
      secondary: null,
      credits: null,
      rateLimitReached: false,
    };
    expect(markCodexUsageStale(usage)).toEqual({ ...usage, stale: true });
    expect(markCodexUsageStale(null)).toBeNull();
  });

  it("retains a degraded last-good session when a transient catalog omits it", () => {
    const complete = fixtureSessions({ sequence: 1, selectedIndex: 0 }).data.sessions as unknown as readonly SessionSummary[];
    const partial = complete.slice(0, 2);

    const merged = mergeLastGoodSessions(complete, partial);

    expect(merged).toHaveLength(complete.length);
    expect(merged.slice(0, 2)).toEqual(partial);
    expect(merged[2]).toMatchObject({
      threadId: complete[2]?.threadId,
      nativeStatus: "unavailable",
      visualStatus: "degraded",
      selected: false,
      microSlot: null,
      siteAssociations: [],
      siteAssociation: null,
    });
  });

  it("does not call the sessions endpoint before opt-in and fetches it after opt-in", async () => {
    const nativeSessions = {
      sequence: 1,
      timestamp: 1,
      registryGeneration: 1,
      sessions: [],
    };
    const client = {
      fetchCapabilities: vi.fn(async () => ({ ok: true })),
      fetchNativeSessions: vi.fn(async () => nativeSessions),
      fetchSessions: vi.fn(async () => []),
    };

    await expect(fetchSecondaryData(client, false)).resolves.toEqual({
      rawCapabilities: { ok: true },
      nativeSessions,
      sessions: null,
    });
    expect(client.fetchCapabilities).toHaveBeenCalledTimes(1);
    expect(client.fetchNativeSessions).toHaveBeenCalledTimes(1);
    expect(client.fetchSessions).not.toHaveBeenCalled();

    await expect(fetchSecondaryData(client, true)).resolves.toEqual({
      rawCapabilities: { ok: true },
      nativeSessions,
      sessions: [],
    });
    expect(client.fetchCapabilities).toHaveBeenCalledTimes(2);
    expect(client.fetchNativeSessions).toHaveBeenCalledTimes(2);
    expect(client.fetchSessions).toHaveBeenCalledTimes(1);
  });

  it("coalesces native-session refreshes and releases the gate after a transient failure", async () => {
    let resolveRequest!: (value: null) => void;
    const client = {
      fetchNativeSessions: vi.fn(() => new Promise<null>((resolve) => {
        resolveRequest = resolve;
      })),
    };
    const gate = { current: null };

    const first = fetchNativeSessionsWithoutOverlap(client, gate);
    const second = fetchNativeSessionsWithoutOverlap(client, gate);
    expect(second).toBe(first);
    expect(client.fetchNativeSessions).toHaveBeenCalledOnce();

    resolveRequest(null);
    await first;
    expect(gate.current).toBeNull();

    const third = fetchNativeSessionsWithoutOverlap(client, gate);
    expect(client.fetchNativeSessions).toHaveBeenCalledTimes(2);
    resolveRequest(null);
    await third;
  });

  it("coalesces opted catalog refreshes until the current request settles", async () => {
    let resolveRequest!: (value: []) => void;
    const client = {
      fetchSessions: vi.fn(() => new Promise<[]>((resolve) => {
        resolveRequest = resolve;
      })),
    };
    const gate = { current: null };

    const first = fetchAllSessionsWithoutOverlap(client, gate);
    const second = fetchAllSessionsWithoutOverlap(client, gate);
    expect(second).toBe(first);
    expect(client.fetchSessions).toHaveBeenCalledOnce();
    resolveRequest([]);
    await first;
    expect(gate.current).toBeNull();
  });

  it("accepts current and higher registry generations but rejects stale native context", () => {
    expect(shouldApplyNativeSessions(null, 0)).toBe(true);
    expect(shouldApplyNativeSessions(4, 4)).toBe(true);
    expect(shouldApplyNativeSessions(4, 5)).toBe(true);
    expect(shouldApplyNativeSessions(5, 4)).toBe(false);
  });

  it("polls native context only while the authenticated page is visibly online", () => {
    expect(shouldPollNativeSessions(true, "visible", true)).toBe(true);
    expect(shouldPollNativeSessions(false, "visible", true)).toBe(false);
    expect(shouldPollNativeSessions(true, "hidden", true)).toBe(false);
    expect(shouldPollNativeSessions(true, "visible", false)).toBe(false);
  });
});

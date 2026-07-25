import { beforeEach, describe, expect, it } from "vitest";
import {
  bindingMatchesDrawingDraft,
  createDrawingDeliveryIdentity,
  deletePendingDrawingDelivery,
  loadPendingDrawingDeliveries,
  loadPendingDrawingDelivery,
  PENDING_DRAWING_DELIVERIES_STORAGE_KEY,
  savePendingDrawingDelivery,
  type PendingDrawingDeliveryBinding,
} from "./drawing-delivery-store";
import { loadPendingCommandIds } from "./pending-command-store";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const COMMAND_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8bb1";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";

async function binding(
  overrides: Partial<PendingDrawingDeliveryBinding> = {},
): Promise<PendingDrawingDeliveryBinding> {
  const identity = await createDrawingDeliveryIdentity(
    '{"version":1,"elements":[{"kind":"stroke"}]}',
    "Apply the exact marked change.",
  );
  return {
    commandId: COMMAND_ID,
    expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
    slotId: "AG00",
    threadId: THREAD_ID,
    threadKey: `native:${THREAD_ID}`,
    expectedSnapshotSeq: 73,
    ...identity,
    ...overrides,
  };
}

describe("pending drawing delivery binding", () => {
  beforeEach(() => localStorage.clear());

  it("persists only immutable hashes and registers the same generic pending ID", async () => {
    const value = await binding();
    expect(savePendingDrawingDelivery(value)).toBe(true);

    expect(loadPendingDrawingDelivery(THREAD_ID)).toEqual(value);
    expect(loadPendingCommandIds()).toContain(COMMAND_ID);

    const serialized = localStorage.getItem(PENDING_DRAWING_DELIVERIES_STORAGE_KEY) ?? "";
    expect(serialized).toContain(BRIDGE_INSTANCE_ID);
    expect(serialized).not.toContain("Apply the exact marked change");
    expect(serialized).not.toContain("elements");
    expect(serialized).not.toContain("png");
    expect(serialized).not.toContain("base64");
  });

  it("refuses replacement while unresolved and clears only the exact thread", async () => {
    const first = await binding();
    const replacement = await binding({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb2",
      expectedSnapshotSeq: 74,
    });
    const other = await binding({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb3",
      slotId: "AG01",
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      threadKey: "native:019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
    });

    expect(savePendingDrawingDelivery(first)).toBe(true);
    expect(savePendingDrawingDelivery(replacement)).toBe(false);
    expect(savePendingDrawingDelivery(other)).toBe(true);
    expect(loadPendingDrawingDeliveries()).toEqual([first, other]);

    deletePendingDrawingDelivery(THREAD_ID);
    expect(loadPendingDrawingDeliveries()).toEqual([other]);
    expect(loadPendingCommandIds()).toEqual([
      COMMAND_ID,
      other.commandId,
    ]);
  });

  it("detects instruction or draft changes without storing either payload", async () => {
    const value = await binding();
    const same = await createDrawingDeliveryIdentity(
      '{"version":1,"elements":[{"kind":"stroke"}]}',
      "Apply the exact marked change.",
    );
    const changedInstruction = await createDrawingDeliveryIdentity(
      '{"version":1,"elements":[{"kind":"stroke"}]}',
      "Apply something else.",
    );
    const changedDraft = await createDrawingDeliveryIdentity(
      '{"version":1,"elements":[]}',
      "Apply the exact marked change.",
    );

    expect(bindingMatchesDrawingDraft(value, same)).toBe(true);
    expect(bindingMatchesDrawingDraft(value, changedInstruction)).toBe(false);
    expect(bindingMatchesDrawingDraft(value, changedDraft)).toBe(false);
  });

  it("fails closed on malformed routing, hashes, and future envelopes", async () => {
    expect(savePendingDrawingDelivery(await binding({ threadKey: "wrong-thread" }))).toBe(false);
    expect(savePendingDrawingDelivery(await binding({ instructionHash: "weak" }))).toBe(false);
    expect(loadPendingDrawingDeliveries()).toEqual([]);

    const { expectedBridgeInstanceId: _bridgeInstanceId, ...legacyBinding } = await binding();
    localStorage.setItem(PENDING_DRAWING_DELIVERIES_STORAGE_KEY, JSON.stringify({
      version: 1,
      deliveries: [legacyBinding],
    }));
    expect(loadPendingDrawingDeliveries()).toEqual([]);

    localStorage.setItem(PENDING_DRAWING_DELIVERIES_STORAGE_KEY, JSON.stringify({
      version: 2,
      deliveries: [await binding()],
    }));
    expect(loadPendingDrawingDeliveries()).toEqual([]);
  });
});

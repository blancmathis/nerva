import { describe, expect, it } from "vitest";
import {
  drawingTargetIdentity,
  evaluateSendGuard,
  type DrawingTarget,
} from "./drawing-target";

const target: DrawingTarget = {
  bridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
  slotId: "AG02",
  threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  title: "Canvas task",
  snapshotSeq: 41,
};

describe("drawing target guard", () => {
  it("permits a complete sketch only for the exact displayed target", () => {
    expect(
      evaluateSendGuard({
        connected: true,
        displayedTarget: target,
        currentTarget: { ...target },
        instruction: "Apply this layout",
        hasContent: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("fails closed when the slot is rebound to another thread", () => {
    const result = evaluateSendGuard({
      connected: true,
      displayedTarget: target,
      currentTarget: {
        ...target,
        threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
        snapshotSeq: 42,
      },
      instruction: "Apply this layout",
      hasContent: true,
    });

    expect(result.reason).toBe("target-changed");
  });

  it("includes the snapshot sequence in identity", () => {
    expect(drawingTargetIdentity({ ...target, snapshotSeq: 42 })).not.toBe(
      drawingTargetIdentity(target),
    );
  });

  it("does not redirect when a newer snapshot still binds the same slot and thread", () => {
    expect(
      evaluateSendGuard({
        connected: true,
        displayedTarget: target,
        currentTarget: { ...target, snapshotSeq: 99 },
        instruction: "Apply this layout",
        hasContent: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("locks the canvas when the bridge generation changes even if sequence and thread collide", () => {
    const result = evaluateSendGuard({
      connected: true,
      displayedTarget: target,
      currentTarget: { ...target, bridgeInstanceId: "0bb7bb32-f477-4792-ad7b-06fef8287138" },
      instruction: "Apply this layout",
      hasContent: true,
    });
    expect(result.reason).toBe("target-changed");
  });

  it("requires connectivity and content but allows an image-only send", () => {
    expect(
      evaluateSendGuard({
        connected: false,
        displayedTarget: target,
        currentTarget: target,
        instruction: "Apply this",
        hasContent: true,
      }).reason,
    ).toBe("offline");
    expect(
      evaluateSendGuard({
        connected: true,
        displayedTarget: target,
        currentTarget: target,
        instruction: "",
        hasContent: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects a native thread key bound to another UUID", () => {
    expect(
      evaluateSendGuard({
        connected: true,
        displayedTarget: {
          ...target,
          threadKey: "local:client-new-thread:019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
        },
        currentTarget: target,
        instruction: "Apply this layout",
        hasContent: true,
      }).reason,
    ).toBe("invalid-target");
  });
});

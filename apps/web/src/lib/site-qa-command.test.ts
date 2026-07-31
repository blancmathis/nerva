import { describe, expect, it } from "vitest";
import { pngBytes } from "../test/image-fixtures";
import { buildSiteQaCommand } from "./site-qa-command";
import type { SiteQaSendPayload } from "./site-qa-types";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const BRIDGE_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
const COMMAND_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba3";

function payload(): SiteQaSendPayload {
  return {
    delivery: {
      commandId: COMMAND_ID,
      expectedBridgeInstanceId: BRIDGE_ID,
      snapshotSeq: 73,
      instructionSuffix: "",
      skillIds: [],
    },
    manifest: {
      version: 1,
      recordingId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba4",
      sourceThreadId: THREAD_ID,
      startedAt: 1_000,
      durationMs: 500,
      intent: "both",
      environment: {
        viewport: { width: 1_024, height: 768 },
        deviceScaleFactor: 2,
        controllerOrientation: "landscape",
      },
      steps: [],
      issues: [{
        issueId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba5",
        frameId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba6",
        expected: "The card remains visible",
        actual: "The card disappears",
        explanation: "The marked card disappears after rotation.",
        hasLocalVoiceNote: false,
      }],
    },
    frames: [{
      id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba6",
      title: "Marked issue",
      url: "https://example.test/component",
      blob: new Blob([pngBytes(32, 24)], { type: "image/png" }),
      width: 32,
      height: 24,
      deviceScaleFactor: 2,
      scrollX: 0,
      scrollY: 100,
    }],
  };
}

describe("Site QA command identity", () => {
  it("rebuilds byte-identical frame identities for the same frozen delivery", async () => {
    const frozen = payload();
    const input = {
      payload: frozen,
      commandId: frozen.delivery.commandId,
      bridgeInstanceId: frozen.delivery.expectedBridgeInstanceId,
      threadId: THREAD_ID,
      snapshotSeq: frozen.delivery.snapshotSeq,
      instructionSuffix: "",
    };

    const first = await buildSiteQaCommand(input);
    const retry = await buildSiteQaCommand(input);

    expect(retry).toEqual(first);
    expect(first.frames[0]?.frameId).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

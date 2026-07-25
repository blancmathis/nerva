import { describe, expect, it } from "vitest";
import {
  SiteQaActionReceiptSchema,
  SiteQaManifestSchema,
  SiteQaRecordedActionSchema,
} from "../src/index.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const TAB_ID = `tab_${"1".repeat(24)}`;

describe("Site QA protocol", () => {
  it("accepts a recorded control but keeps raw text and navigation out of receipts", () => {
    expect(SiteQaRecordedActionSchema.parse({ type: "insertText", text: "secret" })).toEqual({ type: "insertText", text: "secret" });
    const receipt = SiteQaActionReceiptSchema.parse({
      receiptId: "77777777-7777-4777-8777-777777777777",
      threadId: THREAD_ID,
      tabId: TAB_ID,
      action: { type: "insertText" },
      target: null,
      input: { mode: "placeholder", value: "{PASSWORD_1}" },
      beforeUrl: "https://example.test/login",
      afterUrl: "https://example.test/login",
      beforeScroll: { x: 0, y: 0 },
      afterScroll: { x: 0, y: 0 },
      outcome: "applied",
      confidence: "high",
      recordedAt: 1_750_000_000_000,
    });
    expect(JSON.stringify(receipt)).not.toContain("secret");
  });

  it("validates a bounded manifest without microphone bytes or arbitrary browser data", () => {
    const manifest = SiteQaManifestSchema.parse({
      version: 1,
      recordingId: "88888888-8888-4888-8888-888888888888",
      sourceThreadId: THREAD_ID,
      startedAt: 1_750_000_000_000,
      durationMs: 2_000,
      intent: "both",
      environment: { viewport: { width: 1_024, height: 768 }, deviceScaleFactor: 2, controllerOrientation: "landscape" },
      steps: [],
      issues: [{
        issueId: "99999999-9999-4999-8999-999999999999",
        frameId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expected: "Dashboard",
        actual: "Blank page",
        explanation: "The content disappears after Continue.",
        hasLocalVoiceNote: true,
      }],
    });
    expect(manifest.issues[0]?.hasLocalVoiceNote).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("voiceBytes");
  });
});

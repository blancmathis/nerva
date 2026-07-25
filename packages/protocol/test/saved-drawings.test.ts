import { describe, expect, it } from "vitest";

import {
  SavedDrawingCreateRequestSchema,
  SavedDrawingDetailSchema,
} from "../src/index.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

describe("Saved Drawings protocol", () => {
  it("accepts one bounded, session-provenanced drawing", () => {
    const input = SavedDrawingCreateRequestSchema.parse({
      sourceThreadId: THREAD_ID,
      sourceThreadTitle: "Touch polish",
      instruction: "Reduce the toolbar weight",
      pngBase64: "iVBORw==",
      sceneJson: "{}",
      background: "dark",
      width: 1200,
      height: 900,
    });
    expect(input.sourceThreadId).toBe(THREAD_ID);
  });

  it("rejects unbounded or unprovenanced records", () => {
    expect(() => SavedDrawingDetailSchema.parse({
      id: crypto.randomUUID(),
      sourceThreadId: "not-a-thread",
      sourceThreadTitle: "",
      instruction: "",
      background: "white",
      width: 1,
      height: 1,
      byteLength: 1,
      createdAt: 1,
      thumbnailBase64: "iVBORw==",
      pngBase64: "iVBORw==",
      sceneJson: "{}",
    })).toThrow();
  });
});

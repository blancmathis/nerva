import { describe, expect, it } from "vitest";

import { classifyNativeStatus, mapNativeStatus } from "../src/index.js";

describe("native status mapping", () => {
  it.each([
    ["off", "empty"],
    ["idle", "idle"],
    ["working", "working"],
    ["thinking", "working"],
    ["running", "working"],
    ["active", "working"],
    ["unread", "completed"],
    ["completed", "completed"],
    ["awaiting-approval", "needsInput"],
    ["input", "needsInput"],
    ["awaiting-response", "needsInput"],
    ["error", "error"],
    ["systemError", "error"],
    ["offline", "degraded"],
  ] as const)("maps %s to %s", (nativeStatus, visualStatus) => {
    expect(mapNativeStatus(nativeStatus)).toBe(visualStatus);
  });

  it("normalizes known native status text", () => {
    expect(classifyNativeStatus("  THINKING ")).toMatchObject({
      normalized: "thinking",
      category: "working",
      visualStatus: "working",
      known: true,
    });
  });

  it.each(["future-state", "", null, undefined])("degrades unknown status %s", (nativeStatus) => {
    expect(mapNativeStatus(nativeStatus)).toBe("degraded");
    expect(classifyNativeStatus(nativeStatus)).toMatchObject({
      category: "unknown",
      visualStatus: "degraded",
      known: false,
    });
  });
});

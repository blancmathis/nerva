import { describe, expect, it } from "vitest";

import { CodexUsageApiResponseSchema } from "../src/usage.js";

describe("Codex usage protocol", () => {
  it("accepts bounded live usage windows", () => {
    expect(CodexUsageApiResponseSchema.parse({
      ok: true,
      data: {
        available: true,
        stale: false,
        fetchedAt: 1_750_000_000_000,
        planType: "pro",
        limitName: "Codex",
        primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_750_003_600_000 },
        secondary: null,
        credits: null,
        rateLimitReached: false,
      },
    }).data).toMatchObject({ available: true, primary: { usedPercent: 42 } });
  });

  it("rejects percentages outside the displayable range", () => {
    expect(CodexUsageApiResponseSchema.safeParse({
      ok: true,
      data: {
        available: true,
        stale: false,
        fetchedAt: 1,
        planType: null,
        limitName: null,
        primary: { usedPercent: 101, windowMinutes: 300, resetsAt: null },
        secondary: null,
        credits: null,
        rateLimitReached: false,
      },
    }).success).toBe(false);
  });
});

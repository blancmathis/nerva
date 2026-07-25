import { describe, expect, it, vi } from "vitest";

import { ContextRoomAdapter, normalizeContextRoomOrigin } from "../src/context-room-adapter.js";

describe("Context Room read-only adapter", () => {
  it("accepts only exact loopback HTTP origins", () => {
    expect(normalizeContextRoomOrigin("http://127.0.0.1:4319")).toBe("http://127.0.0.1:4319");
    expect(() => normalizeContextRoomOrigin("https://example.com")).toThrow(/loopback/u);
    expect(() => normalizeContextRoomOrigin("http://127.0.0.1:4319/private")).toThrow(/origin/u);
  });

  it("projects only bounded health metadata", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      root: "/workspace/agent-project",
      version: "0.1.9",
      secret: "must-not-cross",
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const status = await new ContextRoomAdapter("http://127.0.0.1:4319").status();
      expect(status).toMatchObject({ configured: true, available: true, roomName: "agent-project", version: "0.1.9" });
      expect(JSON.stringify(status)).not.toContain("must-not-cross");
      expect(JSON.stringify(status)).not.toContain("/workspace/agent-project");
    } finally {
      globalThis.fetch = original;
    }
  });
});

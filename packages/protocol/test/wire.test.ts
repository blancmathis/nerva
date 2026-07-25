import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  ClientWsMessageSchema,
  ServerWsMessageSchema,
  createApiEnvelopeSchema,
} from "../src/index.js";

describe("API envelopes", () => {
  const schema = createApiEnvelopeSchema(z.object({ value: z.string() }).strict());

  it("accepts strict success and failure envelopes", () => {
    expect(schema.safeParse({ ok: true, data: { value: "ready" } }).success).toBe(true);
    expect(
      schema.safeParse({
        ok: false,
        error: {
          code: "CONFLICT",
          message: "Snapshot changed",
          retryable: true,
          details: { currentSequence: 4 },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown envelope and error fields", () => {
    expect(schema.safeParse({ ok: true, data: { value: "ready" }, transcript: "private" }).success).toBe(false);
    expect(
      schema.safeParse({
        ok: false,
        error: {
          code: "CONFLICT",
          message: "Snapshot changed",
          retryable: true,
          details: null,
          shell: "unsafe",
        },
      }).success,
    ).toBe(false);
  });
});

describe("WebSocket messages", () => {
  it("validates bounded client and server heartbeat messages", () => {
    expect(ClientWsMessageSchema.safeParse({
      type: "hello",
      lastBridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
      lastSequence: 12,
    }).success).toBe(true);
    expect(ClientWsMessageSchema.safeParse({ type: "ping", nonce: "heartbeat_12" }).success).toBe(true);
    expect(ServerWsMessageSchema.safeParse({ type: "pong", nonce: "heartbeat_12" }).success).toBe(true);
  });

  it("requires hello sequence numbers to be scoped to an explicit bridge generation", () => {
    expect(ClientWsMessageSchema.safeParse({ type: "hello", lastSequence: 12 }).success).toBe(false);
    expect(ClientWsMessageSchema.safeParse({ type: "hello", lastBridgeInstanceId: null, lastSequence: 0 }).success).toBe(true);
  });

  it("rejects unknown message kinds and fields", () => {
    expect(ClientWsMessageSchema.safeParse({ type: "evaluate", javascript: "alert(1)" }).success).toBe(false);
    expect(ClientWsMessageSchema.safeParse({ type: "ping", nonce: "ok", extra: true }).success).toBe(false);
  });
});

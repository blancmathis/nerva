import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterState, CodexDesktopAdapter } from "@codex-pad/codex-desktop";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultDataPaths } from "../src/paths.js";
import { pairingNonceFromUrl } from "../src/pairing.js";
import { startBridge, type BridgeHandle } from "../src/server.js";
import type { ThreadTransport } from "../src/thread-transport.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const EXPECTED_FAIL_CLOSED_REASON = /(?:No supported system Chrome executable|outbound network confinement.*site capture remains disabled)/iu;
const roots: string[] = [];
const handles: BridgeHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe("production-default site capture", () => {
  it("reports unavailable and rejects capture before any browser driver exists", async () => {
    const adapterState: AdapterState = {
      snapshot: null,
      stale: true,
      health: { status: "degraded", reasons: [], changedAt: Date.now() },
    };
    const adapter = {
      refresh: vi.fn(async () => adapterState),
      snapshot: vi.fn(() => adapterState),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = {
      health: vi.fn(async () => ({
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: null,
        localImageSteerVerified: true,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "test",
        queuedSketches: 0,
      })),
      listSkills: vi.fn(async () => []),
      clearSelectedThread: vi.fn(),
    } as unknown as ThreadTransport;
    const root = await mkdtemp(join(tmpdir(), "codex-pad-default-capture-disabled-"));
    roots.push(root);
    const handle = await startBridge({
      port: await freePort(),
      paths: defaultDataPaths(root),
      publicOrigin: "https://pad.example.test",
      adapter,
      transport,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      logger: { warn: vi.fn(), error: vi.fn() },
      // Deliberately omit siteCaptureService: this exercises production setup.
    });
    handles.push(handle);

    const pairing = await handle.createPairing("https://pad.example.test", "Test iPad");
    const nonce = pairingNonceFromUrl(pairing.qrPayload) ?? "";
    const paired = await handle.app.inject({
      method: "POST",
      url: "/api/pair",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        "user-agent": "Safari",
      },
      payload: { nonce, deviceName: "Test iPad" },
    });
    expect(paired.statusCode).toBe(201);
    const authorization = `Bearer ${String(paired.json().data.bearerToken)}`;

    const capabilities = await handle.app.inject({
      method: "GET",
      url: "/api/capabilities",
      headers: { host: "pad.example.test", authorization },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().data.siteCapture).toMatchObject({
      available: false,
      reason: expect.stringMatching(EXPECTED_FAIL_CLOSED_REASON),
    });

    const bulkSites = await handle.app.inject({
      method: "GET",
      url: "/api/sites",
      headers: { host: "pad.example.test", authorization },
    });
    expect(bulkSites.statusCode).toBe(400);

    const capture = await handle.app.inject({
      method: "POST",
      url: "/api/sites/preview/capture",
      headers: {
        host: "pad.example.test",
        origin: "https://pad.example.test",
        authorization,
      },
      payload: {
        threadId: THREAD_ID,
        path: "/",
        viewport: "ipad-landscape",
        scroll: { x: 0, y: 0 },
      },
    });
    expect(capture.statusCode).toBe(501);
    expect(capture.json()).toMatchObject({
      ok: false,
      error: {
        code: "UNSUPPORTED",
        message: expect.stringMatching(EXPECTED_FAIL_CLOSED_REASON),
      },
    });
  });
});

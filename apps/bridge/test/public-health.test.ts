import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterState, CodexDesktopAdapter } from "@codex-pad/codex-desktop";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultDataPaths } from "../src/paths.js";
import { startBridge, type BridgeHandle } from "../src/server.js";
import type { ThreadTransport } from "../src/thread-transport.js";

const roots: string[] = [];
const handles: BridgeHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe("public bridge health", () => {
  it("never exposes raw adapter reasons to an unauthenticated caller", async () => {
    const sensitiveReason = [
      "CDP failed at /srv/private/project.ts:42",
      "Error: renderer stack",
      "token=sk-test-secret-value-that-must-not-leak",
    ].join("\n");
    const adapterState: AdapterState = {
      snapshot: null,
      stale: true,
      health: {
        status: "degraded",
        reasons: [{ code: "snapshot-stale", message: sensitiveReason }],
        changedAt: Date.now(),
      },
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
    const root = await mkdtemp(join(tmpdir(), "codex-pad-public-health-"));
    roots.push(root);
    const port = await freePort();
    const handle = await startBridge({
      port,
      paths: defaultDataPaths(root),
      publicOrigin: "https://pad.example.test",
      adapter,
      transport,
      siteCaptureService: null,
      refreshIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    handles.push(handle);
    await handle.state.refresh();

    const response = await handle.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "pad.example.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      state: "stale",
      reason: "Native Codex state is temporarily stale.",
    });
    expect(response.body).not.toContain("/srv/private");
    expect(response.body).not.toContain("renderer stack");
    expect(response.body).not.toContain("sk-test-secret");
  });
});

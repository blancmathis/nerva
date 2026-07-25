import { describe, expect, it, vi } from "vitest";
import type { DiscoveredCdpTargets } from "@codex-pad/codex-desktop";
import { listOpenCodexBrowserTabs } from "../src/browser-tabs.js";
import type { ThreadTransport } from "../src/thread-transport.js";

const inventory: DiscoveredCdpTargets = {
  candidate: { port: 43123, source: "process-args" },
  targets: [{
    id: "main",
    type: "page",
    title: "Codex",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/main",
  }, {
    id: "local",
    type: "page",
    title: "Local dashboard\u0000",
    url: "http://user:secret@127.0.0.1:3000/dashboard?token=private#section",
    webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/local",
  }, {
    id: "external",
    type: "page",
    title: "External account",
    url: "https://example.test/account?token=private#section",
    webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/external",
  }, {
    id: "bridge",
    type: "page",
    title: "Codex Pad",
    url: "http://127.0.0.1:8787/",
    webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/bridge",
  }],
};

describe("Codex Browser tab inventory", () => {
  it("exposes only pages proven for the requested thread while stripping secrets and debugger metadata", async () => {
    const transport = {
      refreshDesktopOwnershipIdentity: vi.fn(async () => null),
    } as unknown as ThreadTransport;
    const result = await listOpenCodexBrowserTabs(transport, "019f7ec2-68eb-7183-bb3a-0e67312a8ba1", ["http://127.0.0.1:8787"], {
      discover: vi.fn(async () => inventory),
      readThreadBindings: vi.fn(async () => ({
        sessionObserved: true,
        pages: [{
          rawUrl: "http://user:secret@127.0.0.1:3000/dashboard?token=private#section",
          belongsToThread: true,
        }, {
          rawUrl: "https://example.test/account?token=private#section",
          belongsToThread: true,
        }, {
          rawUrl: "http://127.0.0.1:8787/",
          belongsToThread: false,
        }],
      })),
    });

    expect(result.detail).toMatch(/attached to this Codex task/iu);
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0]).toMatchObject({
      title: "External account",
      url: "https://example.test/account",
      controllable: true,
      reason: null,
    });
    expect(result.tabs[1]).toMatchObject({
      title: "Local dashboard",
      url: "http://127.0.0.1:3000/dashboard",
      controllable: true,
      reason: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|webSocketDebuggerUrl/u);
  });

  it("fails closed when the same private page URL is attached to another thread", async () => {
    const transport = {
      refreshDesktopOwnershipIdentity: vi.fn(async () => null),
    } as unknown as ThreadTransport;
    const result = await listOpenCodexBrowserTabs(transport, "019f7ec2-68eb-7183-bb3a-0e67312a8ba1", [], {
      discover: vi.fn(async () => inventory),
      readThreadBindings: vi.fn(async () => ({
        sessionObserved: true,
        pages: [{ rawUrl: "https://example.test/account?token=private#section", belongsToThread: true }, {
          rawUrl: "https://example.test/account?token=private#section",
          belongsToThread: false,
        }],
      })),
    });

    expect(result.tabs).toEqual([]);
  });
});

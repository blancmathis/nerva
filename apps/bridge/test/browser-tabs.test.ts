import { describe, expect, it, vi } from "vitest";
import type { DiscoveredCdpTargets } from "@codex-pad/codex-desktop";
import { listOpenCodexBrowserTabs, openCodexBrowserTab, parseBrowserSnapshot, type BrowserSnapshot } from "../src/browser-tabs.js";
import type { ThreadTransport } from "../src/thread-transport.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
const inventory: DiscoveredCdpTargets = {
  candidate: { port: 43123, source: "process-args" },
  targets: [
    { id: "main", type: "page", title: "Codex", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/main" },
    { id: "first", type: "page", title: "Account", url: "https://example.test/account?token=one#section", webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/first" },
    { id: "second", type: "page", title: "Account copy", url: "https://example.test/account?token=two#section", webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/second" },
  ],
};

function snapshot(): BrowserSnapshot {
  return { tabs: [
    { conversationId: "client-new-thread:first", browserTabId: "browser-first", guestWebContentsId: 41, pageKey: "page-first", url: "https://example.test/account?token=one#section", title: "Account", ownerRoutePath: `/local/${THREAD_ID}`, mountGeneration: 1, active: true, loading: false },
    { conversationId: "client-new-thread:second", browserTabId: "browser-second", guestWebContentsId: 42, pageKey: "page-second", url: "https://example.test/account?token=two#section", title: "Account copy", ownerRoutePath: `/local/${THREAD_ID}`, mountGeneration: 1, active: false, loading: false },
    { conversationId: "client-new-thread:other", browserTabId: "browser-other", guestWebContentsId: 43, pageKey: "page-other", url: "https://other.example.test/", title: "Other task", ownerRoutePath: `/local/${OTHER_THREAD_ID}`, mountGeneration: 1, active: true, loading: false },
  ] };
}

const transport = { refreshDesktopOwnershipIdentity: vi.fn(async () => null) } as unknown as ThreadTransport;

describe("Codex Browser tab inventory", () => {
  it("keeps Codex cold Browser records without treating them as an incompatible snapshot", () => {
    expect(parseBrowserSnapshot({ tabs: [{
      conversationId: "client-new-thread:cold",
      browserTabId: "client-new-thread:cold:legacy",
      guestWebContentsId: null,
      pageKey: null,
      url: "",
      title: "",
      ownerRoutePath: `/local/${THREAD_ID}`,
      mountGeneration: 0,
      active: false,
      isLoading: false,
    }] }).tabs[0]).toMatchObject({ guestWebContentsId: null, pageKey: null });
  });

  it("keeps duplicate URLs as distinct exact-task tabs and strips private URL data", async () => {
    const result = await listOpenCodexBrowserTabs(transport, THREAD_ID, [], {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot: vi.fn(async () => snapshot()),
      readWebviewFingerprint: vi.fn(async (_current, tab) => ({ guestWebContentsId: tab.guestWebContentsId, href: tab.url, timeOrigin: tab.guestWebContentsId, navigationStart: tab.guestWebContentsId })),
      readTargetFingerprint: vi.fn(async (target) => target.id === "first"
        ? { href: "https://example.test/account?token=one#section", timeOrigin: 41, navigationStart: 41 }
        : target.id === "second" ? { href: "https://example.test/account?token=two#section", timeOrigin: 42, navigationStart: 42 } : null),
    });
    expect(result.tabs).toHaveLength(2);
    expect(new Set(result.tabs.map((tab) => tab.id)).size).toBe(2);
    expect(result.tabs.map((tab) => tab.url)).toEqual(["https://example.test/account", "https://example.test/account"]);
    expect(result.capabilities.control.available).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/token=|webSocketDebuggerUrl/u);
  });

  it("fails closed when the exact webview cannot be mapped uniquely", async () => {
    const result = await listOpenCodexBrowserTabs(transport, THREAD_ID, [], {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot: vi.fn(async () => snapshot()),
      readWebviewFingerprint: vi.fn(async () => null),
    });
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs.every((tab) => !tab.controllable)).toBe(true);
    expect(result.capabilities.discovery.available).toBe(true);
    expect(result.capabilities.control.available).toBe(false);
  });

  it("opens natively and confirms a new exact-task Browser generation", async () => {
    const before = snapshot();
    const after: BrowserSnapshot = { tabs: [...before.tabs, { conversationId: "client-new-thread:new", browserTabId: "browser-new", guestWebContentsId: 44, pageKey: "page-new", url: "https://new.example.test/", title: "New", ownerRoutePath: `/local/${THREAD_ID}`, mountGeneration: 1, active: true, loading: true }] };
    const readBrowserSnapshot = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    const dispatchOpenBrowserTab = vi.fn(async () => undefined);
    await expect(openCodexBrowserTab(transport, THREAD_ID, "https://new.example.test/", {
      discover: vi.fn(async () => inventory), readBrowserSnapshot, dispatchOpenBrowserTab, sleep: vi.fn(async () => undefined),
    })).resolves.toBeUndefined();
    expect(dispatchOpenBrowserTab).toHaveBeenCalledWith(inventory, THREAD_ID, "https://new.example.test/");
  });

  it("does not confirm an existing page merely because it already has the requested URL", async () => {
    const existing = snapshot();
    await expect(openCodexBrowserTab(transport, THREAD_ID, existing.tabs[0]!.url, {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot: vi.fn(async () => existing),
      dispatchOpenBrowserTab: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      openTimeoutMs: 0,
    })).rejects.toMatchObject({ code: "BROWSER_OPEN_UNKNOWN" });
  });
});

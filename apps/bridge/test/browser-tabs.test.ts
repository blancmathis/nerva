import { describe, expect, it, vi } from "vitest";
import type { DiscoveredCdpTargets } from "@codex-pad/codex-desktop";
import { listOpenCodexBrowserTabs, openCodexBrowserTab, parseBrowserSnapshot, resolveOpenCodexBrowserTab, type BrowserSnapshot } from "../src/browser-tabs.js";
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

  it("keeps valid pages when current Codex snapshots also contain ownerless and malformed records", () => {
    const parsed = parseBrowserSnapshot({ tabs: [
      {
        conversationId: "client-new-thread:ownerless",
        browserTabId: "browser-ownerless",
        guestWebContentsId: 91,
        pageKey: "page-ownerless",
        url: "https://ownerless.example.test/",
        title: "Ownerless",
        ownerRoutePath: null,
        mountGeneration: 4,
        active: true,
        isLoading: false,
      },
      { unexpected: "record from another Codex surface" },
      snapshot().tabs[0],
    ] });

    expect(parsed.tabs).toHaveLength(2);
    expect(parsed.tabs[0]).toMatchObject({ ownerRoutePath: null, pageKey: "page-ownerless", mountGeneration: 4 });
    expect(parsed.tabs[1]).toMatchObject({ browserTabId: "browser-first", ownerRoutePath: `/local/${THREAD_ID}` });
  });

  it("fails the snapshot boundary when every non-empty record has an unknown shape", () => {
    expect(() => parseBrowserSnapshot({ tabs: [{ unexpected: true }] }))
      .toThrow(/only tabs with unknown shapes/iu);
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

  it("isolates ownerless and malformed records while keeping valid exact-task capabilities", async () => {
    const mixed = parseBrowserSnapshot({ tabs: [
      snapshot().tabs[0],
      {
        conversationId: "client-new-thread:ownerless",
        browserTabId: "browser-ownerless",
        guestWebContentsId: 91,
        pageKey: "page-ownerless",
        url: "https://ownerless.example.test/",
        title: "Ownerless",
        ownerRoutePath: null,
        mountGeneration: 4,
        active: true,
        loading: false,
      },
      { malformed: true },
    ] });
    const result = await listOpenCodexBrowserTabs(transport, THREAD_ID, [], {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot: vi.fn(async () => mixed),
      readWebviewFingerprint: vi.fn(async (_current, tab) => ({
        guestWebContentsId: tab.guestWebContentsId,
        href: tab.url,
        timeOrigin: 41,
        navigationStart: 41,
      })),
      readTargetFingerprint: vi.fn(async (target) => target.id === "first"
        ? { href: snapshot().tabs[0]!.url, timeOrigin: 41, navigationStart: 41 }
        : null),
    });

    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]).toMatchObject({ title: "Account", controllable: true });
    expect(result.capabilities).toEqual({
      discovery: { available: true, reason: null },
      open: { available: true, reason: null },
      control: { available: true, reason: null },
    });
  });

  it("uses only the newest mount generation to establish exact-task ownership", async () => {
    const currentOwnerless: BrowserSnapshot = { tabs: [
      snapshot().tabs[0]!,
      { ...snapshot().tabs[0]!, ownerRoutePath: null, pageKey: "page-first-remounted", mountGeneration: 2 },
    ] };
    const result = await listOpenCodexBrowserTabs(transport, THREAD_ID, [], {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot: vi.fn(async () => currentOwnerless),
    });

    expect(result.tabs).toEqual([]);
    expect(result.capabilities.discovery.available).toBe(true);
    expect(result.capabilities.open.available).toBe(true);
    expect(result.capabilities.control.available).toBe(true);
  });

  it("recovers from an ambiguous old generation when a newer mount appears", async () => {
    const base = snapshot().tabs[0]!;
    const recovered: BrowserSnapshot = { tabs: [
      base,
      { ...base, pageKey: "page-first-conflict", mountGeneration: 1 },
      { ...base, pageKey: "page-first-current", mountGeneration: 2 },
    ] };
    const result = await listOpenCodexBrowserTabs(transport, THREAD_ID, [], {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot: vi.fn(async () => recovered),
      readWebviewFingerprint: vi.fn(async (_current, tab) => tab.guestWebContentsId === null
        ? null
        : { guestWebContentsId: tab.guestWebContentsId, href: tab.url, timeOrigin: 41, navigationStart: 41 }),
      readTargetFingerprint: vi.fn(async (target) => target.id === "first"
        ? { href: base.url, timeOrigin: 41, navigationStart: 41 }
        : null),
    });

    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]).toMatchObject({ title: "Account", controllable: true });
  });

  it("changes the opaque page identity when pageKey or mount generation changes", async () => {
    const options = {
      discover: vi.fn(async () => inventory),
      readWebviewFingerprint: vi.fn(async (_current: DiscoveredCdpTargets, tab: BrowserSnapshot["tabs"][number]) => tab.guestWebContentsId === null
        ? null
        : {
            guestWebContentsId: tab.guestWebContentsId,
            href: tab.url,
            timeOrigin: 41,
            navigationStart: 41,
          }),
      readTargetFingerprint: vi.fn(async (target: DiscoveredCdpTargets["targets"][number]) => target.id === "first"
        ? { href: snapshot().tabs[0]!.url, timeOrigin: 41, navigationStart: 41 }
        : null),
    };
    const first = await listOpenCodexBrowserTabs(transport, THREAD_ID, [], {
      ...options,
      readBrowserSnapshot: vi.fn(async () => ({ tabs: [snapshot().tabs[0]!] })),
    });
    const remounted = await listOpenCodexBrowserTabs(transport, THREAD_ID, [], {
      ...options,
      readBrowserSnapshot: vi.fn(async () => ({ tabs: [{
        ...snapshot().tabs[0]!,
        pageKey: "page-first-remounted",
        mountGeneration: 2,
      }] })),
    });

    expect(first.tabs[0]?.id).toMatch(/^tab_/u);
    expect(remounted.tabs[0]?.id).toMatch(/^tab_/u);
    expect(remounted.tabs[0]?.id).not.toBe(first.tabs[0]?.id);

    await expect(resolveOpenCodexBrowserTab(transport, THREAD_ID, first.tabs[0]!.id, {
      ...options,
      readBrowserSnapshot: vi.fn(async () => ({ tabs: [{
        ...snapshot().tabs[0]!,
        pageKey: "page-first-remounted",
        mountGeneration: 2,
      }] })),
    })).resolves.toBeNull();
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

  it("does not confirm an unrelated exact-task page opened concurrently", async () => {
    const before = snapshot();
    const after: BrowserSnapshot = { tabs: [...before.tabs, {
      conversationId: "client-new-thread:concurrent",
      browserTabId: "browser-concurrent",
      guestWebContentsId: 45,
      pageKey: "page-concurrent",
      url: "https://unrelated.example.test/",
      title: "Unrelated",
      ownerRoutePath: `/local/${THREAD_ID}`,
      mountGeneration: 1,
      active: true,
      loading: false,
    }] };
    const readBrowserSnapshot = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    await expect(openCodexBrowserTab(transport, THREAD_ID, "https://requested.example.test/", {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot,
      dispatchOpenBrowserTab: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      openTimeoutMs: 0,
    })).rejects.toMatchObject({ code: "BROWSER_OPEN_UNKNOWN" });
  });

  it("does not confirm a stale generation added after dispatch", async () => {
    const before = snapshot();
    const after: BrowserSnapshot = { tabs: [
      ...before.tabs,
      {
        ...before.tabs[0]!,
        pageKey: "page-first-stale",
        mountGeneration: 0,
        url: "https://new.example.test/",
      },
    ] };
    const readBrowserSnapshot = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    await expect(openCodexBrowserTab(transport, THREAD_ID, "https://new.example.test/", {
      discover: vi.fn(async () => inventory),
      readBrowserSnapshot,
      dispatchOpenBrowserTab: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      openTimeoutMs: 0,
    })).rejects.toMatchObject({ code: "BROWSER_OPEN_UNKNOWN" });
  });
});

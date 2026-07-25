import { createHash } from "node:crypto";
import WebSocket from "ws";
import {
  discoverCodexCdpTargets,
  isLoopbackHostname,
  isLoopbackUrl,
  selectCodexRendererTarget,
  type CdpTarget,
  type DiscoveredCdpTargets,
} from "@codex-pad/codex-desktop";
import type { ThreadTransport } from "./thread-transport.js";

export interface OpenBrowserTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly controllable: boolean;
  readonly reason: string | null;
}

export interface OpenBrowserTabsResult {
  readonly tabs: readonly OpenBrowserTab[];
  readonly detail: string;
}

export interface ResolvedBrowserTab {
  readonly tab: OpenBrowserTab;
  /** Bridge-private socket. It must never cross the authenticated API. */
  readonly debuggerUrl: string;
}

export interface BrowserTabInventoryOptions {
  readonly discover?: typeof discoverCodexCdpTargets;
  readonly readThreadBindings?: (
    inventory: DiscoveredCdpTargets,
    threadId: string,
  ) => Promise<ThreadBrowserBindings>;
}

const MAX_TABS = 64;
const MAX_TITLE_LENGTH = 160;
const MAX_PRIVATE_URL_LENGTH = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ThreadBrowserPageBinding {
  readonly rawUrl: string;
  readonly belongsToThread: boolean;
}

export interface ThreadBrowserBindings {
  readonly sessionObserved: boolean;
  readonly pages: readonly ThreadBrowserPageBinding[];
}

interface ScopedResolvedTabs {
  readonly entries: readonly ResolvedBrowserTab[];
  readonly sessionObserved: boolean;
}

interface CdpEvaluationReply {
  readonly id?: number;
  readonly error?: { readonly message?: string };
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: { readonly text?: string };
  };
}

function safePageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function privatePageUrl(value: string): string | null {
  if (value.length < 1 || value.length > MAX_PRIVATE_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function pageTitle(value: string | undefined, url: URL): string {
  const normalized = value?.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized ? normalized.slice(0, MAX_TITLE_LENGTH) : url.hostname;
}

function opaqueTabId(target: CdpTarget): string | null {
  if (!target.id || target.id.length > 512) return null;
  return `tab_${createHash("sha256").update(target.id, "utf8").digest("hex").slice(0, 24)}`;
}

function safeDebuggerUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !isLoopbackHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function threadBindingsExpression(threadId: string): string {
  if (!UUID_PATTERN.test(threadId)) throw new Error("A canonical thread UUID is required for browser discovery.");
  return String.raw`(() => {
    const expectedThreadId = ${JSON.stringify(threadId.toLowerCase())};
    const canonicalThreadId = (value) => typeof value === 'string'
      ? value.match(/(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[^0-9a-f])/i)?.[1]?.toLowerCase() ?? null
      : null;
    const isClientThreadId = (value) => typeof value === 'string'
      && /^(?:local:)?client-new-thread:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    const withoutLocalPrefix = (value) => typeof value === 'string' ? value.replace(/^local:/i, '') : null;
    const sidebarThreadId = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')
      ?.getAttribute('data-app-action-sidebar-thread-id') ?? null;
    const composerThreadId = document.querySelector('[data-above-composer-conversation-id]')
      ?.getAttribute('data-above-composer-conversation-id') ?? null;
    const sidebarCanonical = isClientThreadId(sidebarThreadId) ? null : canonicalThreadId(sidebarThreadId);
    const composerCanonical = canonicalThreadId(composerThreadId);
    const activeConversationId = sidebarCanonical === expectedThreadId
      ? withoutLocalPrefix(sidebarThreadId)
      : isClientThreadId(sidebarThreadId) && composerCanonical === expectedThreadId
        ? withoutLocalPrefix(sidebarThreadId)
        : null;
    const webviews = [...document.querySelectorAll('webview[data-browser-sidebar-conversation-id]')].slice(0, ${MAX_TABS});
    const pages = webviews.flatMap((webview) => {
      const conversationId = webview.getAttribute('data-browser-sidebar-conversation-id');
      const browserTabId = webview.getAttribute('data-browser-sidebar-browser-tab-id');
      const directCanonical = isClientThreadId(conversationId) ? null : canonicalThreadId(conversationId);
      const belongsToThread = directCanonical === expectedThreadId
        || (activeConversationId !== null && conversationId === activeConversationId);
      if (typeof browserTabId !== 'string' || browserTabId.length > 128 || typeof webview.getURL !== 'function') return [];
      try {
        return [{ rawUrl: String(webview.getURL()).slice(0, ${MAX_PRIVATE_URL_LENGTH}), belongsToThread }];
      } catch {
        return [];
      }
    });
    return {
      sessionObserved: activeConversationId !== null
        || sidebarCanonical === expectedThreadId
        || pages.some((page) => page.belongsToThread),
      pages,
    };
  })()`;
}

function parseThreadBindings(value: unknown): ThreadBrowserBindings {
  if (value === null || typeof value !== "object") {
    return { sessionObserved: false, pages: [] };
  }
  const source = value as { readonly sessionObserved?: unknown; readonly pages?: unknown };
  const pages = Array.isArray(source.pages)
    ? source.pages.slice(0, MAX_TABS).flatMap((candidate): ThreadBrowserPageBinding[] => {
        if (candidate === null || typeof candidate !== "object") return [];
        const page = candidate as { readonly rawUrl?: unknown; readonly belongsToThread?: unknown };
        if (typeof page.rawUrl !== "string" || typeof page.belongsToThread !== "boolean") return [];
        const rawUrl = privatePageUrl(page.rawUrl);
        return rawUrl === null ? [] : [{ rawUrl, belongsToThread: page.belongsToThread }];
      })
    : [];
  return { sessionObserved: source.sessionObserved === true, pages };
}

async function evaluateThreadBindings(
  inventory: DiscoveredCdpTargets,
  threadId: string,
): Promise<ThreadBrowserBindings> {
  const target = selectCodexRendererTarget(inventory.targets);
  const debuggerUrl = target?.webSocketDebuggerUrl;
  if (!debuggerUrl || !isLoopbackUrl(debuggerUrl, ["ws:", "wss:"])) {
    return { sessionObserved: false, pages: [] };
  }
  const socket = new WebSocket(debuggerUrl, { handshakeTimeout: 3_000, perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex renderer connection timed out.")), 3_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const reply = await new Promise<CdpEvaluationReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex browser binding lookup timed out.")), 3_000);
      const onMessage = (raw: WebSocket.RawData) => {
        let message: CdpEvaluationReply;
        try {
          message = JSON.parse(String(raw)) as CdpEvaluationReply;
        } catch {
          return;
        }
        if (message.id !== 1) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: threadBindingsExpression(threadId),
          returnByValue: true,
        },
      }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        reject(error);
      });
    });
    if (reply.error || reply.result?.exceptionDetails) return { sessionObserved: false, pages: [] };
    return parseThreadBindings(reply.result?.result?.value);
  } finally {
    socket.close();
  }
}

async function discoverResolvedTabs(
  transport: ThreadTransport,
  threadId: string,
  options: BrowserTabInventoryOptions = {},
): Promise<ScopedResolvedTabs> {
  const identity = await transport.refreshDesktopOwnershipIdentity?.().catch(() => null) ?? null;
  const discover = options.discover ?? discoverCodexCdpTargets;
  const inventory = await discover(identity === null ? {} : { expectedDesktopIdentity: identity });
  const bindings = await (options.readThreadBindings ?? evaluateThreadBindings)(inventory, threadId);
  const bindingCounts = new Map<string, { expected: number; other: number }>();
  for (const binding of bindings.pages) {
    const current = bindingCounts.get(binding.rawUrl) ?? { expected: 0, other: 0 };
    if (binding.belongsToThread) current.expected += 1;
    else current.other += 1;
    bindingCounts.set(binding.rawUrl, current);
  }
  const candidatesByUrl = new Map<string, Array<{ readonly target: CdpTarget; readonly debuggerUrl: string }>>();
  for (const target of inventory.targets) {
    if (target.type !== "page") continue;
    const rawUrl = privatePageUrl(target.url);
    const debuggerUrl = safeDebuggerUrl(target.webSocketDebuggerUrl);
    if (rawUrl === null || debuggerUrl === null) continue;
    const candidates = candidatesByUrl.get(rawUrl) ?? [];
    candidates.push({ target, debuggerUrl });
    candidatesByUrl.set(rawUrl, candidates);
  }
  const seen = new Set<string>();
  const entries = [...candidatesByUrl.entries()].flatMap(([rawUrl, candidates]): ResolvedBrowserTab[] => {
    const binding = bindingCounts.get(rawUrl);
    if (binding?.expected !== 1 || binding.other !== 0 || candidates.length !== 1) return [];
    const candidate = candidates[0];
    if (candidate === undefined) return [];
    const { target, debuggerUrl } = candidate;
    const id = opaqueTabId(target);
    const url = safePageUrl(target.url);
    if (id === null || url === null || seen.has(id)) return [];
    seen.add(id);
    return [{
      tab: {
        id,
        title: pageTitle(target.title, url),
        url: url.toString(),
        controllable: true,
        reason: null,
      },
      debuggerUrl,
    }];
  }).sort((left, right) => (
    left.tab.title.localeCompare(right.tab.title)
    || left.tab.url.localeCompare(right.tab.url)
    || left.tab.id.localeCompare(right.tab.id)
  )).slice(0, MAX_TABS);
  return { entries, sessionObserved: bindings.sessionObserved };
}

export async function resolveOpenCodexBrowserTab(
  transport: ThreadTransport,
  threadId: string,
  tabId: string,
  options: BrowserTabInventoryOptions = {},
): Promise<ResolvedBrowserTab | null> {
  const tabs = await discoverResolvedTabs(transport, threadId, options);
  return tabs.entries.find((candidate) => candidate.tab.id === tabId) ?? null;
}

export async function listOpenCodexBrowserTabs(
  transport: ThreadTransport,
  threadId: string,
  _legacyBridgeOrigins: readonly string[] = [],
  options: BrowserTabInventoryOptions = {},
): Promise<OpenBrowserTabsResult> {
  try {
    const resolved = await discoverResolvedTabs(transport, threadId, options);
    return {
      tabs: resolved.entries.map((entry) => entry.tab),
      detail: resolved.sessionObserved
        ? "Open pages attached to this Codex task. Choose one to browse and annotate."
        : "Open this task on the Mac, then refresh to see only its Codex Browser pages.",
    };
  } catch {
    return {
      tabs: [],
      detail: "Nerva could not read the open Codex Browser pages right now.",
    };
  }
}

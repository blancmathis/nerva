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

export interface BrowserCapability {
  readonly available: boolean;
  readonly reason: string | null;
}

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
  readonly capabilities: {
    readonly discovery: BrowserCapability;
    readonly open: BrowserCapability;
    readonly control: BrowserCapability;
  };
}

export interface BrowserSnapshotTab {
  readonly conversationId: string;
  readonly browserTabId: string;
  readonly guestWebContentsId: number | null;
  readonly pageKey: string | null;
  readonly url: string;
  readonly title: string;
  readonly ownerRoutePath: string | null;
  readonly mountGeneration: number;
  readonly active: boolean;
  readonly loading: boolean;
}

export interface BrowserSnapshot {
  readonly tabs: readonly BrowserSnapshotTab[];
}

interface BrowserFingerprint {
  readonly href: string;
  readonly timeOrigin: number;
  readonly navigationStart: number;
}

interface BrowserWebviewFingerprint extends BrowserFingerprint {
  readonly guestWebContentsId: number;
}

interface TargetFingerprintCandidate {
  readonly target: CdpTarget;
  readonly fingerprint: BrowserFingerprint | null;
}

export interface ResolvedBrowserTab {
  readonly tab: OpenBrowserTab;
  /** Bridge-private socket. It must never cross the authenticated API. */
  readonly debuggerUrl: string;
}

export interface BrowserTabInventoryOptions {
  readonly discover?: typeof discoverCodexCdpTargets;
  readonly readBrowserSnapshot?: (inventory: DiscoveredCdpTargets) => Promise<BrowserSnapshot>;
  readonly readWebviewFingerprint?: (
    inventory: DiscoveredCdpTargets,
    tab: BrowserSnapshotTab,
  ) => Promise<BrowserWebviewFingerprint | null>;
  readonly readTargetFingerprint?: (target: CdpTarget) => Promise<BrowserFingerprint | null>;
  readonly dispatchOpenBrowserTab?: (
    inventory: DiscoveredCdpTargets,
    threadId: string,
    url: string,
  ) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly openTimeoutMs?: number;
}

const MAX_TABS = 64;
const MAX_TITLE_LENGTH = 160;
const MAX_PRIVATE_URL_LENGTH = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const APP_INITIAL_MODULE_PATTERN = /["'](\.\/app-initial-[^"']+\.js)["']/gu;

interface CdpEvaluationReply {
  readonly id?: number;
  readonly error?: { readonly message?: string };
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: { readonly text?: string };
  };
}

interface ScopedResolvedTabs {
  readonly entries: readonly ResolvedBrowserTab[];
  readonly listedTabs: readonly OpenBrowserTab[];
  readonly snapshot: BrowserSnapshot;
  readonly discovery: BrowserCapability;
  readonly control: BrowserCapability;
}

export class BrowserOpenOutcomeUnknownError extends Error {
  readonly code = "BROWSER_OPEN_UNKNOWN";
  constructor() {
    super("Codex accepted the Browser request, but Nerva could not confirm the exact new page. Check the Mac before trying again.");
    this.name = "BrowserOpenOutcomeUnknownError";
  }
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

function opaqueTabId(tab: BrowserSnapshotTab): string {
  return `tab_${createHash("sha256")
    .update(`${tab.conversationId}\0${tab.browserTabId}\0${tab.pageKey ?? ""}\0${tab.mountGeneration}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
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

function canonicalThreadFromOwnerRoute(value: string | null): string | null {
  if (value === null) return null;
  const match = value.match(/^\/local\/([0-9a-f-]{36})(?:\/|$)/iu);
  return match?.[1] && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

export function parseBrowserSnapshot(value: unknown): BrowserSnapshot {
  if (value === null || typeof value !== "object") throw new Error("Codex Browser returned an invalid snapshot.");
  const source = value as { readonly tabs?: unknown };
  if (!Array.isArray(source.tabs) || source.tabs.length > MAX_TABS) {
    throw new Error("Codex Browser returned an invalid tab collection.");
  }
  const tabs = source.tabs.flatMap((candidate): BrowserSnapshotTab[] => {
    if (candidate === null || typeof candidate !== "object") return [];
    const tab = candidate as Record<string, unknown>;
    const conversationId = boundedString(tab.conversationId, 160);
    const browserTabId = boundedString(tab.browserTabId, 160);
    const pageKey = tab.pageKey === null || tab.pageKey === undefined ? null : boundedString(tab.pageKey, 256);
    const ownerRoutePath = tab.ownerRoutePath === null || tab.ownerRoutePath === undefined
      ? null
      : boundedString(tab.ownerRoutePath, 512);
    const url = typeof tab.url === "string" && tab.url.length <= MAX_PRIVATE_URL_LENGTH ? tab.url : null;
    const title = typeof tab.title === "string" ? tab.title.slice(0, MAX_TITLE_LENGTH) : "";
    if (
      conversationId === null
      || browserTabId === null
      || url === null
      || (tab.guestWebContentsId !== null && tab.guestWebContentsId !== undefined && (
        typeof tab.guestWebContentsId !== "number"
        || !Number.isSafeInteger(tab.guestWebContentsId)
        || tab.guestWebContentsId < 1
      ))
      || typeof tab.mountGeneration !== "number"
      || !Number.isSafeInteger(tab.mountGeneration)
      || tab.mountGeneration < 0
    ) return [];
    return [{
      conversationId,
      browserTabId,
      guestWebContentsId: typeof tab.guestWebContentsId === "number" ? tab.guestWebContentsId : null,
      pageKey,
      url,
      title,
      ownerRoutePath,
      mountGeneration: tab.mountGeneration,
      active: tab.active === true,
      loading: tab.isLoading === true || tab.loading === true,
    }];
  });
  // Codex owns this private snapshot and can add transient or unrelated record
  // shapes between Desktop releases. A single unknown record must not hide the
  // exact-task pages that we can still prove. Keep the collection boundary
  // strict, but validate and retain records independently.
  if (source.tabs.length > 0 && tabs.length === 0) {
    throw new Error("Codex Browser returned only tabs with unknown shapes.");
  }
  return { tabs };
}

function sameSnapshotIdentity(left: BrowserSnapshotTab, right: BrowserSnapshotTab): boolean {
  return left.conversationId === right.conversationId
    && left.browserTabId === right.browserTabId
    && left.pageKey === right.pageKey
    && left.mountGeneration === right.mountGeneration
    && left.ownerRoutePath === right.ownerRoutePath
    && left.guestWebContentsId === right.guestWebContentsId
    && left.url === right.url;
}

function snapshotLogicalKey(tab: BrowserSnapshotTab): string {
  return `${tab.conversationId}\0${tab.browserTabId}`;
}

function snapshotGenerationKey(tab: BrowserSnapshotTab): string {
  return `${snapshotLogicalKey(tab)}\0${tab.pageKey ?? ""}\0${tab.mountGeneration}`;
}

/**
 * Codex can briefly retain an earlier mount while the replacement webview is
 * joining the snapshot. Only the newest unambiguous generation may establish
 * ownership or a control target. An ambiguity at the newest generation is
 * isolated to that logical tab instead of degrading unrelated pages.
 */
function currentBrowserTabs(snapshot: BrowserSnapshot): readonly BrowserSnapshotTab[] {
  const current = new Map<string, {
    readonly generation: number;
    readonly tab: BrowserSnapshotTab | null;
  }>();
  for (const tab of snapshot.tabs) {
    const key = snapshotLogicalKey(tab);
    const existing = current.get(key);
    if (existing === undefined || tab.mountGeneration > existing.generation) {
      current.set(key, { generation: tab.mountGeneration, tab });
      continue;
    }
    if (tab.mountGeneration < existing.generation || existing.tab === null) continue;
    if (!sameSnapshotIdentity(existing.tab, tab)) {
      current.set(key, { generation: tab.mountGeneration, tab: null });
    }
  }
  return [...current.values()].flatMap(({ tab }) => tab === null ? [] : [tab]);
}

async function evaluateDebugger(debuggerUrl: string, expression: string, awaitPromise = false): Promise<unknown> {
  if (!isLoopbackUrl(debuggerUrl, ["ws:", "wss:"])) throw new Error("Codex Browser debugger is not loopback-only.");
  const socket = new WebSocket(debuggerUrl, { handshakeTimeout: 3_000, perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Browser connection timed out.")), 3_000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const reply = await new Promise<CdpEvaluationReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Browser evaluation timed out.")), 5_000);
      const onMessage = (raw: WebSocket.RawData) => {
        let message: CdpEvaluationReply;
        try { message = JSON.parse(String(raw)) as CdpEvaluationReply; } catch { return; }
        if (message.id !== 1) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise },
      }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        reject(error);
      });
    });
    if (reply.error || reply.result?.exceptionDetails) {
      throw new Error(reply.error?.message ?? reply.result?.exceptionDetails?.text ?? "Codex Browser evaluation failed.");
    }
    return reply.result?.result?.value;
  } finally {
    socket.close();
  }
}

function rendererDebuggerUrl(inventory: DiscoveredCdpTargets): string {
  const value = selectCodexRendererTarget(inventory.targets)?.webSocketDebuggerUrl;
  if (!value || !isLoopbackUrl(value, ["ws:", "wss:"])) {
    throw new Error("The attested Codex renderer is unavailable.");
  }
  return value;
}

function browserServiceExpression(operation: "snapshot" | "open", input?: { readonly threadId: string; readonly url: string }): string {
  return String.raw`(async () => {
    const script = [...document.scripts].find((candidate) => typeof candidate.src === 'string' && /\/assets\/index-[^/]+\.js$/u.test(candidate.src));
    if (!script) throw new Error('Codex application entry module was not found.');
    const source = await (await fetch(script.src)).text();
    const paths = [...source.matchAll(${APP_INITIAL_MODULE_PATTERN.toString()})].map((match) => match[1]);
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length !== 1) throw new Error('Codex Browser service module is ambiguous.');
    const module = await import(new URL(uniquePaths[0], script.src).href);
    const services = Object.values(module).filter((candidate) => candidate && typeof candidate === 'object' && candidate.debug && typeof candidate.debug.getBrowserSnapshot === 'function');
    if (services.length !== 1) throw new Error('Codex Browser debug service is unavailable or ambiguous.');
    ${operation === "snapshot"
      ? "return await services[0].debug.getBrowserSnapshot();"
      : `if (!globalThis.electronBridge || typeof globalThis.electronBridge.sendMessageFromView !== 'function') throw new Error('Codex Browser host bridge is unavailable.');
    await globalThis.electronBridge.sendMessageFromView(${JSON.stringify({
      type: "open-browser-tab",
      conversationId: input?.threadId,
      initialUrl: input?.url,
      source: "manual",
      initiator: "app_menu",
    })});
    return { dispatched: true };`}
  })()`;
}

async function readBrowserSnapshot(inventory: DiscoveredCdpTargets): Promise<BrowserSnapshot> {
  return parseBrowserSnapshot(await evaluateDebugger(
    rendererDebuggerUrl(inventory),
    browserServiceExpression("snapshot"),
    true,
  ));
}

function parseFingerprint(value: unknown): BrowserFingerprint | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const href = typeof source.href === "string" ? privatePageUrl(source.href) : null;
  if (
    href === null
    || typeof source.timeOrigin !== "number"
    || !Number.isFinite(source.timeOrigin)
    || typeof source.navigationStart !== "number"
    || !Number.isFinite(source.navigationStart)
  ) return null;
  return { href, timeOrigin: source.timeOrigin, navigationStart: source.navigationStart };
}

const PAGE_FINGERPRINT_EXPRESSION = `(() => ({
  href: String(globalThis.location?.href || "").slice(0, ${MAX_PRIVATE_URL_LENGTH}),
  timeOrigin: Number(globalThis.performance?.timeOrigin || 0),
  navigationStart: Number(globalThis.performance?.timing?.navigationStart || 0)
}))()`;

async function readWebviewFingerprint(
  inventory: DiscoveredCdpTargets,
  tab: BrowserSnapshotTab,
): Promise<BrowserWebviewFingerprint | null> {
  const expression = String.raw`(async () => {
    const webviews = [...document.querySelectorAll('webview[data-browser-sidebar-conversation-id][data-browser-sidebar-browser-tab-id]')];
    const matches = webviews.filter((webview) => webview.getAttribute('data-browser-sidebar-conversation-id') === ${JSON.stringify(tab.conversationId)}
      && webview.getAttribute('data-browser-sidebar-browser-tab-id') === ${JSON.stringify(tab.browserTabId)});
    if (matches.length !== 1 || typeof matches[0].getWebContentsId !== 'function' || typeof matches[0].executeJavaScript !== 'function') return null;
    return {
      guestWebContentsId: Number(matches[0].getWebContentsId()),
      ...(await matches[0].executeJavaScript(${JSON.stringify(PAGE_FINGERPRINT_EXPRESSION)}, true)),
    };
  })()`;
  const value = await evaluateDebugger(rendererDebuggerUrl(inventory), expression, true);
  if (value === null || typeof value !== "object") return null;
  const guestWebContentsId = (value as Record<string, unknown>).guestWebContentsId;
  const fingerprint = parseFingerprint(value);
  return fingerprint !== null && typeof guestWebContentsId === "number" && Number.isSafeInteger(guestWebContentsId)
    ? { ...fingerprint, guestWebContentsId }
    : null;
}

async function readTargetFingerprint(target: CdpTarget): Promise<BrowserFingerprint | null> {
  const debuggerUrl = safeDebuggerUrl(target.webSocketDebuggerUrl);
  if (debuggerUrl === null) return null;
  return parseFingerprint(await evaluateDebugger(debuggerUrl, PAGE_FINGERPRINT_EXPRESSION));
}

function sameFingerprint(left: BrowserFingerprint, right: BrowserFingerprint): boolean {
  return left.href === right.href
    && Math.abs(left.timeOrigin - right.timeOrigin) < 0.5
    && Math.abs(left.navigationStart - right.navigationStart) < 0.5;
}

async function resolveSnapshotTab(
  inventory: DiscoveredCdpTargets,
  snapshotTab: BrowserSnapshotTab,
  options: BrowserTabInventoryOptions,
  targetCandidates: readonly TargetFingerprintCandidate[],
): Promise<ResolvedBrowserTab | null> {
  const readWebview = options.readWebviewFingerprint ?? readWebviewFingerprint;
  if (snapshotTab.guestWebContentsId === null || snapshotTab.pageKey === null) return null;
  const webview = await readWebview(inventory, snapshotTab);
  if (webview === null || webview.guestWebContentsId !== snapshotTab.guestWebContentsId) return null;
  const matches = targetCandidates.filter((candidate) => candidate.fingerprint !== null && sameFingerprint(webview, candidate.fingerprint));
  if (matches.length !== 1) return null;
  const target = matches[0]!.target;
  const debuggerUrl = safeDebuggerUrl(target.webSocketDebuggerUrl);
  const visibleUrl = safePageUrl(snapshotTab.url);
  if (debuggerUrl === null || visibleUrl === null) return null;
  return {
    tab: {
      id: opaqueTabId(snapshotTab),
      title: pageTitle(snapshotTab.title || target.title, visibleUrl),
      url: visibleUrl.toString(),
      controllable: true,
      reason: null,
    },
    debuggerUrl,
  };
}

async function readTargetCandidates(
  inventory: DiscoveredCdpTargets,
  options: BrowserTabInventoryOptions,
): Promise<readonly TargetFingerprintCandidate[]> {
  const readTarget = options.readTargetFingerprint ?? readTargetFingerprint;
  return Promise.all(inventory.targets
    .filter((target) => target.type === "page" && safeDebuggerUrl(target.webSocketDebuggerUrl) !== null)
    .map(async (target) => ({ target, fingerprint: await readTarget(target).catch(() => null) })));
}

async function discoverInventory(
  transport: ThreadTransport,
  options: BrowserTabInventoryOptions,
): Promise<DiscoveredCdpTargets> {
  const identity = await transport.refreshDesktopOwnershipIdentity?.().catch(() => null) ?? null;
  const discover = options.discover ?? discoverCodexCdpTargets;
  return discover(identity === null ? {} : { expectedDesktopIdentity: identity });
}

async function discoverResolvedTabs(
  transport: ThreadTransport,
  threadId: string,
  options: BrowserTabInventoryOptions = {},
): Promise<ScopedResolvedTabs> {
  if (!UUID_PATTERN.test(threadId)) throw new Error("A canonical task UUID is required for Browser discovery.");
  const inventory = await discoverInventory(transport, options);
  const snapshot = await (options.readBrowserSnapshot ?? readBrowserSnapshot)(inventory);
  const owned = currentBrowserTabs(snapshot)
    .filter((tab) => canonicalThreadFromOwnerRoute(tab.ownerRoutePath) === threadId.toLowerCase());
  const liveOwned = owned.filter((tab) => safePageUrl(tab.url) !== null && tab.guestWebContentsId !== null && tab.pageKey !== null);
  const targetCandidates = liveOwned.length === 0 ? [] : await readTargetCandidates(inventory, options);
  const resolved = await Promise.all(owned.map(async (tab) => ({
    source: tab,
    resolved: await resolveSnapshotTab(inventory, tab, options, targetCandidates).catch(() => null),
  })));
  const entries = resolved.flatMap(({ resolved: entry }) => entry === null ? [] : [entry]);
  const listedTabs = resolved.flatMap(({ source, resolved: entry }): OpenBrowserTab[] => {
    if (entry !== null) return [entry.tab];
    const visibleUrl = safePageUrl(source.url);
    if (visibleUrl === null) return [];
    return [{
      id: opaqueTabId(source),
      title: pageTitle(source.title, visibleUrl),
      url: visibleUrl.toString(),
      controllable: false,
      reason: source.loading
        ? "This page is still opening in Codex."
        : "Nerva could not prove a unique control target for this page.",
    }];
  }).sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return {
    entries: entries.sort((left, right) => left.tab.title.localeCompare(right.tab.title) || left.tab.id.localeCompare(right.tab.id)),
    listedTabs,
    snapshot,
    discovery: { available: true, reason: null },
    control: listedTabs.length === 0 || entries.length > 0
      ? { available: true, reason: null }
      : { available: false, reason: "The exact Browser pages were found, but this Codex build did not expose a unique control target." },
  };
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
      tabs: resolved.listedTabs,
      detail: resolved.listedTabs.length > 0
        ? "Open pages attached to this exact Codex task."
        : "No Browser pages are open for this task yet.",
      capabilities: {
        discovery: resolved.discovery,
        open: { available: true, reason: null },
        control: resolved.control,
      },
    };
  } catch {
    const reason = "This Codex build changed its Browser integration. Nerva will not guess which task owns a page.";
    return {
      tabs: [],
      detail: reason,
      capabilities: {
        discovery: { available: false, reason },
        open: { available: false, reason },
        control: { available: false, reason },
      },
    };
  }
}

export async function openCodexBrowserTab(
  transport: ThreadTransport,
  threadId: string,
  inputUrl: string,
  options: BrowserTabInventoryOptions = {},
): Promise<void> {
  if (!UUID_PATTERN.test(threadId)) throw new Error("A canonical task UUID is required to open a Browser page.");
  const url = privatePageUrl(inputUrl);
  if (url === null || new URL(url).username !== "" || new URL(url).password !== "" || url.length > 2_048) {
    throw new Error("Only HTTP or HTTPS addresses without embedded credentials can be opened.");
  }
  const inventory = await discoverInventory(transport, options);
  const readSnapshot = options.readBrowserSnapshot ?? readBrowserSnapshot;
  const before = await readSnapshot(inventory);
  const beforeOwned = currentBrowserTabs(before)
    .filter((tab) => canonicalThreadFromOwnerRoute(tab.ownerRoutePath) === threadId.toLowerCase());
  const beforeKeys = new Set(beforeOwned.map(snapshotGenerationKey));
  const beforeByLogicalKey = new Map(beforeOwned.map((tab) => [snapshotLogicalKey(tab), tab]));
  const dispatch = options.dispatchOpenBrowserTab ?? (async (currentInventory, expectedThreadId, initialUrl) => {
    await evaluateDebugger(
      rendererDebuggerUrl(currentInventory),
      browserServiceExpression("open", { threadId: expectedThreadId, url: initialUrl }),
      true,
    );
  });
  await dispatch(inventory, threadId, url);

  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + (options.openTimeoutMs ?? 10_000);
  while (Date.now() <= deadline) {
    const nextInventory = await discoverInventory(transport, options).catch(() => inventory);
    const after = await readSnapshot(nextInventory).catch(() => null);
    const observed = after !== null && after !== undefined && currentBrowserTabs(after).some((tab) => {
      if (canonicalThreadFromOwnerRoute(tab.ownerRoutePath) !== threadId.toLowerCase()) return false;
      if (tab.pageKey === null || privatePageUrl(tab.url) !== url) return false;
      if (!beforeKeys.has(snapshotGenerationKey(tab))) return true;
      const previous = beforeByLogicalKey.get(snapshotLogicalKey(tab));
      return previous !== undefined && privatePageUrl(previous.url) === null;
    });
    if (observed) return;
    await sleep(250);
  }
  throw new BrowserOpenOutcomeUnknownError();
}

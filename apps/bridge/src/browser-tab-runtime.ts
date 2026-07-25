import WebSocket from "ws";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import {
  SiteQaActionReceiptSchema,
  SiteQaTargetDescriptorSchema,
  type SiteQaActionReceipt,
  type SiteQaInputEvidence,
  type SiteQaRecordedAction,
  type SiteQaTargetDescriptor,
} from "@codex-pad/protocol";
import type { ThreadTransport } from "./thread-transport.js";
import {
  resolveOpenCodexBrowserTab,
  type BrowserTabInventoryOptions,
} from "./browser-tabs.js";

export type BrowserTabControl =
  | { readonly type: "tap"; readonly x: number; readonly y: number }
  | { readonly type: "scroll"; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: "insertText"; readonly text: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "key"; readonly key: "Enter" | "Backspace" | "Escape" | "Tab" }
  | { readonly type: "back" | "forward" | "reload" };

export interface BrowserTabFrame {
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly imageBase64: string;
  readonly mimeType: "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly capturedAt: number;
}

export interface BrowserTabRuntime {
  frame(threadId: string, tabId: string): Promise<BrowserTabFrame>;
  control(threadId: string, tabId: string, action: BrowserTabControl): Promise<BrowserTabFrame>;
  recordedControl(threadId: string, tabId: string, action: SiteQaRecordedAction): Promise<{
    readonly frame: BrowserTabFrame;
    readonly receipt: SiteQaActionReceipt;
  }>;
}

interface CdpReply {
  readonly id?: number;
  readonly error?: { readonly message?: string };
  readonly result?: Record<string, unknown>;
}

interface PageState {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly title: string;
  readonly href: string;
}

const MAX_FRAME_BASE64 = 16 * 1024 * 1024;
const MAX_FRAME_PIXELS = 8_192 * 8_192;
const PAGE_STATE_EXPRESSION = `(() => ({
  width: Math.max(1, Math.round(globalThis.innerWidth || document.documentElement.clientWidth || 1)),
  height: Math.max(1, Math.round(globalThis.innerHeight || document.documentElement.clientHeight || 1)),
  deviceScaleFactor: Math.max(1, Math.min(4, Number(globalThis.devicePixelRatio) || 1)),
  scrollX: Math.max(0, Math.round(globalThis.scrollX || 0)),
  scrollY: Math.max(0, Math.round(globalThis.scrollY || 0)),
  title: String(document.title || "").slice(0, 160),
  href: String(globalThis.location?.href || "").slice(0, 4096)
}))()`;

const TARGET_DESCRIPTOR_EXPRESSION = (action: SiteQaRecordedAction): string => {
  const point = action.type === "tap" || action.type === "scroll"
    ? `{ x: ${JSON.stringify(action.x)}, y: ${JSON.stringify(action.y)} }`
    : "null";
  const source = action.type === "insertText"
    ? "document.activeElement"
    : action.type === "tap" || action.type === "scroll"
      ? `document.elementFromPoint(${JSON.stringify(action.x)}, ${JSON.stringify(action.y)})`
      : "null";
  return `(() => {
    const raw = ${source};
    if (!(raw instanceof Element)) return { target: null, privacy: "public" };
    const element = raw.closest('button,a,input,textarea,select,[role],[data-testid],[contenteditable="true"]') || raw;
    const clean = (value) => {
      const text = String(value || "").normalize("NFC").replace(/[\\u0000-\\u001f\\u007f]+/gu, " ").replace(/\\s+/gu, " ").trim();
      if (!text) return null;
      const bounded = text.slice(0, 160);
      if (/\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b/iu.test(bounded)) return "[redacted email]";
      if (/\\b(?:\\d[ -]*?){13,19}\\b/u.test(bounded)) return "[redacted number]";
      if (/\\b[A-Za-z0-9_-]{32,}\\b/u.test(bounded)) return "[redacted sensitive text]";
      return bounded;
    };
    const tagName = element.tagName.toLowerCase();
    const explicitRole = clean(element.getAttribute("role"));
    const implicitRole = tagName === "button" ? "button"
      : tagName === "a" ? "link"
      : tagName === "select" ? "combobox"
      : tagName === "input" && element.type === "checkbox" ? "checkbox"
      : tagName === "input" || tagName === "textarea" ? "textbox"
      : null;
    const role = explicitRole || implicitRole;
    const label = element.labels && element.labels[0] ? clean(element.labels[0].innerText || element.labels[0].textContent) : null;
    const accessibleName = clean(element.getAttribute("aria-label")) || label
      || clean(element.getAttribute("alt")) || clean(element.getAttribute("title"))
      || (tagName === "button" || tagName === "a" ? clean(element.innerText || element.textContent) : null);
    const placeholder = clean(element.getAttribute("placeholder"));
    const testId = clean(element.getAttribute("data-testid"));
    const rawId = clean(element.id);
    const stableId = rawId && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(rawId) ? rawId : null;
    const inputType = tagName === "input" ? clean(element.getAttribute("type") || "text") : null;
    const autocomplete = clean(element.getAttribute("autocomplete")) || "";
    const privacyText = [inputType, autocomplete, label, accessibleName, placeholder, stableId, clean(element.getAttribute("name"))].filter(Boolean).join(" ").toLowerCase();
    const privacy = inputType === "password" || /current-password|new-password|password/u.test(privacyText) ? "password"
      : /one-time-code|\\botp\\b|verification code|recovery code|\\bpin\\b/u.test(privacyText) ? "otp"
      : /cc-|credit.?card|card number|cvv|cvc|transaction/u.test(privacyText) ? "payment"
      : /api.?key|access.?token|secret|private.?key/u.test(privacyText) ? "token"
      : inputType === "email" || /\\bemail\\b/u.test(privacyText) ? "email"
      : inputType === "tel" || /phone|mobile/u.test(privacyText) ? "phone"
      : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable ? "public"
      : "public";
    const rect = element.getBoundingClientRect();
    const viewportPoint = ${point};
    const relativePoint = viewportPoint && rect.width > 0 && rect.height > 0
      ? { x: Math.max(0, Math.min(8192, (viewportPoint.x - rect.left) / rect.width)), y: Math.max(0, Math.min(8192, (viewportPoint.y - rect.top) / rect.height)) }
      : null;
    const kind = tagName === "button" ? "button" : tagName === "a" ? "link"
      : tagName === "select" ? "select" : inputType === "checkbox" ? "checkbox"
      : tagName === "input" || tagName === "textarea" || element.isContentEditable ? "input"
      : tagName === "iframe" ? "frame" : clean(element.textContent) ? "text" : "unknown";
    const confidence = testId || (role && accessibleName) || label ? "high" : stableId || role || accessibleName ? "medium" : "coordinate-only";
    return {
      target: {
        kind, role, accessibleName, label, placeholder, testId, stableId, inputType, tagName,
        relativePoint, viewportPoint, confidence,
        ambiguityReason: confidence === "coordinate-only" ? (tagName === "iframe" ? "cross-origin-frame" : "missing-semantics") : null,
      },
      privacy,
    };
  })()`;
};

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function safeVisibleUrl(value: string, fallback: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

export function safeBrowserNavigationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete HTTP or HTTPS address.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error("Only HTTP or HTTPS addresses without embedded credentials can be opened.");
  }
  if (url.href.length > 2_048) throw new Error("The address is longer than 2,048 characters.");
  return url.href;
}

function pageState(value: unknown, fallbackTitle: string, fallbackUrl: string): PageState {
  const source = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    width: Math.round(boundedNumber(source.width, 1_024, 1, 8_192)),
    height: Math.round(boundedNumber(source.height, 768, 1, 8_192)),
    deviceScaleFactor: boundedNumber(source.deviceScaleFactor, 1, 1, 4),
    scrollX: Math.round(boundedNumber(source.scrollX, 0, 0, 10_000_000)),
    scrollY: Math.round(boundedNumber(source.scrollY, 0, 0, 10_000_000)),
    title: typeof source.title === "string" && source.title.trim() !== ""
      ? source.title.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 160)
      : fallbackTitle,
    href: safeVisibleUrl(typeof source.href === "string" ? source.href : fallbackUrl, fallbackUrl),
  };
}

export async function normalizeBrowserFrameImage(
  imageBase64: string,
  state: Pick<PageState, "width" | "height" | "deviceScaleFactor">,
): Promise<{ readonly imageBase64: string; readonly deviceScaleFactor: number }> {
  if (state.deviceScaleFactor <= 1) return { imageBase64, deviceScaleFactor: 1 };

  // Electron captures hidden webviews at the Mac display's physical Retina
  // resolution. Repainting that large decoded image into a second same-size
  // canvas can exceed WebKit's practical GPU budget and leave a black surface.
  // The iPad never needs more than the page's CSS-pixel viewport for this live
  // control view, so normalize the transport frame before it reaches Safari.
  const normalized = await sharp(Buffer.from(imageBase64, "base64"), {
    failOn: "warning",
    limitInputPixels: MAX_FRAME_PIXELS,
    sequentialRead: true,
  })
    .resize(state.width, state.height, { fit: "fill", withoutEnlargement: true })
    .jpeg({ quality: 82, chromaSubsampling: "4:2:0" })
    .toBuffer();

  return {
    imageBase64: normalized.toString("base64"),
    deviceScaleFactor: 1,
  };
}

class CdpSession {
  readonly #socket: WebSocket;
  #nextId = 0;
  readonly #pending = new Map<number, {
    readonly resolve: (value: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (raw) => this.#onMessage(String(raw)));
    socket.on("close", () => this.#failAll(new Error("The selected browser page closed.")));
    socket.on("error", () => this.#failAll(new Error("The selected browser page connection failed.")));
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url, { handshakeTimeout: 3_000, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The selected browser page did not respond.")), 3_000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new Error("The selected browser page could not be opened.")); });
    });
    return new CdpSession(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("The selected browser page command timed out."));
      }, 5_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("The selected browser page command could not be sent."));
      });
    });
  }

  close(): void {
    this.#socket.close();
  }

  #onMessage(raw: string): void {
    let reply: CdpReply;
    try { reply = JSON.parse(raw) as CdpReply; } catch { return; }
    if (reply.id === undefined) return;
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    this.#pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error(reply.error.message ?? "The browser rejected the command."));
    else pending.resolve(reply.result ?? {});
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function evaluatedValue(result: Record<string, unknown>): unknown {
  const inner = typeof result.result === "object" && result.result !== null
    ? result.result as Record<string, unknown>
    : {};
  return inner.value;
}

async function navigationEntry(session: CdpSession, offset: -1 | 1): Promise<void> {
  const history = await session.send("Page.getNavigationHistory");
  const index = typeof history.currentIndex === "number" ? history.currentIndex : -1;
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const entry = entries[index + offset];
  if (typeof entry !== "object" || entry === null || typeof (entry as Record<string, unknown>).id !== "number") return;
  await session.send("Page.navigateToHistoryEntry", { entryId: (entry as Record<string, unknown>).id });
}

async function applyControl(session: CdpSession, action: BrowserTabControl): Promise<void> {
  if (action.type === "tap") {
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: action.x, y: action.y });
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1 });
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.x, y: action.y, button: "left", clickCount: 1 });
  } else if (action.type === "scroll") {
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: action.x,
      y: action.y,
      deltaX: action.deltaX,
      deltaY: action.deltaY,
    });
  } else if (action.type === "insertText") {
    await session.send("Input.insertText", { text: action.text });
  } else if (action.type === "navigate") {
    await session.send("Page.navigate", { url: safeBrowserNavigationUrl(action.url) });
  } else if (action.type === "key") {
    const keyCode = action.key === "Enter" ? 13 : action.key === "Backspace" ? 8 : action.key === "Escape" ? 27 : 9;
    await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: action.key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: action.key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  } else if (action.type === "reload") {
    await session.send("Page.reload", { ignoreCache: false });
  } else if (action.type === "back") {
    await navigationEntry(session, -1);
  } else {
    await navigationEntry(session, 1);
  }
}

function safeReceiptAction(action: SiteQaRecordedAction): SiteQaActionReceipt["action"] {
  if (action.type === "insertText" || action.type === "navigate") return { type: action.type };
  return action;
}

function inputEvidence(action: SiteQaRecordedAction, privacy: string): SiteQaInputEvidence {
  if (action.type !== "insertText") return { mode: "none" };
  if (privacy === "password") return { mode: "placeholder", value: "{PASSWORD_1}" };
  if (privacy === "otp") return { mode: "placeholder", value: "{OTP_1}" };
  if (privacy === "payment") return { mode: "placeholder", value: "{PAYMENT_1}" };
  if (privacy === "token") return { mode: "placeholder", value: "{TOKEN_1}" };
  if (privacy === "email") return { mode: "placeholder", value: "{TEST_EMAIL_1}" };
  if (privacy === "phone") return { mode: "placeholder", value: "{TEST_PHONE_1}" };
  if (privacy !== "public") return { mode: "placeholder", value: "{PRIVATE_VALUE_1}" };
  return { mode: "literal", value: action.text };
}

function descriptorResult(value: unknown): { readonly target: SiteQaTargetDescriptor | null; readonly privacy: string } {
  const source = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const parsed = source.target === null ? null : SiteQaTargetDescriptorSchema.safeParse(source.target);
  return {
    target: parsed === null || !parsed.success ? null : parsed.data,
    privacy: typeof source.privacy === "string" ? source.privacy : "private",
  };
}

export class VerifiedBrowserTabRuntime implements BrowserTabRuntime {
  constructor(
    private readonly transport: ThreadTransport,
    private readonly inventoryOptions: BrowserTabInventoryOptions = {},
  ) {}

  async frame(threadId: string, tabId: string): Promise<BrowserTabFrame> {
    return (await this.#withTab(threadId, tabId, null, false)).frame;
  }

  async control(threadId: string, tabId: string, action: BrowserTabControl): Promise<BrowserTabFrame> {
    return (await this.#withTab(threadId, tabId, action, false)).frame;
  }

  async recordedControl(threadId: string, tabId: string, action: SiteQaRecordedAction): Promise<{
    readonly frame: BrowserTabFrame;
    readonly receipt: SiteQaActionReceipt;
  }> {
    const result = await this.#withTab(threadId, tabId, action, true);
    if (result.receipt === null) throw new Error("The recorded browser action did not produce a receipt.");
    return { frame: result.frame, receipt: result.receipt };
  }

  async #withTab(threadId: string, tabId: string, action: BrowserTabControl | null, recorded: boolean): Promise<{
    readonly frame: BrowserTabFrame;
    readonly receipt: SiteQaActionReceipt | null;
  }> {
    const resolved = await resolveOpenCodexBrowserTab(this.transport, threadId, tabId, this.inventoryOptions);
    if (!resolved) throw new Error("This browser page is not attached to this Codex task or is no longer open.");
    const session = await CdpSession.connect(resolved.debuggerUrl);
    try {
      await session.send("Page.enable");
      const beforeStateResult = action === null ? null : await session.send("Runtime.evaluate", {
        expression: PAGE_STATE_EXPRESSION,
        returnByValue: true,
      });
      const beforeState = beforeStateResult === null
        ? null
        : pageState(evaluatedValue(beforeStateResult), resolved.tab.title, resolved.tab.url);
      let described: { readonly target: SiteQaTargetDescriptor | null; readonly privacy: string } = { target: null, privacy: "public" };
      if (recorded && action !== null && action.type !== "navigate" && action.type !== "back" && action.type !== "forward" && action.type !== "reload" && action.type !== "key") {
        const describedResult = await session.send("Runtime.evaluate", {
          expression: TARGET_DESCRIPTOR_EXPRESSION(action),
          returnByValue: true,
        });
        described = descriptorResult(evaluatedValue(describedResult));
      }
      if (action !== null) {
        await session.send("Page.bringToFront");
        await applyControl(session, action);
        await new Promise((resolve) => setTimeout(resolve, action.type === "tap" || action.type === "scroll" ? 120 : 260));
      }
      const stateResult = await session.send("Runtime.evaluate", {
        expression: PAGE_STATE_EXPRESSION,
        returnByValue: true,
      });
      const state = pageState(evaluatedValue(stateResult), resolved.tab.title, resolved.tab.url);
      const screenshot = await session.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 82,
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const data = typeof screenshot.data === "string" ? screenshot.data : "";
      if (data.length < 16 || data.length > MAX_FRAME_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
        throw new Error("The browser returned an invalid or oversized page frame.");
      }
      const normalized = await normalizeBrowserFrameImage(data, state);
      if (normalized.imageBase64.length > MAX_FRAME_BASE64) {
        throw new Error("The browser returned an invalid or oversized page frame.");
      }
      const frame: BrowserTabFrame = {
        tabId,
        title: state.title,
        url: state.href,
        imageBase64: normalized.imageBase64,
        mimeType: "image/jpeg",
        width: state.width,
        height: state.height,
        deviceScaleFactor: normalized.deviceScaleFactor,
        scrollX: state.scrollX,
        scrollY: state.scrollY,
        capturedAt: Date.now(),
      };
      if (!recorded || action === null || beforeState === null) return { frame, receipt: null };
      const confidence = described.target?.confidence ?? "high";
      const receipt = SiteQaActionReceiptSchema.parse({
        receiptId: randomUUID(),
        threadId,
        tabId,
        action: safeReceiptAction(action as SiteQaRecordedAction),
        target: described.target,
        input: inputEvidence(action as SiteQaRecordedAction, described.privacy),
        beforeUrl: safeVisibleUrl(beforeState.href, resolved.tab.url),
        afterUrl: frame.url,
        beforeScroll: { x: beforeState.scrollX, y: beforeState.scrollY },
        afterScroll: { x: frame.scrollX, y: frame.scrollY },
        outcome: "applied",
        confidence,
        recordedAt: frame.capturedAt,
      });
      return { frame, receipt };
    } finally {
      session.close();
    }
  }
}

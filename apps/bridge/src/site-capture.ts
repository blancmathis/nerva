import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";

import {
  SiteReviewError,
  assertUrlWithinOrigin,
  buildDriverCaptureRequest,
  normalizeCaptureLimits,
  validateDriverCaptureResult,
  type CaptureScroll,
  type SiteCaptureDriver,
  type SiteCaptureDriverRequest,
  type SiteCaptureDriverResult,
  type SiteCaptureLimits,
  type SiteCaptureRequest,
  type SiteLookupContext,
} from "@codex-pad/site-review";

import type { SiteRegistry } from "./site-registry.js";
import { startCaptureEgressProxy } from "./capture-egress-proxy.js";
import {
  CAPTURE_NETWORK_CONFINEMENT_UNAVAILABLE_DETAIL,
  defaultCaptureNetworkSandboxAvailable,
} from "./capture-process-sandbox.js";

export interface SiteCaptureServiceOptions {
  registry: SiteRegistry;
  driver: SiteCaptureDriver;
  limits?: Partial<SiteCaptureLimits>;
}

/** Safe server result. Local source/final origins are deliberately not exposed. */
export interface SiteCaptureResult {
  siteId: string;
  title?: string;
  finalPath: string;
  viewport: SiteCaptureRequest["viewport"];
  scroll: SiteCaptureRequest["scroll"];
  redirectCount: number;
  png: Uint8Array;
  width: number;
  height: number;
}

function safeFinalPath(finalUrl: string): string {
  const parsed = new URL(finalUrl);
  const finalPath = `${parsed.pathname}${parsed.search}`;
  if (
    finalPath.length > 2_048
    || !finalPath.startsWith("/")
    || finalPath.startsWith("//")
    || finalPath.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(finalPath)
  ) {
    throw new SiteReviewError("INVALID_CAPTURE", "Captured page returned an unsafe final path");
  }
  return finalPath;
}

export class SiteCaptureService {
  readonly #registry: SiteRegistry;
  readonly #driver: SiteCaptureDriver;
  readonly #limits: SiteCaptureLimits;

  constructor(options: SiteCaptureServiceOptions) {
    this.#registry = options.registry;
    this.#driver = options.driver;
    this.#limits = normalizeCaptureLimits(options.limits);
  }

  async capture(
    context: SiteLookupContext,
    request: SiteCaptureRequest,
  ): Promise<SiteCaptureResult> {
    // The caller never supplies an origin. It is recovered from the private,
    // user-approved registry and matched to this exact thread/project context.
    const record = await this.#registry.requireApprovedForContext(request.siteId, context);
    const driverRequest = buildDriverCaptureRequest(record, request, this.#limits);
    const result = await this.#driver.capture(driverRequest);
    const validated = validateDriverCaptureResult(record, request, result, this.#limits);
    return {
      siteId: validated.siteId,
      ...(validated.title === undefined ? {} : { title: validated.title }),
      finalPath: safeFinalPath(validated.finalUrl),
      viewport: validated.viewport,
      scroll: validated.scroll,
      redirectCount: validated.redirectCount,
      png: validated.png,
      width: validated.width,
      height: validated.height,
    };
  }
}

const DEFAULT_CHROME_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

interface PlaywrightRequestLike {
  url(): string;
  method(): string;
  redirectedFrom(): PlaywrightRequestLike | null;
}

interface PlaywrightResponseLike {
  url(): string;
  request(): PlaywrightRequestLike;
}

interface PlaywrightRouteLike {
  request(): PlaywrightRequestLike;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

interface PlaywrightWebSocketRouteLike {
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

interface PlaywrightPopupLike {
  close(): Promise<void>;
}

interface PlaywrightPageLike {
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<PlaywrightResponseLike | null>;
  url(): string;
  title(): Promise<string>;
  evaluate<Result>(pageFunction: () => Result): Promise<Result>;
  screenshot(options: {
    type: "png";
    fullPage: false;
    animations: "disabled";
    timeout: number;
  }): Promise<Uint8Array>;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  on(event: "popup", listener: (page: PlaywrightPopupLike) => void): void;
}

interface PlaywrightContextLike {
  addInitScript(script: () => void): Promise<void>;
  route(pattern: string, handler: (route: PlaywrightRouteLike) => Promise<void>): Promise<void>;
  routeWebSocket(
    pattern: string,
    handler: (route: PlaywrightWebSocketRouteLike) => Promise<void>,
  ): Promise<void>;
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

interface PlaywrightBrowserLike {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    acceptDownloads: false;
    serviceWorkers: "block";
  }): Promise<PlaywrightContextLike>;
  close(): Promise<void>;
}

interface PlaywrightModuleLike {
  chromium: {
    launch(options: {
      executablePath: string;
      headless: true;
      chromiumSandbox: true;
      timeout: number;
      args: readonly string[];
      proxy: { server: string; bypass: "<-loopback>" };
    }): Promise<PlaywrightBrowserLike>;
  };
}

export interface SystemChromeDriverOptions {
  executableCandidates?: readonly string[];
  pathIsExecutable?: (path: string) => Promise<boolean>;
  loadPlaywright?: () => Promise<unknown>;
  networkSandboxAvailable?: () => Promise<boolean>;
}

export type OptionalSystemChromeDriver =
  | { available: true; executablePath: string; driver: SiteCaptureDriver }
  | {
      available: false;
      reason:
        | "playwright-core-unavailable"
        | "process-sandbox-unavailable"
        | "system-chrome-unavailable";
      detail: string;
    };

function isPlaywrightModule(value: unknown): value is PlaywrightModuleLike {
  if (value === null || typeof value !== "object") return false;
  const chromium = (value as { chromium?: unknown }).chromium;
  return (
    chromium !== null &&
    typeof chromium === "object" &&
    typeof (chromium as { launch?: unknown }).launch === "function"
  );
}

async function defaultPathIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultLoadPlaywright(): Promise<unknown> {
  // A variable specifier keeps playwright-core optional at build time. The
  // bridge exposes an explicit unavailable state when it is not installed.
  const moduleName = "playwright-core";
  return import(moduleName);
}

async function findExecutable(
  candidates: readonly string[],
  pathIsExecutable: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathIsExecutable(candidate)) return candidate;
  }
  return null;
}

function countRedirects(response: PlaywrightResponseLike | null): number {
  let request = response?.request() ?? null;
  let redirects = 0;
  while (request?.redirectedFrom() !== null && request?.redirectedFrom() !== undefined) {
    redirects += 1;
    request = request.redirectedFrom();
  }
  return redirects;
}

function requestRedirectCount(request: PlaywrightRequestLike): number {
  let current: PlaywrightRequestLike | null = request;
  let redirects = 0;
  while (current !== null) {
    const previous = current.redirectedFrom();
    if (previous === null) break;
    redirects += 1;
    current = previous;
  }
  return redirects;
}

function disableUnneededCaptureNetworkPrimitives(): void {
  for (const name of [
    "Worker",
    "SharedWorker",
    "WebSocket",
    "WebSocketStream",
    "WebTransport",
    "EventSource",
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
  ]) {
    try {
      Object.defineProperty(globalThis, name, {
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false,
      });
    } catch {
      // A browser that has already made a primitive immutable remains covered
      // by the exact-origin proxy and process-level transport restrictions.
    }
  }
}

function safeCapturedTitle(value: string): string | undefined {
  const title = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
  return title === "" ? undefined : title;
}

interface StableCaptureState {
  finalUrl: string;
  title?: string;
  scroll: CaptureScroll;
}

function readViewportScroll(): CaptureScroll {
  return {
    x: Math.max(0, Math.round(window.scrollX)),
    y: Math.max(0, Math.round(window.scrollY)),
  };
}

function sameCaptureState(left: StableCaptureState, right: StableCaptureState): boolean {
  return left.finalUrl === right.finalUrl
    && left.title === right.title
    && left.scroll.x === right.scroll.x
    && left.scroll.y === right.scroll.y;
}

async function readStableCaptureState(
  page: PlaywrightPageLike,
  approvedOrigin: string,
): Promise<StableCaptureState> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const firstUrl = assertUrlWithinOrigin(page.url(), approvedOrigin).href;
    const firstTitle = safeCapturedTitle(await page.title());
    const firstScroll = await page.evaluate(readViewportScroll);
    const secondTitle = safeCapturedTitle(await page.title());
    const secondScroll = await page.evaluate(readViewportScroll);
    const secondUrl = assertUrlWithinOrigin(page.url(), approvedOrigin).href;
    if (
      firstUrl === secondUrl
      && firstTitle === secondTitle
      && firstScroll.x === secondScroll.x
      && firstScroll.y === secondScroll.y
    ) {
      return {
        finalUrl: secondUrl,
        ...(secondTitle === undefined ? {} : { title: secondTitle }),
        scroll: secondScroll,
      };
    }
  }
  throw new SiteReviewError(
    "INVALID_CAPTURE",
    "Page URL, title, or viewport scroll did not settle during metadata inspection",
  );
}

class SystemChromeCaptureDriver implements SiteCaptureDriver {
  constructor(
    readonly executablePath: string,
    readonly playwright: PlaywrightModuleLike,
  ) {}

  async capture(request: SiteCaptureDriverRequest): Promise<SiteCaptureDriverResult> {
    assertUrlWithinOrigin(request.targetUrl, request.approvedOrigin);
    const egressProxy = await startCaptureEgressProxy(
      request.approvedOrigin,
      request.timeoutMs,
      request.maxRedirects,
    );
    let browser: PlaywrightBrowserLike | undefined;
    let context: PlaywrightContextLike | undefined;
    try {
      browser = await this.playwright.chromium.launch({
        executablePath: this.executablePath,
        headless: true,
        chromiumSandbox: true,
        timeout: request.timeoutMs,
        proxy: { server: egressProxy.proxyUrl, bypass: "<-loopback>" },
        args: [
          "--disable-background-networking",
          "--disable-blink-features=SharedWorker,WebSocketStream",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-http2",
          "--disable-quic",
          "--disable-sync",
          "--dns-prefetch-disable",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1",
          "--metrics-recording-only",
          "--no-default-browser-check",
          "--no-first-run",
          "--safebrowsing-disable-auto-update",
        ],
      });
      context = await browser.newContext({
        viewport: { width: request.viewport.width, height: request.viewport.height },
        deviceScaleFactor: request.viewport.deviceScaleFactor,
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      // Installed for every page and child frame before site code. The exact-
      // origin launch proxy remains the lower-level egress boundary.
      await context.addInitScript(disableUnneededCaptureNetworkPrimitives);

      await context.route("**/*", async (route) => {
        try {
          const method = route.request().method().toUpperCase();
          if (method !== "GET" && method !== "HEAD") {
            throw new SiteReviewError("INVALID_CAPTURE", "Capture blocked a state-changing request");
          }
          if (requestRedirectCount(route.request()) > request.maxRedirects) {
            throw new SiteReviewError("INVALID_CAPTURE", "Capture blocked an excessive redirect chain");
          }
          assertUrlWithinOrigin(route.request().url(), request.approvedOrigin);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket("**/*", async (route) => {
        await route.close({ code: 1008, reason: "blocked during capture" });
      });
      const page = await context.newPage();
      page.on("popup", (popup) => {
        void popup.close();
      });

      const response = await page.goto(request.targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: request.timeoutMs,
      });
      const redirectCount = countRedirects(response);
      if (redirectCount > request.maxRedirects) {
        throw new SiteReviewError(
          "INVALID_CAPTURE",
          `Navigation exceeded the ${request.maxRedirects}-redirect limit`,
        );
      }
      assertUrlWithinOrigin(response?.url() ?? page.url(), request.approvedOrigin);
      if (request.scroll.x !== 0 || request.scroll.y !== 0) {
        // Mouse wheel input avoids page.evaluate and keeps the driver free of
        // injectable browser JavaScript.
        await page.mouse.wheel(request.scroll.x, request.scroll.y);
      }
      const screenshot = (): Promise<Uint8Array> => page.screenshot({
        type: "png",
        fullPage: false,
        animations: "disabled",
        timeout: request.timeoutMs,
      });
      let captureState = await readStableCaptureState(page, request.approvedOrigin);
      let png = await screenshot();
      let finalState = await readStableCaptureState(page, request.approvedOrigin);
      if (!sameCaptureState(finalState, captureState)) {
        // A SPA may finish one same-origin state transition while the browser
        // is capturing. Retry exactly once against the newly observed state.
        captureState = finalState;
        png = await screenshot();
        finalState = await readStableCaptureState(page, request.approvedOrigin);
        if (!sameCaptureState(finalState, captureState)) {
          throw new SiteReviewError(
            "INVALID_CAPTURE",
            "Page URL, title, or viewport scroll did not settle during the bounded capture attempt",
          );
        }
      }
      return {
        png,
        finalUrl: finalState.finalUrl,
        redirectCount,
        scroll: finalState.scroll,
        ...(finalState.title === undefined ? {} : { title: finalState.title }),
      };
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await egressProxy.close().catch(() => undefined);
    }
  }
}

export async function createOptionalSystemChromeDriver(
  options: SystemChromeDriverOptions = {},
): Promise<OptionalSystemChromeDriver> {
  const executablePath = await findExecutable(
    options.executableCandidates ?? DEFAULT_CHROME_EXECUTABLES,
    options.pathIsExecutable ?? defaultPathIsExecutable,
  );
  if (executablePath === null) {
    return {
      available: false,
      reason: "system-chrome-unavailable",
      detail: "No supported system Chrome executable was found; no browser was launched.",
    };
  }
  let loaded: unknown;
  try {
    loaded = await (options.loadPlaywright ?? defaultLoadPlaywright)();
  } catch {
    return {
      available: false,
      reason: "playwright-core-unavailable",
      detail: "playwright-core is optional and is not installed; site capture remains disabled.",
    };
  }
  if (!isPlaywrightModule(loaded)) {
    return {
      available: false,
      reason: "playwright-core-unavailable",
      detail: "The installed playwright-core module does not expose a compatible Chromium launcher.",
    };
  }
  const networkSandboxAvailable = await (
    options.networkSandboxAvailable ?? defaultCaptureNetworkSandboxAvailable
  )();
  if (!networkSandboxAvailable) {
    return {
      available: false,
      reason: "process-sandbox-unavailable",
      detail: CAPTURE_NETWORK_CONFINEMENT_UNAVAILABLE_DETAIL,
    };
  }
  return {
    available: true,
    executablePath,
    driver: new SystemChromeCaptureDriver(executablePath, loaded),
  };
}

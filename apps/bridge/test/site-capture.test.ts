import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSiteOriginPolicy,
  projectCwdIdentifier,
  type SiteCaptureDriver,
  type SiteCaptureDriverRequest,
} from "../../../packages/site-review/src/index.js";
import {
  SiteCaptureService,
  createOptionalSystemChromeDriver,
} from "../src/site-capture.js";
import { SiteRegistry } from "../src/site-registry.js";

const THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e626";
const OTHER_THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e627";
const tempRoots: string[] = [];

function pngHeader(width = 390, height = 844): Uint8Array {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(png.buffer).setUint32(8, 13);
  png.set([73, 72, 68, 82], 12);
  new DataView(png.buffer).setUint32(16, width);
  new DataView(png.buffer).setUint32(20, height);
  return png;
}

async function fixture(driver: SiteCaptureDriver): Promise<{
  service: SiteCaptureService;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-site-capture-"));
  tempRoots.push(root);
  const registry = new SiteRegistry({
    appSupportPath: root,
    originPolicy: createSiteOriginPolicy({ allowedLoopbackPorts: [3000] }),
  });
  await registry.approve({
    siteId: "dashboard",
    label: "Dashboard",
    origin: "http://localhost:3000",
    association: { threadId: THREAD_ID },
  });
  return { service: new SiteCaptureService({ registry, driver }) };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SiteCaptureService", () => {
  it("passes only the registry origin plus a bounded typed path to its injected driver", async () => {
    const capture = vi.fn(async (request: SiteCaptureDriverRequest) => ({
      png: pngHeader(),
      finalUrl: request.targetUrl,
      redirectCount: 0,
      scroll: request.scroll,
      title: "Settings",
    }));
    const { service } = await fixture({ capture });

    await expect(
      service.capture(
        { threadId: THREAD_ID },
        {
          siteId: "dashboard",
          path: "/settings",
          viewport: "mobile-portrait",
          scroll: { x: 0, y: 300 },
        },
      ),
    ).resolves.toMatchObject({
      siteId: "dashboard",
      width: 390,
      height: 844,
    });
    const captured = await service.capture(
      { threadId: THREAD_ID },
      {
        siteId: "dashboard",
        path: "/settings",
        viewport: "mobile-portrait",
        scroll: { x: 0, y: 300 },
      },
    );
    expect(captured).not.toHaveProperty("sourceUrl");
    expect(captured).not.toHaveProperty("finalUrl");
    expect(captured.finalPath).toBe("/settings");
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "http://localhost:3000/settings",
        approvedOrigin: "http://localhost:3000",
        viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
      }),
    );
  });

  it("returns only the validated redirected path and query, never the private origin", async () => {
    const { service } = await fixture({
      capture: async () => ({
        png: pngHeader(),
        finalUrl: "http://localhost:3000/final/dashboard?tab=build#private-fragment",
        redirectCount: 1,
        scroll: { x: 0, y: 0 },
        title: "Redirected dashboard",
      }),
    });
    const captured = await service.capture(
      { threadId: THREAD_ID },
      {
        siteId: "dashboard",
        path: "/start",
        viewport: "mobile-portrait",
        scroll: { x: 0, y: 0 },
      },
    );
    expect(captured).toMatchObject({
      finalPath: "/final/dashboard?tab=build",
      title: "Redirected dashboard",
      redirectCount: 1,
    });
    expect(JSON.stringify(captured)).not.toContain("localhost:3000");
  });

  it("rejects a protocol-relative final path even when it stays on the approved origin", async () => {
    const { service } = await fixture({
      capture: async () => ({
        png: pngHeader(),
        finalUrl: "http://localhost:3000//untrusted.example/review",
        redirectCount: 0,
        scroll: { x: 0, y: 0 },
      }),
    });
    await expect(
      service.capture(
        { threadId: THREAD_ID },
        {
          siteId: "dashboard",
          path: "/",
          viewport: "mobile-portrait",
          scroll: { x: 0, y: 0 },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CAPTURE" });
  });

  it("fails closed before calling the driver for a foreign thread or arbitrary origin path", async () => {
    const capture = vi.fn();
    const { service } = await fixture({ capture });
    await expect(
      service.capture(
        { threadId: OTHER_THREAD_ID },
        {
          siteId: "dashboard",
          path: "/",
          viewport: "ipad-landscape",
          scroll: { x: 0, y: 0 },
        },
      ),
    ).rejects.toMatchObject({ code: "SITE_NOT_APPROVED" });
    await expect(
      service.capture(
        { threadId: THREAD_ID },
        {
          siteId: "dashboard",
          path: "//169.254.169.254/latest/meta-data",
          viewport: "ipad-landscape",
          scroll: { x: 0, y: 0 },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CAPTURE_PATH" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("authorizes project scope only through the opaque server-derived project identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-project-capture-"));
    tempRoots.push(root);
    const registry = new SiteRegistry({
      appSupportPath: root,
      originPolicy: createSiteOriginPolicy({ allowedLoopbackPorts: [3000] }),
    });
    await registry.approve({
      siteId: "project-dashboard",
      label: "Project dashboard",
      origin: "http://localhost:3000",
      association: { projectCwd: "/workspace/private/acme" },
    });
    const capture = vi.fn(async (request: SiteCaptureDriverRequest) => ({
      png: pngHeader(),
      finalUrl: request.targetUrl,
      redirectCount: 0,
      scroll: request.scroll,
    }));
    const service = new SiteCaptureService({ registry, driver: { capture } });
    const request = {
      siteId: "project-dashboard",
      path: "/",
      viewport: "mobile-portrait" as const,
      scroll: { x: 0, y: 0 },
    };

    await expect(service.capture({
      threadId: THREAD_ID,
      projectId: projectCwdIdentifier("/workspace/private/acme"),
    }, request)).resolves.toMatchObject({ siteId: "project-dashboard" });
    await expect(service.capture({
      threadId: THREAD_ID,
      projectId: projectCwdIdentifier("/workspace/private/other"),
    }, request)).rejects.toMatchObject({ code: "SITE_NOT_APPROVED" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin redirects and oversized screenshots returned by a driver", async () => {
    const redirected = await fixture({
      capture: async () => ({
        png: pngHeader(),
        finalUrl: "http://127.0.0.1:3000/",
        redirectCount: 1,
        scroll: { x: 0, y: 0 },
      }),
    });
    await expect(
      redirected.service.capture(
        { threadId: THREAD_ID },
        {
          siteId: "dashboard",
          path: "/",
          viewport: "mobile-portrait",
          scroll: { x: 0, y: 0 },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ORIGIN" });

    const huge = await fixture({
      capture: async () => ({
        png: pngHeader(10_000, 10_000),
        finalUrl: "http://localhost:3000/",
        redirectCount: 0,
        scroll: { x: 0, y: 0 },
      }),
    });
    await expect(
      huge.service.capture(
        { threadId: THREAD_ID },
        {
          siteId: "dashboard",
          path: "/",
          viewport: "mobile-portrait",
          scroll: { x: 0, y: 0 },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CAPTURE" });
  });
});

describe("optional system-Chrome driver", () => {
  it("reports explicit unavailable reasons without launching or falling back to a profile", async () => {
    await expect(
      createOptionalSystemChromeDriver({
        executableCandidates: ["/missing/chrome"],
        pathIsExecutable: async () => false,
      }),
    ).resolves.toMatchObject({ available: false, reason: "system-chrome-unavailable" });
    await expect(
      createOptionalSystemChromeDriver({
        executableCandidates: ["/Applications/Fake Chrome"],
        pathIsExecutable: async () => true,
        loadPlaywright: async () => {
          throw new Error("not installed");
        },
      }),
    ).resolves.toMatchObject({ available: false, reason: "playwright-core-unavailable" });
    const launch = vi.fn();
    await expect(
      createOptionalSystemChromeDriver({
        executableCandidates: ["/Applications/Fake Chrome"],
        pathIsExecutable: async () => true,
        loadPlaywright: async () => ({ chromium: { launch } }),
      }),
    ).resolves.toMatchObject({ available: false, reason: "process-sandbox-unavailable" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses a fresh context policy, blocks cross-origin HTTP and WebSocket traffic, and measures actual scroll", async () => {
    const continued = vi.fn(async () => undefined);
    const aborted = vi.fn(async () => undefined);
    const closedWebSocket = vi.fn(async () => undefined);
    const addInitScript = vi.fn(async () => undefined);
    const wheel = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => ({ x: 0, y: 120 }));
    const contextOptions: unknown[] = [];
    const launchOptions: unknown[] = [];
    let routeHandler:
      | ((route: {
          request(): { url(): string; method(): string; redirectedFrom(): null };
          continue(): Promise<void>;
          abort(code?: string): Promise<void>;
        }) => Promise<void>)
      | undefined;
    const requestFor = (url: string, method = "GET") => ({
      url: () => url,
      method: () => method,
      redirectedFrom: () => null,
    });
    let currentPageUrl = "http://localhost:3000/settings";
    let currentTitle = "Settings";
    const screenshot = vi.fn(async () => {
      currentPageUrl = "http://localhost:3000/client-routed?panel=review";
      currentTitle = "  Client\u0000 routed   review  ";
      return pngHeader();
    });
    const routedRequest = (url: string, method = "GET") => ({
      request: () => requestFor(url, method),
      continue: continued,
      abort: aborted,
    });
    const page = {
      on: vi.fn(),
      goto: async (url: string) => {
        currentPageUrl = url;
        await routeHandler?.(routedRequest(url));
        await routeHandler?.(routedRequest("http://169.254.169.254/latest/meta-data"));
        await routeHandler?.(routedRequest("http://localhost:3000/mutate", "POST"));
        return { url: () => url, request: () => requestFor(url) };
      },
      url: () => currentPageUrl,
      title: async () => currentTitle,
      evaluate,
      screenshot,
      mouse: { wheel },
    };
    const context = {
      addInitScript,
      route: async (_pattern: string, handler: NonNullable<typeof routeHandler>) => {
        routeHandler = handler;
      },
      routeWebSocket: async (
        _pattern: string,
        handler: (route: { close(options?: { code?: number; reason?: string }): Promise<void> }) => Promise<void>,
      ) => handler({ close: closedWebSocket }),
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    };
    const browser = {
      newContext: async (options: unknown) => {
        contextOptions.push(options);
        return context;
      },
      close: vi.fn(async () => undefined),
    };
    const optional = await createOptionalSystemChromeDriver({
      executableCandidates: ["/Applications/Fake Chrome"],
      pathIsExecutable: async () => true,
      loadPlaywright: async () => ({
        chromium: {
          launch: async (options: unknown) => {
            launchOptions.push(options);
            return browser;
          },
        },
      }),
      networkSandboxAvailable: async () => true,
    });
    expect(optional.available).toBe(true);
    if (!optional.available) throw new Error("Expected the injected driver to be available");
    await expect(
      optional.driver.capture({
        targetUrl: "http://localhost:3000/settings",
        approvedOrigin: "http://localhost:3000",
        viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
        scroll: { x: 0, y: 220 },
        maxRedirects: 5,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      finalUrl: "http://localhost:3000/client-routed?panel=review",
      redirectCount: 0,
      scroll: { x: 0, y: 120 },
      title: "Client routed review",
    });
    expect(continued).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(2);
    expect(aborted).toHaveBeenCalledWith("blockedbyclient");
    expect(closedWebSocket).toHaveBeenCalledWith({ code: 1008, reason: "blocked during capture" });
    expect(wheel).toHaveBeenCalledWith(0, 220);
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(launchOptions[0]).not.toHaveProperty("userDataDir");
    expect(launchOptions[0]).toMatchObject({
      executablePath: "/Applications/Fake Chrome",
      chromiumSandbox: true,
      timeout: 1_000,
      proxy: { server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u), bypass: "<-loopback>" },
      args: expect.arrayContaining([
        "--disable-http2",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1",
      ]),
    });
    expect((launchOptions[0] as { args: string[] }).args).not.toContain("--no-sandbox");
    expect(contextOptions[0]).toEqual({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    expect(addInitScript).toHaveBeenCalledWith(expect.any(Function));
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function));
  });

  it("recaptures once when a same-URL title changes during the screenshot", async () => {
    const requestFor = (url: string) => ({
      url: () => url,
      method: () => "GET",
      redirectedFrom: () => null,
    });
    let routeHandler:
      | ((route: {
          request(): ReturnType<typeof requestFor>;
          continue(): Promise<void>;
          abort(code?: string): Promise<void>;
        }) => Promise<void>)
      | undefined;
    let currentTitle = "Before render";
    const screenshot = vi.fn(async () => {
      currentTitle = "After render";
      return pngHeader();
    });
    const page = {
      on: vi.fn(),
      goto: async (url: string) => {
        await routeHandler?.({
          request: () => requestFor(url),
          continue: async () => undefined,
          abort: async () => undefined,
        });
        return { url: () => url, request: () => requestFor(url) };
      },
      url: () => "http://localhost:3000/settings",
      title: async () => currentTitle,
      evaluate: async () => ({ x: 0, y: 0 }),
      screenshot,
      mouse: { wheel: vi.fn(async () => undefined) },
    };
    const context = {
      addInitScript: vi.fn(async () => undefined),
      route: vi.fn(async (_pattern: string, handler: NonNullable<typeof routeHandler>) => {
        routeHandler = handler;
      }),
      routeWebSocket: vi.fn(async () => undefined),
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    };
    const optional = await createOptionalSystemChromeDriver({
      executableCandidates: ["/Applications/Fake Chrome"],
      pathIsExecutable: async () => true,
      loadPlaywright: async () => ({
        chromium: {
          launch: async () => ({
            newContext: async () => context,
            close: vi.fn(async () => undefined),
          }),
        },
      }),
      networkSandboxAvailable: async () => true,
    });
    if (!optional.available) throw new Error("Expected the injected driver to be available");

    await expect(optional.driver.capture({
      targetUrl: "http://localhost:3000/settings",
      approvedOrigin: "http://localhost:3000",
      viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
      scroll: { x: 0, y: 0 },
      maxRedirects: 5,
      timeoutMs: 1_000,
    })).resolves.toMatchObject({
      finalUrl: "http://localhost:3000/settings",
      title: "After render",
      scroll: { x: 0, y: 0 },
    });
    expect(screenshot).toHaveBeenCalledTimes(2);
  });

});

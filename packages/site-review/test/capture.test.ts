import { describe, expect, it } from "vitest";

import {
  SITE_RECORD_VERSION,
  buildDriverCaptureRequest,
  unavailableRemoteBrowserAssociation,
  validateDriverCaptureResult,
  type ApprovedSiteRecord,
  type SiteCaptureRequest,
} from "../src/index.js";

function pngHeader(width: number, height: number, extraBytes = 0): Uint8Array {
  const png = new Uint8Array(24 + extraBytes);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(png.buffer).setUint32(8, 13);
  png.set([73, 72, 68, 82], 12);
  new DataView(png.buffer).setUint32(16, width);
  new DataView(png.buffer).setUint32(20, height);
  return png;
}

const record: ApprovedSiteRecord = {
  version: SITE_RECORD_VERSION,
  siteId: "dashboard",
  label: "Dashboard",
  association: { kind: "thread", threadId: "019f6de7-44c2-7fe2-9d17-9322c952e626" },
  origin: "http://localhost:3000",
  publicOrigin: "https://codex-mac.example-tail.ts.net:3000",
  approvedAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-20T10:00:00.000Z",
  remoteBrowser: unavailableRemoteBrowserAssociation(),
};

const request: SiteCaptureRequest = {
  siteId: "dashboard",
  path: "/settings",
  viewport: "ipad-landscape",
  scroll: { x: 0, y: 640 },
};

describe("capture boundaries", () => {
  it("builds the driver target only from an approved origin and typed request", () => {
    expect(buildDriverCaptureRequest(record, request)).toEqual({
      targetUrl: "http://localhost:3000/settings",
      approvedOrigin: "http://localhost:3000",
      viewport: { width: 1366, height: 1024, deviceScaleFactor: 1 },
      scroll: { x: 0, y: 640 },
      maxRedirects: 5,
      timeoutMs: 20_000,
    });
  });

  it("validates origin, redirect count, PNG type, bytes, and pixels", () => {
    expect(
      validateDriverCaptureResult(record, request, {
        png: pngHeader(1366, 1024),
        finalUrl: "http://localhost:3000/settings/profile",
        redirectCount: 1,
        scroll: { x: 0, y: 320 },
      }),
    ).toMatchObject({ width: 1366, height: 1024, redirectCount: 1, scroll: { x: 0, y: 320 } });

    expect(() =>
      validateDriverCaptureResult(record, request, {
        png: pngHeader(1366, 1024),
        finalUrl: "http://127.0.0.1:3000/settings",
        redirectCount: 1,
        scroll: { x: 0, y: 640 },
      }),
    ).toThrow(/crossed/u);
    expect(() =>
      validateDriverCaptureResult(record, request, {
        png: pngHeader(1366, 1024),
        finalUrl: "http://localhost:3000/settings",
        redirectCount: 6,
        scroll: { x: 0, y: 640 },
      }),
    ).toThrow(/redirect/u);
    expect(() =>
      validateDriverCaptureResult(record, request, {
        png: new Uint8Array([1, 2, 3]),
        finalUrl: "http://localhost:3000/settings",
        redirectCount: 0,
        scroll: { x: 0, y: 640 },
      }),
    ).toThrow(/PNG/u);
    expect(() =>
      validateDriverCaptureResult(
        record,
        request,
        {
          png: pngHeader(1366, 1024, 100),
          finalUrl: "http://localhost:3000/settings",
          redirectCount: 0,
          scroll: { x: 0, y: 640 },
        },
        { maxPngBytes: 64 },
      ),
    ).toThrow(/byte/u);
    expect(() =>
      validateDriverCaptureResult(record, request, {
        png: pngHeader(10_000, 10_000),
        finalUrl: "http://localhost:3000/settings",
        redirectCount: 0,
        scroll: { x: 0, y: 640 },
      }),
    ).toThrow(/dimensions/u);
  });

  it("persists measured driver scroll instead of the requested coordinates", () => {
    expect(validateDriverCaptureResult(record, request, {
      png: pngHeader(1366, 1024),
      finalUrl: "http://localhost:3000/settings",
      redirectCount: 0,
      scroll: { x: 0, y: 0 },
    }).scroll).toEqual({ x: 0, y: 0 });
    expect(() => validateDriverCaptureResult(record, request, {
      png: pngHeader(1366, 1024),
      finalUrl: "http://localhost:3000/settings",
      redirectCount: 0,
      scroll: { x: 0, y: 1_000_001 },
    })).toThrow(/result\.scroll\.y/u);
  });

  it("rejects untyped viewports and unbounded scroll at runtime", () => {
    expect(() =>
      buildDriverCaptureRequest(record, {
        ...request,
        viewport: "arbitrary" as SiteCaptureRequest["viewport"],
      }),
    ).toThrow(/viewport/u);
    expect(() =>
      buildDriverCaptureRequest(record, { ...request, scroll: { x: 0, y: 1_000_001 } }),
    ).toThrow(/scroll.y/u);
  });
});

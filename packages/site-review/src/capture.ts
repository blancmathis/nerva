import { SiteReviewError } from "./errors.js";
import { assertUrlWithinOrigin, resolveApprovedCapturePath } from "./origin.js";
import type { ApprovedSiteRecord } from "./types.js";

export const VIEWPORT_PRESETS = {
  "ipad-landscape": { width: 1_366, height: 1_024, deviceScaleFactor: 1 },
  "ipad-portrait": { width: 1_024, height: 1_366, deviceScaleFactor: 1 },
  "mobile-portrait": { width: 390, height: 844, deviceScaleFactor: 1 },
  "desktop-wide": { width: 1_440, height: 900, deviceScaleFactor: 1 },
} as const;

export type ViewportPreset = keyof typeof VIEWPORT_PRESETS;

export interface CaptureScroll {
  x: number;
  y: number;
}

export interface SiteCaptureRequest {
  siteId: string;
  path: string;
  viewport: ViewportPreset;
  scroll: CaptureScroll;
}

export interface SiteCaptureLimits {
  maxRedirects: number;
  maxPngBytes: number;
  maxPngDimension: number;
  maxPngPixels: number;
  maxScroll: number;
  timeoutMs: number;
}

export const DEFAULT_CAPTURE_LIMITS: Readonly<SiteCaptureLimits> = {
  maxRedirects: 5,
  maxPngBytes: 8 * 1_024 * 1_024,
  maxPngDimension: 8_192,
  maxPngPixels: 20_000_000,
  maxScroll: 1_000_000,
  timeoutMs: 20_000,
};

export interface SiteCaptureDriverRequest {
  targetUrl: string;
  approvedOrigin: string;
  viewport: (typeof VIEWPORT_PRESETS)[ViewportPreset];
  scroll: CaptureScroll;
  maxRedirects: number;
  timeoutMs: number;
}

export interface SiteCaptureDriverResult {
  png: Uint8Array;
  finalUrl: string;
  redirectCount: number;
  scroll: CaptureScroll;
  title?: string;
}

export interface SiteCaptureDriver {
  capture(request: SiteCaptureDriverRequest): Promise<SiteCaptureDriverResult>;
}

export interface ValidatedSiteCapture {
  siteId: string;
  sourceUrl: string;
  finalUrl: string;
  title?: string;
  viewport: ViewportPreset;
  scroll: CaptureScroll;
  redirectCount: number;
  png: Uint8Array;
  width: number;
  height: number;
}

function captureError(message: string): never {
  throw new SiteReviewError("INVALID_CAPTURE", message);
}

function normalizedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return captureError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

export function normalizeCaptureLimits(
  overrides: Partial<SiteCaptureLimits> = {},
): SiteCaptureLimits {
  const limits = { ...DEFAULT_CAPTURE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      captureError(`${name} must be a positive integer`);
    }
  }
  return limits;
}

export function buildDriverCaptureRequest(
  record: ApprovedSiteRecord,
  request: SiteCaptureRequest,
  limitsInput: Partial<SiteCaptureLimits> = {},
): SiteCaptureDriverRequest {
  if (request.siteId !== record.siteId) {
    captureError("Capture site id does not match the approved registry record");
  }
  if (!Object.hasOwn(VIEWPORT_PRESETS, request.viewport)) {
    captureError("Capture viewport is not an approved preset");
  }
  const limits = normalizeCaptureLimits(limitsInput);
  const scroll = {
    x: normalizedInteger(request.scroll.x, "scroll.x", limits.maxScroll),
    y: normalizedInteger(request.scroll.y, "scroll.y", limits.maxScroll),
  };
  return {
    targetUrl: resolveApprovedCapturePath(record.origin, request.path),
    approvedOrigin: record.origin,
    viewport: VIEWPORT_PRESETS[request.viewport],
    scroll,
    maxRedirects: limits.maxRedirects,
    timeoutMs: limits.timeoutMs,
  };
}

function parsePngDimensions(png: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  if (png.byteLength < 24 || signature.some((byte, index) => png[index] !== byte)) {
    return captureError("Capture driver did not return a PNG image");
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunkType = String.fromCharCode(png[12] ?? 0, png[13] ?? 0, png[14] ?? 0, png[15] ?? 0);
  if (view.getUint32(8) !== 13 || chunkType !== "IHDR") {
    return captureError("Capture PNG is missing its leading IHDR chunk");
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) captureError("Capture PNG has empty dimensions");
  return { width, height };
}

export function validateDriverCaptureResult(
  record: ApprovedSiteRecord,
  request: SiteCaptureRequest,
  result: SiteCaptureDriverResult,
  limitsInput: Partial<SiteCaptureLimits> = {},
): ValidatedSiteCapture {
  const limits = normalizeCaptureLimits(limitsInput);
  if (!(result.png instanceof Uint8Array)) {
    captureError("Capture driver did not return PNG bytes");
  }
  if (result.title !== undefined && typeof result.title !== "string") {
    captureError("Capture driver returned an invalid page title");
  }
  if (
    result.scroll === null
    || typeof result.scroll !== "object"
    || typeof result.scroll.x !== "number"
    || typeof result.scroll.y !== "number"
  ) {
    captureError("Capture driver returned invalid measured scroll coordinates");
  }
  if (!Number.isSafeInteger(result.redirectCount) || result.redirectCount < 0) {
    captureError("Capture driver returned an invalid redirect count");
  }
  if (result.redirectCount > limits.maxRedirects) {
    captureError(`Capture exceeded the ${limits.maxRedirects}-redirect limit`);
  }
  const finalUrl = assertUrlWithinOrigin(result.finalUrl, record.origin).href;
  if (result.png.byteLength > limits.maxPngBytes) {
    captureError(`Capture PNG exceeds the ${limits.maxPngBytes}-byte limit`);
  }
  const { width, height } = parsePngDimensions(result.png);
  if (
    width > limits.maxPngDimension ||
    height > limits.maxPngDimension ||
    width * height > limits.maxPngPixels
  ) {
    captureError("Capture PNG dimensions exceed the configured safety limit");
  }
  const scroll = {
    x: normalizedInteger(result.scroll.x, "result.scroll.x", limits.maxScroll),
    y: normalizedInteger(result.scroll.y, "result.scroll.y", limits.maxScroll),
  };
  return {
    siteId: record.siteId,
    sourceUrl: resolveApprovedCapturePath(record.origin, request.path),
    finalUrl,
    ...(result.title === undefined ? {} : { title: result.title.slice(0, 512) }),
    viewport: request.viewport,
    scroll,
    redirectCount: result.redirectCount,
    png: result.png,
    width,
    height,
  };
}

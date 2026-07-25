import type { SiteCaptureResult, SiteCaptureViewport } from "./bridge-client";

export function captureViewportPreset(width: number, height: number): SiteCaptureViewport {
  if (width >= 1_400) return "desktop-wide";
  if (width > height) return "ipad-landscape";
  if (width >= 700) return "ipad-portrait";
  return "mobile-portrait";
}

export function associatedSitePath(requestedUrl: string, approvedOrigin: string): string {
  const requested = new URL(requestedUrl);
  const approved = new URL(approvedOrigin);
  const hostname = requested.hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname.endsWith(".localhost");
  if (
    requested.protocol !== "https:"
    || approved.protocol !== "https:"
    || requested.origin !== approved.origin
    || requested.username
    || requested.password
    || loopback
  ) throw new Error("Capture is limited to the exact public HTTPS site associated with this task.");
  return `${requested.pathname}${requested.search}`;
}

export function publicCapturedSiteUrl(finalPath: string, approvedOrigin: string): string {
  const approved = new URL(approvedOrigin);
  const hostname = approved.hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname.endsWith(".localhost");
  if (
    approved.protocol !== "https:"
    || approved.username !== ""
    || approved.password !== ""
    || approved.pathname !== "/"
    || approved.search !== ""
    || approved.hash !== ""
    || loopback
    || finalPath.length > 2_048
    || !finalPath.startsWith("/")
    || finalPath.startsWith("//")
    || finalPath.includes("#")
    || /[\u0000-\u001f\u007f\\]/u.test(finalPath)
  ) throw new Error("The bridge returned an invalid final site route.");
  const captured = new URL(finalPath, `${approved.origin}/`);
  if (captured.origin !== approved.origin || captured.username || captured.password) {
    throw new Error("The bridge returned a final route outside the approved site.");
  }
  return captured.href;
}

export function capturedFrameGeometry(result: Pick<SiteCaptureResult, "width" | "height" | "scroll">) {
  return {
    viewport: {
      width: result.width,
      height: result.height,
      // The current bridge presets capture CSS pixels at DPR 1. Do not claim
      // the initiating iPad's DPR for a Mac-side image.
      deviceScaleFactor: 1,
    },
    scroll: result.scroll,
  } as const;
}

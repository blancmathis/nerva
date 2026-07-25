import type { ReviewFrame, ReviewImage } from "@codex-pad/review";
import type { SiteInteractionModes } from "@codex-pad/protocol";
import { createUuidV4 } from "../lib/uuid";

export type ReviewInputMode = "smart" | "interact" | "annotate";

export interface AllowedReviewSite {
  readonly url: string;
  /** Exact origin approved by the Mac bridge, for example https://mac.tailnet.ts.net. */
  readonly allowedOrigin: string;
  readonly title?: string;
  readonly captureCapability: "available" | "degraded";
  readonly captureDetail?: string;
  readonly interactionModes: SiteInteractionModes;
}

export interface ReviewFrameGeometry {
  readonly viewport: ReviewFrame["viewport"];
  readonly scroll: ReviewFrame["scroll"];
}

const DEFAULT_GEOMETRY: ReviewFrameGeometry = {
  viewport: { width: 1_024, height: 768, deviceScaleFactor: 2 },
  scroll: { x: 0, y: 0 },
};

export function reviewId(prefix: string): string {
  return `${prefix}-${createUuidV4()}`;
}

function emptyComparison(): ReviewFrame["comparison"] {
  return { mode: "none", before: null, after: null };
}

export function makeBlankReviewFrame(
  geometry: ReviewFrameGeometry = DEFAULT_GEOMETRY,
  id = reviewId("frame"),
): ReviewFrame {
  return {
    id,
    kind: "blank",
    title: "Blank note",
    url: null,
    viewport: geometry.viewport,
    scroll: geometry.scroll,
    capturedImage: null,
    drawing: null,
    photos: [],
    instruction: "",
    comparison: emptyComparison(),
  };
}

export function makeSiteReviewFrame(
  input: {
    readonly url: string;
    readonly title?: string | null;
    readonly capturedImage?: ReviewImage | null;
    readonly geometry?: ReviewFrameGeometry;
    readonly id?: string;
  },
): ReviewFrame {
  const geometry = input.geometry ?? DEFAULT_GEOMETRY;
  return {
    id: input.id ?? reviewId("frame"),
    kind: "site-snapshot",
    title: input.title?.trim() || "Site snapshot",
    url: input.url,
    viewport: geometry.viewport,
    scroll: geometry.scroll,
    capturedImage: input.capturedImage ?? null,
    drawing: null,
    photos: [],
    instruction: "",
    comparison: emptyComparison(),
  };
}

export function makePhotoReviewFrame(
  image: ReviewImage,
  geometry: ReviewFrameGeometry = DEFAULT_GEOMETRY,
  id = reviewId("frame"),
): ReviewFrame {
  return {
    id,
    kind: "photo",
    title: image.metadata.fileName || "Photo",
    url: null,
    viewport: geometry.viewport,
    scroll: geometry.scroll,
    capturedImage: image,
    drawing: null,
    photos: [],
    instruction: "",
    comparison: emptyComparison(),
  };
}

/** URL is metadata, never identity: every capture gets an independent stable frame ID. */
export function frameIdentityKey(frame: ReviewFrame): string {
  return frame.id;
}

export function resolveAllowedSite(site: AllowedReviewSite | null | undefined): URL | null {
  if (!site) return null;
  try {
    const url = new URL(site.url);
    const approved = new URL(site.allowedOrigin);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
    const pwaOrigin = typeof window === "undefined" ? null : window.location.origin;
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      approved.username.length > 0 ||
      approved.password.length > 0 ||
      url.protocol !== "https:" ||
      approved.protocol !== "https:" ||
      loopback ||
      url.origin !== approved.origin ||
      url.origin === pwaOrigin
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** A saved site frame can be recaptured only on its still-approved registered origin. */
export function resolveRegisteredCaptureRoute(
  frame: ReviewFrame,
  site: AllowedReviewSite | null | undefined,
): URL | null {
  if (frame.kind !== "site-snapshot" || frame.capturedImage === null || frame.url === null || !site) return null;
  return resolveAllowedSite({ ...site, url: frame.url });
}

export function canCompareFrame(frame: ReviewFrame): boolean {
  return frame.comparison.before !== null && frame.comparison.after !== null;
}

/**
 * Turn an explicit second image into comparison evidence. The current capture
 * remains the immutable before state; callers are responsible for persisting
 * the after image blob before saving the returned comparison.
 */
export function makeAfterComparison(
  frame: ReviewFrame,
  afterImage: ReviewImage,
): ReviewFrame["comparison"] {
  if (!frame.capturedImage) throw new Error("A captured before image is required to compare an after state.");
  return {
    mode: "side-by-side",
    before: {
      label: "Before",
      image: { ...frame.capturedImage, id: reviewId("before") },
    },
    after: { label: "After", image: afterImage },
  };
}

/** Store the after image as a new frame; the earlier frame remains immutable comparison evidence. */
export function makeIterationFrame(frame: ReviewFrame, id = reviewId("frame")): ReviewFrame {
  const after = frame.comparison.after;
  if (!after) throw new Error("An after image is required to store a new iteration.");
  return {
    ...frame,
    id,
    title: `${frame.title ?? "Review"} · next iteration`,
    capturedImage: { ...after.image, id: reviewId("image") },
    drawing: null,
    photos: [],
    instruction: "",
    comparison: emptyComparison(),
  };
}

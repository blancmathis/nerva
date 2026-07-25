import { REVIEW_LIMITS, type ReviewImage } from "@codex-pad/review";
import { useEffect, useRef, useState } from "react";

import {
  LOCAL_VISUAL_DIFF_THRESHOLD,
  computeLocalVisualDiff,
  localVisualDiffSize,
  type LocalVisualDiffResult,
  type LocalVisualDiffSize,
} from "../lib/local-visual-diff";
import { getReviewBlob } from "../lib/review-store";

type ReviewBlobLoader = (blobRef: string) => Promise<Blob | null>;

interface DiffReadyState {
  readonly kind: "ready";
  readonly result: LocalVisualDiffResult;
  readonly size: LocalVisualDiffSize;
}

interface DiffMessageState {
  readonly kind: "loading" | "error";
  readonly title: string;
  readonly detail: string;
}

type DiffState = DiffReadyState | DiffMessageState;

interface DecodedLocalImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface LocalVisualDiffProps {
  readonly before: ReviewImage;
  readonly after: ReviewImage;
  /** Narrow test seam; production always resolves the local review database. */
  readonly loadBlob?: ReviewBlobLoader;
}

class LocalDiffError extends Error {
  constructor(
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function dimensions(image: ReviewImage): string {
  return `${image.metadata.pixelWidth} × ${image.metadata.pixelHeight}`;
}

function dataUrlBlob(image: ReviewImage, label: string): Blob {
  if (image.source.kind !== "dataUrl") throw new Error("Expected an inline image.");
  const prefix = `data:${image.metadata.mimeType};base64,`;
  if (!image.source.dataUrl.startsWith(prefix)) {
    throw new LocalDiffError(
      `${label} image is unavailable locally.`,
      "Its saved inline media does not match the recorded image type. Re-import that image to compare it.",
    );
  }
  const encoded = image.source.dataUrl.slice(prefix.length);
  const estimatedBytes = Math.floor((encoded.length * 3) / 4);
  if (estimatedBytes > REVIEW_LIMITS.imageBytes) {
    throw new LocalDiffError(
      `${label} image is too large for local diff.`,
      "The saved image exceeds the bounded review-media limit. Resize or crop it before comparing.",
    );
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: image.metadata.mimeType });
  } catch {
    throw new LocalDiffError(
      `${label} image is unavailable locally.`,
      "Its saved inline media could not be read. Re-import that image to compare it.",
    );
  }
}

async function localImageBlob(
  image: ReviewImage,
  label: "Before" | "After",
  loadBlob: ReviewBlobLoader,
): Promise<Blob> {
  const blob = image.source.kind === "blobRef"
    ? await loadBlob(image.source.blobRef)
    : dataUrlBlob(image, label);
  if (!blob) {
    throw new LocalDiffError(
      `${label} image is unavailable on this iPad.`,
      "The saved local media could not be loaded. Re-import that image or use another comparison mode.",
    );
  }
  if (blob.size <= 0 || blob.size > REVIEW_LIMITS.imageBytes) {
    throw new LocalDiffError(
      `${label} image cannot be diffed locally.`,
      "The saved media falls outside the bounded review-image limit. Re-import a smaller image.",
    );
  }
  return blob;
}

async function decodeHtmlImage(blob: Blob): Promise<DecodedLocalImage> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.decoding = "async";
      element.addEventListener("load", () => resolve(element), { once: true });
      element.addEventListener("error", () => reject(new Error("Image decode failed.")), { once: true });
      element.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function decodeLocalImage(
  blob: Blob,
  target: LocalVisualDiffSize,
): Promise<DecodedLocalImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: "high",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Safari versions without resize options can still take the bounded HTML
      // image path below; the review import limit caps the source decode.
    }
  }
  return await decodeHtmlImage(blob);
}

async function rasterPixels(
  blob: Blob,
  image: ReviewImage,
  target: LocalVisualDiffSize,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): Promise<Uint8ClampedArray> {
  const decoded = await decodeLocalImage(blob, target);
  try {
    const resizedBitmap = decoded.width === target.width && decoded.height === target.height;
    const fullSizeImage = decoded.width === image.metadata.pixelWidth
      && decoded.height === image.metadata.pixelHeight;
    if (!resizedBitmap && !fullSizeImage) {
      throw new LocalDiffError(
        "Saved dimensions do not match the decoded image.",
        `Recorded ${dimensions(image)} · decoded ${decoded.width} × ${decoded.height}. Re-import the image before comparing it.`,
      );
    }
    canvas.width = target.width;
    canvas.height = target.height;
    context.clearRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, target.width, target.height);
    return context.getImageData(0, 0, target.width, target.height).data;
  } finally {
    context.clearRect(0, 0, target.width, target.height);
    decoded.close();
  }
}

function percentage(changed: number, total: number): string {
  if (changed === 0) return "0%";
  const value = (changed / total) * 100;
  if (value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

export function LocalVisualDiff({ before, after, loadBlob = getReviewBlob }: LocalVisualDiffProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<DiffState>({
    kind: "loading",
    title: "Building local diff…",
    detail: "Decoding Before and After on this iPad. Nothing is captured or uploaded.",
  });
  const matchingDimensions = before.metadata.pixelWidth === after.metadata.pixelWidth
    && before.metadata.pixelHeight === after.metadata.pixelHeight;

  useEffect(() => {
    if (!matchingDimensions) return;
    let cancelled = false;
    setState({
      kind: "loading",
      title: "Building local diff…",
      detail: "Decoding Before and After on this iPad. Nothing is captured or uploaded.",
    });

    void (async () => {
      try {
        const outputCanvas = canvasRef.current;
        if (!outputCanvas) throw new Error("The visual diff canvas is unavailable.");
        const size = localVisualDiffSize(before.metadata.pixelWidth, before.metadata.pixelHeight);
        const scratchCanvas = document.createElement("canvas");
        scratchCanvas.width = size.width;
        scratchCanvas.height = size.height;
        const scratchContext = scratchCanvas.getContext("2d", { willReadFrequently: true });
        const outputContext = outputCanvas.getContext("2d");
        if (!scratchContext || !outputContext) {
          throw new LocalDiffError(
            "Local diff is unavailable in this browser.",
            "Canvas pixel access is disabled. Before and After remain available in the other comparison modes.",
          );
        }

        const beforeBlob = await localImageBlob(before, "Before", loadBlob);
        const beforePixels = await rasterPixels(beforeBlob, before, size, scratchCanvas, scratchContext);
        if (cancelled) return;
        const afterBlob = await localImageBlob(after, "After", loadBlob);
        const afterPixels = await rasterPixels(afterBlob, after, size, scratchCanvas, scratchContext);
        if (cancelled) return;
        const result = computeLocalVisualDiff(beforePixels, afterPixels);
        outputCanvas.width = size.width;
        outputCanvas.height = size.height;
        const imageData = outputContext.createImageData(size.width, size.height);
        imageData.data.set(result.pixels);
        outputContext.putImageData(imageData, 0, 0);
        if (!cancelled) setState({ kind: "ready", result, size });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof LocalDiffError) {
          setState({ kind: "error", title: error.title, detail: error.detail });
          return;
        }
        setState({
          kind: "error",
          title: "Local diff could not decode both images.",
          detail: "Before and After remain saved. Re-import the unavailable image or use another comparison mode.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [after, before, loadBlob, matchingDimensions]);

  if (!matchingDimensions) {
    return (
      <div className="review-compare-diff is-unavailable" role="status">
        <strong>Diff needs matching image dimensions.</strong>
        <span>Before {dimensions(before)} · After {dimensions(after)}.</span>
        <span>Side by side, Overlay and Blink remain available.</span>
      </div>
    );
  }

  return (
    <figure className={`review-compare-diff${state.kind === "ready" ? " is-ready" : ""}`}>
      <div className="review-compare-diff-viewport" style={{ aspectRatio: `${before.metadata.pixelWidth} / ${before.metadata.pixelHeight}` }}>
        <canvas
          ref={canvasRef}
          className="review-compare-diff-canvas"
          role="img"
          aria-label="Local visual-diff heatmap; coral pixels changed and graphite pixels are unchanged"
        >Local visual-diff heatmap.</canvas>
        {state.kind !== "ready" && (
          <div className="review-compare-diff-message" role="status">
            <strong>{state.title}</strong>
            <span>{state.detail}</span>
          </div>
        )}
      </div>
      {state.kind === "ready" && (
        <figcaption className="review-compare-diff-caption" role="status">
          <div>
            <strong>{percentage(state.result.changedPixels, state.result.totalPixels)} changed</strong>
            <span>{state.result.changedPixels.toLocaleString()} of {state.result.totalPixels.toLocaleString()} analyzed pixels · threshold {LOCAL_VISUAL_DIFF_THRESHOLD}/255</span>
          </div>
          <div className="review-compare-diff-legend" aria-label="Diff legend">
            <span><i className="is-changed" aria-hidden="true" />Changed</span>
            <span><i className="is-unchanged" aria-hidden="true" />Unchanged</span>
          </div>
          <small>
            {state.size.sampled
              ? `Bounded ${state.size.width} × ${state.size.height} preview from ${dimensions(before)}`
              : `Full-size ${state.size.width} × ${state.size.height} comparison`} · local only
          </small>
        </figcaption>
      )}
    </figure>
  );
}

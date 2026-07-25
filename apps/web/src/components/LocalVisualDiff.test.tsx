import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReviewImage } from "@codex-pad/review";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalVisualDiff } from "./LocalVisualDiff";

function reviewImage(id: string, blobRef: string, width = 2, height = 2): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef },
    metadata: {
      mimeType: "image/png",
      byteLength: 1,
      pixelWidth: width,
      pixelHeight: height,
      fileName: `${id}.png`,
      sha256: null,
      capturedAt: 1,
    },
  };
}

function installCanvasDiff(
  beforePixels: Uint8ClampedArray,
  afterPixels: Uint8ClampedArray,
) {
  let readIndex = 0;
  const scratchContext = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: readIndex++ === 0 ? beforePixels : afterPixels })),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  } as unknown as CanvasRenderingContext2D;
  const outputPixels = new Uint8ClampedArray(beforePixels.length);
  const outputContext = {
    createImageData: vi.fn(() => ({ data: outputPixels })),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return (this.classList.contains("review-compare-diff-canvas") ? outputContext : scratchContext) as never;
  });
  return { outputContext, outputPixels };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LocalVisualDiff", () => {
  it("renders a real local heatmap without calling fetch", async () => {
    const beforePixels = Uint8ClampedArray.from([
      20, 20, 20, 255,
      20, 20, 20, 255,
      20, 20, 20, 255,
      20, 20, 20, 255,
    ]);
    const afterPixels = Uint8ClampedArray.from([
      20, 20, 20, 255,
      220, 20, 20, 255,
      20, 20, 20, 255,
      20, 20, 20, 255,
    ]);
    const { outputContext, outputPixels } = installCanvasDiff(beforePixels, afterPixels);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 2, close })));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const loadBlob = vi.fn(async () => new Blob([Uint8Array.of(1)], { type: "image/png" }));

    render(
      <LocalVisualDiff
        before={reviewImage("before", "before-ref")}
        after={reviewImage("after", "after-ref")}
        loadBlob={loadBlob}
      />,
    );

    expect(await screen.findByText("25.0% changed")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /local visual-diff heatmap/i })).toBeInTheDocument();
    expect(screen.getByText(/4 analyzed pixels · threshold 16\/255/i)).toBeInTheDocument();
    expect(screen.getByText(/Full-size 2 × 2 comparison · local only/i)).toBeInTheDocument();
    expect(loadBlob).toHaveBeenNthCalledWith(1, "before-ref");
    expect(loadBlob).toHaveBeenNthCalledWith(2, "after-ref");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
    expect(outputContext.putImageData).toHaveBeenCalledOnce();
    expect(outputPixels[4]).toBe(237);
  });

  it("explains incompatible dimensions before loading either image", () => {
    const loadBlob = vi.fn();
    render(
      <LocalVisualDiff
        before={reviewImage("before", "before-ref", 820, 1_180)}
        after={reviewImage("after", "after-ref", 1_024, 1_366)}
        loadBlob={loadBlob}
      />,
    );

    expect(screen.getByText("Diff needs matching image dimensions.")).toBeInTheDocument();
    expect(screen.getByText("Before 820 × 1180 · After 1024 × 1366.")).toBeInTheDocument();
    expect(screen.getByText(/Side by side, Overlay and Blink remain available/i)).toBeInTheDocument();
    expect(loadBlob).not.toHaveBeenCalled();
  });

  it("identifies which saved image is missing locally", async () => {
    installCanvasDiff(new Uint8ClampedArray(16), new Uint8ClampedArray(16));
    const loadBlob = vi.fn(async () => null);
    render(
      <LocalVisualDiff
        before={reviewImage("before", "before-ref")}
        after={reviewImage("after", "after-ref")}
        loadBlob={loadBlob}
      />,
    );

    expect(await screen.findByText("Before image is unavailable on this iPad.")).toBeInTheDocument();
    expect(screen.getByText(/saved local media could not be loaded/i)).toBeInTheDocument();
    await waitFor(() => expect(loadBlob).toHaveBeenCalledTimes(1));
  });
});

export const LOCAL_VISUAL_DIFF_PIXEL_BUDGET = 2_000_000;
export const LOCAL_VISUAL_DIFF_THRESHOLD = 16;

export interface LocalVisualDiffSize {
  readonly width: number;
  readonly height: number;
  readonly sampled: boolean;
}

export interface LocalVisualDiffResult {
  readonly pixels: Uint8ClampedArray;
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly maximumDelta: number;
}

/**
 * Fit a comparison raster inside a fixed pixel budget while preserving the
 * source aspect ratio. The loop only corrects floating-point rounding at the
 * budget boundary; it never scales a source up.
 */
export function localVisualDiffSize(
  sourceWidth: number,
  sourceHeight: number,
  pixelBudget = LOCAL_VISUAL_DIFF_PIXEL_BUDGET,
): LocalVisualDiffSize {
  if (
    !Number.isSafeInteger(sourceWidth)
    || !Number.isSafeInteger(sourceHeight)
    || sourceWidth <= 0
    || sourceHeight <= 0
  ) {
    throw new Error("Visual diff dimensions must be positive safe integers.");
  }
  if (!Number.isSafeInteger(pixelBudget) || pixelBudget <= 0) {
    throw new Error("Visual diff pixel budget must be a positive safe integer.");
  }

  const sourcePixels = sourceWidth * sourceHeight;
  if (sourcePixels <= pixelBudget) {
    return { width: sourceWidth, height: sourceHeight, sampled: false };
  }

  const scale = Math.sqrt(pixelBudget / sourcePixels);
  let width = Math.max(1, Math.floor(sourceWidth * scale));
  let height = Math.max(1, Math.floor(sourceHeight * scale));
  while (width * height > pixelBudget) {
    if (width / sourceWidth >= height / sourceHeight) width -= 1;
    else height -= 1;
  }
  return { width, height, sampled: true };
}

/**
 * Build a local heatmap from two equally-sized RGBA rasters. Pixels whose
 * largest channel delta exceeds the fixed noise threshold use the Review
 * coral/amber signal; unchanged pixels retain a quiet luminance reference.
 */
export function computeLocalVisualDiff(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  threshold = LOCAL_VISUAL_DIFF_THRESHOLD,
): LocalVisualDiffResult {
  if (before.length === 0 || before.length !== after.length || before.length % 4 !== 0) {
    throw new Error("Visual diff rasters must contain equal non-empty RGBA data.");
  }
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 254) {
    throw new Error("Visual diff threshold must be an integer from 0 to 254.");
  }

  const pixels = new Uint8ClampedArray(before.length);
  let changedPixels = 0;
  let maximumDelta = 0;

  for (let index = 0; index < before.length; index += 4) {
    const redDelta = Math.abs((before[index] ?? 0) - (after[index] ?? 0));
    const greenDelta = Math.abs((before[index + 1] ?? 0) - (after[index + 1] ?? 0));
    const blueDelta = Math.abs((before[index + 2] ?? 0) - (after[index + 2] ?? 0));
    const alphaDelta = Math.abs((before[index + 3] ?? 0) - (after[index + 3] ?? 0));
    const delta = Math.max(redDelta, greenDelta, blueDelta, alphaDelta);
    maximumDelta = Math.max(maximumDelta, delta);

    if (delta > threshold) {
      changedPixels += 1;
      const intensity = (delta - threshold) / (255 - threshold);
      pixels[index] = 237;
      pixels[index + 1] = Math.round(114 + 60 * (1 - intensity));
      pixels[index + 2] = Math.round(95 - 42 * intensity);
      pixels[index + 3] = 255;
      continue;
    }

    const luminance = Math.round(
      (after[index] ?? 0) * 0.2126
      + (after[index + 1] ?? 0) * 0.7152
      + (after[index + 2] ?? 0) * 0.0722,
    );
    const reference = Math.round(24 + luminance * 0.32);
    pixels[index] = reference;
    pixels[index + 1] = reference;
    pixels[index + 2] = reference;
    pixels[index + 3] = 255;
  }

  return {
    pixels,
    changedPixels,
    totalPixels: before.length / 4,
    maximumDelta,
  };
}

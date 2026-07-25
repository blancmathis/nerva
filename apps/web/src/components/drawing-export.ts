import {
  createExportGeometry,
  exportSceneToPng,
  type ExportGeometry,
  type PngExportOptions,
  type Scene,
} from "@codex-pad/drawing";
import { MAX_SKETCH_BYTES } from "@codex-pad/protocol";

const MAX_EXPORT_ATTEMPTS = 6;
const MIN_LEGIBLE_LONG_EDGE = 1_024;
const TARGET_BYTE_RATIO = 0.92;
const MAX_RESIZE_FACTOR = 0.82;
const MAX_BROWSER_EXPORT_BYTES = Math.floor(MAX_SKETCH_BYTES * TARGET_BYTE_RATIO);

type PngExporter = (scene: Scene, options: PngExportOptions) => Promise<Blob>;

export interface BoundedPngExport {
  readonly blob: Blob;
  readonly geometry: ExportGeometry;
}

function oversizedExportError(): Error {
  return new Error(
    "The PNG preview still exceeds the 8 MB upload limit at a legible size. Crop or resize the photo, then try again.",
  );
}

function smallerOptions(
  options: PngExportOptions,
  geometry: ExportGeometry,
  byteLength: number,
): PngExportOptions | null {
  const currentLongEdge = Math.max(geometry.width, geometry.height);
  if (currentLongEdge <= MIN_LEGIBLE_LONG_EDGE) return null;

  const byteRatio = MAX_BROWSER_EXPORT_BYTES / byteLength;
  const requestedFactor = Math.min(MAX_RESIZE_FACTOR, Math.sqrt(byteRatio));
  const nextLongEdge = Math.max(
    MIN_LEGIBLE_LONG_EDGE,
    Math.floor(currentLongEdge * requestedFactor),
  );
  if (nextLongEdge >= currentLongEdge) return null;

  const factor = nextLongEdge / currentLongEdge;
  const pixelRatio = Math.max(0.25, (options.pixelRatio ?? 1) * factor);
  return {
    ...options,
    maxWidth: Math.max(1, Math.floor(geometry.width * factor)),
    maxHeight: Math.max(1, Math.floor(geometry.height * factor)),
    pixelRatio,
  };
}

/**
 * Flatten a drawing without ever handing an oversized PNG to the native bridge.
 * Retrying from the vector scene keeps strokes and text sharper than decoding and
 * resampling an already flattened PNG.
 */
export async function exportSceneToBoundedPng(
  scene: Scene,
  initialOptions: PngExportOptions,
  exporter: PngExporter = exportSceneToPng,
): Promise<BoundedPngExport> {
  let options = initialOptions;

  for (let attempt = 0; attempt < MAX_EXPORT_ATTEMPTS; attempt += 1) {
    const geometry = createExportGeometry(scene, options);
    let blob: Blob | null = await exporter(scene, options);
    // Leave room for the bridge's metadata-stripping Sharp re-encode, which can
    // be a little larger than the browser's PNG for high-entropy photographs.
    if (blob.size <= MAX_BROWSER_EXPORT_BYTES) return { blob, geometry };

    const byteLength = blob.size;
    blob = null;
    const next = smallerOptions(options, geometry, byteLength);
    if (next === null) throw oversizedExportError();
    options = next;
  }

  throw oversizedExportError();
}

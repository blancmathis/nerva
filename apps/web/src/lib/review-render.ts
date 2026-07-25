import {
  createImageElement,
  createShapeElement,
  exportSceneToPng,
  type ImportedImageSource,
  type Scene,
} from "@codex-pad/drawing";
import { reviewDraftReducer, type ReviewDraft, type ReviewFrame, type ReviewImage } from "@codex-pad/review";

import { prepareReviewImage, reviewImageBlobRef, type PreparedReviewImage } from "./review-media";
import { getReviewBlob } from "./review-store";

export interface ReviewBlobWrite {
  readonly id: string;
  readonly blob: Blob;
}

export interface FlattenedReviewDrawings {
  readonly draft: ReviewDraft;
  readonly blobWrites: readonly ReviewBlobWrite[];
}

function importedSource(image: ReviewImage): ImportedImageSource {
  const metadata = {
    mimeType: image.metadata.mimeType,
    byteLength: image.metadata.byteLength,
    pixelWidth: image.metadata.pixelWidth,
    pixelHeight: image.metadata.pixelHeight,
    name: image.metadata.fileName,
    sha256: image.metadata.sha256,
  } as const;
  return image.source.kind === "blobRef"
    ? { kind: "blobRef", blobId: image.source.blobRef, metadata }
    : { kind: "dataUrl", dataUrl: image.source.dataUrl, metadata };
}

function compositeScene(frame: ReviewFrame, scene: Scene): Scene {
  const background = frame.capturedImage
    ? createImageElement({
        id: `review-background-${frame.id}`,
        x: 0,
        y: 0,
        width: scene.viewport.width,
        height: scene.viewport.height,
        source: importedSource(frame.capturedImage),
        isBackground: true,
      })
    : createShapeElement({
        id: `review-background-${frame.id}`,
        shape: "rectangle",
        x: 0,
        y: 0,
        width: scene.viewport.width,
        height: scene.viewport.height,
        strokeColor: "#fbfaf5",
        strokeWidth: 1,
        fillColor: "#fbfaf5",
      });
  return { ...scene, elements: [background, ...scene.elements] };
}

async function loadImage(source: ImportedImageSource): Promise<CanvasImageSource> {
  let blob: Blob;
  if (source.kind === "blobRef") {
    const stored = await getReviewBlob(source.blobId);
    if (!stored) throw new Error(`Review background ${source.blobId} is missing.`);
    blob = stored;
  } else {
    const response = await fetch(source.dataUrl);
    blob = await response.blob();
  }
  if (typeof createImageBitmap === "function") return await createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      URL.revokeObjectURL(url);
      resolve(image);
    }, { once: true });
    image.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("A review image could not be decoded."));
    }, { once: true });
    image.src = url;
  });
}

export async function renderReviewFrame(frame: ReviewFrame): Promise<PreparedReviewImage | null> {
  if (frame.drawing?.kind !== "scene" || frame.drawing.scene.elements.length === 0) return null;
  const scene = compositeScene(frame, frame.drawing.scene);
  const png = await exportSceneToPng(scene, {
    padding: 0,
    maxWidth: Math.min(4_096, Math.ceil(scene.viewport.width * frame.viewport.deviceScaleFactor)),
    maxHeight: Math.min(4_096, Math.ceil(scene.viewport.height * frame.viewport.deviceScaleFactor)),
    pixelRatio: Math.min(3, frame.viewport.deviceScaleFactor),
    background: "white",
    imageResolver: loadImage,
  });
  const prepared = await prepareReviewImage(png, `${frame.id}-annotated.png`);
  const blobRef = reviewImageBlobRef(prepared.image);
  if (!blobRef) throw new Error("The annotation image did not receive a local reference.");
  return prepared;
}

/**
 * Prepare every changed drawing before manifest creation without touching IndexedDB.
 * The caller commits the returned draft and every Blob in one transaction, so a
 * later render failure cannot strand an earlier frame's annotation PNG.
 */
export async function flattenReviewDrawings(
  draft: ReviewDraft,
  renderFrame: (frame: ReviewFrame) => Promise<PreparedReviewImage | null> = renderReviewFrame,
): Promise<FlattenedReviewDrawings> {
  let next = draft;
  const blobWrites: ReviewBlobWrite[] = [];
  for (const frame of draft.frames) {
    if (frame.drawing?.kind !== "scene" || frame.drawing.renderedImage) continue;
    const rendered = await renderFrame(frame);
    if (!rendered) continue;
    const blobRef = reviewImageBlobRef(rendered.image);
    if (!blobRef) throw new Error("The annotation image did not receive a local reference.");
    next = reviewDraftReducer(next, {
      type: "updateFrame",
      frameId: frame.id,
      patch: { drawing: { ...frame.drawing, renderedImage: rendered.image } },
    }, Math.max(Date.now(), next.updatedAt + 1));
    blobWrites.push({ id: blobRef, blob: rendered.blob });
  }
  return { draft: next, blobWrites };
}

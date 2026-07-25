import { assertScene, type Scene } from "@codex-pad/drawing";
import { z } from "zod";

import { REVIEW_DRAFT_VERSION, REVIEW_LIMITS } from "./constants.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const dataUrlPrefixPattern = /^data:image\/(?:png|jpeg|webp);base64,/;

const boundedIdentifier = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(REVIEW_LIMITS.referenceCharacters, `${label} is too long`);

export const ReviewIdSchema = boundedIdentifier("Review id");
export const FrameIdSchema = boundedIdentifier("Frame id");

/** An exact, canonical app-server thread UUID. */
export const ReviewTargetThreadIdSchema = z
  .string()
  .regex(canonicalUuidPattern, "Expected a canonical thread UUID")
  .transform((value) => value.toLowerCase());

export const EpochMillisSchema = z.number().int().nonnegative().safe();

export const ViewportSchema = z
  .object({
    width: z.number().int().positive().max(REVIEW_LIMITS.imageDimension),
    height: z.number().int().positive().max(REVIEW_LIMITS.imageDimension),
    deviceScaleFactor: z.number().positive().max(8),
  })
  .strict();

export const ScrollPositionSchema = z
  .object({
    x: z.number().finite().min(-10_000_000).max(10_000_000),
    y: z.number().finite().min(-10_000_000).max(10_000_000),
  })
  .strict();

export const ReviewImageMetadataSchema = z
  .object({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteLength: z.number().int().nonnegative().max(REVIEW_LIMITS.imageBytes),
    pixelWidth: z.number().int().positive().max(REVIEW_LIMITS.imageDimension),
    pixelHeight: z.number().int().positive().max(REVIEW_LIMITS.imageDimension),
    fileName: z.string().max(REVIEW_LIMITS.fileNameCharacters).nullable(),
    sha256: z.string().regex(sha256Pattern).toLowerCase().nullable(),
    capturedAt: EpochMillisSchema,
  })
  .strict();

export const ReviewImageSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("blobRef"),
      blobRef: boundedIdentifier("Blob reference"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dataUrl"),
      dataUrl: z
        .string()
        .min(1)
        .max(REVIEW_LIMITS.dataUrlCharacters)
        .regex(dataUrlPrefixPattern, "Expected a supported image data URL"),
    })
    .strict(),
]);

export const ReviewImageSchema = z
  .object({
    id: boundedIdentifier("Image id"),
    source: ReviewImageSourceSchema,
    metadata: ReviewImageMetadataSchema,
  })
  .strict()
  .superRefine((image, context) => {
    if (image.source.kind === "dataUrl") {
      const declaredMime = image.source.dataUrl.slice(5, image.source.dataUrl.indexOf(";"));
      if (declaredMime !== image.metadata.mimeType) {
        context.addIssue({
          code: "custom",
          message: "Image data URL MIME type must match image metadata",
          path: ["source", "dataUrl"],
        });
      }
    }
  });

export const DrawingSceneSchema = z.custom<Scene>((value) => {
  try {
    assertScene(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a valid serializable @codex-pad/drawing scene");

const renderedImageField = ReviewImageSchema.optional();

export const ReviewDrawingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("scene"),
      scene: DrawingSceneSchema,
      renderedImage: renderedImageField,
    })
    .strict(),
  z
    .object({
      kind: z.literal("drawingDraftRef"),
      drawingDraftRef: boundedIdentifier("Drawing draft reference"),
      renderedImage: renderedImageField,
    })
    .strict(),
]);

export const ReviewVariantSchema = z
  .object({
    label: z.string().trim().max(128),
    image: ReviewImageSchema,
  })
  .strict();

export const CompareModeSchema = z.enum([
  "none",
  "side-by-side",
  "overlay",
  "swipe",
  "blink",
  "diff",
]);

export const FrameComparisonSchema = z
  .object({
    mode: CompareModeSchema,
    before: ReviewVariantSchema.nullable(),
    after: ReviewVariantSchema.nullable(),
  })
  .strict()
  .superRefine((comparison, context) => {
    if (comparison.mode !== "none" && (comparison.before === null || comparison.after === null)) {
      context.addIssue({
        code: "custom",
        message: "Before and after variants are required when compare mode is enabled",
      });
    }
  });

export const ReviewFrameKindSchema = z.enum(["site-snapshot", "photo", "blank"]);

export const ReviewFrameSchema = z
  .object({
    id: FrameIdSchema,
    kind: ReviewFrameKindSchema,
    title: z.string().trim().max(REVIEW_LIMITS.titleCharacters).nullable(),
    url: z
      .string()
      .trim()
      .max(REVIEW_LIMITS.urlCharacters)
      .url()
      .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
        message: "Only HTTP(S) review URLs are supported",
      })
      .refine((value) => {
        const parsed = new URL(value);
        return parsed.username.length === 0 && parsed.password.length === 0;
      }, {
        message: "Review URLs cannot contain embedded credentials",
      })
      .nullable(),
    viewport: ViewportSchema,
    scroll: ScrollPositionSchema,
    capturedImage: ReviewImageSchema.nullable(),
    drawing: ReviewDrawingSchema.nullable(),
    photos: z.array(ReviewImageSchema).max(REVIEW_LIMITS.images),
    instruction: z.string().max(REVIEW_LIMITS.frameInstructionCharacters),
    comparison: FrameComparisonSchema,
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.kind === "site-snapshot" && frame.url === null) {
      context.addIssue({ code: "custom", message: "A site snapshot requires its URL", path: ["url"] });
    }
    if (frame.kind === "photo" && frame.capturedImage === null && frame.photos.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A photo frame requires at least one image",
        path: ["photos"],
      });
    }
  });

export const ReviewDraftSchema = z
  .object({
    version: z.literal(REVIEW_DRAFT_VERSION),
    id: ReviewIdSchema,
    targetThreadId: ReviewTargetThreadIdSchema,
    createdAt: EpochMillisSchema,
    updatedAt: EpochMillisSchema,
    generalInstruction: z.string().max(REVIEW_LIMITS.instructionCharacters),
    frames: z.array(ReviewFrameSchema).max(REVIEW_LIMITS.frames),
  })
  .strict()
  .superRefine((draft, context) => {
    const frameIds = new Set<string>();
    const imageIds = new Set<string>();
    let imageCount = 0;

    const registerImage = (image: ReviewImage, path: (string | number)[]) => {
      imageCount += 1;
      if (imageIds.has(image.id)) {
        context.addIssue({ code: "custom", message: `Duplicate image id ${image.id}`, path });
      }
      imageIds.add(image.id);
    };

    for (const [frameIndex, frame] of draft.frames.entries()) {
      if (frameIds.has(frame.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate frame id ${frame.id}`,
          path: ["frames", frameIndex, "id"],
        });
      }
      frameIds.add(frame.id);

      if (frame.capturedImage !== null) {
        registerImage(frame.capturedImage, ["frames", frameIndex, "capturedImage", "id"]);
      }
      if (frame.drawing?.renderedImage !== undefined) {
        registerImage(frame.drawing.renderedImage, ["frames", frameIndex, "drawing", "renderedImage", "id"]);
      }
      frame.photos.forEach((image, imageIndex) =>
        registerImage(image, ["frames", frameIndex, "photos", imageIndex, "id"]),
      );
      if (frame.comparison.before !== null) {
        registerImage(frame.comparison.before.image, ["frames", frameIndex, "comparison", "before", "image", "id"]);
      }
      if (frame.comparison.after !== null) {
        registerImage(frame.comparison.after.image, ["frames", frameIndex, "comparison", "after", "image", "id"]);
      }
    }

    if (imageCount > REVIEW_LIMITS.images) {
      context.addIssue({
        code: "custom",
        message: `A review may contain at most ${REVIEW_LIMITS.images} images`,
        path: ["frames"],
      });
    }

    if (draft.updatedAt < draft.createdAt) {
      context.addIssue({
        code: "custom",
        message: "updatedAt cannot precede createdAt",
        path: ["updatedAt"],
      });
    }
  });

export type ReviewId = z.infer<typeof ReviewIdSchema>;
export type ReviewTargetThreadId = z.infer<typeof ReviewTargetThreadIdSchema>;
export type ReviewImageMetadata = z.infer<typeof ReviewImageMetadataSchema>;
export type ReviewImageSource = z.infer<typeof ReviewImageSourceSchema>;
export type ReviewImage = z.infer<typeof ReviewImageSchema>;
export type ReviewDrawing = z.infer<typeof ReviewDrawingSchema>;
export type ReviewVariant = z.infer<typeof ReviewVariantSchema>;
export type CompareMode = z.infer<typeof CompareModeSchema>;
export type FrameComparison = z.infer<typeof FrameComparisonSchema>;
export type ReviewFrameKind = z.infer<typeof ReviewFrameKindSchema>;
export type ReviewFrame = z.infer<typeof ReviewFrameSchema>;
export type ReviewDraft = z.infer<typeof ReviewDraftSchema>;

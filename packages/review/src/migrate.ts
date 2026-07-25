import { migrateScene } from "@codex-pad/drawing";
import { z } from "zod";

import { REVIEW_DRAFT_VERSION } from "./constants.js";
import {
  EpochMillisSchema,
  FrameComparisonSchema,
  FrameIdSchema,
  ReviewDraftSchema,
  ReviewFrameSchema,
  ReviewFrameKindSchema,
  ReviewIdSchema,
  ReviewImageSchema,
  ReviewTargetThreadIdSchema,
  ScrollPositionSchema,
  ViewportSchema,
  type ReviewDraft,
} from "./schemas.js";

const LegacyDrawingSchema = z.union([
  z
    .object({
      scene: z.unknown(),
      renderedImage: ReviewImageSchema.optional(),
    })
    .strict(),
  z
    .object({
      drawingDraftRef: z.string().min(1).max(512),
      renderedImage: ReviewImageSchema.optional(),
    })
    .strict(),
]);

const LegacyFrameSchema = z
  .object({
    id: FrameIdSchema,
    kind: ReviewFrameKindSchema,
    title: z.string().max(512).nullish(),
    url: z.string().max(4_096).nullish(),
    viewport: ViewportSchema,
    scroll: ScrollPositionSchema,
    image: ReviewImageSchema.nullish(),
    drawing: LegacyDrawingSchema.nullish(),
    photos: z.array(ReviewImageSchema).optional(),
    instruction: z.string().max(8_000).optional(),
    before: ReviewImageSchema.nullish(),
    after: ReviewImageSchema.nullish(),
    compareMode: z
      .enum(["none", "side-by-side", "overlay", "swipe", "blink", "diff"])
      .optional(),
  })
  .strict();

const LegacyVoiceSegmentV1Schema = z
  .object({
    id: z.string().min(1).max(512),
    blobRef: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(128).startsWith("audio/"),
    durationMs: z.number().int().positive().max(2 * 60 * 60 * 1_000),
    startedAt: EpochMillisSchema.optional(),
    frameId: FrameIdSchema.optional(),
    userTranscript: z.string().max(40_000).optional(),
    browserTranscript: z.string().max(40_000).optional(),
  })
  .strict();

const LegacyReviewDraftV1Schema = z
  .object({
    version: z.literal(1),
    id: ReviewIdSchema,
    threadId: ReviewTargetThreadIdSchema,
    createdAt: EpochMillisSchema,
    updatedAt: EpochMillisSchema.optional(),
    instruction: z.string().max(20_000).optional(),
    frames: z.array(LegacyFrameSchema).max(12),
    voiceSegments: z.array(LegacyVoiceSegmentV1Schema).max(30).optional(),
  })
  .strict();

const LegacyVoiceTimelineAnchorV2Schema = z
  .object({
    frameId: FrameIdSchema,
    offsetMs: z.number().int().nonnegative().max(2 * 60 * 60 * 1_000),
  })
  .strict();

const LegacyVoiceSegmentV2Schema = z
  .object({
    id: z.string().trim().min(1).max(512),
    blobRef: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(128).startsWith("audio/"),
    durationMs: z.number().int().positive().max(2 * 60 * 60 * 1_000),
    timelineOrder: z.number().int().nonnegative().safe(),
    startedAt: EpochMillisSchema,
    anchors: z.array(LegacyVoiceTimelineAnchorV2Schema).max(48),
    userTranscript: z.string().max(40_000).optional(),
    browserTranscript: z.string().max(40_000).optional(),
  })
  .strict();

const LegacyReviewDraftV2Schema = z
  .object({
    version: z.literal(2),
    id: ReviewIdSchema,
    targetThreadId: ReviewTargetThreadIdSchema,
    createdAt: EpochMillisSchema,
    updatedAt: EpochMillisSchema,
    generalInstruction: z.string().max(20_000),
    frames: z.array(ReviewFrameSchema).max(12),
    voiceSegments: z.array(LegacyVoiceSegmentV2Schema).max(30),
  })
  .strict();

export function migrateReviewDraft(value: unknown): ReviewDraft {
  const current = ReviewDraftSchema.safeParse(value);
  if (current.success) {
    return current.data;
  }

  const previous = LegacyReviewDraftV2Schema.safeParse(value);
  if (previous.success) {
    return ReviewDraftSchema.parse({
      version: REVIEW_DRAFT_VERSION,
      id: previous.data.id,
      targetThreadId: previous.data.targetThreadId,
      createdAt: previous.data.createdAt,
      updatedAt: previous.data.updatedAt,
      generalInstruction: previous.data.generalInstruction,
      frames: previous.data.frames,
    });
  }

  const legacy = LegacyReviewDraftV1Schema.parse(value);
  const frames = legacy.frames.map((frame) => {
    const compareMode = frame.compareMode ?? "none";
    const comparison = FrameComparisonSchema.parse({
      mode: compareMode,
      before: frame.before === null || frame.before === undefined
        ? null
        : { label: "Before", image: frame.before },
      after: frame.after === null || frame.after === undefined
        ? null
        : { label: "After", image: frame.after },
    });
    const drawing = frame.drawing === null || frame.drawing === undefined
      ? null
      : "drawingDraftRef" in frame.drawing
        ? {
            kind: "drawingDraftRef" as const,
            drawingDraftRef: frame.drawing.drawingDraftRef,
            ...(frame.drawing.renderedImage === undefined
              ? {}
              : { renderedImage: frame.drawing.renderedImage }),
          }
        : {
            kind: "scene" as const,
            scene: migrateScene(frame.drawing.scene),
            ...(frame.drawing.renderedImage === undefined
              ? {}
              : { renderedImage: frame.drawing.renderedImage }),
          };

    return {
      id: frame.id,
      kind: frame.kind,
      title: frame.title ?? null,
      url: frame.url ?? null,
      viewport: frame.viewport,
      scroll: frame.scroll,
      capturedImage: frame.image ?? null,
      drawing,
      photos: frame.photos ?? [],
      instruction: frame.instruction ?? "",
      comparison,
    };
  });

  return ReviewDraftSchema.parse({
    version: REVIEW_DRAFT_VERSION,
    id: legacy.id,
    targetThreadId: legacy.threadId,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt ?? legacy.createdAt,
    generalInstruction: legacy.instruction ?? "",
    frames,
  });
}

import { z } from "zod";

import { decodedBase64Length, PngBase64Schema } from "./image.js";
import { EpochMillisSchema, SequenceSchema, ThreadIdSchema, UuidSchema } from "./primitives.js";
import { ActivityLabelSchema, SlotIndexSchema } from "./snapshot.js";
import { mapNativeStatus, VisualStatusSchema } from "./status.js";

export const MAX_SESSION_SUMMARIES = 500;
export const MAX_NATIVE_SESSION_SUMMARIES = 6;
export const MAX_SITE_ASSOCIATIONS_PER_SESSION = 64;
export const MAX_REVIEW_FRAMES = 12;
export const MAX_REVIEW_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_REVIEW_TOTAL_BYTES = 24 * 1024 * 1024;

function isDisplayOnlyHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function isOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      isDisplayOnlyHttpUrl(value) &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

/** Metadata only. Servers must never navigate to or fetch this client value. */
export const DisplayOnlyHttpUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isDisplayOnlyHttpUrl, "Expected an HTTP(S) URL without credentials");

export const SiteOriginSchema = DisplayOnlyHttpUrlSchema.refine(
  isOrigin,
  "Expected an HTTP(S) origin without a path, query, or fragment",
);

export const ReviewCapabilityStateSchema = z.enum(["available", "readOnly", "unavailable", "degraded"]);
export const SiteIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);

/**
 * Per-device PWA preference only. It grants no bridge authority: every
 * operation must still send and re-authorize the exact threadId + siteId.
 */
export const LocalSessionSiteSelectionSchema = z
  .object({
    threadId: ThreadIdSchema,
    selectedSiteId: SiteIdSchema,
  })
  .strict();

/** Stable, opaque identity derived from a normalized absolute project cwd. */
export const ProjectIdSchema = z
  .string()
  .regex(/^project:[A-Za-z0-9_-]{43}$/u, "Expected an opaque project identifier");

export const ReviewCapabilitiesSchema = z
  .object({
    state: ReviewCapabilityStateSchema,
    canCaptureFrames: z.boolean(),
    canSendReview: z.boolean(),
    supportsInlinePng: z.boolean(),
    supportsUploadRefs: z.boolean(),
    maxFrames: z.number().int().min(1).max(MAX_REVIEW_FRAMES),
    maxFrameBytes: z.number().int().min(1).max(MAX_REVIEW_FRAME_BYTES),
    maxTotalBytes: z.number().int().min(1).max(MAX_REVIEW_TOTAL_BYTES),
    reason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const RemoteBrowserAssociationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.literal("thread-tab-mapping-unproven"),
      detail: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      status: z.literal("experimental"),
      reason: z.literal("thread-tab-mapping-proven-for-session"),
      detail: z.string().trim().min(1).max(512),
      proofId: z.string().trim().min(1).max(128),
    })
    .strict(),
]);

export const SiteInteractionModesSchema = z
  .object({
    selected: z.literal("none"),
    direct: z
      .object({
        status: z.literal("unavailable"),
        reason: z.literal("same-host-storage-boundary"),
        detail: z.string().trim().min(1).max(512),
      })
      .strict(),
    remoteBrowser: z
      .object({
        status: z.literal("unavailable"),
        reason: z.enum([
          "thread-tab-mapping-unproven",
          "typed-remote-browser-transport-unavailable",
        ]),
        detail: z.string().trim().min(1).max(512),
        association: RemoteBrowserAssociationSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((modes, context) => {
    const expectedReason = modes.remoteBrowser.association.status === "unavailable"
      ? "thread-tab-mapping-unproven"
      : "typed-remote-browser-transport-unavailable";
    if (modes.remoteBrowser.reason !== expectedReason) {
      context.addIssue({
        code: "custom",
        message: "Remote browser availability must match its association and typed transport",
        path: ["remoteBrowser", "reason"],
      });
    }
  });

export const SiteAssociationSchema = z
  .object({
    associationId: SiteIdSchema,
    threadId: ThreadIdSchema,
    /** Present only when this session-visible association comes from project scope. */
    projectId: ProjectIdSchema.nullable(),
    name: z.string().trim().min(1).max(200),
    origin: SiteOriginSchema,
    createdAt: EpochMillisSchema,
    updatedAt: EpochMillisSchema,
    capabilities: ReviewCapabilitiesSchema,
    interactionModes: SiteInteractionModesSchema,
  })
  .strict()
  .superRefine((association, context) => {
    if (association.updatedAt < association.createdAt) {
      context.addIssue({
        code: "custom",
        message: "updatedAt cannot precede createdAt",
        path: ["updatedAt"],
      });
    }
  });

export const ProjectLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => value !== "." && value !== "..", "Expected a project display label")
  .refine((value) => !/[\\/\u0000-\u001f\u007f]/.test(value), "Project labels cannot contain paths or control characters");

function compareSiteAssociations(
  left: z.infer<typeof SiteAssociationSchema>,
  right: z.infer<typeof SiteAssociationSchema>,
): number {
  const leftScope = left.projectId === null ? 0 : 1;
  const rightScope = right.projectId === null ? 0 : 1;
  if (leftScope !== rightScope) return leftScope - rightScope;
  const leftName = left.name.normalize("NFC");
  const rightName = right.name.normalize("NFC");
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  return left.associationId < right.associationId
    ? -1
    : left.associationId > right.associationId ? 1 : 0;
}

export const SessionSummarySchema = z
  .object({
    threadId: ThreadIdSchema,
    title: z.string().trim().min(1).max(500).nullable(),
    nativeStatus: z.string().trim().min(1).max(128),
    visualStatus: VisualStatusSchema,
    activityLabel: ActivityLabelSchema,
    activityAt: EpochMillisSchema.nullable(),
    projectId: ProjectIdSchema.nullable(),
    projectLabel: ProjectLabelSchema.nullable(),
    selected: z.boolean(),
    microSlot: SlotIndexSchema.nullable(),
    ownedByHost: z.boolean(),
    siteAssociations: z.array(SiteAssociationSchema).max(MAX_SITE_ASSOCIATIONS_PER_SESSION),
    /** Temporary deterministic compatibility projection of siteAssociations[0]. */
    siteAssociation: SiteAssociationSchema.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    if ((session.projectId === null) !== (session.projectLabel === null)) {
      context.addIssue({
        code: "custom",
        message: "projectId and projectLabel must either both be present or both be null",
        path: [session.projectId === null ? "projectId" : "projectLabel"],
      });
    }
    const seenSiteIds = new Set<string>();
    session.siteAssociations.forEach((association, index) => {
      if (association.threadId !== session.threadId) {
        context.addIssue({
          code: "custom",
          message: "Every site association must belong to this exact thread",
          path: ["siteAssociations", index, "threadId"],
        });
      }
      if (association.projectId !== null && association.projectId !== session.projectId) {
        context.addIssue({
          code: "custom",
          message: "A project-scoped site association must match the session's opaque project identifier",
          path: ["siteAssociations", index, "projectId"],
        });
      }
      if (seenSiteIds.has(association.associationId)) {
        context.addIssue({
          code: "custom",
          message: "Site association IDs must be unique within one session",
          path: ["siteAssociations", index, "associationId"],
        });
      }
      seenSiteIds.add(association.associationId);
      const previous = session.siteAssociations[index - 1];
      if (previous !== undefined && compareSiteAssociations(previous, association) > 0) {
        context.addIssue({
          code: "custom",
          message: "Site associations must be ordered by thread scope, normalized label, then stable id",
          path: ["siteAssociations", index],
        });
      }
    });
    const defaultAssociation = session.siteAssociations[0] ?? null;
    if (
      (defaultAssociation === null) !== (session.siteAssociation === null)
      || (
        defaultAssociation !== null
        && session.siteAssociation !== null
        && JSON.stringify(defaultAssociation) !== JSON.stringify(session.siteAssociation)
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "siteAssociation must exactly mirror the deterministic first siteAssociations item",
        path: ["siteAssociation"],
      });
    }
    if (session.visualStatus !== mapNativeStatus(session.nativeStatus)) {
      context.addIssue({
        code: "custom",
        message: "visualStatus must be the safe mapping of nativeStatus",
        path: ["visualStatus"],
      });
    }
  });

export const AllSessionsResponseSchema = z
  .object({
    sequence: SequenceSchema,
    timestamp: EpochMillisSchema,
    sessions: z.array(SessionSummarySchema).max(MAX_SESSION_SUMMARIES),
  })
  .strict()
  .superRefine((response, context) => {
    const seenThreadIds = new Set<string>();
    response.sessions.forEach((session, index) => {
      if (seenThreadIds.has(session.threadId)) {
        context.addIssue({
          code: "custom",
          message: "Session thread IDs must be unique",
          path: ["sessions", index, "threadId"],
        });
      }
      seenThreadIds.add(session.threadId);
    });
  });

export const SessionListResponseSchema = AllSessionsResponseSchema;

export const NativeSessionsResponseSchema = z
  .object({
    sequence: SequenceSchema,
    timestamp: EpochMillisSchema,
    registryGeneration: z.number().int().nonnegative().safe(),
    sessions: z.array(SessionSummarySchema).max(MAX_NATIVE_SESSION_SUMMARIES),
  })
  .strict()
  .superRefine((response, context) => {
    const seenThreadIds = new Set<string>();
    const seenMicroSlots = new Set<number>();
    response.sessions.forEach((session, index) => {
      if (session.microSlot === null) {
        context.addIssue({
          code: "custom",
          message: "Native sessions must occupy a current micro slot",
          path: ["sessions", index, "microSlot"],
        });
      } else if (seenMicroSlots.has(session.microSlot)) {
        context.addIssue({
          code: "custom",
          message: "Native session micro slots must be unique",
          path: ["sessions", index, "microSlot"],
        });
      } else {
        seenMicroSlots.add(session.microSlot);
      }
      if (seenThreadIds.has(session.threadId)) {
        context.addIssue({
          code: "custom",
          message: "Native session thread IDs must be unique",
          path: ["sessions", index, "threadId"],
        });
      }
      seenThreadIds.add(session.threadId);
    });
  });

export const ReviewImageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inlinePng"),
      png: PngBase64Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("uploadRef"),
      /** Opaque reference issued by the bridge; never a filesystem path. */
      uploadId: UuidSchema,
      byteLength: z.number().int().min(1).max(MAX_REVIEW_FRAME_BYTES),
    })
    .strict(),
]);

export const ReviewViewportSchema = z
  .object({
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    devicePixelRatio: z.number().min(0.5).max(8),
  })
  .strict();

export const ReviewScrollSchema = z
  .object({
    x: z.number().finite().min(0).max(10_000_000),
    y: z.number().finite().min(0).max(10_000_000),
    documentWidth: z.number().finite().min(1).max(10_000_000),
    documentHeight: z.number().finite().min(1).max(10_000_000),
  })
  .strict();

export const ReviewFrameKindSchema = z.enum(["siteSnapshot", "photo", "blank"]);

export const ReviewFrameSchema = z
  .object({
    frameId: UuidSchema,
    index: z.number().int().min(0).max(MAX_REVIEW_FRAMES - 1),
    kind: ReviewFrameKindSchema,
    image: ReviewImageSchema,
    url: DisplayOnlyHttpUrlSchema.nullable(),
    title: z.string().trim().min(1).max(500).nullable(),
    viewport: ReviewViewportSchema,
    scroll: ReviewScrollSchema,
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.kind === "siteSnapshot" && frame.url === null) {
      context.addIssue({
        code: "custom",
        message: "A siteSnapshot frame requires URL metadata",
        path: ["url"],
      });
    }
    if (frame.kind !== "siteSnapshot" && frame.url !== null) {
      context.addIssue({
        code: "custom",
        message: "Only siteSnapshot frames may contain URL metadata",
        path: ["url"],
      });
    }
  });

export const OrderedReviewFramesSchema = z
  .array(ReviewFrameSchema)
  .min(1)
  .max(MAX_REVIEW_FRAMES)
  .superRefine((frames, context) => {
    const frameIds = new Set<string>();
    let totalImageBytes = 0;

    frames.forEach((frame, index) => {
      if (frame.index !== index) {
        context.addIssue({
          code: "custom",
          message: `Expected frame index ${index}`,
          path: [index, "index"],
        });
      }
      if (frameIds.has(frame.frameId)) {
        context.addIssue({
          code: "custom",
          message: "Frame IDs must be unique",
          path: [index, "frameId"],
        });
      }
      frameIds.add(frame.frameId);

      if (frame.image.kind === "inlinePng") {
        const frameBytes = decodedBase64Length(frame.image.png);
        if (frameBytes > MAX_REVIEW_FRAME_BYTES) {
          context.addIssue({
            code: "custom",
            message: "Frame image exceeds the per-frame limit",
            path: [index, "image", "png"],
          });
        }
        totalImageBytes += frameBytes;
      } else {
        totalImageBytes += frame.image.byteLength;
      }
    });

    if (totalImageBytes > MAX_REVIEW_TOTAL_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Review images exceed the total payload limit",
      });
    }
  });

export type DisplayOnlyHttpUrl = z.infer<typeof DisplayOnlyHttpUrlSchema>;
export type ReviewCapabilityState = z.infer<typeof ReviewCapabilityStateSchema>;
export type ReviewCapabilities = z.infer<typeof ReviewCapabilitiesSchema>;
export type SiteId = z.infer<typeof SiteIdSchema>;
export type LocalSessionSiteSelection = z.infer<typeof LocalSessionSiteSelectionSchema>;
export type RemoteBrowserAssociation = z.infer<typeof RemoteBrowserAssociationSchema>;
export type SiteInteractionModes = z.infer<typeof SiteInteractionModesSchema>;
export type SiteAssociation = z.infer<typeof SiteAssociationSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type ProjectLabel = z.infer<typeof ProjectLabelSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type AllSessionsResponse = z.infer<typeof AllSessionsResponseSchema>;
export type SessionListResponse = AllSessionsResponse;
export type NativeSessionsResponse = z.infer<typeof NativeSessionsResponseSchema>;
export type ReviewImage = z.infer<typeof ReviewImageSchema>;
export type ReviewViewport = z.infer<typeof ReviewViewportSchema>;
export type ReviewScroll = z.infer<typeof ReviewScrollSchema>;
export type ReviewFrameKind = z.infer<typeof ReviewFrameKindSchema>;
export type ReviewFrame = z.infer<typeof ReviewFrameSchema>;
export type OrderedReviewFrames = z.infer<typeof OrderedReviewFramesSchema>;

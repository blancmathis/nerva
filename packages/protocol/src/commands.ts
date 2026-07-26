import { z } from "zod";

import { PngBase64Schema } from "./image.js";
import { CommandIdSchema, EpochMillisSchema, SequenceSchema, ThreadIdSchema } from "./primitives.js";
import { OrderedReviewFramesSchema } from "./review.js";
import {
  JoystickDirectionSchema,
  JoystickAssignmentIdentitySchema,
  KeycapIdSchema,
  MicroActionSlotSchema,
  NativeCommandIdSchema,
  ReasoningEffortSchema,
  ApprovalItemIdSchema,
  ApprovalKindSchema,
  ApprovalRequestIdSchema,
  BridgeInstanceIdSchema,
  SlotIndexSchema,
} from "./snapshot.js";

export { MAX_SKETCH_BASE64_LENGTH, MAX_SKETCH_BYTES, PngBase64Schema } from "./image.js";

const ShortInstructionSchema = z.string().trim().min(1).max(2_000);
const OptionalSketchInstructionSchema = z.string().trim().max(2_000);

export const ReviewInstructionSchema = z.string().trim().min(1).max(8_000);

export const LibraryIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected an opaque library identifier");

export const LibraryCommandIdSchema = LibraryIdSchema;

export const LibraryPromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_000)
  .refine((value) => !/[\u0000\u000b\u000c]/.test(value), "Prompt contains unsupported control characters");

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:-]*$/, "Expected an allowlisted skill name");

const CommandMetadataShape = {
  commandId: CommandIdSchema,
  expectedBridgeInstanceId: BridgeInstanceIdSchema,
  expectedSequence: SequenceSchema,
  expectedThreadId: ThreadIdSchema.nullable(),
} as const;

export const CommandMetadataSchema = z.object(CommandMetadataShape).strict();

export const SelectAgentCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("selectAgent"),
    slot: SlotIndexSchema,
    expectedThreadId: ThreadIdSchema,
  })
  .strict();

export const RunMicroActionCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("runMicroAction"),
    slot: SlotIndexSchema,
    actionSlot: MicroActionSlotSchema,
    expectedKeycapId: KeycapIdSchema,
    expectedNativeCommandId: NativeCommandIdSchema.nullable(),
    expectedThreadId: ThreadIdSchema,
    gesture: z.enum(["tap", "begin", "end"]).optional(),
    gestureId: CommandIdSchema.nullable().optional(),
  })
  .strict()
  .superRefine((command, context) => {
    const gesture = command.gesture ?? "tap";
    if (gesture === "tap") {
      if (command.gestureId !== undefined && command.gestureId !== null) {
        context.addIssue({ code: "custom", message: "Tap actions cannot carry a gestureId", path: ["gestureId"] });
      }
      return;
    }
    if (
      command.actionSlot !== "ACT10_ACT11"
      || command.expectedKeycapId !== "MIC"
      || (command.expectedNativeCommandId !== "dictation.toggle" && command.expectedNativeCommandId !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only the exact native Dictation action can use begin/end gestures",
        path: ["gesture"],
      });
    }
    if (command.gestureId === undefined || command.gestureId === null) {
      context.addIssue({ code: "custom", message: "A begin/end gesture requires a gestureId", path: ["gestureId"] });
    } else if (gesture === "begin" && command.gestureId !== command.commandId) {
      context.addIssue({ code: "custom", message: "A begin gesture must bind its own commandId", path: ["gestureId"] });
    } else if (gesture === "end" && command.gestureId === command.commandId) {
      context.addIssue({ code: "custom", message: "An end gesture must reference the accepted begin command", path: ["gestureId"] });
    }
  });

export const RunJoystickActionCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("runJoystickAction"),
    direction: JoystickDirectionSchema,
    expectedAssignment: JoystickAssignmentIdentitySchema,
    expectedThreadId: ThreadIdSchema,
  })
  .strict();

export const ReasoningAdjustmentSchema = z.enum(["increase", "decrease"]);

export const AdjustReasoningCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("adjustReasoning"),
    adjustment: ReasoningAdjustmentSchema,
    expectedThreadId: ThreadIdSchema,
  })
  .strict();

export const SetModelReasoningCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("setModelReasoning"),
    expectedThreadId: ThreadIdSchema,
    model: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/u),
    effort: ReasoningEffortSchema,
  })
  .strict();

export const ApprovalDecisionSchema = z.enum(["accept", "decline"]);

export const RespondToApprovalCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("respondToApproval"),
    expectedThreadId: ThreadIdSchema,
    requestId: ApprovalRequestIdSchema,
    turnId: ThreadIdSchema,
    itemId: ApprovalItemIdSchema,
    approvalKind: ApprovalKindSchema,
    decision: ApprovalDecisionSchema,
  })
  .strict();

export const CreateTaskCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("createTask"),
    instruction: ShortInstructionSchema.nullable(),
  })
  .strict();

const LegacySendSketchCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("sendSketch"),
    targetThreadId: ThreadIdSchema,
    expectedThreadId: ThreadIdSchema,
    instruction: OptionalSketchInstructionSchema,
    png: PngBase64Schema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.targetThreadId !== command.expectedThreadId) {
      context.addIssue({
        code: "custom",
        message: "targetThreadId must match expectedThreadId",
        path: ["targetThreadId"],
      });
    }
  });

export const SketchExportScopeSchema = z.enum(["board", "area"]);
export const SketchExportQualitySchema = z.enum(["good", "reduced", "overview-detail"]);
export const SketchImageSchema = z.object({
  fileName: z.string().min(1).max(120).regex(/^Nerva Board [A-Za-z0-9._ -]+\.png$/u),
  png: PngBase64Schema,
  kind: z.enum(["overview", "detail", "atlas"]),
  tileNumber: z.number().int().min(1).max(12),
}).strict();
export const SketchTileManifestSchema = z.object({
  version: z.literal(1),
  quality: SketchExportQualitySchema,
  overlap: z.number().min(0).max(0.25),
  tiles: z.array(z.object({
    tileNumber: z.number().int().min(1).max(12),
    kind: z.enum(["overview", "detail", "atlas"]),
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
  }).strict()).min(1).max(12),
}).strict();

const TiledSendSketchCommandSchema = z.object({
  ...CommandMetadataShape,
  type: z.literal("sendSketch"),
  version: z.literal(2),
  targetThreadId: ThreadIdSchema,
  expectedThreadId: ThreadIdSchema,
  instruction: z.literal(""),
  boardId: z.string().uuid(),
  checkpointId: z.string().uuid(),
  scope: SketchExportScopeSchema,
  images: z.array(SketchImageSchema).min(1).max(12),
  manifest: SketchTileManifestSchema,
}).strict().superRefine((command, context) => {
  if (command.targetThreadId !== command.expectedThreadId) {
    context.addIssue({ code: "custom", message: "targetThreadId must match expectedThreadId", path: ["targetThreadId"] });
  }
  if (new Set(command.images.map((image) => image.fileName)).size !== command.images.length) {
    context.addIssue({ code: "custom", message: "image filenames must be unique", path: ["images"] });
  }
  if (command.manifest.tiles.length !== command.images.length) {
    context.addIssue({ code: "custom", message: "manifest tiles must match ordered images", path: ["manifest", "tiles"] });
  }
});

export const SendSketchCommandSchema = z.union([
  LegacySendSketchCommandSchema,
  TiledSendSketchCommandSchema,
]);

export const AcknowledgeCompletionCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("acknowledgeCompletion"),
    targetThreadId: ThreadIdSchema,
    expectedThreadId: ThreadIdSchema,
    completionRevision: z.number().int().nonnegative().safe().nullable(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.targetThreadId !== command.expectedThreadId) {
      context.addIssue({
        code: "custom",
        message: "targetThreadId must match expectedThreadId",
        path: ["targetThreadId"],
      });
    }
  });

export const SendReviewCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("sendReview"),
    targetThreadId: ThreadIdSchema,
    expectedThreadId: ThreadIdSchema,
    snapshotSeq: SequenceSchema,
    instruction: ReviewInstructionSchema,
    frames: OrderedReviewFramesSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.targetThreadId !== command.expectedThreadId) {
      context.addIssue({
        code: "custom",
        message: "targetThreadId must match expectedThreadId",
        path: ["targetThreadId"],
      });
    }
    if (command.snapshotSeq !== command.expectedSequence) {
      context.addIssue({
        code: "custom",
        message: "snapshotSeq must match expectedSequence",
        path: ["snapshotSeq"],
      });
    }
  });

export const RunLibraryCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("runLibraryCommand"),
    targetThreadId: ThreadIdSchema,
    expectedThreadId: ThreadIdSchema,
    snapshotSeq: SequenceSchema,
    libraryId: LibraryIdSchema,
    libraryCommandId: LibraryCommandIdSchema,
    prompt: LibraryPromptSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.targetThreadId !== command.expectedThreadId) {
      context.addIssue({
        code: "custom",
        message: "targetThreadId must match expectedThreadId",
        path: ["targetThreadId"],
      });
    }
    if (command.snapshotSeq !== command.expectedSequence) {
      context.addIssue({
        code: "custom",
        message: "snapshotSeq must match expectedSequence",
        path: ["snapshotSeq"],
      });
    }
  });

export const OpenSessionCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("openSession"),
    targetThreadId: ThreadIdSchema,
    expectedThreadId: ThreadIdSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.targetThreadId !== command.expectedThreadId) {
      context.addIssue({
        code: "custom",
        message: "targetThreadId must match expectedThreadId",
        path: ["targetThreadId"],
      });
    }
  });

export const RunSkillCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("runSkill"),
    targetThreadId: ThreadIdSchema,
    expectedThreadId: ThreadIdSchema,
    skillName: SkillNameSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.targetThreadId !== command.expectedThreadId) {
      context.addIssue({
        code: "custom",
        message: "targetThreadId must match expectedThreadId",
        path: ["targetThreadId"],
      });
    }
  });

export const RefreshSnapshotCommandSchema = z
  .object({
    ...CommandMetadataShape,
    type: z.literal("refreshSnapshot"),
    lastKnownSequence: SequenceSchema,
  })
  .strict();

export const CommandSchema = z.union([
  SelectAgentCommandSchema,
  RunMicroActionCommandSchema,
  RunJoystickActionCommandSchema,
  AdjustReasoningCommandSchema,
  SetModelReasoningCommandSchema,
  RespondToApprovalCommandSchema,
  CreateTaskCommandSchema,
  SendSketchCommandSchema,
  AcknowledgeCompletionCommandSchema,
  SendReviewCommandSchema,
  RunLibraryCommandSchema,
  OpenSessionCommandSchema,
  RunSkillCommandSchema,
  RefreshSnapshotCommandSchema,
]);

export const CommandRequestSchema = z
  .object({
    command: CommandSchema,
  })
  .strict();

export const CommandExecutionStatusSchema = z.enum(["inFlight", "succeeded", "failed", "unknown"]);
export const CommandAckDispositionSchema = z.enum(["accepted", "duplicate"]);

export const CommandErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  })
  .strict();

export const CommandResultSchema = z
  .object({
    sequence: SequenceSchema,
    targetThreadId: ThreadIdSchema.nullable(),
    message: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const CommandAckSchema = z
  .object({
    commandId: CommandIdSchema,
    disposition: CommandAckDispositionSchema,
    status: z.enum(["inFlight", "succeeded", "failed"]),
    sequence: SequenceSchema,
    targetThreadId: ThreadIdSchema.nullable(),
    error: CommandErrorSchema.nullable(),
  })
  .strict()
  .superRefine((ack, context) => {
    if (ack.status === "failed" && ack.error === null) {
      context.addIssue({
        code: "custom",
        message: "A failed command requires an error",
        path: ["error"],
      });
    }
    if (ack.status === "succeeded" && ack.error !== null) {
      context.addIssue({ code: "custom", message: "A succeeded command cannot contain an error", path: ["error"] });
    }
    if (ack.status === "inFlight" && ack.error !== null && !ack.error.retryable) {
      context.addIssue({ code: "custom", message: "An in-flight delivery warning must be retryable", path: ["error"] });
    }
  });

/** Result of GET /api/commands/:commandId after an iPad reconnect. */
export const CommandStatusResponseSchema = z
  .object({
    commandId: CommandIdSchema,
    status: CommandExecutionStatusSchema,
    sequence: SequenceSchema,
    targetThreadId: ThreadIdSchema.nullable(),
    result: CommandResultSchema.nullable(),
    error: CommandErrorSchema.nullable(),
    updatedAt: EpochMillisSchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.status === "failed" && response.error === null) {
      context.addIssue({ code: "custom", message: "A failed command requires an error", path: ["error"] });
    }
    if (["succeeded", "unknown"].includes(response.status) && response.error !== null) {
      context.addIssue({ code: "custom", message: "Succeeded and unknown commands cannot contain an error", path: ["error"] });
    }
    if (response.status === "inFlight" && response.error !== null && !response.error.retryable) {
      context.addIssue({ code: "custom", message: "An in-flight delivery warning must be retryable", path: ["error"] });
    }
    if (response.status === "unknown" && response.result !== null) {
      context.addIssue({ code: "custom", message: "An unknown command cannot have a result", path: ["result"] });
    }
  });

export const CommandReconciliationSchema = CommandStatusResponseSchema;

export type LibraryId = z.infer<typeof LibraryIdSchema>;
export type LibraryCommandId = z.infer<typeof LibraryCommandIdSchema>;
export type LibraryPrompt = z.infer<typeof LibraryPromptSchema>;
export type ReviewInstruction = z.infer<typeof ReviewInstructionSchema>;
export type SkillName = z.infer<typeof SkillNameSchema>;
export type CommandMetadata = z.infer<typeof CommandMetadataSchema>;
export type SelectAgentCommand = z.infer<typeof SelectAgentCommandSchema>;
export type RunMicroActionCommand = z.infer<typeof RunMicroActionCommandSchema>;
export type RunJoystickActionCommand = z.infer<typeof RunJoystickActionCommandSchema>;
export type ReasoningAdjustment = z.infer<typeof ReasoningAdjustmentSchema>;
export type AdjustReasoningCommand = z.infer<typeof AdjustReasoningCommandSchema>;
export type SetModelReasoningCommand = z.infer<typeof SetModelReasoningCommandSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type RespondToApprovalCommand = z.infer<typeof RespondToApprovalCommandSchema>;
export type CreateTaskCommand = z.infer<typeof CreateTaskCommandSchema>;
export type SendSketchCommand = z.infer<typeof SendSketchCommandSchema>;
export type AcknowledgeCompletionCommand = z.infer<typeof AcknowledgeCompletionCommandSchema>;
export type SendReviewCommand = z.infer<typeof SendReviewCommandSchema>;
export type RunLibraryCommand = z.infer<typeof RunLibraryCommandSchema>;
export type OpenSessionCommand = z.infer<typeof OpenSessionCommandSchema>;
export type RunSkillCommand = z.infer<typeof RunSkillCommandSchema>;
export type RefreshSnapshotCommand = z.infer<typeof RefreshSnapshotCommandSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type CommandRequest = z.infer<typeof CommandRequestSchema>;
export type CommandExecutionStatus = z.infer<typeof CommandExecutionStatusSchema>;
export type CommandAckDisposition = z.infer<typeof CommandAckDispositionSchema>;
export type CommandError = z.infer<typeof CommandErrorSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type CommandAck = z.infer<typeof CommandAckSchema>;
export type CommandStatusResponse = z.infer<typeof CommandStatusResponseSchema>;
export type CommandReconciliation = CommandStatusResponse;

import { z } from "zod";

import { EpochMillisSchema, SequenceSchema, ThreadIdSchema, UuidSchema } from "./primitives.js";
import { mapNativeStatus, VisualStatusSchema } from "./status.js";

export const SlotIndexSchema = z.number().int().min(0).max(5);

/** Unique to one running bridge generation; it rotates whenever the bridge restarts. */
export const BridgeInstanceIdSchema = UuidSchema;

/** Renderer activity text can contain prompt or dictation content and never crosses the bridge. */
export const ActivityLabelSchema = z.null();

export const BridgeHealthStateSchema = z.enum([
  "live",
  "reconnecting",
  "stale",
  "offline",
  "degraded",
]);

export const BridgeHealthSchema = z
  .object({
    state: BridgeHealthStateSchema,
    reason: z.string().trim().min(1).max(500).nullable(),
    changedAt: EpochMillisSchema,
    lastSuccessfulRefreshAt: EpochMillisSchema.nullable(),
  })
  .strict();

export const ThemeSchema = z.enum(["light", "dark"]);
export const ThemeModeSchema = ThemeSchema;
export const AgentSourceSchema = z.enum(["pinned", "recent", "priority", "custom"]);
export const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);

export const ApprovalRequestIdSchema = z.union([
  z.number().int().safe(),
  z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/, "Control characters are not allowed"),
]);

export const ApprovalKindSchema = z.enum(["commandExecution", "fileChange", "permissions"]);

export const ApprovalItemIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Control characters are not allowed");

export const PendingApprovalSchema = z
  .object({
    requestId: ApprovalRequestIdSchema,
    threadId: ThreadIdSchema,
    turnId: ThreadIdSchema,
    itemId: ApprovalItemIdSchema,
    kind: ApprovalKindSchema,
    actionable: z.boolean(),
    summary: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const NativeReasoningStateSchema = z
  .object({
    effort: ReasoningEffortSchema,
    adjustable: z.boolean(),
  })
  .strict();

export const AgentSlotSchema = z
  .object({
    slot: SlotIndexSchema,
    threadId: ThreadIdSchema.nullable(),
    title: z.string().trim().min(1).max(500).nullable(),
    activityLabel: ActivityLabelSchema,
    nativeStatus: z.string().trim().min(1).max(128),
    visualStatus: VisualStatusSchema,
    selected: z.boolean(),
    activityAt: EpochMillisSchema.nullable(),
    ownedByHost: z.boolean(),
  })
  .strict()
  .superRefine((slot, context) => {
    if (slot.selected && slot.threadId === null) {
      context.addIssue({
        code: "custom",
        message: "A selected slot must have a threadId",
        path: ["threadId"],
      });
    }
    if (slot.visualStatus !== mapNativeStatus(slot.nativeStatus)) {
      context.addIssue({
        code: "custom",
        message: "visualStatus must be the safe mapping of nativeStatus",
        path: ["visualStatus"],
      });
    }
  });

const AssignmentTextSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Control characters are not allowed");

export const KeycapIdSchema = AssignmentTextSchema;
export const NativeCommandIdSchema = AssignmentTextSchema;

export const ActionAssignmentSchema = z
  .object({
    keycapId: AssignmentTextSchema.nullable(),
    nativeCommandId: NativeCommandIdSchema.nullable(),
    label: z.string().trim().min(1).max(100).nullable(),
    enabled: z.boolean(),
  })
  .strict();

export const JoystickAssignmentIdentitySchema = z
  .object({
    type: z.literal("command"),
    commandId: NativeCommandIdSchema,
  })
  .strict();

export const JoystickAssignmentSchema = z.union([
  z
    .object({
      type: z.literal("command"),
      commandId: NativeCommandIdSchema,
      label: z.string().trim().min(1).max(100).nullable(),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.null(),
      commandId: z.null(),
      label: z.null(),
      enabled: z.literal(false),
    })
    .strict(),
]);

export const MicroActionSlotSchema = z.enum([
  "ACT06",
  "ACT07",
  "ACT08",
  "ACT09",
  "ACT10_ACT11",
  "ACT12",
]);

export const JoystickDirectionSchema = z.enum(["up", "right", "down", "left"]);

export const ActionAssignmentsSchema = z
  .object({
    micro: z
      .object({
        ACT06: ActionAssignmentSchema,
        ACT07: ActionAssignmentSchema,
        ACT08: ActionAssignmentSchema,
        ACT09: ActionAssignmentSchema,
        ACT10_ACT11: ActionAssignmentSchema,
        ACT12: ActionAssignmentSchema,
      })
      .strict(),
    joystick: z
      .object({
        up: JoystickAssignmentSchema,
        right: JoystickAssignmentSchema,
        down: JoystickAssignmentSchema,
        left: JoystickAssignmentSchema,
      })
      .strict(),
  })
  .strict();

const SixSlotTupleSchema = z.tuple([
  AgentSlotSchema,
  AgentSlotSchema,
  AgentSlotSchema,
  AgentSlotSchema,
  AgentSlotSchema,
  AgentSlotSchema,
]);

export const SixAgentSlotsSchema = SixSlotTupleSchema.superRefine((slots, context) => {
  slots.forEach((slot, index) => {
    if (slot.slot !== index) {
      context.addIssue({
        code: "custom",
        message: `Expected slot index ${index}`,
        path: [index, "slot"],
      });
    }
  });
});

export const MicroSnapshotSchema = z
  .object({
    bridgeInstanceId: BridgeInstanceIdSchema,
    sequence: SequenceSchema,
    timestamp: EpochMillisSchema,
    codexVersion: z.string().trim().min(1).max(100).nullable(),
    bridgeHealth: BridgeHealthSchema,
    agentSource: AgentSourceSchema,
    slots: SixAgentSlotsSchema,
    actionAssignments: ActionAssignmentsSchema,
    /**
     * Exact task currently observed in Codex Desktop. This is navigation state,
     * not mutation authority, and the task may be outside the native six.
     */
    activeThreadId: ThreadIdSchema.nullable().default(null),
    selectedThreadId: ThreadIdSchema.nullable(),
    /** Exact app-server identities only; no approval is inferred from native labels. */
    pendingApprovals: z.array(PendingApprovalSchema).max(16).default([]),
    reasoning: NativeReasoningStateSchema.nullable(),
    theme: ThemeSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const selectedSlots = snapshot.slots.filter((slot) => slot.selected);

    if (selectedSlots.length > 1) {
      context.addIssue({
        code: "custom",
        message: "At most one agent slot may be selected",
        path: ["slots"],
      });
      return;
    }

    const selectedSlot = selectedSlots[0];
    if (selectedSlot === undefined && snapshot.selectedThreadId !== null) {
      context.addIssue({
        code: "custom",
        message: "selectedThreadId requires a selected slot",
        path: ["selectedThreadId"],
      });
    } else if (selectedSlot !== undefined && selectedSlot.threadId !== snapshot.selectedThreadId) {
      context.addIssue({
        code: "custom",
        message: "selectedThreadId must match the selected slot",
        path: ["selectedThreadId"],
      });
    }

    const requestIds = new Set<string>();
    snapshot.pendingApprovals.forEach((approval, index) => {
      if (snapshot.selectedThreadId === null || approval.threadId !== snapshot.selectedThreadId) {
        context.addIssue({
          code: "custom",
          message: "A pending approval must belong to the exact selected thread",
          path: ["pendingApprovals", index, "threadId"],
        });
      }
      const requestKey = `${typeof approval.requestId}:${String(approval.requestId)}`;
      if (requestIds.has(requestKey)) {
        context.addIssue({
          code: "custom",
          message: "Pending approval request identities must be unique",
          path: ["pendingApprovals", index, "requestId"],
        });
      }
      requestIds.add(requestKey);
    });
  });

export type SlotIndex = z.infer<typeof SlotIndexSchema>;
export type BridgeInstanceId = z.infer<typeof BridgeInstanceIdSchema>;
export type ActivityLabel = z.infer<typeof ActivityLabelSchema>;
export type BridgeHealthState = z.infer<typeof BridgeHealthStateSchema>;
export type BridgeHealth = z.infer<typeof BridgeHealthSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type ThemeMode = Theme;
export type AgentSource = z.infer<typeof AgentSourceSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ApprovalRequestId = z.infer<typeof ApprovalRequestIdSchema>;
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;
export type ApprovalItemId = z.infer<typeof ApprovalItemIdSchema>;
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;
export type NativeReasoningState = z.infer<typeof NativeReasoningStateSchema>;
export type AgentSlot = z.infer<typeof AgentSlotSchema>;
export type MicroActionSlot = z.infer<typeof MicroActionSlotSchema>;
export type KeycapId = z.infer<typeof KeycapIdSchema>;
export type NativeCommandId = z.infer<typeof NativeCommandIdSchema>;
export type JoystickDirection = z.infer<typeof JoystickDirectionSchema>;
export type ActionAssignment = z.infer<typeof ActionAssignmentSchema>;
export type JoystickAssignmentIdentity = z.infer<typeof JoystickAssignmentIdentitySchema>;
export type JoystickAssignment = z.infer<typeof JoystickAssignmentSchema>;
export type ActionAssignments = z.infer<typeof ActionAssignmentsSchema>;
export type SixAgentSlots = z.infer<typeof SixAgentSlotsSchema>;
export type MicroSnapshot = z.infer<typeof MicroSnapshotSchema>;

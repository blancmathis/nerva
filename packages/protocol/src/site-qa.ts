import { z } from "zod";

import { EpochMillisSchema, ThreadIdSchema, UuidSchema } from "./primitives.js";

export const MAX_SITE_QA_STEPS = 100;
export const MAX_SITE_QA_ISSUES = 24;
export const MAX_SITE_QA_DURATION_MS = 10 * 60 * 1_000;

const BoundedTextSchema = z.string().max(160).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u);
const NullableBoundedTextSchema = BoundedTextSchema.nullable();

export const SiteQaPointSchema = z.object({
  x: z.number().min(0).max(8_192),
  y: z.number().min(0).max(8_192),
}).strict();

export const SiteQaRecordedActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number().min(0).max(8_192), y: z.number().min(0).max(8_192) }).strict(),
  z.object({
    type: z.literal("scroll"),
    x: z.number().min(0).max(8_192),
    y: z.number().min(0).max(8_192),
    deltaX: z.number().min(-4_000).max(4_000),
    deltaY: z.number().min(-4_000).max(4_000),
  }).strict(),
  z.object({ type: z.literal("insertText"), text: z.string().max(1_000) }).strict(),
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2_048) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Backspace", "Escape", "Tab"]) }).strict(),
  z.object({ type: z.enum(["back", "forward", "reload"]) }).strict(),
]);

export const SiteQaManifestActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number().min(0).max(8_192), y: z.number().min(0).max(8_192) }).strict(),
  z.object({
    type: z.literal("scroll"),
    x: z.number().min(0).max(8_192),
    y: z.number().min(0).max(8_192),
    deltaX: z.number().min(-4_000).max(4_000),
    deltaY: z.number().min(-4_000).max(4_000),
  }).strict(),
  z.object({ type: z.literal("insertText") }).strict(),
  z.object({ type: z.literal("navigate") }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Backspace", "Escape", "Tab"]) }).strict(),
  z.object({ type: z.enum(["back", "forward", "reload"]) }).strict(),
]);

export const SiteQaTargetDescriptorSchema = z.object({
  kind: z.enum(["button", "link", "input", "checkbox", "select", "text", "frame", "unknown"]),
  role: NullableBoundedTextSchema,
  accessibleName: NullableBoundedTextSchema,
  label: NullableBoundedTextSchema,
  placeholder: NullableBoundedTextSchema,
  testId: NullableBoundedTextSchema,
  stableId: NullableBoundedTextSchema,
  inputType: NullableBoundedTextSchema,
  tagName: NullableBoundedTextSchema,
  relativePoint: SiteQaPointSchema.nullable(),
  viewportPoint: SiteQaPointSchema.nullable(),
  confidence: z.enum(["high", "medium", "coordinate-only"]),
  ambiguityReason: z.enum(["missing-semantics", "cross-origin-frame", "non-unique", "sensitive-name", "unknown-target"]).nullable(),
}).strict();

export const SiteQaInputEvidenceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("literal"), value: z.string().max(1_000) }).strict(),
  z.object({
    mode: z.literal("placeholder"),
    value: z.enum(["{PASSWORD_1}", "{OTP_1}", "{PAYMENT_1}", "{TOKEN_1}", "{TEST_EMAIL_1}", "{TEST_PHONE_1}", "{PRIVATE_VALUE_1}"]),
  }).strict(),
]);

export const SiteQaActionReceiptSchema = z.object({
  receiptId: UuidSchema,
  threadId: ThreadIdSchema,
  tabId: z.string().regex(/^tab_[a-f0-9]{24}$/u),
  action: SiteQaManifestActionSchema,
  target: SiteQaTargetDescriptorSchema.nullable(),
  input: SiteQaInputEvidenceSchema,
  beforeUrl: z.string().max(2_048),
  afterUrl: z.string().max(2_048),
  beforeScroll: SiteQaPointSchema,
  afterScroll: SiteQaPointSchema,
  outcome: z.enum(["applied", "no-visible-change", "unknown"]),
  confidence: z.enum(["high", "medium", "coordinate-only"]),
  recordedAt: EpochMillisSchema,
}).strict();

export const SiteQaManifestStepSchema = z.object({
  stepId: UuidSchema,
  index: z.number().int().min(0).max(MAX_SITE_QA_STEPS - 1),
  relativeAtMs: z.number().int().min(0).max(MAX_SITE_QA_DURATION_MS),
  action: SiteQaManifestActionSchema,
  target: SiteQaTargetDescriptorSchema.nullable(),
  input: SiteQaInputEvidenceSchema,
  beforeUrl: z.string().max(2_048),
  afterUrl: z.string().max(2_048),
  confidence: z.enum(["high", "medium", "coordinate-only"]),
  evidenceFrameId: UuidSchema,
}).strict();

export const SiteQaManifestIssueSchema = z.object({
  issueId: UuidSchema,
  frameId: UuidSchema,
  expected: z.string().max(1_500),
  actual: z.string().max(1_500),
  explanation: z.string().max(3_000),
  hasLocalVoiceNote: z.boolean(),
}).strict();

export const SiteQaManifestSchema = z.object({
  version: z.literal(1),
  recordingId: UuidSchema,
  sourceThreadId: ThreadIdSchema,
  startedAt: EpochMillisSchema,
  durationMs: z.number().int().min(0).max(MAX_SITE_QA_DURATION_MS),
  intent: z.enum(["diagnose-and-fix", "regression-test", "both"]),
  environment: z.object({
    viewport: z.object({ width: z.number().int().min(1).max(8_192), height: z.number().int().min(1).max(8_192) }).strict(),
    deviceScaleFactor: z.number().min(1).max(4),
    controllerOrientation: z.enum(["portrait", "landscape"]),
  }).strict(),
  steps: z.array(SiteQaManifestStepSchema).max(MAX_SITE_QA_STEPS),
  issues: z.array(SiteQaManifestIssueSchema).max(MAX_SITE_QA_ISSUES),
}).strict();

export type SiteQaRecordedAction = z.infer<typeof SiteQaRecordedActionSchema>;
export type SiteQaTargetDescriptor = z.infer<typeof SiteQaTargetDescriptorSchema>;
export type SiteQaInputEvidence = z.infer<typeof SiteQaInputEvidenceSchema>;
export type SiteQaActionReceipt = z.infer<typeof SiteQaActionReceiptSchema>;
export type SiteQaManifest = z.infer<typeof SiteQaManifestSchema>;

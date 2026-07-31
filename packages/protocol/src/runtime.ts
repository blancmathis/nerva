import { z } from "zod";

import { BridgeHealthSchema } from "./snapshot.js";
import {
  ApiContractVersionSchema,
  BuildRevisionSchema,
} from "./runtime-identity.js";

export const RuntimeCapabilityIdSchema = z.enum([
  "sessions",
  "nativeControls",
  "composerAttachment",
  "skillsAndModels",
  "approvals",
  "sites",
]);

export const RuntimeCapabilityStateSchema = z.enum([
  "available",
  "recovering",
  "needsVerification",
  "unavailable",
]);

export const RuntimeCapabilityCheckSchema = z
  .object({
    id: RuntimeCapabilityIdSchema,
    label: z.string().trim().min(1).max(80),
    state: RuntimeCapabilityStateSchema,
    reason: z.string().trim().min(1).max(300).nullable(),
    lastProvenAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const RuntimeSchemaCompatibilitySchema = z
  .object({
    state: z.enum(["current", "missing", "invalid", "unknown"]),
    summary: z.string().trim().min(1).max(300),
    remediation: z.string().trim().min(1).max(300).nullable(),
  })
  .strict();

/**
 * Small, privacy-safe runtime proof document. It reports integration state,
 * never prompt text, terminal output, file paths, tokens, or task identities.
 */
export const RuntimeDiagnosticsSchema = z
  .object({
    protocolVersion: z.literal(1),
    bridgeVersion: z.string().trim().min(1).max(100),
    /** Optional only while one pre-identity runtime generation may still reply. */
    buildRevision: BuildRevisionSchema.optional(),
    apiContractVersion: ApiContractVersionSchema.optional(),
    codexVersion: z.string().trim().min(1).max(100).nullable(),
    snapshotSequence: z.number().int().nonnegative(),
    capturedAt: z.number().int().nonnegative(),
    bridgeHealth: BridgeHealthSchema,
    schemaCompatibility: RuntimeSchemaCompatibilitySchema,
    checks: z.array(RuntimeCapabilityCheckSchema).length(6),
  })
  .strict();

export type RuntimeCapabilityId = z.infer<typeof RuntimeCapabilityIdSchema>;
export type RuntimeCapabilityState = z.infer<typeof RuntimeCapabilityStateSchema>;
export type RuntimeCapabilityCheck = z.infer<typeof RuntimeCapabilityCheckSchema>;
export type RuntimeSchemaCompatibility = z.infer<typeof RuntimeSchemaCompatibilitySchema>;
export type RuntimeDiagnostics = z.infer<typeof RuntimeDiagnosticsSchema>;

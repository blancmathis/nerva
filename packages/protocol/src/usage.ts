import { z } from "zod";

import { createApiEnvelopeSchema } from "./api.js";

export const CodexUsageWindowSchema = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowMinutes: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
}).strict();

export const CodexUsageCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().trim().max(120).nullable(),
}).strict();

export const CodexUsageSnapshotSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    stale: z.boolean(),
    fetchedAt: z.number().int().nonnegative(),
    planType: z.string().trim().min(1).max(80).nullable(),
    limitName: z.string().trim().min(1).max(120).nullable(),
    primary: CodexUsageWindowSchema.nullable(),
    secondary: CodexUsageWindowSchema.nullable(),
    credits: CodexUsageCreditsSchema.nullable(),
    rateLimitReached: z.boolean(),
  }).strict(),
  z.object({
    available: z.literal(false),
    stale: z.literal(false),
    fetchedAt: z.number().int().nonnegative(),
    reason: z.enum(["app-server-unavailable", "usage-unavailable"]),
  }).strict(),
]);

export const CodexUsageApiResponseSchema = createApiEnvelopeSchema(CodexUsageSnapshotSchema);

export type CodexUsageWindow = z.infer<typeof CodexUsageWindowSchema>;
export type CodexUsageCredits = z.infer<typeof CodexUsageCreditsSchema>;
export type CodexUsageSnapshot = z.infer<typeof CodexUsageSnapshotSchema>;
export type CodexUsageApiResponse = z.infer<typeof CodexUsageApiResponseSchema>;

import { z } from "zod";

import { CommandAckSchema, CommandStatusResponseSchema } from "./commands.js";
import { AllSessionsResponseSchema, NativeSessionsResponseSchema } from "./review.js";
import { MicroSnapshotSchema } from "./snapshot.js";
import { RuntimeDiagnosticsSchema } from "./runtime.js";
import { ContextRoomStatusSchema } from "./integrations.js";
import {
  SavedDrawingDeleteResultSchema,
  SavedDrawingDetailSchema,
  SavedDrawingsListSchema,
} from "./saved-drawings.js";

export const ApiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "AGENT_BUSY",
  "CODEX_DEGRADED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

const ApiErrorDetailValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    details: z.record(z.string(), ApiErrorDetailValueSchema).nullable(),
  })
  .strict();

export function createApiSuccessEnvelopeSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z
    .object({
      ok: z.literal(true),
      data: dataSchema,
    })
    .strict();
}

export const createApiFailureEnvelopeSchema = () =>
  z
    .object({
      ok: z.literal(false),
      error: ApiErrorSchema,
    })
    .strict();

export function createApiEnvelopeSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z.union([createApiSuccessEnvelopeSchema(dataSchema), createApiFailureEnvelopeSchema()]);
}

export const SnapshotApiResponseSchema = createApiEnvelopeSchema(MicroSnapshotSchema);
export const RuntimeDiagnosticsApiResponseSchema = createApiEnvelopeSchema(RuntimeDiagnosticsSchema);
export const ContextRoomStatusApiResponseSchema = createApiEnvelopeSchema(ContextRoomStatusSchema);
export const CommandAckApiResponseSchema = createApiEnvelopeSchema(CommandAckSchema);
export const CommandStatusApiResponseSchema = createApiEnvelopeSchema(CommandStatusResponseSchema);
export const AllSessionsApiResponseSchema = createApiEnvelopeSchema(AllSessionsResponseSchema);
export const NativeSessionsApiResponseSchema = createApiEnvelopeSchema(NativeSessionsResponseSchema);
export const SavedDrawingsApiResponseSchema = createApiEnvelopeSchema(SavedDrawingsListSchema);
export const SavedDrawingApiResponseSchema = createApiEnvelopeSchema(SavedDrawingDetailSchema);
export const SavedDrawingDeleteApiResponseSchema = createApiEnvelopeSchema(SavedDrawingDeleteResultSchema);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiSuccess<T> = Readonly<{ ok: true; data: T }>;
export type ApiFailure = Readonly<{ ok: false; error: ApiError }>;
export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;
export type SnapshotApiResponse = z.infer<typeof SnapshotApiResponseSchema>;
export type RuntimeDiagnosticsApiResponse = z.infer<typeof RuntimeDiagnosticsApiResponseSchema>;
export type ContextRoomStatusApiResponse = z.infer<typeof ContextRoomStatusApiResponseSchema>;
export type CommandAckApiResponse = z.infer<typeof CommandAckApiResponseSchema>;
export type CommandStatusApiResponse = z.infer<typeof CommandStatusApiResponseSchema>;
export type AllSessionsApiResponse = z.infer<typeof AllSessionsApiResponseSchema>;
export type NativeSessionsApiResponse = z.infer<typeof NativeSessionsApiResponseSchema>;
export type SavedDrawingsApiResponse = z.infer<typeof SavedDrawingsApiResponseSchema>;
export type SavedDrawingApiResponse = z.infer<typeof SavedDrawingApiResponseSchema>;
export type SavedDrawingDeleteApiResponse = z.infer<typeof SavedDrawingDeleteApiResponseSchema>;

import { z } from "zod";

import { UuidSchema } from "./primitives.js";

const Base64Schema = z.string().min(4).max(12_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u);

export const SavedDrawingBackgroundSchema = z.enum(["white", "dark", "transparent"]);

export const SavedDrawingCreateRequestSchema = z.object({
  sourceThreadId: UuidSchema,
  sourceThreadTitle: z.string().trim().min(1).max(240),
  instruction: z.string().max(4_000),
  pngBase64: Base64Schema,
  sceneJson: z.string().min(2).max(4_000_000),
  background: SavedDrawingBackgroundSchema,
  width: z.number().int().min(1).max(4_096),
  height: z.number().int().min(1).max(4_096),
}).strict();

export const SavedDrawingSummarySchema = z.object({
  id: UuidSchema,
  sourceThreadId: UuidSchema,
  sourceThreadTitle: z.string().trim().min(1).max(240),
  instruction: z.string().max(4_000),
  background: SavedDrawingBackgroundSchema,
  width: z.number().int().min(1).max(4_096),
  height: z.number().int().min(1).max(4_096),
  byteLength: z.number().int().min(1).max(8 * 1024 * 1024),
  createdAt: z.number().int().nonnegative(),
  thumbnailBase64: Base64Schema.max(512_000),
}).strict();

export const SavedDrawingDetailSchema = SavedDrawingSummarySchema.extend({
  pngBase64: Base64Schema,
  sceneJson: z.string().min(2).max(4_000_000),
}).strict();

export const SavedDrawingsListSchema = z.object({
  drawings: z.array(SavedDrawingSummarySchema).max(48),
}).strict();

export const SavedDrawingDeleteResultSchema = z.object({
  deleted: z.literal(true),
  drawingId: UuidSchema,
}).strict();

export type SavedDrawingCreateRequest = z.infer<typeof SavedDrawingCreateRequestSchema>;
export type SavedDrawingSummary = z.infer<typeof SavedDrawingSummarySchema>;
export type SavedDrawingDetail = z.infer<typeof SavedDrawingDetailSchema>;
export type SavedDrawingsList = z.infer<typeof SavedDrawingsListSchema>;
export type SavedDrawingDeleteResult = z.infer<typeof SavedDrawingDeleteResultSchema>;

import { z } from "zod";

export const ContextRoomStatusSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  checkedAt: z.number().int().nonnegative(),
  roomName: z.string().trim().min(1).max(100).nullable(),
  version: z.string().trim().min(1).max(100).nullable(),
  reason: z.string().trim().min(1).max(300).nullable(),
}).strict();

export type ContextRoomStatus = z.infer<typeof ContextRoomStatusSchema>;

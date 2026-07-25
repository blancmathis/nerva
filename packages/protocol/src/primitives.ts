import { z } from "zod";

/** Canonical, hyphenated UUID text. Values are normalized to lowercase. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const UuidSchema = z
  .string()
  .regex(UUID_PATTERN, "Expected a canonical UUID")
  .transform((value) => value.toLowerCase());

export const ThreadIdSchema = UuidSchema;
export const CommandIdSchema = UuidSchema;

export const SequenceSchema = z.number().int().nonnegative().safe();
export const EpochMillisSchema = z.number().int().nonnegative().safe();

export type Uuid = z.infer<typeof UuidSchema>;
export type ThreadId = z.infer<typeof ThreadIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type Sequence = z.infer<typeof SequenceSchema>;

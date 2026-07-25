import { z } from "zod";

const CardTextSchema = z.string().trim().min(1).max(500);

export const NervaCardToneSchema = z.enum(["neutral", "info", "success", "warning", "danger"]);

export const NervaCardBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: CardTextSchema }).strict(),
  z.object({
    type: z.literal("metric"),
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(80),
    detail: z.string().trim().min(1).max(160).nullable(),
  }).strict(),
  z.object({
    type: z.literal("progress"),
    label: z.string().trim().min(1).max(80),
    value: z.number().min(0).max(1),
    detail: z.string().trim().min(1).max(160).nullable(),
  }).strict(),
  z.object({
    type: z.literal("list"),
    label: z.string().trim().min(1).max(80),
    items: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
  }).strict(),
  z.object({
    type: z.literal("status"),
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(120),
    tone: NervaCardToneSchema,
  }).strict(),
]);

/**
 * A bounded display document for agent-provided explanations. It deliberately
 * has no HTML, scripts, URLs, event handlers, or arbitrary style fields.
 */
export const NervaCardSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  source: z.enum(["nerva", "codex", "context-room"]),
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().min(1).max(200).nullable(),
  tone: NervaCardToneSchema,
  blocks: z.array(NervaCardBlockSchema).min(1).max(12),
}).strict();

export type NervaCard = z.infer<typeof NervaCardSchema>;
export type NervaCardBlock = z.infer<typeof NervaCardBlockSchema>;

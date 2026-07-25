import { z } from "zod";

import { createApiEnvelopeSchema } from "./api.js";

export const PRODUCT_STATE_VERSION = 1 as const;
export const MAX_PINNED_SESSIONS = 12;
export const MAX_HOME_SECTIONS = 12;
export const MAX_HOME_CASES = 48;
export const MAX_MODEL_REASONING_PRESETS = 24;
export const MAX_SITE_FAVORITES = 48;

export const HomeColorSchema = z.enum([
  "amber",
  "cobalt",
  "coral",
  "sage",
  "violet",
  "slate",
]);

export const AutomaticHomeStatusSchema = z.enum([
  "needs-approval",
  "error",
  "working",
  "waiting",
  "completed",
  "idle",
]);

const BoundedIdSchema = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u);
const ThreadIdSchema = z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
const DisplayNameSchema = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u);

export const HomeCaseSchema = z.object({
  id: BoundedIdSchema,
  name: DisplayNameSchema,
  color: HomeColorSchema,
  threadIds: z.array(ThreadIdSchema).max(MAX_PINNED_SESSIONS),
}).strict();

export const HomeSectionSchema = z.object({
  id: BoundedIdSchema,
  name: DisplayNameSchema,
  color: HomeColorSchema,
  cases: z.array(HomeCaseSchema).max(MAX_HOME_CASES),
}).strict();

export const HomeLayoutSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["manual", "automatic"]),
  pinnedThreadIds: z.array(ThreadIdSchema).max(MAX_PINNED_SESSIONS),
  manual: z.object({
    sections: z.array(HomeSectionSchema).max(MAX_HOME_SECTIONS),
    looseThreadIds: z.array(ThreadIdSchema).max(MAX_PINNED_SESSIONS),
  }).strict(),
  automaticOrder: z.array(AutomaticHomeStatusSchema).length(6),
}).strict().superRefine((layout, context) => {
  const pinned = new Set(layout.pinnedThreadIds);
  if (pinned.size !== layout.pinnedThreadIds.length) {
    context.addIssue({ code: "custom", message: "Pinned task identifiers must be unique", path: ["pinnedThreadIds"] });
  }
  if (new Set(layout.automaticOrder).size !== 6) {
    context.addIssue({ code: "custom", message: "Automatic status order must contain every status exactly once", path: ["automaticOrder"] });
  }
  const sectionIds = new Set<string>();
  const caseIds = new Set<string>();
  const placed = new Set<string>();
  let caseCount = 0;
  for (const [sectionIndex, section] of layout.manual.sections.entries()) {
    if (sectionIds.has(section.id)) {
      context.addIssue({ code: "custom", message: "Section identifiers must be unique", path: ["manual", "sections", sectionIndex, "id"] });
    }
    sectionIds.add(section.id);
    for (const [caseIndex, homeCase] of section.cases.entries()) {
      caseCount += 1;
      if (caseIds.has(homeCase.id)) {
        context.addIssue({ code: "custom", message: "Case identifiers must be unique", path: ["manual", "sections", sectionIndex, "cases", caseIndex, "id"] });
      }
      caseIds.add(homeCase.id);
      for (const [threadIndex, threadId] of homeCase.threadIds.entries()) {
        if (!pinned.has(threadId) || placed.has(threadId)) {
          context.addIssue({ code: "custom", message: "Every placed task must be pinned and appear exactly once", path: ["manual", "sections", sectionIndex, "cases", caseIndex, "threadIds", threadIndex] });
        }
        placed.add(threadId);
      }
    }
  }
  if (caseCount > MAX_HOME_CASES) {
    context.addIssue({ code: "custom", message: `A Home layout cannot contain more than ${MAX_HOME_CASES} cases`, path: ["manual", "sections"] });
  }
  for (const [threadIndex, threadId] of layout.manual.looseThreadIds.entries()) {
    if (!pinned.has(threadId) || placed.has(threadId)) {
      context.addIssue({ code: "custom", message: "Every loose task must be pinned and appear exactly once", path: ["manual", "looseThreadIds", threadIndex] });
    }
    placed.add(threadId);
  }
  if (placed.size !== pinned.size) {
    context.addIssue({ code: "custom", message: "Every pinned task must have one manual placement", path: ["manual"] });
  }
});

export const ModelReasoningPresetSchema = z.object({
  id: BoundedIdSchema,
  model: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/u),
  reasoning: z.enum(["minimal", "low", "medium", "high", "xhigh", "ultra", "max"]),
  enabled: z.boolean(),
}).strict();

function isFavoriteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export const SiteFavoriteSchema = z.object({
  id: BoundedIdSchema,
  label: DisplayNameSchema,
  url: z.string().trim().min(1).max(2_048).refine(isFavoriteUrl, "Expected an HTTP(S) URL without credentials"),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const ProductPreferencesSchema = z.object({
  compactControls: z.boolean(),
  keepAwake: z.boolean(),
  allSessionsEnabled: z.literal(true),
  theme: z.enum(["system", "light", "dark"]),
  cardDensity: z.enum(["rich", "compact"]),
  motion: z.enum(["system", "full", "reduced"]),
  haptics: z.boolean(),
  notifications: z.object({
    needsApproval: z.boolean(),
    completed: z.boolean(),
    error: z.boolean(),
    waiting: z.boolean(),
  }).strict(),
  defaultHomeMode: z.enum(["manual", "automatic"]),
  modelReasoningPresets: z.array(ModelReasoningPresetSchema).max(MAX_MODEL_REASONING_PRESETS),
  siteFavorites: z.array(SiteFavoriteSchema).max(MAX_SITE_FAVORITES).default([]),
}).strict().superRefine((preferences, context) => {
  const ids = new Set<string>();
  for (const [index, preset] of preferences.modelReasoningPresets.entries()) {
    if (ids.has(preset.id)) {
      context.addIssue({ code: "custom", message: "Model preset identifiers must be unique", path: ["modelReasoningPresets", index, "id"] });
    }
    ids.add(preset.id);
  }
  const favoriteIds = new Set<string>();
  for (const [index, favorite] of preferences.siteFavorites.entries()) {
    if (favoriteIds.has(favorite.id)) {
      context.addIssue({ code: "custom", message: "Site favorite identifiers must be unique", path: ["siteFavorites", index, "id"] });
    }
    favoriteIds.add(favorite.id);
  }
});

export const ProductStateSchema = z.object({
  version: z.literal(PRODUCT_STATE_VERSION),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  homeLayout: HomeLayoutSchema,
  preferences: ProductPreferencesSchema,
}).strict();

export const ProductStateUpdateRequestSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  homeLayout: HomeLayoutSchema,
  preferences: ProductPreferencesSchema,
}).strict();

export const ProductStateApiResponseSchema = createApiEnvelopeSchema(ProductStateSchema);

export type HomeColor = z.infer<typeof HomeColorSchema>;
export type AutomaticHomeStatus = z.infer<typeof AutomaticHomeStatusSchema>;
export type ProductHomeLayout = z.infer<typeof HomeLayoutSchema>;
export type ProductPreferences = z.infer<typeof ProductPreferencesSchema>;
export type SiteFavorite = z.infer<typeof SiteFavoriteSchema>;
export type ProductState = z.infer<typeof ProductStateSchema>;
export type ProductStateUpdateRequest = z.infer<typeof ProductStateUpdateRequestSchema>;

import { z } from "zod";

export const VisualStatusSchema = z.enum([
  "empty",
  "idle",
  "working",
  "completed",
  "needsInput",
  "error",
  "degraded",
]);

export type VisualStatus = z.infer<typeof VisualStatusSchema>;

export const NativeStatusCategorySchema = z.enum([
  "empty",
  "idle",
  "working",
  "completed",
  "needsInput",
  "error",
  "degraded",
  "unknown",
]);

export type NativeStatusCategory = z.infer<typeof NativeStatusCategorySchema>;

const STATUS_CATEGORIES = {
  off: "empty",
  empty: "empty",
  idle: "idle",
  working: "working",
  thinking: "working",
  running: "working",
  active: "working",
  unread: "completed",
  complete: "completed",
  completed: "completed",
  done: "completed",
  approval: "needsInput",
  "awaiting-approval": "needsInput",
  input: "needsInput",
  "awaiting-response": "needsInput",
  "needs-input": "needsInput",
  error: "error",
  failed: "error",
  systemerror: "error",
  disconnected: "degraded",
  degraded: "degraded",
  notloaded: "degraded",
  offline: "degraded",
  unknown: "degraded",
} as const satisfies Record<string, Exclude<NativeStatusCategory, "unknown">>;

export type NativeStatusClassification = Readonly<{
  normalized: string;
  category: NativeStatusCategory;
  visualStatus: VisualStatus;
  known: boolean;
}>;

export function classifyNativeStatus(nativeStatus: string | null | undefined): NativeStatusClassification {
  const normalized = nativeStatus?.trim().toLowerCase() ?? "";
  const category = STATUS_CATEGORIES[normalized as keyof typeof STATUS_CATEGORIES];

  if (category === undefined) {
    return {
      normalized,
      category: "unknown",
      visualStatus: "degraded",
      known: false,
    };
  }

  return {
    normalized,
    category,
    visualStatus: category,
    known: true,
  };
}

/** Unknown native states fail visibly instead of being presented as idle. */
export function mapNativeStatus(nativeStatus: string | null | undefined): VisualStatus {
  return classifyNativeStatus(nativeStatus).visualStatus;
}

export const visualStatusFromNative = mapNativeStatus;

import { threadIdFromKey, type AgentSlot, type SlotStatus } from "./model";

export const SPATIAL_LAYOUT_VERSION = 2 as const;

export const SPATIAL_BOX_COLORS = [
  "cobalt",
  "amber",
  "coral",
  "sage",
  "violet",
  "slate",
] as const;

export const SPATIAL_BOX_SIZES = ["compact", "standard", "wide"] as const;

export type SpatialBoxColor = (typeof SPATIAL_BOX_COLORS)[number];
export type SpatialBoxSize = (typeof SPATIAL_BOX_SIZES)[number];

export interface SessionSummary {
  readonly threadId: string;
  readonly title: string;
  readonly status?: string;
  readonly threadKey?: string | null;
  readonly projectId?: string | null;
  readonly project?: string | null;
  readonly cwd?: string | null;
  readonly updatedAt?: string | null;
  readonly attention?: boolean;
}

export interface SpatialSession {
  readonly threadId: string;
  readonly threadKey: string | null;
  readonly title: string;
  readonly status: SlotStatus;
  readonly attention: boolean;
  readonly projectId: string | null;
  readonly project: string | null;
  readonly cwd: string | null;
  readonly updatedAt: string | null;
  readonly nativeSlotId: string | null;
  readonly nativeSlotIndex: number | null;
}

export interface SpatialBox {
  readonly id: string;
  readonly name: string;
  readonly color: SpatialBoxColor;
  readonly size: SpatialBoxSize;
  readonly threadIds: readonly string[];
}

export interface SpatialLayout {
  readonly version: typeof SPATIAL_LAYOUT_VERSION;
  readonly boxes: readonly SpatialBox[];
  readonly unassignedThreadIds: readonly string[];
}

export type SpatialLayoutAction =
  | { readonly type: "load-layout"; readonly layout: SpatialLayout }
  | { readonly type: "reconcile"; readonly currentThreadIds: readonly string[] }
  | {
      readonly type: "create-box";
      readonly box: Omit<SpatialBox, "threadIds">;
      readonly threadIds?: readonly string[];
    }
  | { readonly type: "rename-box"; readonly boxId: string; readonly name: string }
  | { readonly type: "recolor-box"; readonly boxId: string; readonly color: SpatialBoxColor }
  | { readonly type: "resize-box"; readonly boxId: string; readonly size: SpatialBoxSize }
  | { readonly type: "reorder-box"; readonly boxId: string; readonly toIndex: number }
  | { readonly type: "delete-box"; readonly boxId: string }
  | {
      readonly type: "move-session";
      readonly threadId: string;
      readonly targetBoxId: string | null;
      readonly beforeThreadId?: string;
    };

export interface GroupingSuggestion {
  readonly id: string;
  readonly kind: "project" | "folder";
  readonly label: string;
  readonly boxName: string;
  readonly threadIds: readonly string[];
}

const KNOWN_STATUSES = new Set<SlotStatus>([
  "off",
  "idle",
  "working",
  "unread",
  "awaiting-approval",
  "awaiting-response",
  "error",
  "degraded",
]);

const ATTENTION_STATUSES = new Set<SlotStatus>([
  "unread",
  "awaiting-approval",
  "awaiting-response",
  "error",
]);

const DEFAULT_LAYOUT: SpatialLayout = {
  version: SPATIAL_LAYOUT_VERSION,
  boxes: [],
  unassignedThreadIds: [],
};

export function emptySpatialLayout(): SpatialLayout {
  return DEFAULT_LAYOUT;
}

function normalizeStatus(value: string | undefined): SlotStatus {
  return value && KNOWN_STATUSES.has(value as SlotStatus)
    ? (value as SlotStatus)
    : "degraded";
}

function cleanText(value: unknown, fallback: string, maximum = 80): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, maximum);
  return cleaned || fallback;
}

function cleanId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().slice(0, 160);
  return cleaned || fallback;
}

function isBoxColor(value: unknown): value is SpatialBoxColor {
  return typeof value === "string" && (SPATIAL_BOX_COLORS as readonly string[]).includes(value);
}

function isBoxSize(value: unknown): value is SpatialBoxSize {
  return typeof value === "string" && (SPATIAL_BOX_SIZES as readonly string[]).includes(value);
}

function threadIdFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const cleaned = value.trim().slice(0, 256);
    return cleaned || null;
  }
  if (value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>).threadId;
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim().slice(0, 256)
      : null;
  }
  return null;
}

function idsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    const id = threadIdFromUnknown(entry);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function migrateBox(
  value: unknown,
  index: number,
  usedBoxIds: Set<string>,
  globallyOwnedThreads: Set<string>,
): SpatialBox | null {
  const record = recordFromUnknown(value);
  if (!record) return null;

  const rawId = cleanId(record.id, `box-${index + 1}`);
  let id = rawId;
  let suffix = 2;
  while (usedBoxIds.has(id)) {
    id = `${rawId}-${suffix}`;
    suffix += 1;
  }
  usedBoxIds.add(id);

  const rawThreads = record.threadIds ?? record.sessionIds ?? record.items;
  const threadIds = idsFromUnknown(rawThreads).filter((threadId) => {
    if (globallyOwnedThreads.has(threadId)) return false;
    globallyOwnedThreads.add(threadId);
    return true;
  });

  const legacyWidth = record.width;
  const size = isBoxSize(record.size)
    ? record.size
    : legacyWidth === "large" || legacyWidth === 2
      ? "wide"
      : legacyWidth === "small" || legacyWidth === 0
        ? "compact"
        : "standard";

  return {
    id,
    name: cleanText(record.name ?? record.title, `Box ${index + 1}`),
    color: isBoxColor(record.color) ? record.color : SPATIAL_BOX_COLORS[index % SPATIAL_BOX_COLORS.length]!,
    size,
    threadIds,
  };
}

/**
 * Accepts the current schema and the early v1 `groups`/`looseSessionIds` shape.
 * Unknown session fields are deliberately discarded: persistence contains identity
 * and layout metadata only, never titles, prompts, cwd values, or transcripts.
 */
export function migrateSpatialLayout(value: unknown): SpatialLayout {
  const record = recordFromUnknown(value);
  if (!record) return emptySpatialLayout();

  const rawBoxes = Array.isArray(record.boxes)
    ? record.boxes
    : Array.isArray(record.groups)
      ? record.groups
      : [];
  const usedBoxIds = new Set<string>();
  const globallyOwnedThreads = new Set<string>();
  const boxes = rawBoxes
    .map((box, index) => migrateBox(box, index, usedBoxIds, globallyOwnedThreads))
    .filter((box): box is SpatialBox => box !== null);

  const rawUnassigned =
    record.unassignedThreadIds ?? record.looseSessionIds ?? record.unassigned ?? [];
  const unassignedThreadIds = idsFromUnknown(rawUnassigned).filter((threadId) => {
    if (globallyOwnedThreads.has(threadId)) return false;
    globallyOwnedThreads.add(threadId);
    return true;
  });

  return {
    version: SPATIAL_LAYOUT_VERSION,
    boxes,
    unassignedThreadIds,
  };
}

function layoutsEqual(left: SpatialLayout, right: SpatialLayout): boolean {
  if (left.boxes.length !== right.boxes.length) return false;
  if (left.unassignedThreadIds.length !== right.unassignedThreadIds.length) return false;
  for (let index = 0; index < left.unassignedThreadIds.length; index += 1) {
    if (left.unassignedThreadIds[index] !== right.unassignedThreadIds[index]) return false;
  }
  for (let index = 0; index < left.boxes.length; index += 1) {
    const a = left.boxes[index]!;
    const b = right.boxes[index]!;
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.color !== b.color ||
      a.size !== b.size ||
      a.threadIds.length !== b.threadIds.length
    ) {
      return false;
    }
    for (let threadIndex = 0; threadIndex < a.threadIds.length; threadIndex += 1) {
      if (a.threadIds[threadIndex] !== b.threadIds[threadIndex]) return false;
    }
  }
  return true;
}

export function reconcileSpatialLayout(
  layout: SpatialLayout,
  currentThreadIds: readonly string[],
): SpatialLayout {
  const sanitized = migrateSpatialLayout(layout);
  const owned = new Set<string>();
  for (const box of sanitized.boxes) {
    for (const threadId of box.threadIds) owned.add(threadId);
  }
  for (const threadId of sanitized.unassignedThreadIds) owned.add(threadId);

  const appended: string[] = [];
  for (const rawId of currentThreadIds) {
    const threadId = threadIdFromUnknown(rawId);
    if (threadId && !owned.has(threadId)) {
      owned.add(threadId);
      appended.push(threadId);
    }
  }

  if (appended.length === 0 && layoutsEqual(layout, sanitized)) return layout;
  return {
    ...sanitized,
    unassignedThreadIds: [...sanitized.unassignedThreadIds, ...appended],
  };
}

function withoutThread(layout: SpatialLayout, threadId: string): SpatialLayout {
  return {
    ...layout,
    boxes: layout.boxes.map((box) => ({
      ...box,
      threadIds: box.threadIds.filter((candidate) => candidate !== threadId),
    })),
    unassignedThreadIds: layout.unassignedThreadIds.filter((candidate) => candidate !== threadId),
  };
}

function insertBefore(
  threadIds: readonly string[],
  threadId: string,
  beforeThreadId: string | undefined,
): readonly string[] {
  if (!beforeThreadId) return [...threadIds, threadId];
  const index = threadIds.indexOf(beforeThreadId);
  if (index < 0) return [...threadIds, threadId];
  return [...threadIds.slice(0, index), threadId, ...threadIds.slice(index)];
}

export function spatialLayoutReducer(
  layout: SpatialLayout,
  action: SpatialLayoutAction,
): SpatialLayout {
  switch (action.type) {
    case "load-layout":
      return migrateSpatialLayout(action.layout);
    case "reconcile":
      return reconcileSpatialLayout(layout, action.currentThreadIds);
    case "create-box": {
      if (layout.boxes.some((box) => box.id === action.box.id)) return layout;
      const threadIds = idsFromUnknown(action.threadIds ?? []);
      let next = layout;
      for (const threadId of threadIds) next = withoutThread(next, threadId);
      return {
        ...next,
        boxes: [
          ...next.boxes,
          {
            id: cleanId(action.box.id, `box-${next.boxes.length + 1}`),
            name: cleanText(action.box.name, `Box ${next.boxes.length + 1}`),
            color: isBoxColor(action.box.color) ? action.box.color : "cobalt",
            size: isBoxSize(action.box.size) ? action.box.size : "standard",
            threadIds,
          },
        ],
      };
    }
    case "rename-box": {
      const target = layout.boxes.find((box) => box.id === action.boxId);
      if (!target) return layout;
      const name = cleanText(action.name, target.name);
      if (name === target.name) return layout;
      return {
        ...layout,
        boxes: layout.boxes.map((box) => (box.id === action.boxId ? { ...box, name } : box)),
      };
    }
    case "recolor-box":
      if (!isBoxColor(action.color)) return layout;
      return {
        ...layout,
        boxes: layout.boxes.map((box) =>
          box.id === action.boxId ? { ...box, color: action.color } : box,
        ),
      };
    case "resize-box":
      if (!isBoxSize(action.size)) return layout;
      return {
        ...layout,
        boxes: layout.boxes.map((box) =>
          box.id === action.boxId ? { ...box, size: action.size } : box,
        ),
      };
    case "reorder-box": {
      const fromIndex = layout.boxes.findIndex((box) => box.id === action.boxId);
      if (fromIndex < 0 || layout.boxes.length < 2) return layout;
      const toIndex = Math.max(0, Math.min(layout.boxes.length - 1, action.toIndex));
      if (toIndex === fromIndex) return layout;
      const boxes = [...layout.boxes];
      const [moved] = boxes.splice(fromIndex, 1);
      if (!moved) return layout;
      boxes.splice(toIndex, 0, moved);
      return { ...layout, boxes };
    }
    case "delete-box": {
      const deleted = layout.boxes.find((box) => box.id === action.boxId);
      if (!deleted) return layout;
      const unassigned = new Set(layout.unassignedThreadIds);
      const returned = [...layout.unassignedThreadIds];
      for (const threadId of deleted.threadIds) {
        if (!unassigned.has(threadId)) {
          unassigned.add(threadId);
          returned.push(threadId);
        }
      }
      return {
        ...layout,
        boxes: layout.boxes.filter((box) => box.id !== action.boxId),
        unassignedThreadIds: returned,
      };
    }
    case "move-session": {
      const threadId = threadIdFromUnknown(action.threadId);
      if (!threadId) return layout;
      if (action.targetBoxId && !layout.boxes.some((box) => box.id === action.targetBoxId)) {
        return layout;
      }
      const next = withoutThread(layout, threadId);
      if (action.targetBoxId === null) {
        return {
          ...next,
          unassignedThreadIds: insertBefore(
            next.unassignedThreadIds,
            threadId,
            action.beforeThreadId,
          ),
        };
      }
      return {
        ...next,
        boxes: next.boxes.map((box) =>
          box.id === action.targetBoxId
            ? {
                ...box,
                threadIds: insertBefore(box.threadIds, threadId, action.beforeThreadId),
              }
            : box,
        ),
      };
    }
  }
}

export function boxIdForThread(layout: SpatialLayout, threadId: string): string | null {
  return layout.boxes.find((box) => box.threadIds.includes(threadId))?.id ?? null;
}

export function spatialSessionsFromSources(
  slots: readonly AgentSlot[],
  summaries: readonly SessionSummary[] = [],
): readonly SpatialSession[] {
  const sessions = new Map<string, SpatialSession>();

  for (const slot of [...slots].sort((left, right) => left.index - right.index)) {
    const threadId = slot.threadId ?? threadIdFromKey(slot.threadKey);
    if (!threadId) continue;
    sessions.set(threadId, {
      threadId,
      threadKey: slot.threadKey,
      title: cleanText(slot.title, `Session ${threadId.slice(-8)}`),
      status: normalizeStatus(slot.status),
      attention: ATTENTION_STATUSES.has(normalizeStatus(slot.status)),
      projectId: null,
      project: null,
      cwd: null,
      updatedAt: slot.updatedAt ?? null,
      nativeSlotId: slot.slotId,
      nativeSlotIndex: slot.index,
    });
  }

  for (const summary of summaries) {
    const threadId = threadIdFromUnknown(summary.threadId);
    if (!threadId) continue;
    const existing = sessions.get(threadId);
    if (existing) {
      sessions.set(threadId, {
        ...existing,
        threadKey: existing.threadKey ?? summary.threadKey ?? null,
        projectId: summary.projectId?.trim() || null,
        project: summary.project?.trim() || null,
        cwd: summary.cwd?.trim() || null,
        updatedAt: existing.updatedAt ?? summary.updatedAt ?? null,
        attention: existing.attention || summary.attention === true,
      });
      continue;
    }
    const status = normalizeStatus(summary.status);
    sessions.set(threadId, {
      threadId,
      threadKey: summary.threadKey ?? null,
      title: cleanText(summary.title, `Session ${threadId.slice(-8)}`),
      status,
      attention: summary.attention === true || ATTENTION_STATUSES.has(status),
      projectId: summary.projectId?.trim() || null,
      project: summary.project?.trim() || null,
      cwd: summary.cwd?.trim() || null,
      updatedAt: summary.updatedAt ?? null,
      nativeSlotId: null,
      nativeSlotIndex: null,
    });
  }

  return [...sessions.values()];
}

function folderName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

export function buildGroupingSuggestions(
  sessions: readonly SpatialSession[],
  layout: SpatialLayout,
): readonly GroupingSuggestion[] {
  const groups = new Map<string, GroupingSuggestion>();
  for (const session of sessions) {
    const kind = session.project ? "project" : session.cwd ? "folder" : null;
    if (!kind) continue;
    const name = kind === "project" ? session.project! : folderName(session.cwd!);
    const normalized = name.trim();
    if (!normalized) continue;
    const id = `${kind}:${normalized.toLocaleLowerCase()}`;
    const existing = groups.get(id);
    groups.set(id, {
      id,
      kind,
      label: `${kind === "project" ? "Project" : "Folder"}: ${normalized}`,
      boxName: normalized,
      threadIds: existing ? [...existing.threadIds, session.threadId] : [session.threadId],
    });
  }

  return [...groups.values()]
    .filter((suggestion) => suggestion.threadIds.length >= 2)
    .filter(
      (suggestion) =>
        !layout.boxes.some(
          (box) =>
            box.name.toLocaleLowerCase() === suggestion.boxName.toLocaleLowerCase() &&
            suggestion.threadIds.every((threadId) => box.threadIds.includes(threadId)),
        ),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function sessionMatchesSearch(session: SpatialSession, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [
    session.title,
    session.threadId,
    session.threadId.slice(-8),
    session.project,
    session.cwd,
    session.status,
    session.nativeSlotIndex === null ? null : `slot ${session.nativeSlotIndex + 1}`,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(needle);
}

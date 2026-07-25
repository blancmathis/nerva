import { openDB } from "idb";
import type { BridgeSnapshot } from "./model";
import { normalizeSnapshot } from "./normalize";

const DATABASE = "codex-pad-display-cache";
const STORE = "last-good";
const SNAPSHOT_KEY = "snapshot";
const PREFS_KEY = "codex-pad.ui-preferences.v1";
const PRODUCT_STATE_DIRTY_KEY = "codex-pad.product-state-dirty.v1";
const LEGACY_PRESET_RECOVERY_KEY = "codex-pad.legacy-preset-recovery.v1";

export interface ProductStateDirtyScope {
  readonly homeLayout: boolean;
  readonly preferences: boolean;
}

const CLEAN_PRODUCT_STATE_SCOPE: ProductStateDirtyScope = {
  homeLayout: false,
  preferences: false,
};

export interface UiPreferences {
  readonly compactControls: boolean;
  readonly keepAwake: boolean;
  readonly allSessionsEnabled: boolean;
  readonly theme: "system" | "light" | "dark";
  readonly cardDensity: "rich" | "compact";
  readonly motion: "system" | "full" | "reduced";
  readonly haptics: boolean;
  readonly notifications: {
    readonly needsApproval: boolean;
    readonly completed: boolean;
    readonly error: boolean;
    readonly waiting: boolean;
  };
  readonly defaultHomeMode: "manual" | "automatic";
  readonly modelReasoningPresets: readonly ModelReasoningPreset[];
  readonly siteFavorites: readonly SiteFavorite[];
}

export interface ModelReasoningPreset {
  readonly id: string;
  readonly model: string;
  readonly reasoning: "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra" | "max";
  readonly enabled: boolean;
}

export interface SiteFavorite {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly updatedAt: number;
}

const REASONING_LEVELS = new Set<ModelReasoningPreset["reasoning"]>(["minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);

function modelReasoningPresets(value: unknown): readonly ModelReasoningPreset[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const source = candidate as Record<string, unknown>;
    const model = typeof source.model === "string" ? source.model.trim().slice(0, 100) : "";
    const reasoning = source.reasoning;
    if (!model || typeof reasoning !== "string" || !REASONING_LEVELS.has(reasoning as ModelReasoningPreset["reasoning"])) return [];
    return [{
      id: typeof source.id === "string" && source.id.trim() ? source.id.trim().slice(0, 120) : `preset-${index + 1}`,
      model,
      reasoning: reasoning as ModelReasoningPreset["reasoning"],
      enabled: source.enabled !== false,
    }];
  });
}

function siteFavorites(value: unknown): readonly SiteFavorite[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 48).flatMap((candidate): SiteFavorite[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const source = candidate as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim().slice(0, 120) : "";
    const label = typeof source.label === "string" ? source.label.trim().slice(0, 80) : "";
    const updatedAt = typeof source.updatedAt === "number" && Number.isSafeInteger(source.updatedAt) && source.updatedAt >= 0
      ? source.updatedAt
      : 0;
    if (!id || ids.has(id) || !label || typeof source.url !== "string") return [];
    try {
      const url = new URL(source.url.trim());
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.href.length > 2_048) return [];
      ids.add(id);
      return [{ id, label, url: url.href, updatedAt }];
    } catch {
      return [];
    }
  });
}

export const DEFAULT_PREFERENCES: UiPreferences = {
  compactControls: false,
  keepAwake: false,
  // Target Home and Unpinned Sessions require the authenticated catalog. This
  // is a display request, not mutation authority, and still fails closed when
  // the installed transport cannot provide it.
  allSessionsEnabled: true,
  theme: "system",
  cardDensity: "rich",
  motion: "system",
  haptics: false,
  notifications: {
    needsApproval: true,
    completed: true,
    error: true,
    waiting: true,
  },
  defaultHomeMode: "manual",
  modelReasoningPresets: [],
  siteFavorites: [],
};

async function database() {
  return openDB(DATABASE, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
}

export async function saveLastSnapshot(snapshot: BridgeSnapshot): Promise<void> {
  const db = await database();
  await db.put(STORE, {
    ...snapshot,
    slots: snapshot.slots.map((slot) => ({ ...slot, activityLabel: null })),
  }, SNAPSHOT_KEY);
}

export async function loadLastSnapshot(): Promise<BridgeSnapshot | null> {
  const db = await database();
  return normalizeSnapshot(await db.get(STORE, SNAPSHOT_KEY));
}

export function loadPreferences(): UiPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
    const notifications = parsed.notifications && typeof parsed.notifications === "object"
      ? parsed.notifications as Record<string, unknown>
      : {};
    return {
      compactControls: parsed.compactControls === true,
      keepAwake: parsed.keepAwake === true,
      allSessionsEnabled: true,
      theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : "system",
      cardDensity: parsed.cardDensity === "compact" || parsed.compactControls === true ? "compact" : "rich",
      motion: parsed.motion === "full" || parsed.motion === "reduced" ? parsed.motion : "system",
      haptics: parsed.haptics === true,
      notifications: {
        needsApproval: notifications.needsApproval !== false,
        completed: notifications.completed !== false,
        error: notifications.error !== false,
        waiting: notifications.waiting !== false,
      },
      defaultHomeMode: parsed.defaultHomeMode === "automatic" ? "automatic" : "manual",
      modelReasoningPresets: modelReasoningPresets(parsed.modelReasoningPresets),
      siteFavorites: siteFavorites(parsed.siteFavorites),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: UiPreferences): void {
  // Display preferences only. The bridge bearer lives in a separate IndexedDB store.
  localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
}

/**
 * One-time repair for builds that could let a stale Home save replace newer Mac
 * presets with an empty list. It only offers a non-empty local list when the Mac
 * has none; after this migration decision the normal revisioned Product State
 * rules remain authoritative.
 */
export function claimLegacyPresetRecovery(
  local: UiPreferences,
  remote: UiPreferences,
): boolean {
  try {
    if (localStorage.getItem(LEGACY_PRESET_RECOVERY_KEY) === "1") return false;
    localStorage.setItem(LEGACY_PRESET_RECOVERY_KEY, "1");
  } catch {
    // Without durable one-time state, do not risk repeatedly resurrecting an
    // intentionally empty remote preset list.
    return false;
  }
  return local.modelReasoningPresets.length > 0 && remote.modelReasoningPresets.length === 0;
}

/** Remember exactly which local Product State fields still need a confirmed Mac write. */
export function markProductStateDirty(field: keyof ProductStateDirtyScope): ProductStateDirtyScope {
  const current = loadProductStateDirtyScope();
  const next = { ...current, [field]: true };
  try {
    localStorage.setItem(PRODUCT_STATE_DIRTY_KEY, JSON.stringify(next));
  } catch {
    // Current in-memory state can still be synchronized during this app run.
  }
  return next;
}

export function clearProductStateDirty(): void {
  try {
    localStorage.removeItem(PRODUCT_STATE_DIRTY_KEY);
  } catch {
    // A successful Mac write remains authoritative even if local cleanup fails.
  }
}

export function isProductStateDirty(): boolean {
  const scope = loadProductStateDirtyScope();
  return scope.homeLayout || scope.preferences;
}

export function loadProductStateDirtyScope(): ProductStateDirtyScope {
  try {
    const value = localStorage.getItem(PRODUCT_STATE_DIRTY_KEY);
    // Earlier builds stored a single marker. Treat it as both fields so an
    // interrupted local change is never silently discarded during migration.
    if (value === "1") return { homeLayout: true, preferences: true };
    const parsed = JSON.parse(value ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return CLEAN_PRODUCT_STATE_SCOPE;
    const source = parsed as Record<string, unknown>;
    return {
      homeLayout: source.homeLayout === true,
      preferences: source.preferences === true,
    };
  } catch {
    return CLEAN_PRODUCT_STATE_SCOPE;
  }
}

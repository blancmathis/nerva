import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureSnapshot } from "../../e2e/fixture-data";
import type { BridgeSnapshot } from "./model";
import { normalizeSnapshot } from "./normalize";
import {
  clearProductStateDirty,
  claimLegacyPresetRecovery,
  DEFAULT_PREFERENCES,
  isProductStateDirty,
  loadProductStateDirtyScope,
  loadPreferences,
  markProductStateDirty,
  saveLastSnapshot,
  savePreferences,
} from "./storage";

const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "indexedDB");
});

describe("UI privacy preferences", () => {
  it("migrates legacy preferences into the target global display defaults", () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    localStorage.setItem("codex-pad.ui-preferences.v1", JSON.stringify({ theme: "dark" }));
    expect(loadPreferences()).toMatchObject({ theme: "dark", allSessionsEnabled: true, cardDensity: "rich" });
    localStorage.setItem("codex-pad.ui-preferences.v1", JSON.stringify({ compactControls: true }));
    expect(loadPreferences().cardDensity).toBe("compact");
    localStorage.setItem("codex-pad.ui-preferences.v1", "not-json");
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("persists target card, motion, notification, and layout preferences", () => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      cardDensity: "compact",
      motion: "reduced",
      haptics: false,
      defaultHomeMode: "automatic",
      notifications: { needsApproval: true, completed: false, error: true, waiting: true },
    });
    expect(loadPreferences()).toMatchObject({
      cardDensity: "compact",
      motion: "reduced",
      haptics: false,
      defaultHomeMode: "automatic",
      notifications: { completed: false, waiting: true },
    });
  });

  it("persists an unsynchronized Product State marker across an app reload", () => {
    expect(isProductStateDirty()).toBe(false);
    markProductStateDirty("preferences");
    expect(isProductStateDirty()).toBe(true);
    expect(loadProductStateDirtyScope()).toEqual({ homeLayout: false, preferences: true });
    markProductStateDirty("homeLayout");
    expect(loadProductStateDirtyScope()).toEqual({ homeLayout: true, preferences: true });
    clearProductStateDirty();
    expect(isProductStateDirty()).toBe(false);
  });

  it("migrates the legacy Product State marker without losing either local field", () => {
    localStorage.setItem("codex-pad.product-state-dirty.v1", "1");
    expect(loadProductStateDirtyScope()).toEqual({ homeLayout: true, preferences: true });
  });

  it("offers a locally retained preset list once after the historical empty-list overwrite", () => {
    const local = {
      ...DEFAULT_PREFERENCES,
      modelReasoningPresets: [{ id: "sol-high", model: "sol", reasoning: "high" as const, enabled: true }],
    };
    expect(claimLegacyPresetRecovery(local, DEFAULT_PREFERENCES)).toBe(true);
    expect(claimLegacyPresetRecovery(local, DEFAULT_PREFERENCES)).toBe(false);
  });

  it("never persists transcript-like activity text in the display cache", async () => {
    const normalized = normalizeSnapshot({
      ok: true,
      data: fixtureSnapshot({
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        sequence: 4,
        selectedIndex: 0,
      }),
    });
    expect(normalized).not.toBeNull();
    const secret = "Dictated prompt: publish the private draft";
    const unsafe = {
      ...normalized!,
      slots: normalized!.slots.map((slot, index) => index === 0
        ? { ...slot, activityLabel: secret }
        : slot),
    } as unknown as BridgeSnapshot;

    await saveLastSnapshot(unsafe);

    const db = await openDB("codex-pad-display-cache", 1);
    const stored = await db.get("last-good", "snapshot") as unknown;
    db.close();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect((stored as BridgeSnapshot).slots[0]?.activityLabel).toBeNull();
  });
});

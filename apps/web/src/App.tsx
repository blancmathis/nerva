import type {
  AdjustReasoningCommand,
  Command,
  CreateTaskCommand,
  OpenSessionCommand,
  RunLibraryCommand,
  RunJoystickActionCommand,
  RunMicroActionCommand,
  RespondToApprovalCommand,
  RunSkillCommand,
  SelectAgentCommand,
  SetModelReasoningCommand,
  SavedDrawingSummary,
  SiteAssociation,
} from "@codex-pad/protocol";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandStatusToast } from "./components/CommandStatusToast";
import { CapabilityCenter } from "./components/CapabilityCenter";
import type {
  DrawingKeepPayload,
  DrawingSendPayload,
  DrawingTarget,
  SavedDrawingWorkingCopy,
} from "./components/DrawingStudio";
import type { DrawingDeliveryStatus } from "./components/drawing-delivery";
import { HomeDashboard } from "./components/HomeDashboard";
import { PairingScreen } from "./components/PairingScreen";
import { PwaUpdateBanner } from "./components/PwaUpdateBanner";
import type {
  AllowedReviewSite,
  AtomicReviewSend,
  CapturedReviewImage,
  CaptureReviewSiteInput,
} from "./components/ReviewStudio";
import { SessionWorkspace } from "./components/SessionWorkspace";
import { SiteHubPage } from "./components/SiteHubPage";
import { BrowserSiteStudio } from "./components/BrowserSiteStudio";
import { SettingsPage } from "./components/SettingsPage";
import { ChevronIcon, CloseIcon } from "./components/Icons";
import {
  createInitialHomeLayout,
  homeLayoutReducer,
  MAX_PINNED_SESSIONS,
  migrateHomeLayout,
  type HomeLayout,
  type HomeLayoutAction,
} from "./lib/home-layout";
import { loadHomeLayout, saveHomeLayout } from "./lib/home-layout-storage";
import { emptySlot, type AgentSlot, type BridgeCapabilities, type PendingApproval } from "./lib/model";
import {
  hasExactSelectedTarget,
  liveMutationSnapshot,
  supportsBridgeCommand,
  supportsSelectedTargetCommand,
  supportsSlotSelection,
  type MutationGateState,
} from "./lib/mutation-gates";
import {
  buildJoystickCommand,
  buildMicroActionCommand,
  isCodexDictationBinding,
  isCodexSubmitBinding,
  isGenericApprovalBinding,
  microActionReference,
} from "./lib/control-commands";
import { prepareReviewImage, reviewImageBlobRef, reviewImageDataUrl } from "./lib/review-media";
import { reviewCommand } from "./lib/review-command";
import { getReviewBlob, loadReviewDraft } from "./lib/review-store";
import { associatedSitePath, capturedFrameGeometry, captureViewportPreset } from "./lib/site-capture";
import { buildProductSessions, type ProductSession } from "./lib/session-presentation";
import {
  claimLegacyPresetRecovery,
  clearProductStateDirty,
  loadProductStateDirtyScope,
  loadPreferences,
  markProductStateDirty,
  savePreferences,
  type ModelReasoningPreset,
  type ProductStateDirtyScope,
  type UiPreferences,
} from "./lib/storage";
import { useBridge } from "./lib/use-bridge";
import { usePwaUpdate } from "./lib/pwa-updates";
import { createUuidV4 } from "./lib/uuid";
import { useCaptureInboxSummary } from "./lib/capture-inbox-store";
import { blobToBase64 } from "./components/drawing-image";
import type { OpenBrowserTab } from "./lib/bridge-client";
import { buildSiteQaCommand } from "./lib/site-qa-command";
import type { SiteQaSendPayload } from "./lib/site-qa-types";
import {
  activityEventForSession,
  appendSessionActivity,
  type SessionActivityEvent,
} from "./lib/activity-timeline";
import {
  disableIntelligentPush,
  enableIntelligentPush,
  notificationPermission as readNotificationPermission,
  notificationTargetFromMessage,
  notificationTargetFromUrl,
  notifySessionActivity,
  reconcileIntelligentPush,
  syncAgentBadge,
  type NervaNotificationPermission,
  type NervaNotificationTarget,
} from "./lib/agent-notifications";

type WorkspaceView = "home" | "inbox" | "session" | "sites" | "site" | "review" | "settings";

interface ActiveDictationGesture {
  readonly id: string;
  readonly bridgeInstanceId: string;
  readonly threadId: string;
  readonly action: string;
}

const SITE_SELECTION_STORAGE_KEY = "codex-pad.site-selection.v1";

function loadSiteSelections(): Readonly<Record<string, string>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SITE_SELECTION_STORAGE_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([threadId, siteId]) => (
      /^[0-9a-f-]{36}$/iu.test(threadId)
      && typeof siteId === "string"
      && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(siteId)
    )));
  } catch {
    return {};
  }
}

function saveSiteSelections(value: Readonly<Record<string, string>>): void {
  try { localStorage.setItem(SITE_SELECTION_STORAGE_KEY, JSON.stringify(value)); } catch { /* preference remains in memory */ }
}

const DrawingStudio = lazy(() => import("./components/DrawingStudio").then((module) => ({ default: module.DrawingStudio })));
const ReviewStudio = lazy(() => import("./components/ReviewStudio").then((module) => ({ default: module.ReviewStudio })));
const CaptureInboxPage = lazy(() => import("./components/CaptureInboxPage").then((module) => ({ default: module.CaptureInboxPage })));

function FeatureLoading({ label }: { readonly label: string }) {
  return <section className="feature-placeholder" aria-busy="true"><div><strong>{label}</strong><span>Opening local workspace…</span></div></section>;
}

const ACTION_ALIASES: Record<string, readonly string[]> = {
  fast: ["fast", "quick", "quickmode"],
  approve: ["approve", "accept", "allow", "appr"],
  decline: ["decline", "reject", "deny", "rej"],
  fork: ["fork", "branch", "forkthread", "split"],
  new: ["new", "newtask", "createtask", "newthread"],
};

function token(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function commandEnabled(capabilities: BridgeCapabilities, name: string): boolean {
  const expected = token(name);
  return capabilities.commands.some((command) => token(command) === expected);
}

function resolveMicroBinding(capabilities: BridgeCapabilities, canonical: string): string | null {
  if (canonical === "approve" || canonical === "decline") return null;
  const aliases = ACTION_ALIASES[canonical] ?? [canonical];
  const binding = capabilities.microActions.find((candidate) => {
    if (!candidate.enabled || isGenericApprovalBinding(candidate)) return false;
    const values = [candidate.label, candidate.nativeCommandId, candidate.keycapId]
      .filter((value): value is string => Boolean(value))
      .map(token);
    return aliases.some((alias) => values.some((value) => value === alias || value.includes(alias)));
  });
  return binding ? microActionReference(binding) : null;
}

function resolveCodexDictationBinding(capabilities: BridgeCapabilities, hasTarget: boolean): string | null {
  if (!hasTarget || !commandEnabled(capabilities, "runMicroAction")) return null;
  const binding = capabilities.microActions.find((candidate) => (
    candidate.enabled && isCodexDictationBinding(candidate)
  ));
  return binding ? microActionReference(binding) : null;
}

function resolveCodexSubmitBinding(capabilities: BridgeCapabilities, hasTarget: boolean): string | null {
  if (!hasTarget || !commandEnabled(capabilities, "runMicroAction")) return null;
  const binding = capabilities.microActions.find((candidate) => (
    candidate.enabled && isCodexSubmitBinding(candidate)
  ));
  return binding ? microActionReference(binding) : null;
}

export function resolveControlAction(
  capabilities: BridgeCapabilities,
  canonical: string,
  hasTarget: boolean,
): string | null {
  if (canonical === "select") {
    return commandEnabled(capabilities, "selectAgent") ? "semantic:selectAgent" : null;
  }
  if (canonical === "joystick") {
    return hasTarget && commandEnabled(capabilities, "runJoystickAction")
      ? "semantic:runJoystickAction"
      : null;
  }
  if (canonical.startsWith("micro:")) {
    const exactBinding = capabilities.microActions.some((binding) => (
      binding.enabled
      && !isGenericApprovalBinding(binding)
      && microActionReference(binding) === canonical
    ));
    return hasTarget && exactBinding && commandEnabled(capabilities, "runMicroAction")
      ? canonical
      : null;
  }
  if (canonical === "dictate") return resolveCodexDictationBinding(capabilities, hasTarget);
  if (canonical === "send") return resolveCodexSubmitBinding(capabilities, hasTarget);
  if (canonical === "reasoning") {
    return hasTarget && commandEnabled(capabilities, "adjustReasoning")
      ? "semantic:adjustReasoning"
      : null;
  }
  if (canonical === "skill") {
    return commandEnabled(capabilities, "runSkill") && capabilities.skills.some((skill) => skill.enabled)
      ? "semantic:runSkill"
      : null;
  }
  const native = resolveMicroBinding(capabilities, canonical);
  const nativeAvailable = native !== null && commandEnabled(capabilities, "runMicroAction");
  if (canonical === "new") {
    if (nativeAvailable && hasTarget) return native;
    return commandEnabled(capabilities, "createTask") ? "semantic:createTask" : null;
  }
  return nativeAvailable && hasTarget ? native : null;
}

function statusLabel(phase: ReturnType<typeof useBridge>["phase"]): string {
  switch (phase) {
    case "online": return "Connected";
    case "connecting": return "Connecting";
    case "reconnecting": return "Reconnecting";
    case "pairing": return "Pairing";
    case "offline": return "Offline";
  }
}

function createId(): string {
  return createUuidV4();
}

function directSiteInteractionAvailable(status: string): boolean {
  return status === "available";
}

function displaySiteHost(value: string): string {
  try { return new URL(value).hostname || "Favorite site"; }
  catch { return "Favorite site"; }
}

export function appendSkillSuffix(message: string, skillIds: readonly string[]): string {
  const unique = [...new Set(skillIds.map((skill) => skill.trim()).filter(Boolean))];
  if (unique.length === 0) return message.trim();
  const suffix = `Use the following skills for this task: ${unique.join(", ")}.`;
  const trimmed = message.trim();
  return trimmed ? `${trimmed}\n\n${suffix}` : suffix;
}

export function tryAcquireCommandMutation(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseCommandMutation(lock: { current: boolean }): void {
  lock.current = false;
}

function App() {
  const [preferences, setPreferences] = useState<UiPreferences>(loadPreferences);
  const bridge = useBridge({ allSessionsEnabled: preferences.allSessionsEnabled });
  const pwa = usePwaUpdate();
  const captureInbox = useCaptureInboxSummary();
  const [notificationPermission, setNotificationPermission] = useState<NervaNotificationPermission>(readNotificationPermission);
  const [pendingNotificationTarget, setPendingNotificationTarget] = useState<NervaNotificationTarget | null>(() => notificationTargetFromUrl(window.location));
  const pairingJourneyRef = useRef(false);
  const [view, setView] = useState<WorkspaceView>("home");
  const [homeAttentionRequestKey, setHomeAttentionRequestKey] = useState(0);
  const [homeFocusActive, setHomeFocusActive] = useState(false);
  const [reviewReturnView, setReviewReturnView] = useState<"session" | "inbox">("session");
  const [captureInboxBusy, setCaptureInboxBusy] = useState(false);
  const [captureInboxTargetThreadId, setCaptureInboxTargetThreadId] = useState<string | null>(null);
  const [sessionThreadId, setSessionThreadId] = useState<string | null>(null);
  const [homeLayout, setHomeLayout] = useState<HomeLayout | null>(null);
  const homeLayoutLoadedRef = useRef(false);
  const remoteProductStateHydratedRef = useRef(false);
  const [globalProductStateReady, setGlobalProductStateReady] = useState(false);
  const [productStateRetry, setProductStateRetry] = useState(0);
  const [productStateDirtyScope, setProductStateDirtyScope] = useState<ProductStateDirtyScope>(loadProductStateDirtyScope);
  const desiredProductStatePayloadRef = useRef<string | null>(null);
  const [followMac, setFollowMac] = useState(true);
  const previousFollowMacRef = useRef(true);
  const lastObservedMacThreadRef = useRef<string | null | undefined>(undefined);
  const ipadInitiatedMacThreadRef = useRef<string | null>(null);
  const [previousIpadView, setPreviousIpadView] = useState<{ readonly view: WorkspaceView; readonly sessionThreadId: string | null } | null>(null);
  const [selectingSlotId, setSelectingSlotId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dictationGesture, setDictationGesture] = useState<ActiveDictationGesture | null>(null);
  const commandMutationInFlightRef = useRef(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [drawingImportOnOpen, setDrawingImportOnOpen] = useState(false);
  const [drawingSending, setDrawingSending] = useState(false);
  const [drawingStatus, setDrawingStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [drawingMessage, setDrawingMessage] = useState<string | null>(null);
  const [selectedSkillsByThread, setSelectedSkillsByThread] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [savedDrawingsOpen, setSavedDrawingsOpen] = useState(false);
  const [activeBrowserTab, setActiveBrowserTab] = useState<OpenBrowserTab | null>(null);
  const [selectedSiteByThread, setSelectedSiteByThread] = useState<Readonly<Record<string, SiteAssociation>>>({});
  const [selectedSiteIdByThread, setSelectedSiteIdByThread] = useState<Readonly<Record<string, string>>>(loadSiteSelections);
  const [savedDrawingWorkingCopy, setSavedDrawingWorkingCopy] = useState<SavedDrawingWorkingCopy | null>(null);
  const [savedDrawingFilter, setSavedDrawingFilter] = useState("all");
  const [savedDrawingMessage, setSavedDrawingMessage] = useState<string | null>(null);
  const [savedDrawingBusyId, setSavedDrawingBusyId] = useState<string | null>(null);
  const [savedDrawingDeleteId, setSavedDrawingDeleteId] = useState<string | null>(null);
  const [pinReplacementThreadId, setPinReplacementThreadId] = useState<string | null>(null);
  const [activityByThread, setActivityByThread] = useState<Readonly<Record<string, readonly SessionActivityEvent[]>>>({});
  const previousSessionStatusRef = useRef<ReadonlyMap<string, ProductSession["status"]>>(new Map());

  const slots = bridge.snapshot?.slots ?? Array.from({ length: 6 }, (_, index) => emptySlot(index));
  const selected = slots.find((slot) => slot.selected)
    ?? slots.find((slot) => slot.slotId === bridge.snapshot?.selectedSlotId)
    ?? null;
  const mutationGate: MutationGateState = {
    phase: bridge.phase,
    cached: bridge.cached,
    snapshot: bridge.snapshot,
  };
  const mutationSnapshot = liveMutationSnapshot(mutationGate);
  const hasMutationAuthority = mutationSnapshot !== null;
  const capabilities = bridge.snapshot?.capabilities ?? {
    commands: [],
    microActions: [],
    joystickActions: [],
    reasoningModes: [],
    currentReasoningMode: null,
    skills: [],
    drawing: false,
    review: false,
    reviewMaxImages: 0,
    siteCapture: { available: false, reason: null },
    libraries: [],
  } satisfies BridgeCapabilities;

  const effectiveTheme = preferences.theme === "system"
    ? bridge.snapshot?.theme ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : preferences.theme;

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.motion = preferences.motion;
    document.documentElement.style.colorScheme = effectiveTheme;
  }, [effectiveTheme, preferences.motion]);

  useEffect(() => {
    if (bridge.phase === "pairing") {
      pairingJourneyRef.current = true;
      return;
    }
    if (!pairingJourneyRef.current || bridge.phase !== "online" || !bridge.snapshot?.activeThreadKey) return;
    pairingJourneyRef.current = false;
    setFollowMac(true);
    setSessionThreadId(bridge.snapshot.activeThreadKey);
    setView("session");
  }, [bridge.phase, bridge.snapshot?.activeThreadKey]);

  useEffect(() => {
    if (
      dictationGesture !== null
      && bridge.snapshot !== null
      && bridge.snapshot.bridgeInstanceId !== dictationGesture.bridgeInstanceId
    ) {
      setDictationGesture(null);
    }
  }, [bridge.snapshot?.bridgeInstanceId, dictationGesture]);

  const drawingTarget = useMemo<DrawingTarget | null>(() => {
    if (!selected?.threadId || !selected.threadKey || !bridge.snapshot) return null;
    return {
      bridgeInstanceId: bridge.snapshot.bridgeInstanceId,
      slotId: selected.slotId,
      threadId: selected.threadId,
      threadKey: selected.threadKey,
      title: selected.title,
      snapshotSeq: bridge.snapshot.seq,
    };
  }, [bridge.snapshot, selected]);

  const reconcileDrawingDelivery = useCallback(async (
    commandId: string,
  ): Promise<DrawingDeliveryStatus | null> => {
    const result = await bridge.commandStatus(commandId);
    if (!result) return null;
    return {
      state: result.state,
      ok: result.ack.ok,
      message: result.ack.message,
    };
  }, [bridge.commandStatus]);

  const sessionContexts = useMemo(() => {
    const byThreadId = new Map(bridge.nativeSessions.map((session) => [session.threadId, session]));
    for (const session of bridge.sessions) {
      if (!byThreadId.has(session.threadId)) byThreadId.set(session.threadId, session);
    }
    return [...byThreadId.values()];
  }, [bridge.nativeSessions, bridge.sessions]);
  const productSessions = useMemo(() => buildProductSessions(
    slots,
    bridge.nativeSessions,
    bridge.sessions,
    bridge.snapshot?.activeThreadKey ?? null,
  ), [bridge.nativeSessions, bridge.sessions, bridge.snapshot?.activeThreadKey, slots]);

  useEffect(() => {
    if (pendingNotificationTarget === null) return;
    setDrawingOpen(false);
    setDrawingImportOnOpen(false);
    setSavedDrawingWorkingCopy(null);
    if (pendingNotificationTarget.view === "mission") {
      setView("home");
      setHomeAttentionRequestKey((current) => current + 1);
    } else {
      setFollowMac(false);
      setSessionThreadId(pendingNotificationTarget.threadId);
      setView("session");
    }
    window.history.replaceState({}, "", "/");
    setPendingNotificationTarget(null);
  }, [pendingNotificationTarget]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const target = notificationTargetFromMessage(event.data);
      if (target !== null) setPendingNotificationTarget(target);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const refreshPermission = () => setNotificationPermission(readNotificationPermission());
    document.addEventListener("visibilitychange", refreshPermission);
    window.addEventListener("pageshow", refreshPermission);
    return () => {
      document.removeEventListener("visibilitychange", refreshPermission);
      window.removeEventListener("pageshow", refreshPermission);
    };
  }, []);

  useEffect(() => {
    if (bridge.phase !== "online" || bridge.pushStatus === null || notificationPermission !== "granted") return;
    void reconcileIntelligentPush(
      bridge.pushStatus,
      bridge.savePushSubscription,
      bridge.removePushSubscription,
    ).catch(() => undefined);
  }, [bridge.phase, bridge.pushStatus, bridge.removePushSubscription, bridge.savePushSubscription, notificationPermission]);

  useEffect(() => {
    const previous = previousSessionStatusRef.current;
    const nextStatuses = new Map<string, ProductSession["status"]>();
    const events = productSessions.flatMap((session) => {
      nextStatuses.set(session.threadId, session.status);
      const event = activityEventForSession(session, previous.get(session.threadId) ?? null);
      return event ? [event] : [];
    });
    previousSessionStatusRef.current = nextStatuses;
    if (events.length === 0) return;
    for (const event of events) {
      if (!previous.has(event.threadId)) continue;
      const session = productSessions.find((candidate) => candidate.threadId === event.threadId);
      const importantForLocalNotification = event.status !== "unread"
        || homeLayout?.pinnedThreadIds.includes(event.threadId) === true;
      if (session && importantForLocalNotification) void notifySessionActivity(
        event,
        session.title,
        preferences.notifications,
        bridge.pushStatus?.subscribed === true,
      );
    }
    setActivityByThread((current) => {
      const next = { ...current };
      for (const event of events) {
        next[event.threadId] = appendSessionActivity(next[event.threadId] ?? [], event);
      }
      return next;
    });
  }, [bridge.pushStatus?.subscribed, homeLayout?.pinnedThreadIds, preferences.notifications, productSessions]);

  useEffect(() => {
    void syncAgentBadge(productSessions, preferences.notifications);
  }, [preferences.notifications, productSessions]);
  const viewedSession = sessionThreadId
    ? productSessions.find((session) => session.threadId === sessionThreadId) ?? null
    : null;

  useEffect(() => {
    if (!savedDrawingsOpen || bridge.phase !== "online") return;
    setSavedDrawingMessage(null);
    void bridge.refreshSavedDrawings().catch(() => {
      setSavedDrawingMessage("Saved Drawings could not be loaded from the Mac.");
    });
  }, [bridge.phase, bridge.refreshSavedDrawings, savedDrawingsOpen]);

  const savedDrawingSources = useMemo(() => {
    const sources = new Map<string, string>();
    for (const drawing of bridge.savedDrawings) {
      if (!sources.has(drawing.sourceThreadId)) sources.set(drawing.sourceThreadId, drawing.sourceThreadTitle);
    }
    return [...sources.entries()].map(([threadId, title]) => ({ threadId, title }));
  }, [bridge.savedDrawings]);

  const visibleSavedDrawings = useMemo<readonly SavedDrawingSummary[]>(() => (
    savedDrawingFilter === "all"
      ? bridge.savedDrawings
      : bridge.savedDrawings.filter((drawing) => drawing.sourceThreadId === savedDrawingFilter)
  ), [bridge.savedDrawings, savedDrawingFilter]);
  const pinnedProductSessions = useMemo(() => {
    const sessionsById = new Map(productSessions.map((session) => [session.threadId, session]));
    return homeLayout?.pinnedThreadIds.flatMap((threadId) => {
      const session = sessionsById.get(threadId);
      return session ? [session] : [];
    }) ?? [];
  }, [homeLayout?.pinnedThreadIds, productSessions]);
  desiredProductStatePayloadRef.current = homeLayout === null
    ? null
    : JSON.stringify({ homeLayout, preferences });

  useEffect(() => {
    if (
      remoteProductStateHydratedRef.current
      || !bridge.snapshot
      || bridge.phase !== "online"
      || !bridge.productStateLoaded
      || !bridge.productState
    ) return;
    remoteProductStateHydratedRef.current = true;
    homeLayoutLoadedRef.current = true;
    void loadHomeLayout().then((stored) => {
      const remote = bridge.productState;
      const recoveringLegacyPresets = remote !== null && claimLegacyPresetRecovery(preferences, remote.preferences);
      const preferencesDirty = productStateDirtyScope.preferences || recoveringLegacyPresets;
      if (recoveringLegacyPresets) {
        markProductStateDirty("preferences");
        setProductStateDirtyScope((current) => ({ ...current, preferences: true }));
      }
      if (productStateDirtyScope.homeLayout || preferencesDirty) {
        const nextLayout = productStateDirtyScope.homeLayout
          ? stored ?? (remote ? migrateHomeLayout(remote.homeLayout) : createInitialHomeLayout([]))
          : remote ? migrateHomeLayout(remote.homeLayout) : stored ?? createInitialHomeLayout([]);
        setHomeLayout(nextLayout);
        if (!preferencesDirty && remote) {
          setPreferences(remote.preferences);
          savePreferences(remote.preferences);
        }
        void saveHomeLayout(nextLayout);
        return;
      }
      const remoteIsPristine = remote?.revision === 0
        && remote.homeLayout.pinnedThreadIds.length === 0
        && remote.homeLayout.manual.sections.length === 0;
      if (remote && (!remoteIsPristine || !stored)) {
        const nextLayout = migrateHomeLayout(remote.homeLayout);
        setHomeLayout(nextLayout);
        setPreferences(remote.preferences);
        savePreferences(remote.preferences);
        void saveHomeLayout(nextLayout);
        return;
      }
      if (stored) {
        setHomeLayout(stored);
        return;
      }
      const initial = createInitialHomeLayout([]);
      setHomeLayout({ ...initial, mode: preferences.defaultHomeMode });
    }).finally(() => setGlobalProductStateReady(true));
  }, [bridge.phase, bridge.productState, bridge.productStateLoaded, bridge.snapshot, preferences.defaultHomeMode, productStateDirtyScope.homeLayout, productStateDirtyScope.preferences]);

  useEffect(() => {
    if (homeLayoutLoadedRef.current || !bridge.snapshot) return;
    const fallbackReady = bridge.phase === "offline"
      || bridge.phase === "reconnecting"
      || (bridge.phase === "online" && bridge.productStateLoaded && !bridge.productState);
    if (!fallbackReady) return;
    homeLayoutLoadedRef.current = true;
    void loadHomeLayout().then((stored) => {
      if (stored) {
        setHomeLayout(stored);
        return;
      }
      const initial = createInitialHomeLayout([]);
      setHomeLayout({ ...initial, mode: preferences.defaultHomeMode });
    });
  }, [bridge.phase, bridge.productState, bridge.productStateLoaded, bridge.snapshot, preferences.defaultHomeMode]);

  useEffect(() => {
    if (!homeLayout) return;
    void saveHomeLayout(homeLayout);
    if (!homeLayoutLoadedRef.current || !globalProductStateReady || !bridge.productState) return;
    const mergedHomeLayout = productStateDirtyScope.homeLayout
      ? homeLayout
      : migrateHomeLayout(bridge.productState.homeLayout);
    const mergedPreferences = productStateDirtyScope.preferences
      ? preferences
      : bridge.productState.preferences;
    const localPayload = JSON.stringify({ homeLayout: mergedHomeLayout, preferences: mergedPreferences });
    const remotePayload = JSON.stringify({
      homeLayout: bridge.productState.homeLayout,
      preferences: bridge.productState.preferences,
    });
    if (localPayload === remotePayload) {
      clearProductStateDirty();
      setProductStateDirtyScope({ homeLayout: false, preferences: false });
      if (JSON.stringify(homeLayout) !== JSON.stringify(mergedHomeLayout)) {
        setHomeLayout(mergedHomeLayout);
        void saveHomeLayout(mergedHomeLayout);
      }
      if (JSON.stringify(preferences) !== JSON.stringify(mergedPreferences)) {
        setPreferences(mergedPreferences);
        savePreferences(mergedPreferences);
      }
      return;
    }
    if (!productStateDirtyScope.homeLayout && !productStateDirtyScope.preferences) return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    void bridge.saveProductState(mergedHomeLayout, mergedPreferences).then((result) => {
      if (!active) return;
      if (result.ok) {
        if (desiredProductStatePayloadRef.current === localPayload) {
          clearProductStateDirty();
          setProductStateDirtyScope({ homeLayout: false, preferences: false });
        }
        return;
      }
      retryTimer = setTimeout(() => setProductStateRetry((value) => value + 1), 1_500);
    });
    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [bridge.productState, bridge.saveProductState, globalProductStateReady, homeLayout, preferences, productStateDirtyScope.homeLayout, productStateDirtyScope.preferences, productStateRetry]);

  useEffect(() => {
    const activeThreadId = bridge.snapshot?.activeThreadKey ?? null;
    const followJustEnabled = followMac && !previousFollowMacRef.current;
    previousFollowMacRef.current = followMac;
    if (lastObservedMacThreadRef.current === undefined || lastObservedMacThreadRef.current === null) {
      lastObservedMacThreadRef.current = activeThreadId;
      return;
    }
    if (ipadInitiatedMacThreadRef.current !== null) {
      if (activeThreadId && activeThreadId === ipadInitiatedMacThreadRef.current) {
        ipadInitiatedMacThreadRef.current = null;
        lastObservedMacThreadRef.current = activeThreadId;
      }
      return;
    }
    if (!activeThreadId) return;
    const macTaskChanged = activeThreadId !== lastObservedMacThreadRef.current;
    lastObservedMacThreadRef.current = activeThreadId;
    if (view === "inbox" || (view === "home" && homeFocusActive)) return;
    if (!followMac) return;
    if (!macTaskChanged && !followJustEnabled) return;
    const ipadAlreadyShowsMacTask = view === "session" && sessionThreadId === activeThreadId;
    if (ipadAlreadyShowsMacTask) return;
    setPreviousIpadView({ view, sessionThreadId });
    setDrawingOpen(false);
    setDrawingImportOnOpen(false);
    setSavedDrawingWorkingCopy(null);
    setSessionThreadId(activeThreadId);
    setView("session");
  }, [bridge.snapshot?.activeThreadKey, followMac, homeFocusActive, sessionThreadId, view]);

  const selectedAssociation = useMemo(() => {
    if (!viewedSession) return null;
    return selectedSiteByThread[viewedSession.threadId]
      ?? viewedSession.siteAssociations.find((association) => association.associationId === selectedSiteIdByThread[viewedSession.threadId])
      ?? viewedSession.siteAssociations[0]
      ?? null;
  }, [selectedSiteByThread, selectedSiteIdByThread, viewedSession]);

  const reviewSite = useMemo<AllowedReviewSite | null>(() => {
    const association = selectedAssociation;
    if (!association) return null;
    const directAvailable = directSiteInteractionAvailable(association.interactionModes.direct.status);
    const captureAvailable = directAvailable
      && association.capabilities.canCaptureFrames
      && capabilities.siteCapture.available;
    const captureDetail = directAvailable
      ? association.capabilities.reason ?? capabilities.siteCapture.reason
      : association.interactionModes.direct.detail;
    return {
      url: association.origin,
      allowedOrigin: association.origin,
      title: association.name,
      captureCapability: captureAvailable ? "available" : "degraded",
      ...(captureDetail ? { captureDetail } : {}),
      interactionModes: association.interactionModes,
    };
  }, [capabilities.siteCapture, selectedAssociation]);

  function updatePreferences(next: UiPreferences) {
    const nextScope = markProductStateDirty("preferences");
    setProductStateDirtyScope((current) => ({ ...current, preferences: nextScope.preferences }));
    setPreferences(next);
    savePreferences(next);
  }

  function dispatchHomeLayout(action: HomeLayoutAction) {
    const nextScope = markProductStateDirty("homeLayout");
    setProductStateDirtyScope((current) => ({ ...current, homeLayout: nextScope.homeLayout }));
    setHomeLayout((current) => current ? homeLayoutReducer(current, action) : current);
  }

  function resolveAction(canonical: string): string | null {
    if (!hasMutationAuthority) return null;
    return resolveControlAction(
      capabilities,
      canonical,
      mutationSnapshot !== null && hasExactSelectedTarget(mutationSnapshot, selected),
    );
  }

  function beginCommandMutation(action: string): boolean {
    if (!tryAcquireCommandMutation(commandMutationInFlightRef)) return false;
    setBusyAction(action);
    return true;
  }

  function finishCommandMutation() {
    releaseCommandMutation(commandMutationInFlightRef);
    setBusyAction(null);
  }

  async function selectSlot(slot: AgentSlot) {
    const snapshot = liveMutationSnapshot(mutationGate);
    if (!snapshot || !supportsSlotSelection(mutationGate, slot) || !slot.threadId) return;
    const command: SelectAgentCommand = {
      type: "selectAgent",
      commandId: createId(),
      expectedBridgeInstanceId: snapshot.bridgeInstanceId,
      expectedSequence: snapshot.seq,
      expectedThreadId: slot.threadId,
      slot: slot.index as 0 | 1 | 2 | 3 | 4 | 5,
    };
    setSelectingSlotId(slot.slotId);
    try {
      await bridge.command(command);
    } finally {
      setSelectingSlotId(null);
    }
  }

  async function runControl(action: string, value?: string) {
    const snapshot = liveMutationSnapshot(mutationGate);
    if (!snapshot) return;
    let command: Command | null = null;
    if (action.startsWith("micro:")) {
      if (
        !selected?.threadId
        || !supportsSelectedTargetCommand(mutationGate, "runMicroAction", selected)
        || resolveControlAction(capabilities, action, true) !== action
      ) return;
      if (
        selected.status === "awaiting-approval"
        || snapshot.pendingApprovals.some((approval) => approval.threadId === selected.threadId)
      ) return;
      const [, actionSlot, encodedKeycapId, encodedNativeCommandId] = action.split(":");
      if (!actionSlot || !encodedKeycapId || encodedNativeCommandId === undefined) return;
      command = buildMicroActionCommand(
        snapshot,
        selected.threadId,
        actionSlot as RunMicroActionCommand["actionSlot"],
        decodeURIComponent(encodedKeycapId),
        encodedNativeCommandId === "" ? null : decodeURIComponent(encodedNativeCommandId),
        createId(),
      );
    } else if (action === "semantic:createTask") {
      if (!supportsBridgeCommand(mutationGate, "createTask")) return;
      command = {
        type: "createTask",
        commandId: createId(),
        expectedBridgeInstanceId: snapshot.bridgeInstanceId,
        expectedSequence: snapshot.seq,
        expectedThreadId: null,
        instruction: null,
      } satisfies CreateTaskCommand;
    } else if (action === "semantic:adjustReasoning" && selected?.threadId) {
      if (!supportsSelectedTargetCommand(mutationGate, "adjustReasoning", selected)) return;
      if (
        selected.status === "awaiting-approval"
        || snapshot.pendingApprovals.some((approval) => approval.threadId === selected.threadId)
      ) return;
      command = {
        type: "adjustReasoning",
        commandId: createId(),
        expectedBridgeInstanceId: snapshot.bridgeInstanceId,
        expectedSequence: snapshot.seq,
        expectedThreadId: selected.threadId,
        adjustment: value === "decrease" ? "decrease" : "increase",
      } satisfies AdjustReasoningCommand;
    } else if (action === "semantic:runSkill" && selected?.threadId && value) {
      if (
        !supportsSelectedTargetCommand(mutationGate, "runSkill", selected)
        || !capabilities.skills.some((skill) => skill.id === value && skill.enabled)
      ) return;
      command = {
        type: "runSkill",
        commandId: createId(),
        expectedBridgeInstanceId: snapshot.bridgeInstanceId,
        expectedSequence: snapshot.seq,
        expectedThreadId: selected.threadId,
        targetThreadId: selected.threadId,
        skillName: value,
      } satisfies RunSkillCommand;
    }
    if (!command) return;
    const canonical = ["fast", "approve", "decline", "fork", "dictate", "send", "new", "reasoning", "skill"]
      .find((name) => resolveAction(name) === action) ?? action;
    if (!beginCommandMutation(canonical)) return;
    try {
      await bridge.command(command);
    } finally {
      finishCommandMutation();
    }
  }

  async function toggleDictation() {
    const snapshot = liveMutationSnapshot(mutationGate);
    const active = dictationGesture;
    const action = active?.action ?? resolveAction("dictate");
    if (
      !snapshot
      || !selected?.threadId
      || !action?.startsWith("micro:")
      || !supportsSelectedTargetCommand(mutationGate, "runMicroAction", selected)
      || (active !== null && active.threadId !== selected.threadId)
    ) return;
    const [, actionSlot, encodedKeycapId, encodedNativeCommandId] = action.split(":");
    if (!actionSlot || !encodedKeycapId || encodedNativeCommandId === undefined) return;
    const commandId = createId();
    const gesture = active === null ? "begin" : "end";
    const gestureId = active?.id ?? commandId;
    const command = buildMicroActionCommand(
      snapshot,
      selected.threadId,
      actionSlot as RunMicroActionCommand["actionSlot"],
      decodeURIComponent(encodedKeycapId),
      encodedNativeCommandId === "" ? null : decodeURIComponent(encodedNativeCommandId),
      commandId,
      gesture,
      gestureId,
    );
    if (!command || !beginCommandMutation("dictate")) return;
    try {
      const ack = await bridge.command(command);
      if (!ack.ok && !ack.pending) return;
      if (gesture === "begin") {
        setFollowMac(false);
        setDictationGesture({
          id: gestureId,
          bridgeInstanceId: snapshot.bridgeInstanceId,
          threadId: selected.threadId,
          action,
        });
      } else {
        setDictationGesture(null);
      }
    } finally {
      finishCommandMutation();
    }
  }

  async function sendPrompt() {
    const submitAction = resolveAction("send");
    const active = dictationGesture;
    if (submitAction === null) return;
    if (active === null) {
      await runControl(submitAction);
      return;
    }

    const snapshot = liveMutationSnapshot(mutationGate);
    if (
      !snapshot
      || !selected?.threadId
      || active.threadId !== selected.threadId
      || !active.action.startsWith("micro:")
      || !submitAction.startsWith("micro:")
      || !supportsSelectedTargetCommand(mutationGate, "runMicroAction", selected)
      || selected.status === "awaiting-approval"
      || snapshot.pendingApprovals.some((approval) => approval.threadId === selected.threadId)
    ) return;

    const [, dictationSlot, encodedDictationKeycapId, encodedDictationCommandId] = active.action.split(":");
    const [, submitSlot, encodedSubmitKeycapId, encodedSubmitCommandId] = submitAction.split(":");
    if (
      !dictationSlot
      || !encodedDictationKeycapId
      || encodedDictationCommandId === undefined
      || !submitSlot
      || !encodedSubmitKeycapId
      || encodedSubmitCommandId === undefined
    ) return;

    const stopCommand = buildMicroActionCommand(
      snapshot,
      selected.threadId,
      dictationSlot as RunMicroActionCommand["actionSlot"],
      decodeURIComponent(encodedDictationKeycapId),
      encodedDictationCommandId === "" ? null : decodeURIComponent(encodedDictationCommandId),
      createId(),
      "end",
      active.id,
    );
    if (!stopCommand || !beginCommandMutation("send")) return;

    try {
      const stopAck = await bridge.command(stopCommand);
      if (!stopAck.ok || stopAck.pending || stopAck.sequence === undefined) return;
      setDictationGesture(null);

      const submitCommand = buildMicroActionCommand(
        { ...snapshot, seq: stopAck.sequence },
        selected.threadId,
        submitSlot as RunMicroActionCommand["actionSlot"],
        decodeURIComponent(encodedSubmitKeycapId),
        encodedSubmitCommandId === "" ? null : decodeURIComponent(encodedSubmitCommandId),
        createId(),
      );
      if (submitCommand) await bridge.command(submitCommand);
    } finally {
      finishCommandMutation();
    }
  }

  async function setModelReasoning(preset: Pick<ModelReasoningPreset, "model" | "reasoning">): Promise<boolean> {
    const snapshot = liveMutationSnapshot(mutationGate);
    if (
      !snapshot
      || !selected?.threadId
      || !supportsSelectedTargetCommand(mutationGate, "setModelReasoning", selected)
      || !capabilities.models?.some((model) => (
        model.model === preset.model
        && model.supportedReasoningEfforts.includes(preset.reasoning)
      ))
      || !beginCommandMutation("model-reasoning")
    ) return false;
    const command: SetModelReasoningCommand = {
      type: "setModelReasoning",
      commandId: createId(),
      expectedBridgeInstanceId: snapshot.bridgeInstanceId,
      expectedSequence: snapshot.seq,
      expectedThreadId: selected.threadId,
      model: preset.model,
      effort: preset.reasoning,
    };
    try {
      const ack = await bridge.command(command);
      return ack.ok || ack.pending === true;
    } finally {
      finishCommandMutation();
    }
  }

  async function respondToApproval(approval: PendingApproval, decision: "accept" | "decline") {
    const snapshot = liveMutationSnapshot(mutationGate);
    if (
      !snapshot
      || !selected?.threadId
      || !supportsSelectedTargetCommand(mutationGate, "respondToApproval", selected)
    ) return;
    const current = snapshot.pendingApprovals.find((candidate) => (
      candidate.requestId === approval.requestId
      && candidate.threadId === approval.threadId
      && candidate.turnId === approval.turnId
      && candidate.itemId === approval.itemId
      && candidate.kind === approval.kind
      && candidate.actionable
    ));
    if (!current || current.threadId !== selected.threadId) return;
    const action = `approval:${decision}:${typeof current.requestId}:${String(current.requestId)}`;
    if (!beginCommandMutation(action)) return;
    const command: RespondToApprovalCommand = {
      type: "respondToApproval",
      commandId: createId(),
      expectedBridgeInstanceId: snapshot.bridgeInstanceId,
      expectedSequence: snapshot.seq,
      expectedThreadId: current.threadId,
      requestId: current.requestId,
      turnId: current.turnId,
      itemId: current.itemId,
      approvalKind: current.kind,
      decision,
    };
    try {
      await bridge.command(command);
    } finally {
      finishCommandMutation();
    }
  }

  async function runJoystick(direction: RunJoystickActionCommand["direction"]) {
    const snapshot = liveMutationSnapshot(mutationGate);
    if (
      !snapshot
      || !selected?.threadId
      || !supportsSelectedTargetCommand(mutationGate, "runJoystickAction", selected)
    ) return;
    if (
      selected.status === "awaiting-approval"
      || snapshot.pendingApprovals.some((approval) => approval.threadId === selected.threadId)
    ) return;
    // Resolve from the current authoritative snapshot at click time; never reuse
    // a keycap ID captured before a native reassignment.
    const command = buildJoystickCommand(snapshot, selected.threadId, direction, createId());
    if (!command) return;
    if (!beginCommandMutation(`joystick:${direction}`)) return;
    try {
      await bridge.command(command);
    } finally {
      finishCommandMutation();
    }
  }

  async function sendDrawing(payload: DrawingSendPayload) {
    if (
      !supportsSelectedTargetCommand(mutationGate, "sendSketch", selected)
      || !capabilities.drawing
      || !mutationSnapshot
      || payload.expectedBridgeInstanceId !== mutationSnapshot.bridgeInstanceId
      || payload.expectedSnapshotSeq !== mutationSnapshot.seq
      || !selected?.threadId
      || selected.threadId !== payload.threadId
      || selected.slotId !== payload.slotId
    ) {
      return { ok: false, message: "The exact selected task changed. Close and reopen the canvas before attaching." };
    }
    setDrawingSending(true);
    setDrawingStatus("sending");
    setDrawingMessage("Attaching the sketch to the Mac composer…");
    try {
      const ack = await bridge.sketch({
        commandId: payload.commandId,
        expectedBridgeInstanceId: payload.expectedBridgeInstanceId,
        expectedSnapshotSeq: payload.expectedSnapshotSeq,
        slotId: payload.slotId,
        threadKey: payload.threadKey,
        // Drawing only attaches one image to the Mac composer. It never submits
        // the composer or injects text; the user remains in control of Send.
        instruction: "",
        png: payload.png,
      });
      if (!ack.ok) {
        setDrawingStatus("error");
        setDrawingMessage(ack.message);
        return { ok: false, message: ack.message, deliveryUnknown: ack.pending === true };
      }
      setDrawingStatus("sent");
      setDrawingMessage(ack.pending
        ? "Composer attachment acknowledgement is still in progress; no message was submitted."
        : ack.message);
      return { ok: true, pending: ack.pending === true, message: ack.message };
    } catch (error) {
      setDrawingStatus("error");
      setDrawingMessage(error instanceof Error ? error.message : "Sketch attachment was not accepted. It was not replayed.");
      return {
        ok: false,
        deliveryUnknown: true,
        message: error instanceof Error ? error.message : "Attachment outcome is unknown.",
      };
    } finally {
      setDrawingSending(false);
    }
  }

  async function sendSiteAnnotation(png: Blob) {
    if (!drawingTarget) return { ok: false, message: "The exact selected task is unavailable." };
    return sendDrawing({
      commandId: createId(),
      expectedBridgeInstanceId: drawingTarget.bridgeInstanceId,
      slotId: drawingTarget.slotId,
      threadId: drawingTarget.threadId,
      threadKey: drawingTarget.threadKey ?? drawingTarget.threadId,
      snapshotSeq: drawingTarget.snapshotSeq,
      expectedSnapshotSeq: drawingTarget.snapshotSeq,
      instruction: "",
      png,
      pngBase64: await blobToBase64(png),
      scene: null,
      background: "white",
    });
  }

  async function sendSiteQaRecording(payload: SiteQaSendPayload) {
    const snapshot = liveMutationSnapshot(mutationGate);
    if (
      !snapshot
      || !selected?.threadId
      || selected.threadId !== payload.manifest.sourceThreadId
      || !supportsSelectedTargetCommand(mutationGate, "sendReview", selected)
      || !capabilities.review
      || capabilities.reviewMaxImages === 0
      || payload.frames.length > capabilities.reviewMaxImages
    ) {
      return { ok: false, message: "This exact Codex task cannot accept the complete QA report right now. It remains saved locally." };
    }
    try {
      const armedSkills = selectedSkillsByThread[payload.manifest.sourceThreadId] ?? [];
      const suffix = appendSkillSuffix("", armedSkills);
      const command = await buildSiteQaCommand({
        payload,
        // Reopening a saved recording cannot create a second Codex task for
        // the same approved report.
        commandId: payload.manifest.recordingId,
        bridgeInstanceId: snapshot.bridgeInstanceId,
        threadId: selected.threadId,
        snapshotSeq: snapshot.seq,
        instructionSuffix: suffix ? `\n\n${suffix}` : "",
      });
      const ack = await bridge.command(command);
      if (ack.ok && armedSkills.length > 0) {
        setSelectedSkillsByThread((current) => ({ ...current, [payload.manifest.sourceThreadId]: [] }));
      }
      return { ok: ack.ok, pending: ack.pending === true, message: ack.message };
    } catch (caught) {
      return { ok: false, message: caught instanceof Error ? caught.message : "The QA report could not be prepared." };
    }
  }

  async function keepDrawing(payload: DrawingKeepPayload) {
    return bridge.saveDrawing(payload);
  }

  async function useSavedDrawing(drawingId: string) {
    if (!viewedSession || !targetReady) {
      setSavedDrawingMessage("Open this session on the Mac before using a saved drawing here.");
      return;
    }
    setSavedDrawingBusyId(drawingId);
    setSavedDrawingMessage(null);
    try {
      const drawing = await bridge.loadSavedDrawing(drawingId);
      if (!drawing) {
        setSavedDrawingMessage("This saved drawing is no longer available on the Mac.");
        return;
      }
      setSavedDrawingWorkingCopy({
        id: drawing.id,
        sceneJson: drawing.sceneJson,
        instruction: drawing.instruction,
      });
      setDrawingImportOnOpen(false);
      setDrawingStatus("idle");
      setDrawingMessage(null);
      setSavedDrawingsOpen(false);
      setDrawingOpen(true);
    } finally {
      setSavedDrawingBusyId(null);
    }
  }

  async function deleteSavedDrawing(drawingId: string) {
    setSavedDrawingBusyId(drawingId);
    setSavedDrawingMessage(null);
    try {
      const result = await bridge.deleteSavedDrawing(drawingId);
      setSavedDrawingMessage(result.message);
      if (result.ok) setSavedDrawingDeleteId(null);
    } finally {
      setSavedDrawingBusyId(null);
    }
  }

  async function openProductSession(session: ProductSession) {
    setSessionThreadId(session.threadId);
    setView("session");
    const snapshot = liveMutationSnapshot(mutationGate);
    if (!snapshot) return;
    ipadInitiatedMacThreadRef.current = session.threadId;
    if (supportsBridgeCommand(mutationGate, "openSession")) {
      const command: OpenSessionCommand = {
        type: "openSession",
        commandId: createId(),
        expectedBridgeInstanceId: snapshot.bridgeInstanceId,
        expectedSequence: snapshot.seq,
        expectedThreadId: session.threadId,
        targetThreadId: session.threadId,
      };
      const ack = await bridge.command(command);
      if (
        !ack.ok
        && !ack.pending
        && ipadInitiatedMacThreadRef.current === session.threadId
      ) {
        ipadInitiatedMacThreadRef.current = null;
      }
      return;
    }
    // Compatibility with an older bridge that only exposes native slot
    // selection. Current bridges always use the exact thread deep-link above.
    const native = session.nativeSlot;
    if (native && !native.selected) await selectSlot(native);
  }

  async function sendReview(payload: AtomicReviewSend) {
    const snapshot = liveMutationSnapshot(mutationGate);
    if (
      !snapshot
      || !supportsSelectedTargetCommand(mutationGate, "sendReview", selected)
      || !selected?.threadId
      || selected.threadId !== payload.targetThreadId
      || payload.expectedBridgeInstanceId !== snapshot.bridgeInstanceId
      || payload.snapshotSeq !== snapshot.seq
    ) {
      return { ok: false, message: "The selected task or snapshot changed. Reopen the send review for the current task." };
    }
    const imageCount = payload.manifest.images.length;
    if (
      !capabilities.review
      || capabilities.reviewMaxImages === 0
      || imageCount < 1
      || imageCount > capabilities.reviewMaxImages
    ) {
      return {
        ok: false,
        message: capabilities.reviewMaxImages === 1 && imageCount > 1
          ? `This Codex connection can send one image per review. The ${imageCount}-image deck remains local and was not dropped, flattened, split, or sent.`
          : "Review delivery is unavailable for this exact image manifest. Nothing was sent.",
      };
    }
    try {
      const armedSkills = selectedSkillsByThread[payload.targetThreadId] ?? [];
      const command = await reviewCommand({
        ...payload,
        manifest: {
          ...payload.manifest,
          instruction: appendSkillSuffix(payload.manifest.instruction, armedSkills),
        },
      });
      const ack = await bridge.command(command);
      if (ack.ok && armedSkills.length > 0) {
        setSelectedSkillsByThread((current) => ({ ...current, [payload.targetThreadId]: [] }));
      }
      return { ok: ack.ok, pending: ack.pending === true, message: ack.message };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "The review could not be prepared." };
    }
  }

  async function captureAssociatedSite(input: CaptureReviewSiteInput): Promise<CapturedReviewImage> {
    if (
      !hasMutationAuthority
      || !selected?.threadId
      || !mutationSnapshot
      || !hasExactSelectedTarget(mutationSnapshot, selected)
      || !selectedAssociation
      || !capabilities.siteCapture.available
    ) {
      throw new Error(capabilities.siteCapture.reason ?? "Site capture is unavailable.");
    }
    const { width, height } = input.viewport;
    const viewport = captureViewportPreset(width, height);
    const result = await bridge.captureSite({
      siteId: selectedAssociation.associationId,
      threadId: selected.threadId,
      path: associatedSitePath(input.url, selectedAssociation.origin),
      viewport,
      scroll: {
        x: Math.max(0, Math.min(1_000_000, Math.round(input.scroll.x))),
        y: Math.max(0, Math.min(1_000_000, Math.round(input.scroll.y))),
      },
    });
    const binary = atob(result.pngBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const prepared = await prepareReviewImage(new Blob([bytes], { type: "image/png" }), result.title ?? "site-capture.png");
    return {
      ...prepared,
      geometry: capturedFrameGeometry(result),
      finalPath: result.finalPath,
      title: result.title,
    };
  }

  if (bridge.phase === "pairing") return <PairingScreen onPair={bridge.pair} />;

  const targetReady = Boolean(
    viewedSession
    && selected?.threadId === viewedSession.threadId
    && mutationSnapshot
    && hasExactSelectedTarget(mutationSnapshot, selected),
  );
  const selectedSkillIds = viewedSession ? selectedSkillsByThread[viewedSession.threadId] ?? [] : [];
  const pendingApprovals = viewedSession
    ? bridge.snapshot?.pendingApprovals.filter((approval) => approval.threadId === viewedSession.threadId) ?? []
    : [];
  const macUnavailable = bridge.phase !== "online" || bridge.snapshot?.health === "offline";

  function toggleViewedSkill(skillId: string) {
    if (!viewedSession || !capabilities.skills.some((skill) => skill.id === skillId && skill.enabled)) return;
    setSelectedSkillsByThread((current) => {
      const selectedSkills = current[viewedSession.threadId] ?? [];
      return {
        ...current,
        [viewedSession.threadId]: selectedSkills.includes(skillId)
          ? selectedSkills.filter((candidate) => candidate !== skillId)
          : [...selectedSkills, skillId],
      };
    });
  }

  function returnHome() {
    setActiveBrowserTab(null);
    setView("home");
    setSessionThreadId(null);
  }

  return (
    <div className="app-shell cp-app-shell" data-view={view}>
      <header className="cp-topbar">
        <button type="button" className="cp-brand" aria-label="Open Nerva Home" onClick={returnHome}>
          <span className="cp-brand__mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <span><strong>Nerva</strong><small>Agentic dev control</small></span>
        </button>
        <nav aria-label="Current location">
          {viewedSession && view !== "inbox" && <button type="button" aria-current={view === "session" ? "page" : undefined} onClick={() => setView("session")}>{viewedSession.title}</button>}
          {view === "sites" && <><ChevronIcon /><span>Sites</span></>}
          {view === "site" && <><ChevronIcon /><span>Live Site</span></>}
          {view === "review" && <><ChevronIcon /><span>Site Review</span></>}
          {view === "inbox" && <span>Capture Inbox</span>}
          {view === "settings" && <span>Settings</span>}
        </nav>
        <div className="cp-topbar__status">
          <CapabilityCenter
            phase={bridge.phase}
            diagnostics={bridge.runtimeDiagnostics}
            diagnosticsLoaded={bridge.runtimeDiagnosticsLoaded}
            pwa={pwa}
            pushStatus={bridge.pushStatus}
            pushStatusLoaded={bridge.pushStatusLoaded}
            onRefresh={async () => {
              await Promise.all([bridge.refreshRuntimeDiagnostics(), bridge.refreshPushStatus()]);
            }}
            onCheckForUpdate={pwa.check}
          />
          <span className={`cp-connection phase-${bridge.phase}`}><i aria-hidden="true" /><span>{bridge.phase === "online" ? "Mac connected" : statusLabel(bridge.phase)}</span></span>
          {bridge.snapshot && <span className="cp-sequence">#{bridge.snapshot.seq}</span>}
        </div>
      </header>

      <div className="cp-app-content">
        {view === "home" && homeLayout && (
          <HomeDashboard
            layout={homeLayout}
            sessions={productSessions}
            compactCards={preferences.cardDensity === "compact"}
            macUnavailable={macUnavailable}
            codexUsage={bridge.codexUsage}
            codexUsageLoaded={bridge.codexUsageLoaded}
            onLayoutAction={dispatchHomeLayout}
            onOpenSession={(session) => void openProductSession(session)}
            onOpenCurrentMacSession={() => {
              const current = productSessions.find((session) => session.activeOnMac);
              if (current) void openProductSession(current);
            }}
            attentionRequestKey={homeAttentionRequestKey}
            onFocusChange={setHomeFocusActive}
            onOpenCaptureInbox={() => { setCaptureInboxTargetThreadId(null); setView("inbox"); }}
            captureInboxCount={captureInbox.summary.count}
            onOpenSettings={() => setView("settings")}
            onRefreshCodexUsage={() => void bridge.refreshCodexUsage()}
          />
        )}

        {view === "home" && !homeLayout && <FeatureLoading label="Preparing Home" />}

        {view === "inbox" && (
          <Suspense fallback={<FeatureLoading label="Capture Inbox" />}>
            <CaptureInboxPage
              targetSession={captureInboxTargetThreadId === null
                ? null
                : productSessions.find((session) => session.threadId === captureInboxTargetThreadId) ?? null}
              macUnavailable={macUnavailable}
              onBusyChange={setCaptureInboxBusy}
              onUseInSession={(threadId) => {
                setSessionThreadId(threadId);
                setFollowMac(false);
                setReviewReturnView("session");
                setView("review");
              }}
              onBackToSession={() => {
                if (captureInboxTargetThreadId === null) return;
                setSessionThreadId(captureInboxTargetThreadId);
                setFollowMac(false);
                setView("session");
              }}
            />
          </Suspense>
        )}

        {view === "session" && viewedSession && (
          <SessionWorkspace
            session={viewedSession}
            pinned={homeLayout?.pinnedThreadIds.includes(viewedSession.threadId) ?? false}
            followMac={followMac}
            targetReady={targetReady}
            macUnavailable={macUnavailable}
            skills={capabilities.skills}
            selectedSkillIds={selectedSkillIds}
            reasoningModes={capabilities.reasoningModes}
            currentReasoningMode={capabilities.currentReasoningMode}
            currentModel={capabilities.currentModel ?? null}
            models={capabilities.models ?? []}
            modelReasoningPresets={preferences.modelReasoningPresets}
            modelReasoningEnabled={supportsSelectedTargetCommand(mutationGate, "setModelReasoning", selected)}
            dictationAction={dictationGesture?.threadId === viewedSession.threadId
              ? dictationGesture.action
              : resolveAction("dictate")}
            dictationActive={dictationGesture?.threadId === viewedSession.threadId}
            fastAction={resolveAction("fast")}
            sendAction={resolveAction("send")}
            pendingApprovals={pendingApprovals}
            approvalEnabled={supportsSelectedTargetCommand(mutationGate, "respondToApproval", selected)}
            busyAction={busyAction}
            activityEvents={activityByThread[viewedSession.threadId] ?? []}
            captureInboxCount={captureInbox.summary.count}
            onTogglePin={() => {
              if (!homeLayout) return;
              if (homeLayout.pinnedThreadIds.includes(viewedSession.threadId)) {
                dispatchHomeLayout({ type: "unpin", threadId: viewedSession.threadId });
                return;
              }
              if (homeLayout.pinnedThreadIds.length >= MAX_PINNED_SESSIONS) {
                setPinReplacementThreadId(viewedSession.threadId);
                return;
              }
              dispatchHomeLayout({ type: "pin", threadId: viewedSession.threadId });
            }}
            onToggleFollow={() => setFollowMac((current) => !current)}
            onToggleSkill={toggleViewedSkill}
            onRunAction={(action, value) => void runControl(action, value)}
            onSendPrompt={() => void sendPrompt()}
            onToggleDictation={() => void toggleDictation()}
            onSetModelReasoning={setModelReasoning}
            onApprovalDecision={(approval, decision) => void respondToApproval(approval, decision)}
            onOpenDrawing={(importPhoto) => {
              setDrawingStatus("idle");
              setDrawingMessage(null);
              setDrawingImportOnOpen(importPhoto);
              setSavedDrawingWorkingCopy(null);
              setDrawingOpen(true);
            }}
            onOpenReview={() => setView("sites")}
            onOpenImageReview={() => { setReviewReturnView("session"); setView("review"); }}
            onOpenCaptureInbox={() => { setCaptureInboxTargetThreadId(viewedSession.threadId); setView("inbox"); }}
            onOpenSavedDrawings={() => setSavedDrawingsOpen(true)}
            onOpenOnMac={() => void openProductSession(viewedSession)}
          />
        )}

        {view === "sites" && viewedSession && (
          <SiteHubPage
            threadId={viewedSession.threadId}
            threadTitle={viewedSession.title}
            favorites={preferences.siteFavorites}
            fetchBrowserTabs={bridge.fetchOpenBrowserTabs}
            onOpenTab={(tab) => { setActiveBrowserTab(tab); setView("site"); }}
            onNavigateTab={async (tab, url) => {
              const next = await bridge.controlBrowserTab(viewedSession.threadId, tab.id, { type: "navigate", url });
              setActiveBrowserTab({ ...tab, title: next.title, url: next.url });
              setView("site");
            }}
            onFavoritesChange={(siteFavorites) => updatePreferences({ ...preferences, siteFavorites })}
            onBack={() => setView("session")}
          />
        )}

        {view === "site" && viewedSession && activeBrowserTab && (
          <BrowserSiteStudio
            tab={activeBrowserTab}
            threadId={viewedSession.threadId}
            sendEnabled={supportsSelectedTargetCommand(mutationGate, "sendSketch", selected) && capabilities.drawing}
            fetchFrame={bridge.fetchBrowserTabFrame}
            controlTab={bridge.controlBrowserTab}
            recordTabAction={bridge.recordBrowserTabAction}
            onSendAnnotation={sendSiteAnnotation}
            onSendRecording={sendSiteQaRecording}
            favorites={preferences.siteFavorites}
            onToggleFavorite={(url, title) => {
              const existing = preferences.siteFavorites.find((favorite) => favorite.url === url);
              updatePreferences({
                ...preferences,
                siteFavorites: existing
                  ? preferences.siteFavorites.filter((favorite) => favorite.id !== existing.id)
                  : [...preferences.siteFavorites, { id: createUuidV4(), label: (title.trim() || displaySiteHost(url)).slice(0, 80), url, updatedAt: Date.now() }],
              });
            }}
            onOpenSites={() => setView("sites")}
          />
        )}

        {view === "session" && !viewedSession && (
          <section className="cp-unavailable-surface"><strong>Session unavailable</strong><p>Its identity is preserved, but the Mac did not return fresh session data.</p><button type="button" onClick={returnHome}>Return Home</button></section>
        )}

      {view === "review" && (
        <main className="feature-workspace">
          {viewedSession ? (
            <Suspense fallback={<FeatureLoading label="Review studio" />}>
              <ReviewStudio
                key={viewedSession.threadId}
                bridgeInstanceId={bridge.snapshot?.bridgeInstanceId ?? "local-capture-inbox"}
                threadId={viewedSession.threadId}
                threadKey={viewedSession.threadKey}
                threadTitle={viewedSession.title}
                snapshotSeq={bridge.snapshot?.seq ?? 0}
                sendEnabled={supportsSelectedTargetCommand(mutationGate, "sendReview", selected) && capabilities.review && capabilities.reviewMaxImages > 0}
                reviewMaxImages={capabilities.reviewMaxImages}
                agentUpdated={viewedSession.status === "unread"}
                site={reviewSite}
                onClose={() => setView(reviewReturnView)}
                onSendReview={sendReview}
                {...(hasMutationAuthority && mutationSnapshot && hasExactSelectedTarget(mutationSnapshot, selected) && reviewSite?.captureCapability === "available" ? { onCaptureSite: captureAssociatedSite } : {})}
              />
            </Suspense>
          ) : (
            <section className="feature-placeholder"><div><strong>Review unavailable</strong><span>Open and verify this exact session on the Mac first.</span><button type="button" onClick={() => setView("session")}>Back to Session</button></div></section>
          )}
        </main>
      )}

        {view === "settings" && (
          <SettingsPage
            preferences={preferences}
            models={capabilities.models ?? []}
            onChange={updatePreferences}
            onBack={returnHome}
            onManageSavedDrawings={() => setSavedDrawingsOpen(true)}
            devices={bridge.devices}
            currentDeviceId={bridge.currentDeviceId}
            devicesLoaded={bridge.devicesLoaded}
            onRefreshDevices={bridge.refreshDevices}
            onRevokeDevice={bridge.revokeDevice}
            notificationPermission={notificationPermission}
            pushStatus={bridge.pushStatus}
            pushStatusLoaded={bridge.pushStatusLoaded}
            onEnableNotifications={async () => {
              if (bridge.pushStatus === null) return { ok: false, message: "Connect to the Mac before enabling background alerts." };
              try {
                await enableIntelligentPush(bridge.pushStatus, bridge.savePushSubscription);
                setNotificationPermission(readNotificationPermission());
                return { ok: true, message: "Intelligent background alerts are active." };
              } catch (error) {
                setNotificationPermission(readNotificationPermission());
                return { ok: false, message: error instanceof Error ? error.message : "Background alerts could not be enabled." };
              }
            }}
            onDisableNotifications={async () => {
              try {
                await disableIntelligentPush(bridge.removePushSubscription);
                return { ok: true, message: "Background alerts are off. Your iPadOS permission is unchanged." };
              } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : "Background alerts could not be disabled." };
              }
            }}
            contextRoomStatus={bridge.contextRoomStatus}
            contextRoomStatusLoaded={bridge.contextRoomStatusLoaded}
            onRefreshContextRoom={bridge.refreshContextRoomStatus}
          />
        )}
      </div>

      {pwa.updateReady && (
        <PwaUpdateBanner
          safeToReload={!drawingOpen && !captureInboxBusy && view !== "review" && view !== "site"}
          availableBuildId={pwa.availableBuild?.buildId ?? null}
          onReload={pwa.reload}
        />
      )}

      {previousIpadView && (
        <div className="cp-return-banner" role="status">
          <span><strong>Mac changed sessions.</strong><small>Your previous iPad view is saved.</small></span>
          <button type="button" onClick={() => {
            setView(previousIpadView.view);
            setSessionThreadId(previousIpadView.sessionThreadId);
            setPreviousIpadView(null);
          }}>Return to previous iPad view</button>
          <button type="button" className="cp-icon-button" aria-label="Dismiss saved view" onClick={() => setPreviousIpadView(null)}><CloseIcon /></button>
        </div>
      )}

      {savedDrawingsOpen && (
        <div className="cp-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSavedDrawingsOpen(false); }}>
          <aside className="cp-saved-drawings" role="dialog" aria-modal="true" aria-labelledby="saved-drawings-title">
            <header><div><p className="cp-overline">Global visual memory</p><h2 id="saved-drawings-title">Saved Drawings</h2></div><button type="button" className="cp-icon-button" aria-label="Close Saved Drawings" onClick={() => setSavedDrawingsOpen(false)}><CloseIcon /></button></header>
            <div className="cp-saved-drawings__toolbar">
              <label>
                <span>Source session</span>
                <select value={savedDrawingFilter} onChange={(event) => setSavedDrawingFilter(event.target.value)}>
                  <option value="all">All sessions</option>
                  {savedDrawingSources.map((source) => <option key={source.threadId} value={source.threadId}>{source.title}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => void bridge.refreshSavedDrawings()}>Refresh</button>
            </div>
            {savedDrawingMessage && <p className="cp-saved-drawings__message" role="status">{savedDrawingMessage}</p>}
            {!bridge.savedDrawingsLoaded ? (
              <div className="cp-saved-drawings__empty" aria-busy="true"><strong>Loading from your Mac…</strong></div>
            ) : visibleSavedDrawings.length === 0 ? (
              <div className="cp-saved-drawings__empty"><strong>{bridge.savedDrawings.length === 0 ? "No kept drawings yet." : "No drawings from this session."}</strong><p>Drafts stay local to this iPad. A drawing appears here only after you choose Keep in the drawing editor.</p></div>
            ) : (
              <div className="cp-saved-drawings__grid">
                {visibleSavedDrawings.map((drawing) => (
                  <article key={drawing.id} className="cp-saved-drawing-card">
                    <div className={`cp-saved-drawing-card__image background-${drawing.background}`}><img src={`data:image/webp;base64,${drawing.thumbnailBase64}`} alt="" /></div>
                    <div className="cp-saved-drawing-card__copy">
                      <strong>{drawing.instruction || "Untitled drawing"}</strong>
                      <span>{drawing.sourceThreadTitle}</span>
                      <small>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(drawing.createdAt)}</small>
                    </div>
                    <div className="cp-saved-drawing-card__actions">
                      <button type="button" disabled={!viewedSession || !targetReady || savedDrawingBusyId !== null} onClick={() => void useSavedDrawing(drawing.id)}>{savedDrawingBusyId === drawing.id && savedDrawingDeleteId !== drawing.id ? "Opening…" : "Use in current session"}</button>
                      {savedDrawingDeleteId === drawing.id ? (
                        <span className="cp-saved-drawing-card__confirm"><button type="button" onClick={() => setSavedDrawingDeleteId(null)}>Cancel</button><button type="button" className="is-destructive" disabled={savedDrawingBusyId !== null} onClick={() => void deleteSavedDrawing(drawing.id)}>Delete</button></span>
                      ) : (
                        <button type="button" className="is-quiet" aria-label={`Delete drawing from ${drawing.sourceThreadTitle}`} onClick={() => setSavedDrawingDeleteId(drawing.id)}>Delete</button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}

      {pinReplacementThreadId && (
        <div className="cp-modal-layer" role="presentation">
          <section className="cp-replace-modal" role="dialog" aria-modal="true" aria-labelledby="session-replace-title">
            <p className="cp-overline">Home limit reached</p>
            <h2 id="session-replace-title">Choose a session to unpin.</h2>
            <p>Home holds up to 12 sessions. The Codex session itself is never deleted.</p>
            <div>
              {pinnedProductSessions.map((session) => (
                <button type="button" key={session.threadId} onClick={() => {
                  dispatchHomeLayout({ type: "replace-pin", unpinThreadId: session.threadId, pinThreadId: pinReplacementThreadId });
                  setPinReplacementThreadId(null);
                }}><span>{session.title}</span><small>{session.project ?? session.threadId.slice(-8)}</small></button>
              ))}
            </div>
            <button type="button" className="cp-secondary-button" onClick={() => setPinReplacementThreadId(null)}>Cancel</button>
          </section>
        </div>
      )}

      {!hasMutationAuthority && bridge.snapshot && (
        <div className="offline-strip" role="status">
          <span>{bridge.cached ? "Showing the last snapshot saved on this iPad." : "Live state is unavailable; the last good snapshot is display-only."}</span>
          <span>No command will be queued or replayed.</span>
        </div>
      )}

      {bridge.lastAck && <CommandStatusToast ack={bridge.lastAck} onDismiss={bridge.clearAck} />}

      {drawingOpen && (
        <Suspense fallback={<div className="drawing-studio"><FeatureLoading label="Drawing studio" /></div>}>
          <DrawingStudio
            key={savedDrawingWorkingCopy?.id ?? "draft"}
            open
            target={drawingTarget}
            importOnOpen={drawingImportOnOpen}
            initialSavedDrawing={savedDrawingWorkingCopy}
            connected={supportsSelectedTargetCommand(mutationGate, "sendSketch", selected) && capabilities.drawing}
            sending={drawingSending}
            sendStatus={drawingStatus}
            statusMessage={drawingMessage}
            onClose={() => { setDrawingOpen(false); setDrawingImportOnOpen(false); setSavedDrawingWorkingCopy(null); }}
            onSend={sendDrawing}
            onKeep={keepDrawing}
            onReconcileDelivery={reconcileDrawingDelivery}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;

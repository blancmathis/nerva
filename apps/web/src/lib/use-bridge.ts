import type {
  Command,
  CodexUsageSnapshot,
  ContextRoomStatus,
  DiagramDocument,
  DiagramUpdateRequest,
  NativeSessionsResponse,
  PairedDevice,
  ProductState,
  RuntimeDiagnostics,
  SavedDrawingCreateRequest,
  SavedDrawingDetail,
  SavedDrawingSummary,
  SessionSummary,
} from "@codex-pad/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BridgeClient,
  BridgeHttpError,
  type BrowserTabControl,
  type BrowserTabFrame,
  type RecordedBrowserTabControlResult,
  type CommandStatusResult,
  type ManagedSite,
  type OpenBrowserTabsResult,
  type BrowserPushSubscription,
  type PushServerStatus,
  type SiteCaptureResult,
  type SiteCaptureViewport,
} from "./bridge-client";
import type { SiteQaRecordedAction } from "@codex-pad/protocol";
import type {
  BridgeCapabilities,
  BridgeSnapshot,
  CommandAck,
  ConnectionPhase,
  PairResult,
  SketchRequest,
} from "./model";
import { mergeSecondaryCapabilities, normalizeSecondaryCapabilities } from "./normalize";
import {
  loadPendingCommandIds,
  MAX_PERSISTED_PENDING_COMMAND_IDS,
  savePendingCommandIds,
} from "./pending-command-store";
import { loadLastSnapshot, saveLastSnapshot } from "./storage";
import { isFreshSnapshot } from "./snapshot-order";
import type { HomeLayout } from "./home-layout";
import type { UiPreferences } from "./storage";

type SecondaryCapabilities = Omit<BridgeCapabilities, "microActions" | "joystickActions">;

interface SecondaryDataClient {
  fetchCapabilities(): Promise<unknown | null>;
  fetchNativeSessions(): Promise<NativeSessionsResponse | null>;
  fetchSessions(): Promise<readonly SessionSummary[] | null>;
}

export interface NativeSessionsRequestGate {
  current: Promise<NativeSessionsResponse | null> | null;
}

export interface AllSessionsRequestGate {
  current: Promise<readonly SessionSummary[] | null> | null;
}

export function fetchNativeSessionsWithoutOverlap(
  client: Pick<SecondaryDataClient, "fetchNativeSessions">,
  gate: NativeSessionsRequestGate,
): Promise<NativeSessionsResponse | null> {
  if (gate.current) return gate.current;
  const request = client.fetchNativeSessions().catch(() => null);
  gate.current = request;
  void request.then(() => {
    if (gate.current === request) gate.current = null;
  });
  return request;
}

export function fetchAllSessionsWithoutOverlap(
  client: Pick<SecondaryDataClient, "fetchSessions">,
  gate: AllSessionsRequestGate,
): Promise<readonly SessionSummary[] | null> {
  if (gate.current) return gate.current;
  const request = client.fetchSessions().catch(() => null);
  gate.current = request;
  void request.then(() => {
    if (gate.current === request) gate.current = null;
  });
  return request;
}

export function shouldApplyNativeSessions(
  currentRegistryGeneration: number | null,
  nextRegistryGeneration: number,
): boolean {
  return currentRegistryGeneration === null || nextRegistryGeneration >= currentRegistryGeneration;
}

export function shouldPollNativeSessions(
  connected: boolean,
  visibilityState: DocumentVisibilityState,
  online: boolean,
): boolean {
  return connected && visibilityState === "visible" && online;
}

export function markCodexUsageStale(current: CodexUsageSnapshot | null): CodexUsageSnapshot | null {
  return current?.available ? { ...current, stale: true } : current;
}

/**
 * A catalog refresh has no deletion tombstones, so omissions cannot safely be
 * interpreted as archived tasks. Retain omitted last-good summaries as stale
 * orientation until a reload or an explicit product action resolves them.
 */
export function mergeLastGoodSessions(
  current: readonly SessionSummary[],
  next: readonly SessionSummary[],
): readonly SessionSummary[] {
  const freshThreadIds = new Set(next.map((session) => session.threadId));
  const stale = current
    .filter((session) => !freshThreadIds.has(session.threadId))
    .map((session): SessionSummary => ({
      ...session,
      nativeStatus: "unavailable",
      visualStatus: "degraded",
      activityLabel: null,
      selected: false,
      microSlot: null,
      siteAssociations: [],
      siteAssociation: null,
    }));
  return [...next, ...stale];
}

export interface SecondaryData {
  readonly rawCapabilities: unknown | null;
  readonly nativeSessions: NativeSessionsResponse | null;
  readonly sessions: readonly SessionSummary[] | null;
}

export async function fetchSecondaryData(
  client: SecondaryDataClient,
  allSessionsEnabled: boolean,
  fetchNativeSessions: () => Promise<NativeSessionsResponse | null> = () => client.fetchNativeSessions(),
  fetchAllSessions: () => Promise<readonly SessionSummary[] | null> = () => client.fetchSessions(),
  fetchCapabilities: () => Promise<unknown | null> = () => client.fetchCapabilities(),
): Promise<SecondaryData> {
  if (!allSessionsEnabled) {
    const [rawCapabilities, nativeSessions] = await Promise.all([
      fetchCapabilities(),
      fetchNativeSessions(),
    ]);
    return { rawCapabilities, nativeSessions, sessions: null };
  }
  const [rawCapabilities, nativeSessions, sessions] = await Promise.all([
    fetchCapabilities(),
    fetchNativeSessions(),
    fetchAllSessions(),
  ]);
  return { rawCapabilities, nativeSessions, sessions };
}

export interface UseBridgeOptions {
  readonly allSessionsEnabled?: boolean;
}

export interface BridgeController {
  readonly snapshot: BridgeSnapshot | null;
  readonly phase: ConnectionPhase;
  readonly cached: boolean;
  readonly nativeSessions: readonly SessionSummary[];
  readonly sessions: readonly SessionSummary[];
  readonly sessionsAvailable: boolean;
  readonly codexUsage: CodexUsageSnapshot | null;
  readonly codexUsageLoaded: boolean;
  readonly runtimeDiagnostics: RuntimeDiagnostics | null;
  readonly runtimeDiagnosticsLoaded: boolean;
  readonly contextRoomStatus: ContextRoomStatus | null;
  readonly contextRoomStatusLoaded: boolean;
  readonly productState: ProductState | null;
  readonly productStateLoaded: boolean;
  readonly pushStatus: PushServerStatus | null;
  readonly pushStatusLoaded: boolean;
  readonly devices: readonly PairedDevice[];
  readonly currentDeviceId: string | null;
  readonly devicesLoaded: boolean;
  readonly savedDrawings: readonly SavedDrawingSummary[];
  readonly savedDrawingsLoaded: boolean;
  readonly pendingCount: number;
  readonly lastAck: CommandAck | null;
  readonly pair: (nonce: string, deviceName: string) => Promise<PairResult>;
  readonly command: (request: Command) => Promise<CommandAck>;
  readonly sketch: (request: SketchRequest) => Promise<CommandAck>;
  readonly commandStatus: (commandId: string) => Promise<CommandStatusResult | null>;
  readonly captureSite: (request: {
    readonly siteId: string;
    readonly threadId: string;
    readonly path: string;
    readonly viewport: SiteCaptureViewport;
    readonly scroll: { readonly x: number; readonly y: number };
  }) => Promise<SiteCaptureResult>;
  readonly fetchManagedSites: (threadId: string) => Promise<readonly ManagedSite[]>;
  readonly fetchOpenBrowserTabs: (threadId: string) => Promise<OpenBrowserTabsResult>;
  readonly fetchBrowserTabFrame: (threadId: string, tabId: string) => Promise<BrowserTabFrame>;
  readonly controlBrowserTab: (threadId: string, tabId: string, action: BrowserTabControl) => Promise<BrowserTabFrame>;
  readonly recordBrowserTabAction: (threadId: string, tabId: string, action: SiteQaRecordedAction) => Promise<RecordedBrowserTabControlResult>;
  readonly addManagedSite: (input: {
    readonly threadId: string;
    readonly name: string;
    readonly url: string;
    readonly scope: "thread" | "project";
  }) => Promise<readonly ManagedSite[]>;
  readonly removeManagedSite: (threadId: string, siteId: string) => Promise<void>;
  readonly refreshSessions: () => Promise<void>;
  readonly refreshCodexUsage: () => Promise<void>;
  readonly refreshRuntimeDiagnostics: () => Promise<void>;
  readonly refreshContextRoomStatus: () => Promise<void>;
  readonly refreshPushStatus: () => Promise<void>;
  readonly savePushSubscription: (subscription: BrowserPushSubscription) => Promise<void>;
  readonly removePushSubscription: () => Promise<void>;
  readonly saveProductState: (
    homeLayout: HomeLayout,
    preferences: UiPreferences,
  ) => Promise<ProductStateSaveResult>;
  readonly refreshDevices: () => Promise<void>;
  readonly revokeDevice: (deviceId: string) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly refreshSavedDrawings: () => Promise<void>;
  readonly loadSavedDrawing: (drawingId: string) => Promise<SavedDrawingDetail | null>;
  readonly saveDrawing: (input: SavedDrawingCreateRequest) => Promise<{
    readonly ok: boolean;
    readonly drawing: SavedDrawingDetail | null;
    readonly message: string;
  }>;
  readonly deleteSavedDrawing: (drawingId: string) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly fetchDiagrams: (threadId: string) => Promise<readonly DiagramDocument[]>;
  readonly updateDiagram: (
    diagramId: string,
    threadId: string,
    input: DiagramUpdateRequest,
  ) => Promise<DiagramDocument>;
  readonly clearAck: () => void;
}

export interface ProductStateSaveResult {
  readonly ok: boolean;
  readonly state: ProductState | null;
  readonly message: string;
}

export function chooseLiveSnapshot(
  current: BridgeSnapshot | null,
  next: BridgeSnapshot,
  _hasReceivedLiveSnapshot: boolean,
): BridgeSnapshot {
  return isFreshSnapshot(current, next) ? next : current ?? next;
}

export async function refreshSnapshotAfterCommand(
  request: Command,
  ack: CommandAck,
  refreshSnapshot: () => Promise<boolean>,
): Promise<void> {
  if (
    (
      request.type !== "adjustReasoning"
      && request.type !== "setModelReasoning"
      && request.type !== "respondToApproval"
      && request.type !== "runMicroAction"
    )
    || !ack.ok
    || ack.pending === true
  ) return;
  await refreshSnapshot();
}

function unknownAck(commandId: string): CommandAck {
  return {
    commandId,
    ok: false,
    pending: true,
    message: "Delivery is unknown. Nerva will check this command ID, never resend it.",
  };
}

export function useBridge({ allSessionsEnabled = false }: UseBridgeOptions = {}): BridgeController {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [nativeSessions, setNativeSessions] = useState<readonly SessionSummary[]>([]);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [sessionsAvailable, setSessionsAvailable] = useState(false);
  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot | null>(null);
  const [codexUsageLoaded, setCodexUsageLoaded] = useState(false);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [runtimeDiagnosticsLoaded, setRuntimeDiagnosticsLoaded] = useState(false);
  const [contextRoomStatus, setContextRoomStatus] = useState<ContextRoomStatus | null>(null);
  const [contextRoomStatusLoaded, setContextRoomStatusLoaded] = useState(false);
  const [productState, setProductState] = useState<ProductState | null>(null);
  const [productStateLoaded, setProductStateLoaded] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushServerStatus | null>(null);
  const [pushStatusLoaded, setPushStatusLoaded] = useState(false);
  const [devices, setDevices] = useState<readonly PairedDevice[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [savedDrawings, setSavedDrawings] = useState<readonly SavedDrawingSummary[]>([]);
  const [savedDrawingsLoaded, setSavedDrawingsLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [cached, setCached] = useState(false);
  const [lastAck, setLastAck] = useState<CommandAck | null>(null);
  const pendingRef = useRef<Set<string> | null>(null);
  pendingRef.current ??= new Set(loadPendingCommandIds());
  const pendingCommands = pendingRef.current;
  const [pendingCount, setPendingCount] = useState(pendingCommands.size);
  const clientRef = useRef<BridgeClient | null>(null);
  const productStateRef = useRef<ProductState | null>(null);
  const productStateSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  productStateRef.current = productState;
  const secondaryRef = useRef<SecondaryCapabilities | null>(null);
  const liveSnapshotSeenRef = useRef(false);
  const connectedRef = useRef(false);
  const allSessionsEnabledRef = useRef(allSessionsEnabled);
  const secondaryRequestGenerationRef = useRef(0);
  const capabilitiesRequestGenerationRef = useRef(0);
  const capabilitiesRequestGateRef = useRef<Promise<unknown | null> | null>(null);
  const nativeSessionsRequestGenerationRef = useRef(0);
  const nativeSessionsRegistryGenerationRef = useRef<number | null>(null);
  const nativeSessionsRequestGateRef = useRef<NativeSessionsRequestGate>({ current: null });
  const allSessionsRequestGateRef = useRef<AllSessionsRequestGate>({ current: null });
  allSessionsEnabledRef.current = allSessionsEnabled;

  const persistPending = useCallback(() => {
    const persisted = savePendingCommandIds(pendingCommands);
    if (pendingCommands.size > MAX_PERSISTED_PENDING_COMMAND_IDS) {
      pendingCommands.clear();
      for (const commandId of persisted) pendingCommands.add(commandId);
    }
    setPendingCount(pendingCommands.size);
  }, [pendingCommands]);

  const trackPending = useCallback((commandId: string) => {
    pendingCommands.delete(commandId);
    pendingCommands.add(commandId);
    persistPending();
  }, [pendingCommands, persistPending]);

  const finishPending = useCallback((commandId: string) => {
    if (!pendingCommands.delete(commandId)) return;
    persistPending();
  }, [pendingCommands, persistPending]);

  const applyNativeSessions = useCallback((next: NativeSessionsResponse | null): boolean => {
    if (
      !next
      || !shouldApplyNativeSessions(
        nativeSessionsRegistryGenerationRef.current,
        next.registryGeneration,
      )
    ) return false;
    const previousRegistryGeneration = nativeSessionsRegistryGenerationRef.current;
    nativeSessionsRegistryGenerationRef.current = next.registryGeneration;
    setNativeSessions(next.sessions);
    return previousRegistryGeneration !== null
      && next.registryGeneration > previousRegistryGeneration;
  }, []);

  const fetchNativeSessions = useCallback((client: SecondaryDataClient) => (
    fetchNativeSessionsWithoutOverlap(client, nativeSessionsRequestGateRef.current)
  ), []);

  const fetchAllSessions = useCallback((client: SecondaryDataClient) => (
    fetchAllSessionsWithoutOverlap(client, allSessionsRequestGateRef.current)
  ), []);

  const fetchCapabilities = useCallback((client: SecondaryDataClient): Promise<unknown | null> => {
    if (capabilitiesRequestGateRef.current) return capabilitiesRequestGateRef.current;
    const request = client.fetchCapabilities().catch(() => null);
    capabilitiesRequestGateRef.current = request;
    void request.then(() => {
      if (capabilitiesRequestGateRef.current === request) capabilitiesRequestGateRef.current = null;
    });
    return request;
  }, []);

  const refreshCapabilities = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const requestGeneration = ++capabilitiesRequestGenerationRef.current;
    const rawCapabilities = await fetchCapabilities(client);
    if (
      requestGeneration !== capabilitiesRequestGenerationRef.current
      || clientRef.current !== client
    ) return;
    const capabilities = normalizeSecondaryCapabilities(rawCapabilities);
    if (!capabilities) return;
    secondaryRef.current = capabilities;
    setSnapshot((current) => current ? mergeSecondaryCapabilities(current, capabilities) : current);
  }, [fetchCapabilities]);

  const refreshAllSessions = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !allSessionsEnabledRef.current) return;
    const requestGeneration = secondaryRequestGenerationRef.current;
    const next = await fetchAllSessions(client);
    if (
      requestGeneration !== secondaryRequestGenerationRef.current
      || !allSessionsEnabledRef.current
      || !next
    ) return;
    setSessions((current) => mergeLastGoodSessions(current, next));
    setSessionsAvailable(true);
  }, [fetchAllSessions]);

  const refreshAllSessionsAfterRegistryAdvance = useCallback(() => {
    if (!allSessionsEnabledRef.current) return;
    secondaryRequestGenerationRef.current += 1;
    allSessionsRequestGateRef.current.current = null;
    setSessions((current) => current.map((session) => session.siteAssociations.length === 0
      ? session
      : { ...session, siteAssociations: [], siteAssociation: null }));
    void refreshAllSessions();
  }, [refreshAllSessions]);

  const refreshNativeSessions = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const requestGeneration = nativeSessionsRequestGenerationRef.current;
    const next = await fetchNativeSessions(client);
    if (requestGeneration !== nativeSessionsRequestGenerationRef.current) return;
    const registryAdvanced = applyNativeSessions(next);
    if (registryAdvanced) refreshAllSessionsAfterRegistryAdvance();
  }, [applyNativeSessions, fetchNativeSessions, refreshAllSessionsAfterRegistryAdvance]);

  const clearConnectionSecondaryData = useCallback((forgetLastGood = false) => {
    secondaryRequestGenerationRef.current += 1;
    capabilitiesRequestGenerationRef.current += 1;
    capabilitiesRequestGateRef.current = null;
    nativeSessionsRequestGenerationRef.current += 1;
    nativeSessionsRegistryGenerationRef.current = null;
    nativeSessionsRequestGateRef.current.current = null;
    allSessionsRequestGateRef.current.current = null;
    if (forgetLastGood) {
      setNativeSessions([]);
      setSessions([]);
    }
    setSessionsAvailable(false);
  }, []);

  const refreshSecondary = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const requestGeneration = ++secondaryRequestGenerationRef.current;
    const capabilitiesRequestGeneration = ++capabilitiesRequestGenerationRef.current;
    const nativeRequestGeneration = nativeSessionsRequestGenerationRef.current;
    const requestedSessions = allSessionsEnabledRef.current;
    const {
      rawCapabilities,
      nativeSessions: nextNativeSessions,
      sessions: nextSessions,
    } = await fetchSecondaryData(
      client,
      requestedSessions,
      () => fetchNativeSessions(client),
      () => fetchAllSessions(client),
      () => fetchCapabilities(client),
    );
    if (requestGeneration !== secondaryRequestGenerationRef.current) return;
    if (capabilitiesRequestGeneration === capabilitiesRequestGenerationRef.current) {
      const capabilities = normalizeSecondaryCapabilities(rawCapabilities);
      if (capabilities) {
        secondaryRef.current = capabilities;
        setSnapshot((current) => current ? mergeSecondaryCapabilities(current, capabilities) : current);
      }
    }
    if (nativeRequestGeneration === nativeSessionsRequestGenerationRef.current) {
      const registryAdvanced = applyNativeSessions(nextNativeSessions);
      if (registryAdvanced && requestedSessions && allSessionsEnabledRef.current) {
        refreshAllSessionsAfterRegistryAdvance();
        return;
      }
    }
    if (requestedSessions && allSessionsEnabledRef.current) {
      if (nextSessions) {
        setSessions((current) => mergeLastGoodSessions(current, nextSessions));
        setSessionsAvailable(true);
      } else {
        setSessionsAvailable(false);
      }
    } else {
      setSessions([]);
      setSessionsAvailable(false);
    }
  }, [applyNativeSessions, fetchAllSessions, fetchCapabilities, fetchNativeSessions, refreshAllSessionsAfterRegistryAdvance]);

  const refreshProductState = useCallback(async (): Promise<ProductState | null> => {
    const client = clientRef.current;
    if (!client) return null;
    const next = await client.fetchProductState();
    if (next) {
      productStateRef.current = next;
      setProductState(next);
    }
    setProductStateLoaded(true);
    return next;
  }, []);

  const refreshCodexUsage = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const next = await client.fetchCodexUsage();
    if (next) setCodexUsage(next);
    else setCodexUsage(markCodexUsageStale);
    setCodexUsageLoaded(true);
  }, []);

  const refreshRuntimeDiagnostics = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const next = await client.fetchRuntimeDiagnostics();
    if (next) setRuntimeDiagnostics(next);
    setRuntimeDiagnosticsLoaded(true);
  }, []);

  const refreshContextRoomStatus = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const next = await client.fetchContextRoomStatus();
    if (next) setContextRoomStatus(next);
    setContextRoomStatusLoaded(true);
  }, []);

  const refreshPushStatus = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const next = await client.fetchPushStatus();
    if (next) setPushStatus(next);
    setPushStatusLoaded(true);
  }, []);

  const savePushSubscription = useCallback(async (subscription: BrowserPushSubscription): Promise<void> => {
    const client = clientRef.current;
    if (!client) throw new Error("Mac connection is unavailable");
    await client.savePushSubscription(subscription);
    await refreshPushStatus();
  }, [refreshPushStatus]);

  const removePushSubscription = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) throw new Error("Mac connection is unavailable");
    await client.removePushSubscription();
    setPushStatus((current) => current ? { ...current, subscribed: false } : current);
    setPushStatusLoaded(true);
  }, []);

  const refreshDevices = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const next = await client.fetchDevices();
    if (next) {
      setDevices(next.devices);
      setCurrentDeviceId(next.currentDeviceId);
    }
    setDevicesLoaded(true);
  }, []);

  const refreshSavedDrawings = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    try {
      setSavedDrawings(await client.fetchSavedDrawings());
    } finally {
      setSavedDrawingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!allSessionsEnabled) {
      secondaryRequestGenerationRef.current += 1;
      allSessionsRequestGateRef.current.current = null;
      setSessions([]);
      setSessionsAvailable(false);
      void refreshNativeSessions();
      return;
    }
    void refreshSecondary();
  }, [allSessionsEnabled, refreshNativeSessions, refreshSecondary]);

  const commandStatus = useCallback(async (commandId: string) => {
    const client = clientRef.current;
    if (!client) return null;
    const result = await client.commandStatus(commandId);
    if (!result) return null;
    setLastAck(result.ack);
    if (result.state === "final") finishPending(commandId);
    else trackPending(commandId);
    return result;
  }, [finishPending, trackPending]);

  const reconcilePending = useCallback(async () => {
    if (!clientRef.current || pendingCommands.size === 0) return;
    for (const commandId of [...pendingCommands]) {
      await commandStatus(commandId);
    }
  }, [commandStatus, pendingCommands]);

  useEffect(() => {
    let active = true;
    void loadLastSnapshot().then((stored) => {
      if (!active || !stored || liveSnapshotSeenRef.current) return;
      setSnapshot((current) => current ?? stored);
      setCached(true);
    });

    const client = new BridgeClient({
      onSnapshot(next) {
        if (!active) return;
        const merged = mergeSecondaryCapabilities(next, secondaryRef.current);
        setSnapshot((current) => chooseLiveSnapshot(current, merged, liveSnapshotSeenRef.current));
        liveSnapshotSeenRef.current = true;
        setInitializing(false);
        void saveLastSnapshot(merged);
        // Native selection and the managed app-server may recover on different
        // refreshes. Re-read their derived capabilities for every sequenced
        // snapshot so an early degraded response cannot leave Draw or models
        // disabled for the rest of the installed PWA session.
        void refreshCapabilities();
      },
      onConnection(nextConnected) {
        if (!active) return;
        connectedRef.current = nextConnected;
        setConnected(nextConnected);
        setCached(!nextConnected);
        setInitializing(false);
        if (nextConnected) {
          void reconcilePending();
          void refreshSecondary();
          void refreshProductState();
          void refreshDevices();
          void refreshCodexUsage();
          void refreshRuntimeDiagnostics();
          void refreshContextRoomStatus();
          void refreshPushStatus();
        } else {
          setCodexUsage(markCodexUsageStale);
          clearConnectionSecondaryData();
        }
      },
      onUnauthorized() {
        if (!active) return;
        connectedRef.current = false;
        setPairing(true);
        setConnected(false);
        setProductState(null);
        productStateRef.current = null;
        setProductStateLoaded(false);
        setDevices([]);
        setCurrentDeviceId(null);
        setDevicesLoaded(false);
        setSavedDrawings([]);
        setSavedDrawingsLoaded(false);
        setCodexUsage(null);
        setCodexUsageLoaded(false);
        setRuntimeDiagnostics(null);
        setRuntimeDiagnosticsLoaded(false);
        setContextRoomStatus(null);
        setContextRoomStatusLoaded(false);
        setPushStatus(null);
        setPushStatusLoaded(false);
        clearConnectionSecondaryData(true);
        setInitializing(false);
      },
      onAck(ack) {
        if (!active) return;
        if (!ack.pending) finishPending(ack.commandId);
        setLastAck(ack);
      },
    });
    clientRef.current = client;
    void client.start().then(async (authenticated) => {
      if (authenticated) await Promise.all([
        refreshSecondary(),
        refreshProductState(),
        refreshDevices(),
        refreshCodexUsage(),
        refreshRuntimeDiagnostics(),
        refreshContextRoomStatus(),
        refreshPushStatus(),
      ]);
    }).finally(() => {
      if (active) setInitializing(false);
    });

    const onVisibility = () => {
      const available = document.visibilityState !== "hidden" && navigator.onLine !== false;
      client.setVisible(available);
      if (available) {
        void reconcilePending();
        void refreshSecondary();
        void refreshProductState();
        void refreshDevices();
        void refreshCodexUsage();
        void refreshRuntimeDiagnostics();
        void refreshContextRoomStatus();
        void refreshPushStatus();
      }
    };
    const onResume = () => {
      const available = document.visibilityState !== "hidden" && navigator.onLine !== false;
      client.setVisible(available);
      if (!available) return;
      void client.refreshSnapshot();
      void reconcilePending();
      void refreshSecondary();
      void refreshProductState();
      void refreshDevices();
      void refreshCodexUsage();
      void refreshRuntimeDiagnostics();
      void refreshContextRoomStatus();
      void refreshPushStatus();
    };
    const onOffline = () => {
      client.setVisible(false);
      connectedRef.current = false;
      setConnected(false);
      setCached(true);
      setCodexUsage(markCodexUsageStale);
      clearConnectionSecondaryData();
    };
    const nativeSessionsPoll = window.setInterval(() => {
      if (!active || !shouldPollNativeSessions(
        connectedRef.current,
        document.visibilityState,
        navigator.onLine !== false,
      )) return;
      // Capabilities can recover independently of the native snapshot (for
      // example after the managed app-server reconnects). Poll the small,
      // single-flight capability document while foregrounded so Draw, Skills,
      // and Model + Reasoning cannot remain stuck in their degraded state.
      void refreshCapabilities();
      void refreshNativeSessions();
    }, 2_000);
    const codexUsagePoll = window.setInterval(() => {
      if (!active || !shouldPollNativeSessions(
        connectedRef.current,
        document.visibilityState,
        navigator.onLine !== false,
      )) return;
      void refreshCodexUsage();
    }, 60_000);
    const runtimeDiagnosticsPoll = window.setInterval(() => {
      if (!active || !shouldPollNativeSessions(
        connectedRef.current,
        document.visibilityState,
        navigator.onLine !== false,
      )) return;
      void refreshRuntimeDiagnostics();
    }, 10_000);
    const contextRoomPoll = window.setInterval(() => {
      if (!active || !shouldPollNativeSessions(
        connectedRef.current,
        document.visibilityState,
        navigator.onLine !== false,
      )) return;
      void refreshContextRoomStatus();
    }, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    window.addEventListener("offline", onOffline);

    return () => {
      active = false;
      connectedRef.current = false;
      nativeSessionsRequestGenerationRef.current += 1;
      client.stop();
      clientRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(nativeSessionsPoll);
      window.clearInterval(codexUsagePoll);
      window.clearInterval(runtimeDiagnosticsPoll);
      window.clearInterval(contextRoomPoll);
    };
  }, [clearConnectionSecondaryData, finishPending, reconcilePending, refreshCapabilities, refreshCodexUsage, refreshContextRoomStatus, refreshDevices, refreshNativeSessions, refreshProductState, refreshPushStatus, refreshRuntimeDiagnostics, refreshSecondary]);

  const pair = useCallback(async (nonce: string, deviceName: string) => {
    const client = clientRef.current;
    if (!client) return { ok: false, message: "Bridge is not ready" };
    const result = await client.pair(nonce, deviceName);
    if (result.ok) {
      setPairing(false);
      setInitializing(true);
      window.history.replaceState({}, "", "/");
      await client.refreshSnapshot();
      await Promise.all([refreshSecondary(), refreshProductState(), refreshDevices(), refreshCodexUsage(), refreshRuntimeDiagnostics(), refreshContextRoomStatus(), refreshPushStatus()]);
      client.setVisible(true);
    }
    return result;
  }, [refreshCodexUsage, refreshContextRoomStatus, refreshDevices, refreshProductState, refreshPushStatus, refreshRuntimeDiagnostics, refreshSecondary]);

  const command = useCallback(async (request: Command) => {
    const commandId = request.commandId;
    const client = clientRef.current;
    if (!client) return { commandId, ok: false, pending: false, message: "Bridge is not ready" };
    trackPending(commandId);
    try {
      const ack = await client.command(request);
      if (!ack.pending) finishPending(commandId);
      setLastAck(ack);
      await refreshSnapshotAfterCommand(request, ack, () => client.refreshSnapshot());
      return ack;
    } catch {
      const ack = unknownAck(commandId);
      setLastAck(ack);
      return ack;
    }
  }, [finishPending, trackPending]);

  const sketch = useCallback(async (request: SketchRequest) => {
    const commandId = request.commandId;
    const client = clientRef.current;
    if (!client) return { commandId, ok: false, pending: false, message: "Bridge is not ready" };
    trackPending(commandId);
    try {
      const ack = await client.sketch(request);
      if (!ack.pending) finishPending(commandId);
      setLastAck(ack);
      return ack;
    } catch {
      const ack = unknownAck(commandId);
      setLastAck(ack);
      return ack;
    }
  }, [finishPending, trackPending]);

  const phase = useMemo<ConnectionPhase>(() => {
    if (pairing) return "pairing";
    if (connected) return "online";
    if (initializing) return "connecting";
    return snapshot ? "reconnecting" : "offline";
  }, [connected, initializing, pairing, snapshot]);

  const saveGlobalProductState = useCallback(async (
    homeLayout: HomeLayout,
    productPreferences: UiPreferences,
  ): Promise<ProductStateSaveResult> => {
    const save = async (): Promise<ProductStateSaveResult> => {
      const client = clientRef.current;
      const current = productStateRef.current;
      if (!client || !current) {
        return { ok: false, state: null, message: "Global Mac storage is unavailable" };
      }
      try {
        const next = await client.saveProductState({
          expectedRevision: current.revision,
          homeLayout,
          preferences: productPreferences,
        });
        productStateRef.current = next;
        setProductState(next);
        return { ok: true, state: next, message: "Saved on the Mac" };
      } catch (error) {
        if (error instanceof BridgeHttpError && error.status === 409) {
          const latest = await refreshProductState();
          return { ok: false, state: latest, message: "Another device changed this layout first" };
        }
        return {
          ok: false,
          state: current,
          message: error instanceof Error ? error.message : "Global Mac storage is unavailable",
        };
      }
    };
    const queued = productStateSaveChainRef.current.then(save, save);
    productStateSaveChainRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [refreshProductState]);

  const revokePairedDevice = useCallback(async (deviceId: string) => {
    const client = clientRef.current;
    if (!client) return { ok: false, message: "Mac connection is unavailable" };
    try {
      await client.revokeDevice(deviceId);
      await refreshDevices();
      return { ok: true, message: "Device disconnected" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Device could not be disconnected" };
    }
  }, [refreshDevices]);

  const loadSavedDrawing = useCallback(async (drawingId: string): Promise<SavedDrawingDetail | null> => {
    const client = clientRef.current;
    if (!client) return null;
    try {
      return await client.fetchSavedDrawing(drawingId);
    } catch {
      return null;
    }
  }, []);

  const saveDrawing = useCallback(async (input: SavedDrawingCreateRequest) => {
    const client = clientRef.current;
    if (!client) return { ok: false, drawing: null, message: "Mac connection is unavailable" } as const;
    try {
      const drawing = await client.saveDrawing(input);
      setSavedDrawings((current) => [drawing, ...current.filter((candidate) => candidate.id !== drawing.id)]);
      setSavedDrawingsLoaded(true);
      return { ok: true, drawing, message: "Kept in Saved Drawings on the Mac" } as const;
    } catch (error) {
      return {
        ok: false,
        drawing: null,
        message: error instanceof Error ? error.message : "Drawing could not be kept on the Mac",
      } as const;
    }
  }, []);

  const deleteSavedDrawing = useCallback(async (drawingId: string) => {
    const client = clientRef.current;
    if (!client) return { ok: false, message: "Mac connection is unavailable" } as const;
    try {
      await client.deleteSavedDrawing(drawingId);
      setSavedDrawings((current) => current.filter((drawing) => drawing.id !== drawingId));
      return { ok: true, message: "Saved drawing deleted" } as const;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Saved drawing could not be deleted",
      } as const;
    }
  }, []);

  return {
    snapshot,
    phase,
    cached,
    nativeSessions,
    sessions,
    sessionsAvailable,
    codexUsage,
    codexUsageLoaded,
    runtimeDiagnostics,
    runtimeDiagnosticsLoaded,
    contextRoomStatus,
    contextRoomStatusLoaded,
    productState,
    productStateLoaded,
    pushStatus,
    pushStatusLoaded,
    devices,
    currentDeviceId,
    devicesLoaded,
    savedDrawings,
    savedDrawingsLoaded,
    pendingCount,
    lastAck,
    pair,
    command,
    sketch,
    commandStatus,
    captureSite: useCallback(async (request) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      return client.captureSite(request);
    }, []),
    fetchManagedSites: useCallback(async (threadId) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      return client.fetchManagedSites(threadId);
    }, []),
    fetchOpenBrowserTabs: useCallback(async (threadId) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      return client.fetchOpenBrowserTabs(threadId);
    }, []),
    fetchBrowserTabFrame: useCallback(async (threadId, tabId) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      return client.fetchBrowserTabFrame(threadId, tabId);
    }, []),
    controlBrowserTab: useCallback(async (threadId, tabId, action) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      return client.controlBrowserTab(threadId, tabId, action);
    }, []),
    recordBrowserTabAction: useCallback(async (threadId, tabId, action) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      return client.recordBrowserTabAction(threadId, tabId, action);
    }, []),
    addManagedSite: useCallback(async (input) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      const next = await client.addManagedSite(input);
      await refreshSecondary();
      return next;
    }, [refreshSecondary]),
    removeManagedSite: useCallback(async (threadId, siteId) => {
      const client = clientRef.current;
      if (!client) throw new Error("Bridge is not ready");
      await client.removeManagedSite(threadId, siteId);
      await refreshSecondary();
    }, [refreshSecondary]),
    refreshSessions: refreshSecondary,
    refreshCodexUsage,
    refreshRuntimeDiagnostics,
    refreshContextRoomStatus,
    refreshPushStatus,
    savePushSubscription,
    removePushSubscription,
    saveProductState: saveGlobalProductState,
    refreshDevices,
    revokeDevice: revokePairedDevice,
    refreshSavedDrawings,
    loadSavedDrawing,
    saveDrawing,
    deleteSavedDrawing,
    fetchDiagrams: useCallback(async (threadId) => {
      const client = clientRef.current;
      if (!client) throw new Error("Mac connection is unavailable");
      return client.fetchDiagrams(threadId);
    }, []),
    updateDiagram: useCallback(async (diagramId, threadId, input) => {
      const client = clientRef.current;
      if (!client) throw new Error("Mac connection is unavailable");
      return client.updateDiagram(diagramId, threadId, input);
    }, []),
    clearAck: useCallback(() => setLastAck(null), []),
  };
}

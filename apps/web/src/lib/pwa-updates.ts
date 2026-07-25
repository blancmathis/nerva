import { useSyncExternalStore } from "react";

export interface AppBuildMeta {
  readonly product: "Nerva";
  readonly version: string;
  readonly buildId: string;
}

export interface PwaUpdateSnapshot {
  readonly updateReady: boolean;
  readonly checking: boolean;
  readonly currentVersion: string;
  readonly currentBuildId: string;
  readonly availableBuild: AppBuildMeta | null;
}

const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | null = null;
let started = false;
let updateReady = false;
let checking = false;
let availableBuild: AppBuildMeta | null = null;
let currentSnapshot: PwaUpdateSnapshot = {
  updateReady: false,
  checking: false,
  currentVersion: __NERVA_VERSION__,
  currentBuildId: __NERVA_BUILD_ID__,
  availableBuild: null,
};

function snapshot(): PwaUpdateSnapshot {
  return currentSnapshot;
}

function refreshSnapshot(): void {
  currentSnapshot = {
    updateReady,
    checking,
    currentVersion: __NERVA_VERSION__,
    currentBuildId: __NERVA_BUILD_ID__,
    availableBuild,
  };
}

function publish(): void {
  refreshSnapshot();
  for (const listener of listeners) listener();
}

function appBuildMeta(value: unknown): AppBuildMeta | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return source.product === "Nerva"
    && typeof source.version === "string"
    && source.version.length > 0
    && typeof source.buildId === "string"
    && /^[a-f0-9]{16}$/u.test(source.buildId)
    ? source as unknown as AppBuildMeta
    : null;
}

async function readAvailableBuild(): Promise<void> {
  try {
    const response = await fetch("/app-meta.json", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return;
    availableBuild = appBuildMeta(await response.json());
  } catch {
    // Offline is a normal PWA state; the last known update proof remains.
  }
}

function markUpdateReady(): void {
  updateReady = true;
  void readAvailableBuild().finally(publish);
  publish();
}

export async function checkForPwaUpdate(): Promise<void> {
  if (!registration || checking) return;
  checking = true;
  publish();
  try {
    await registration.update();
    await readAvailableBuild();
  } finally {
    checking = false;
    publish();
  }
}

export function reloadUpdatedPwa(): void {
  window.location.reload();
}

export function startPwaUpdateMonitor(): void {
  if (started || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  started = true;
  window.addEventListener("load", () => {
    const hadControllerAtStart = navigator.serviceWorker.controller !== null;
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((next) => {
      registration = next;
      if (next.waiting && hadControllerAtStart) markUpdateReady();
      next.addEventListener("updatefound", () => {
        const worker = next.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "activated" && hadControllerAtStart) markUpdateReady();
        });
      });
      void checkForPwaUpdate();
    }).catch(() => undefined);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadControllerAtStart) markUpdateReady();
    });
  }, { once: true });

  const onVisible = () => {
    if (document.visibilityState === "visible") void checkForPwaUpdate();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.setInterval(() => {
    if (document.visibilityState === "visible") void checkForPwaUpdate();
  }, 15 * 60_000);
}

export function usePwaUpdate(): PwaUpdateSnapshot & {
  readonly check: () => Promise<void>;
  readonly reload: () => void;
} {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    snapshot,
  );
  return { ...current, check: checkForPwaUpdate, reload: reloadUpdatedPwa };
}

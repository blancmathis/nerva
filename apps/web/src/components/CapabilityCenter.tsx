import type {
  RuntimeCapabilityCheck,
  RuntimeCapabilityState,
  RuntimeDiagnostics,
} from "@codex-pad/protocol";
import { useMemo, useState } from "react";

import type { ConnectionPhase } from "../lib/model";
import type { PwaUpdateSnapshot } from "../lib/pwa-updates";
import type { PushServerStatus } from "../lib/bridge-client";
import { CheckIcon, CloseIcon, RefreshIcon, SlidersIcon } from "./Icons";

interface CapabilityCenterProps {
  readonly phase: ConnectionPhase;
  readonly diagnostics: RuntimeDiagnostics | null;
  readonly diagnosticsLoaded: boolean;
  readonly pwa: PwaUpdateSnapshot;
  readonly pushStatus: PushServerStatus | null;
  readonly pushStatusLoaded: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onCheckForUpdate: () => Promise<void>;
}

interface ClientCheck {
  readonly id: string;
  readonly label: string;
  readonly state: RuntimeCapabilityState;
  readonly reason: string;
}

const STATE_LABELS: Readonly<Record<RuntimeCapabilityState, string>> = {
  available: "Available",
  recovering: "Recovering",
  needsVerification: "Needs verification",
  unavailable: "Unavailable",
};

function notificationsCheck(pushStatus: PushServerStatus | null, pushStatusLoaded: boolean): ClientCheck {
  const serviceWorker = "serviceWorker" in navigator;
  const notifications = "Notification" in window;
  if (!serviceWorker || !notifications) {
    return {
      id: "notifications",
      label: "Notifications",
      state: "unavailable",
      reason: "This browser does not expose installed-PWA notifications.",
    };
  }
  if (Notification.permission === "denied") {
    return {
      id: "notifications",
      label: "Notifications",
      state: "unavailable",
      reason: "Notification permission is blocked in iPadOS Settings.",
    };
  }
  if (Notification.permission !== "granted") {
    return {
      id: "notifications",
      label: "Notifications",
      state: "needsVerification",
      reason: "Permission has not been granted for this installed app.",
    };
  }
  if (pushStatus?.subscribed) {
    return {
      id: "notifications",
      label: "Notifications",
      state: "available",
      reason: "Encrypted background Web Push is subscribed for this paired device.",
    };
  }
  return {
    id: "notifications",
    label: "Notifications",
    state: pushStatusLoaded ? "needsVerification" : "recovering",
    reason: pushStatusLoaded
      ? "Permission is granted, but this device has no active Mac Push subscription."
      : "Checking the paired device's private Push subscription.",
  };
}

function capabilitySummary(checks: readonly { readonly state: RuntimeCapabilityState }[]): RuntimeCapabilityState {
  if (checks.some((check) => check.state === "unavailable")) return "unavailable";
  if (checks.some((check) => check.state === "recovering")) return "recovering";
  if (checks.some((check) => check.state === "needsVerification")) return "needsVerification";
  return "available";
}

function formatProof(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function diagnosticText(
  diagnostics: RuntimeDiagnostics | null,
  client: ClientCheck,
  pwa: PwaUpdateSnapshot,
): string {
  const lines = [
    `Nerva ${pwa.currentVersion} (${pwa.currentBuildId})`,
    `PWA update ready: ${pwa.updateReady ? "yes" : "no"}`,
  ];
  if (diagnostics) {
    lines.push(
      `Bridge ${diagnostics.bridgeVersion} / protocol ${diagnostics.protocolVersion}`,
      `Codex ${diagnostics.codexVersion ?? "unknown"}`,
      `Schema ${diagnostics.schemaCompatibility.state}: ${diagnostics.schemaCompatibility.summary}`,
      ...diagnostics.checks.map((check) => `${check.label}: ${STATE_LABELS[check.state]}${check.reason ? ` — ${check.reason}` : ""}`),
    );
  }
  lines.push(`${client.label}: ${STATE_LABELS[client.state]} — ${client.reason}`);
  return lines.join("\n");
}

function CapabilityRow({ check }: { readonly check: RuntimeCapabilityCheck | ClientCheck }) {
  const proof = "lastProvenAt" in check ? formatProof(check.lastProvenAt) : null;
  return (
    <li className="cp-capability-row" data-state={check.state}>
      <span className="cp-capability-row__light" aria-hidden="true" />
      <span className="cp-capability-row__copy">
        <strong>{check.label}</strong>
        <small>{check.reason ?? "Live proof is current."}</small>
      </span>
      <span className="cp-capability-row__state">
        {STATE_LABELS[check.state]}
        {proof && <small>Proved {proof}</small>}
      </span>
    </li>
  );
}

export function CapabilityCenter({
  phase,
  diagnostics,
  diagnosticsLoaded,
  pwa,
  pushStatus,
  pushStatusLoaded,
  onRefresh,
  onCheckForUpdate,
}: CapabilityCenterProps) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const clientCheck = useMemo(() => notificationsCheck(pushStatus, pushStatusLoaded), [open, pushStatus, pushStatusLoaded]);
  const checks = diagnostics?.checks ?? [];
  const summary = phase === "offline" || phase === "pairing"
    ? "unavailable"
    : checks.length === 0
      ? "recovering"
      : capabilitySummary([...checks, clientCheck]);

  async function refresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([onRefresh(), onCheckForUpdate()]);
    } finally {
      setRefreshing(false);
    }
  }

  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnosticText(diagnostics, clientCheck, pwa));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="cp-capability-trigger"
        data-state={summary}
        aria-label={`Open Capability Center — ${STATE_LABELS[summary]}`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <SlidersIcon />
        <span aria-hidden="true" />
      </button>
      {open && (
        <div className="cp-capability-layer" role="presentation" onPointerDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <section className="cp-capability-center" role="dialog" aria-modal="true" aria-labelledby="capability-center-title">
            <header>
              <div>
                <p className="cp-overline">Live integration proof</p>
                <h2 id="capability-center-title">Capability Center</h2>
                <p>Each control is shown against the layer it actually needs.</p>
              </div>
              <button type="button" className="cp-icon-button" aria-label="Close Capability Center" onClick={() => setOpen(false)}><CloseIcon /></button>
            </header>

            {!diagnosticsLoaded ? (
              <div className="cp-capability-loading" aria-busy="true">Reading the Mac runtime…</div>
            ) : diagnostics ? (
              <ul className="cp-capability-list">
                {diagnostics.checks.map((check) => <CapabilityRow key={check.id} check={check} />)}
                <CapabilityRow check={clientCheck} />
              </ul>
            ) : (
              <div className="cp-capability-loading">Runtime diagnostics are unavailable while the Mac reconnects.</div>
            )}

            <div className="cp-capability-builds">
              <div><span>Nerva</span><strong>{pwa.currentVersion}</strong><small>Build {pwa.currentBuildId}</small></div>
              <div><span>Bridge</span><strong>{diagnostics?.bridgeVersion ?? "—"}</strong><small>Protocol {diagnostics?.protocolVersion ?? "—"}</small></div>
              <div><span>Codex</span><strong>{diagnostics?.codexVersion ?? "Unknown"}</strong><small>Snapshot #{diagnostics?.snapshotSequence ?? "—"}</small></div>
            </div>

            {diagnostics && (
              <article className="cp-schema-proof" data-state={diagnostics.schemaCompatibility.state}>
                <span className="cp-schema-proof__icon"><CheckIcon /></span>
                <span><strong>Installed schema: {diagnostics.schemaCompatibility.state}</strong><small>{diagnostics.schemaCompatibility.summary}</small></span>
                {diagnostics.schemaCompatibility.remediation && <code>{diagnostics.schemaCompatibility.remediation}</code>}
              </article>
            )}

            <footer>
              <button type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshIcon />{refreshing ? "Checking…" : "Run diagnostics"}</button>
              <button type="button" className="is-secondary" onClick={() => void copyDiagnostics()}>{copied ? "Copied" : "Copy summary"}</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

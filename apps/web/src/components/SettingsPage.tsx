import { useState } from "react";
import type { ContextRoomStatus, PairedDevice } from "@codex-pad/protocol";
import type { ModelCapability } from "../lib/model";
import type { ModelReasoningPreset, UiPreferences } from "../lib/storage";
import { ArrowDownIcon, ArrowUpIcon, ChevronIcon, CloseIcon, PlusIcon, SlidersIcon } from "./Icons";
import type { NervaNotificationPermission } from "../lib/agent-notifications";
import type { PushServerStatus } from "../lib/bridge-client";
import { NervaCard } from "./NervaCard";

interface SettingsPageProps {
  readonly preferences: UiPreferences;
  readonly models: readonly ModelCapability[];
  readonly onChange: (preferences: UiPreferences) => void;
  readonly onBack: () => void;
  readonly onManageSavedDrawings: () => void;
  readonly devices: readonly PairedDevice[];
  readonly currentDeviceId: string | null;
  readonly devicesLoaded: boolean;
  readonly onRefreshDevices: () => Promise<void>;
  readonly onRevokeDevice: (deviceId: string) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly notificationPermission: NervaNotificationPermission;
  readonly pushStatus: PushServerStatus | null;
  readonly pushStatusLoaded: boolean;
  readonly onEnableNotifications: () => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly onDisableNotifications: () => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly contextRoomStatus: ContextRoomStatus | null;
  readonly contextRoomStatusLoaded: boolean;
  readonly onRefreshContextRoom: () => Promise<void>;
}

const REASONING = ["minimal", "low", "medium", "high", "xhigh", "ultra", "max"] as const;

function supportedReasoning(model: ModelCapability | undefined): readonly ModelReasoningPreset["reasoning"][] {
  return model?.supportedReasoningEfforts.filter(
    (value): value is ModelReasoningPreset["reasoning"] => REASONING.includes(value as ModelReasoningPreset["reasoning"]),
  ) ?? [];
}

function Toggle({ checked, disabled = false, label, onChange }: { readonly checked: boolean; readonly disabled?: boolean; readonly label: string; readonly onChange: (checked: boolean) => void }) {
  return <button type="button" className="cp-toggle" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

export function SettingsPage({
  preferences,
  models,
  onChange,
  onBack,
  onManageSavedDrawings,
  devices,
  currentDeviceId,
  devicesLoaded,
  onRefreshDevices,
  onRevokeDevice,
  notificationPermission,
  pushStatus,
  pushStatusLoaded,
  onEnableNotifications,
  onDisableNotifications,
  contextRoomStatus,
  contextRoomStatusLoaded,
  onRefreshContextRoom,
}: SettingsPageProps) {
  const [addingPreset, setAddingPreset] = useState(false);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState<ModelReasoningPreset["reasoning"]>("medium");
  const [confirmDeviceId, setConfirmDeviceId] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [requestingNotifications, setRequestingNotifications] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const hapticsAvailable = typeof navigator !== "undefined" && "vibrate" in navigator;
  const selectedModel = models.find((candidate) => candidate.model === model);
  const reasoningOptions = supportedReasoning(selectedModel);
  const duplicatePreset = preferences.modelReasoningPresets.some((preset) => (
    preset.model === model && preset.reasoning === reasoning
  ));

  function update(patch: Partial<UiPreferences>) {
    onChange({ ...preferences, ...patch });
  }

  function movePreset(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= preferences.modelReasoningPresets.length) return;
    const presets = [...preferences.modelReasoningPresets];
    [presets[index], presets[nextIndex]] = [presets[nextIndex]!, presets[index]!];
    update({ modelReasoningPresets: presets });
  }

  function beginAddingPreset() {
    const initialModel = models.find((candidate) => candidate.isDefault) ?? models[0];
    const options = supportedReasoning(initialModel);
    setModel(initialModel?.model ?? "");
    setReasoning(options.includes(initialModel?.defaultReasoningEffort as ModelReasoningPreset["reasoning"])
      ? initialModel!.defaultReasoningEffort as ModelReasoningPreset["reasoning"]
      : options[0] ?? "medium");
    setAddingPreset(true);
  }

  return (
    <main className="cp-settings">
      <header className="cp-settings__header cp-enter">
        <button type="button" className="cp-back-button" onClick={onBack}><ChevronIcon direction="left" />Home</button>
        <div><p className="cp-overline">Nerva</p><h1>Settings</h1><p>Global presentation and session controls.</p></div>
        <span><SlidersIcon /></span>
      </header>

      <div className="cp-settings__grid cp-enter cp-enter--2">
        <section className="cp-settings-card">
          <header><p className="cp-overline">Appearance</p><h2>Light, material, density.</h2></header>
          <div className="cp-setting-row">
            <div><strong>Session cards</strong><small>Use the same density across Home.</small></div>
            <div className="cp-segmented cp-segmented--small">
              <button type="button" aria-pressed={preferences.cardDensity === "rich"} onClick={() => update({ cardDensity: "rich" })}>Rich</button>
              <button type="button" aria-pressed={preferences.cardDensity === "compact"} onClick={() => update({ cardDensity: "compact" })}>Compact</button>
            </div>
          </div>
          <div className="cp-setting-row">
            <div><strong>Theme</strong><small>System follows the iPad appearance.</small></div>
            <select aria-label="Theme" value={preferences.theme} onChange={(event) => update({ theme: event.target.value as UiPreferences["theme"] })}>
              <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
            </select>
          </div>
          <div className="cp-setting-row">
            <div><strong>Motion</strong><small>Reduced uses opacity only and respects accessibility settings.</small></div>
            <select aria-label="Motion" value={preferences.motion} onChange={(event) => update({ motion: event.target.value as UiPreferences["motion"] })}>
              <option value="system">System</option><option value="full">Full</option><option value="reduced">Reduced</option>
            </select>
          </div>
          <div className="cp-setting-row">
            <div><strong>Haptics</strong><small>{hapticsAvailable ? "Mode, capture, approval, and transfer feedback." : "Not exposed by installed iPad web apps."}</small></div>
            <Toggle label="Haptics" checked={hapticsAvailable && preferences.haptics} disabled={!hapticsAvailable} onChange={(haptics) => update({ haptics })} />
          </div>
        </section>

        <section className="cp-settings-card">
          <header><p className="cp-overline">Agentic system</p><h2>Context Room.</h2></header>
          <NervaCard document={{
            version: 1,
            id: "context-room-status",
            source: "context-room",
            title: contextRoomStatus?.roomName ?? "Context Room",
            subtitle: "Read-only health adapter. Review and orchestration mutations stay outside this surface.",
            tone: contextRoomStatus?.available ? "success" : contextRoomStatus?.configured ? "warning" : "neutral",
            blocks: [
              {
                type: "status",
                label: "Connection",
                value: !contextRoomStatusLoaded ? "Checking" : contextRoomStatus?.available ? "Available" : contextRoomStatus?.configured ? "Unavailable" : "Not configured",
                tone: contextRoomStatus?.available ? "success" : contextRoomStatus?.configured ? "warning" : "neutral",
              },
              ...(contextRoomStatus?.version ? [{ type: "metric" as const, label: "Version", value: contextRoomStatus.version, detail: null }] : []),
              ...(contextRoomStatus?.reason ? [{ type: "text" as const, text: contextRoomStatus.reason }] : []),
            ],
          }} />
          <button type="button" className="cp-refresh-devices" onClick={() => void onRefreshContextRoom()}>Refresh Context Room</button>
          <p className="cp-settings-caveat">Nerva Cards render a strict data schema—never arbitrary agent HTML or JavaScript.</p>
        </section>

        <section className="cp-settings-card">
          <header><p className="cp-overline">Home</p><h2>Your layout stays yours.</h2><p>Status filters temporarily focus the same Home without changing its sections, cases or order.</p></header>
          <button type="button" className="cp-settings-action" onClick={onManageSavedDrawings}><span><strong>Saved Drawings</strong><small>Review or delete drawings kept on the Mac.</small></span><ChevronIcon /></button>
        </section>

        <section className="cp-settings-card cp-settings-card--wide">
          <header><p className="cp-overline">Model + Reasoning</p><h2>Build the one-touch slider.</h2><p>Presets are ordered from lighter to stronger. Unsupported combinations remain disabled rather than falling back silently.</p></header>
          <div className="cp-preset-list">
            {preferences.modelReasoningPresets.map((preset, index) => (
              <article key={preset.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{models.find((candidate) => candidate.model === preset.model)?.displayName ?? preset.model}</strong><small>{preset.reasoning} reasoning</small></div>
                <Toggle label={`Enable ${preset.model} ${preset.reasoning}`} checked={preset.enabled} onChange={(enabled) => update({ modelReasoningPresets: preferences.modelReasoningPresets.map((candidate) => candidate.id === preset.id ? { ...candidate, enabled } : candidate) })} />
                <button type="button" aria-label={`Move ${preset.model} ${preset.reasoning} up`} disabled={index === 0} onClick={() => movePreset(index, -1)}><ArrowUpIcon /></button>
                <button type="button" aria-label={`Move ${preset.model} ${preset.reasoning} down`} disabled={index === preferences.modelReasoningPresets.length - 1} onClick={() => movePreset(index, 1)}><ArrowDownIcon /></button>
                <button type="button" aria-label={`Remove ${preset.model} ${preset.reasoning}`} onClick={() => update({ modelReasoningPresets: preferences.modelReasoningPresets.filter((candidate) => candidate.id !== preset.id) })}><CloseIcon /></button>
              </article>
            ))}
            {preferences.modelReasoningPresets.length === 0 && <p className="cp-preset-empty">No presets yet. The Session page continues to show the current Codex reasoning control.</p>}
          </div>
          {addingPreset ? (
            <form className="cp-preset-form" onSubmit={(event) => {
              event.preventDefault();
              if (!selectedModel || !reasoningOptions.includes(reasoning) || duplicatePreset) return;
              update({ modelReasoningPresets: [...preferences.modelReasoningPresets, { id: crypto.randomUUID(), model: selectedModel.model, reasoning, enabled: true }] });
              setModel("");
              setAddingPreset(false);
            }}>
              <label><span>Model</span><select aria-label="Model" value={model} onChange={(event) => {
                const nextModel = models.find((candidate) => candidate.model === event.target.value);
                const nextOptions = supportedReasoning(nextModel);
                setModel(event.target.value);
                setReasoning(nextOptions.includes(nextModel?.defaultReasoningEffort as ModelReasoningPreset["reasoning"])
                  ? nextModel!.defaultReasoningEffort as ModelReasoningPreset["reasoning"]
                  : nextOptions[0] ?? "medium");
              }} autoFocus>{models.map((candidate) => <option key={candidate.model} value={candidate.model}>{candidate.displayName}</option>)}</select></label>
              <label><span>Reasoning</span><select value={reasoning} onChange={(event) => setReasoning(event.target.value as ModelReasoningPreset["reasoning"])}>{reasoningOptions.map((level) => <option key={level}>{level}</option>)}</select></label>
              <button type="submit" disabled={!selectedModel || reasoningOptions.length === 0 || duplicatePreset}>{duplicatePreset ? "Already added" : "Add preset"}</button>
              <button type="button" onClick={() => setAddingPreset(false)}>Cancel</button>
            </form>
          ) : <button type="button" className="cp-add-preset" disabled={models.length === 0} onClick={beginAddingPreset}><PlusIcon />{models.length === 0 ? "Waiting for Codex models…" : "Add preset"}</button>}
          <p className="cp-settings-caveat">Only models and reasoning levels currently reported by Codex can be added. Presets remain synchronized across paired devices.</p>
        </section>

        <section className="cp-settings-card">
          <header><p className="cp-overline">Notifications</p><h2>Only the moments that matter.</h2></header>
          <div className="cp-notification-permission" data-state={pushStatus?.subscribed ? "subscribed" : notificationPermission}>
            <span><strong>Background alerts</strong><small>{pushStatus?.subscribed
              ? "Active—even when Nerva is fully suspended."
              : notificationPermission === "granted"
                ? pushStatusLoaded ? "Permission granted. Finish the private Mac subscription." : "Checking the private Mac subscription…"
              : notificationPermission === "denied"
                ? "Blocked in iPadOS Settings."
                : notificationPermission === "unsupported"
                  ? "Unavailable in this browser context."
                  : "Enable from one explicit touch in the installed app."}</small></span>
            {pushStatus !== null && notificationPermission !== "denied" && notificationPermission !== "unsupported" && <button type="button" disabled={requestingNotifications} onClick={() => {
              setRequestingNotifications(true);
              setNotificationMessage(null);
              const operation = pushStatus.subscribed ? onDisableNotifications : onEnableNotifications;
              void operation().then((result) => setNotificationMessage(result.message)).finally(() => setRequestingNotifications(false));
            }}>{requestingNotifications ? "Updating…" : pushStatus.subscribed ? "Turn off" : "Enable"}</button>}
          </div>
          {notificationMessage && <p className="cp-settings-caveat" role="status">{notificationMessage}</p>}
          {([
            ["needsApproval", "Needs approval"],
            ["completed", "Completed"],
            ["error", "Error"],
            ["waiting", "Waiting for your answer"],
          ] as const).map(([key, label]) => (
            <div className="cp-setting-row" key={key}><div><strong>{label}</strong></div><Toggle label={`${label} notifications`} checked={preferences.notifications[key]} onChange={(checked) => update({ notifications: { ...preferences.notifications, [key]: checked } })} /></div>
          ))}
          <p className="cp-settings-caveat">Nerva sends only blocking questions, approvals, errors, important pinned completions, and grouped review-ready results. The Lock Screen never offers an approval action; tapping opens the exact Session or Home Priority.</p>
        </section>

        <section className="cp-settings-card">
          <header><p className="cp-overline">Devices</p><h2>Private tailnet connection.</h2></header>
          <div className="cp-device-list">
            {devices.filter((device) => device.revokedAt === null).map((device) => {
              const current = device.id === currentDeviceId;
              return (
                <div className="cp-device-row" key={device.id}>
                  <span className="cp-device-row__light" />
                  <div><strong>{current ? "This iPad" : device.name}</strong><small>{current ? device.name : `Paired ${new Date(device.createdAt).toLocaleDateString()}`}</small></div>
                  {confirmDeviceId === device.id ? (
                    <div className="cp-device-confirm">
                      <button type="button" disabled={deviceBusy !== null} onClick={() => {
                        setDeviceBusy(device.id);
                        setDeviceMessage(null);
                        void onRevokeDevice(device.id).then((result) => {
                          setDeviceBusy(null);
                          setConfirmDeviceId(null);
                          setDeviceMessage(result.message);
                        });
                      }}>{deviceBusy === device.id ? "Disconnecting…" : "Confirm"}</button>
                      <button type="button" disabled={deviceBusy !== null} onClick={() => setConfirmDeviceId(null)}>Cancel</button>
                    </div>
                  ) : <button type="button" onClick={() => setConfirmDeviceId(device.id)}>{current ? "Disconnect" : "Revoke"}</button>}
                </div>
              );
            })}
            {devicesLoaded && devices.every((device) => device.revokedAt !== null) && <p className="cp-preset-empty">No active paired devices.</p>}
            {!devicesLoaded && <p className="cp-preset-empty">Loading paired devices…</p>}
          </div>
          {deviceMessage && <p className="cp-settings-caveat" role="status">{deviceMessage}</p>}
          <button type="button" className="cp-refresh-devices" disabled={deviceBusy !== null} onClick={() => void onRefreshDevices()}>Refresh devices</button>
        </section>
      </div>
    </main>
  );
}

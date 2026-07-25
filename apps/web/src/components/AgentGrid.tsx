import { useEffect, useState } from "react";
import { STATUS_LABELS, type AgentSlot } from "../lib/model";

interface AgentGridProps {
  readonly slots: readonly AgentSlot[];
  readonly activeThreadId?: string | null;
  readonly canSelect: boolean;
  readonly selectingSlotId: string | null;
  readonly onSelect: (slot: AgentSlot) => void;
  readonly decorations?: Readonly<Record<string, AgentDecoration>>;
}

export interface AgentDecoration {
  readonly hasSite: boolean;
  readonly siteThumbnailUrl: string | null;
  readonly draftFrames: number;
}

function slotNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function relativeActivity(activityAt: number | null, now = Date.now()): string | null {
  if (activityAt === null) return null;
  const elapsed = Math.max(0, now - activityAt);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

type StatusObservation = Readonly<{ status: AgentSlot["status"]; observedAt: number }>;

function observeStatuses(
  slots: readonly AgentSlot[],
  previous: Readonly<Record<string, StatusObservation>>,
  now: number,
): Readonly<Record<string, StatusObservation>> {
  return Object.fromEntries(slots.map((slot) => {
    const existing = previous[slot.slotId];
    return [slot.slotId, existing?.status === slot.status ? existing : { status: slot.status, observedAt: now }];
  }));
}

export function AgentGrid({ slots, activeThreadId = null, canSelect, selectingSlotId, onSelect, decorations = {} }: AgentGridProps) {
  const [clock, setClock] = useState(() => Date.now());
  const [statusObservations, setStatusObservations] = useState<Readonly<Record<string, StatusObservation>>>(() => (
    observeStatuses(slots, {}, Date.now())
  ));

  useEffect(() => {
    const now = Date.now();
    setClock(now);
    setStatusObservations((previous) => observeStatuses(slots, previous, now));
  }, [slots]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className={`agent-grid${canSelect ? "" : " is-readonly"}`} aria-label="Codex Micro agent slots">
      {slots.map((slot) => {
        const disabled = !canSelect || !slot.threadKey;
        const statusLabel = STATUS_LABELS[slot.status];
        const activityTime = relativeActivity(slot.activityAt, clock);
        const statusObservedAt = statusObservations[slot.slotId]?.observedAt ?? clock;
        const statusAge = relativeActivity(statusObservedAt, clock) ?? "now";
        const decoration = decorations[slot.slotId];
        const activeOnMac = slot.threadId !== null && slot.threadId === activeThreadId;
        const needsAttention = ["unread", "awaiting-approval", "awaiting-response", "error"].includes(slot.status);
        return (
          <button
            key={slot.slotId}
            type="button"
            className={`agent-card status-${slot.status}${slot.selected ? " is-selected" : ""}${activeOnMac ? " is-active-on-mac" : ""}`}
            aria-pressed={slot.selected}
            aria-label={`Agent ${slotNumber(slot.index)}, ${slot.title}, ${statusLabel}${slot.selected ? ", selected" : ""}${activeOnMac ? ", active on Mac" : ""}`}
            disabled={disabled}
            onClick={() => onSelect(slot)}
          >
            <span className="signal-rail" aria-hidden="true"><span /></span>
            <span className="card-register" aria-hidden="true">{slotNumber(slot.index)}</span>
            <span className="agent-card-copy">
              <span className="agent-kicker">
                <span>Agent {slotNumber(slot.index)}</span>
                <span className="status-label">{statusLabel}</span>
              </span>
              <span className="agent-title" title={slot.title}>{slot.title}</span>
              {decoration?.siteThumbnailUrl && (
                <span className="agent-site-thumbnail" aria-label="Latest saved site review frame">
                  <img src={decoration.siteThumbnailUrl} alt="" />
                </span>
              )}
              {activityTime && (
                <span className="agent-activity" title={slot.activityAt ? new Date(slot.activityAt).toLocaleString() : undefined}>
                  <span>Activity</span><time>{activityTime}</time>
                </span>
              )}
              <span className="agent-status-age" title="Measured from when this browser observed the current state">
                <span>State seen</span><time>{statusAge}</time>
              </span>
              <span className="thread-reference">
                {slot.suffix ? <>thread <span>{slot.suffix}</span></> : "No task assigned"}
              </span>
              {(needsAttention || (decoration && (decoration.hasSite || decoration.draftFrames > 0))) && (
                <span className="agent-badges" aria-label="Task context">
                  {needsAttention && <span className="needs-attention">Needs attention</span>}
                  {decoration?.hasSite && <span>Site</span>}
                  {(decoration?.draftFrames ?? 0) > 0 && <span>{decoration?.draftFrames} draft {decoration?.draftFrames === 1 ? "frame" : "frames"}</span>}
                </span>
              )}
            </span>
            {slot.selected && <span className="selected-flag">Selected</span>}
            {activeOnMac && <span className="mac-active-flag">On Mac</span>}
            {selectingSlotId === slot.slotId && <span className="card-pending" aria-label="Selection pending" />}
          </button>
        );
      })}
    </section>
  );
}

import type { AgentSlot, BridgeSnapshot, ConnectionPhase } from "./model";

export interface MutationGateState {
  readonly phase: ConnectionPhase;
  readonly cached: boolean;
  readonly snapshot: BridgeSnapshot | null;
}

function capabilityToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Returns the current mutation snapshot only while it is attested by the live
 * WebSocket connection. Degraded native metadata is allowed; an offline or
 * cached snapshot is display-only.
 */
export function liveMutationSnapshot(state: MutationGateState): BridgeSnapshot | null {
  if (
    state.phase !== "online"
    || state.cached
    || state.snapshot === null
    || state.snapshot.health === "offline"
  ) return null;
  return state.snapshot;
}

export function supportsBridgeCommand(state: MutationGateState, command: string): boolean {
  const snapshot = liveMutationSnapshot(state);
  if (!snapshot) return false;
  const expected = capabilityToken(command);
  return snapshot.capabilities.commands.some((candidate) => capabilityToken(candidate) === expected);
}

/** A selected-target mutation needs one exact selected slot and matching snapshot identities. */
export function hasExactSelectedTarget(snapshot: BridgeSnapshot, slot: AgentSlot | null): boolean {
  if (
    !slot?.selected
    || !slot.threadId
    || !slot.threadKey
    || snapshot.selectedSlotId !== slot.slotId
    || (
      snapshot.selectedThreadKey !== slot.threadId
      && snapshot.selectedThreadKey !== slot.threadKey
    )
  ) return false;
  const selected = snapshot.slots.filter((candidate) => candidate.selected);
  return selected.length === 1
    && selected[0]?.slotId === slot.slotId
    && selected[0]?.threadId === slot.threadId
    && selected[0]?.threadKey === slot.threadKey;
}

export function supportsSelectedTargetCommand(
  state: MutationGateState,
  command: string,
  slot: AgentSlot | null,
): boolean {
  const snapshot = liveMutationSnapshot(state);
  return snapshot !== null
    && supportsBridgeCommand(state, command)
    && hasExactSelectedTarget(snapshot, slot);
}

/** Selection targets must themselves still be part of the attested snapshot. */
export function supportsSlotSelection(state: MutationGateState, slot: AgentSlot): boolean {
  const snapshot = liveMutationSnapshot(state);
  if (!snapshot || !slot.threadId || !supportsBridgeCommand(state, "selectAgent")) return false;
  return snapshot.slots.some((candidate) => (
    candidate.slotId === slot.slotId
    && candidate.index === slot.index
    && candidate.threadId === slot.threadId
    && candidate.threadKey === slot.threadKey
  ));
}

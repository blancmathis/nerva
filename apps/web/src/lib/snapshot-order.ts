import type { BridgeSnapshot } from "./model";

export type SnapshotCursor = Pick<BridgeSnapshot, "bridgeInstanceId" | "seq">;
export type SnapshotAcceptance = "advanced" | "current" | "rejected";

/** Sequence numbers are monotonic only inside one running bridge generation. */
export function isFreshSnapshot(current: SnapshotCursor | null, next: SnapshotCursor): boolean {
  return current === null
    || current.bridgeInstanceId !== next.bridgeInstanceId
    || next.seq > current.seq;
}

/** Exact duplicates attest a socket without re-emitting display state. */
export function classifySnapshot(current: SnapshotCursor | null, next: SnapshotCursor): SnapshotAcceptance {
  if (current === null) return "advanced";
  if (current.bridgeInstanceId === next.bridgeInstanceId && current.seq === next.seq) return "current";
  return isFreshSnapshot(current, next) ? "advanced" : "rejected";
}

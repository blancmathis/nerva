import { BridgeInstanceIdSchema, CommandIdSchema } from "@codex-pad/protocol";
import {
  loadPendingCommandIds,
  savePendingCommandIds,
} from "./pending-command-store";

export const PENDING_DRAWING_DELIVERIES_STORAGE_KEY =
  "codex-pad.pending-drawing-deliveries.v1";
export const MAX_PERSISTED_DRAWING_DELIVERIES = 64;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SLOT_PATTERN = /^AG0[0-5]$/;

export interface PendingDrawingDeliveryBinding {
  readonly commandId: string;
  readonly expectedBridgeInstanceId: string;
  readonly slotId: string;
  readonly threadId: string;
  readonly threadKey: string;
  readonly expectedSnapshotSeq: number;
  readonly instructionHash: string;
  readonly draftIdentity: string;
}

interface PendingDrawingDeliveryEnvelope {
  readonly version: 1;
  readonly deliveries: readonly PendingDrawingDeliveryBinding[];
}

export interface DrawingDeliveryIdentity {
  readonly instructionHash: string;
  readonly draftIdentity: string;
}

function runtimeStorage(override: Storage | null | undefined): Storage | null {
  if (override !== undefined) return override;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function canonicalThreadId(value: unknown): string | null {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

function canonicalCommandId(value: unknown): string | null {
  const parsed = CommandIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validThreadKey(value: unknown, threadId: string): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.toLowerCase().endsWith(threadId);
}

function sanitizeBinding(value: unknown): PendingDrawingDeliveryBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Partial<PendingDrawingDeliveryBinding>;
  const commandId = canonicalCommandId(source.commandId);
  const bridgeInstanceId = BridgeInstanceIdSchema.safeParse(source.expectedBridgeInstanceId);
  const threadId = canonicalThreadId(source.threadId);
  if (
    !commandId
    || !bridgeInstanceId.success
    || !threadId
    || !SLOT_PATTERN.test(source.slotId ?? "")
    || !validThreadKey(source.threadKey, threadId)
    || !Number.isSafeInteger(source.expectedSnapshotSeq)
    || (source.expectedSnapshotSeq ?? -1) < 0
    || !SHA256_PATTERN.test(source.instructionHash ?? "")
    || !SHA256_PATTERN.test(source.draftIdentity ?? "")
  ) return null;

  return {
    commandId,
    expectedBridgeInstanceId: bridgeInstanceId.data,
    slotId: source.slotId as string,
    threadId,
    threadKey: source.threadKey,
    expectedSnapshotSeq: source.expectedSnapshotSeq as number,
    instructionHash: source.instructionHash as string,
    draftIdentity: source.draftIdentity as string,
  };
}

function sanitizeBindings(values: unknown): PendingDrawingDeliveryBinding[] {
  if (!Array.isArray(values)) return [];
  const byThread = new Map<string, PendingDrawingDeliveryBinding>();
  for (const value of values) {
    const binding = sanitizeBinding(value);
    if (!binding) continue;
    byThread.delete(binding.threadId);
    byThread.set(binding.threadId, binding);
  }
  return [...byThread.values()];
}

export function loadPendingDrawingDeliveries(
  storageOverride?: Storage | null,
): PendingDrawingDeliveryBinding[] {
  const storage = runtimeStorage(storageOverride);
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_DRAWING_DELIVERIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PendingDrawingDeliveryEnvelope>;
    if (parsed.version !== 1) return [];
    return sanitizeBindings(parsed.deliveries);
  } catch {
    return [];
  }
}

export function loadPendingDrawingDelivery(
  threadId: string,
  storageOverride?: Storage | null,
): PendingDrawingDeliveryBinding | null {
  const canonical = canonicalThreadId(threadId);
  if (!canonical) return null;
  return loadPendingDrawingDeliveries(storageOverride)
    .find((binding) => binding.threadId === canonical) ?? null;
}

/**
 * Persists only immutable routing and digest metadata, then adds the same
 * commandId to the generic GET-only reconciliation ledger. Mutation payloads,
 * PNG bytes, scene JSON, and instruction text never enter localStorage.
 */
export function savePendingDrawingDelivery(
  input: PendingDrawingDeliveryBinding,
  storageOverride?: Storage | null,
): boolean {
  const binding = sanitizeBinding(input);
  const storage = runtimeStorage(storageOverride);
  if (!binding || !storage) return false;

  try {
    const stored = loadPendingDrawingDelivery(binding.threadId, storage);
    if (stored && JSON.stringify(stored) !== JSON.stringify(binding)) return false;
    const current = loadPendingDrawingDeliveries(storage)
      .filter((candidate) => candidate.threadId !== binding.threadId);
    if (current.length >= MAX_PERSISTED_DRAWING_DELIVERIES) return false;
    const deliveries = sanitizeBindings([...current, binding]);
    const envelope: PendingDrawingDeliveryEnvelope = { version: 1, deliveries };
    storage.setItem(PENDING_DRAWING_DELIVERIES_STORAGE_KEY, JSON.stringify(envelope));
    savePendingCommandIds([...loadPendingCommandIds(storage), binding.commandId], storage);

    return loadPendingDrawingDelivery(binding.threadId, storage)?.commandId === binding.commandId
      && loadPendingCommandIds(storage).includes(binding.commandId);
  } catch {
    return false;
  }
}

export function deletePendingDrawingDelivery(
  threadId: string,
  storageOverride?: Storage | null,
): void {
  const canonical = canonicalThreadId(threadId);
  const storage = runtimeStorage(storageOverride);
  if (!canonical || !storage) return;
  try {
    const deliveries = loadPendingDrawingDeliveries(storage)
      .filter((binding) => binding.threadId !== canonical);
    if (deliveries.length === 0) {
      storage.removeItem(PENDING_DRAWING_DELIVERIES_STORAGE_KEY);
    } else {
      const envelope: PendingDrawingDeliveryEnvelope = { version: 1, deliveries };
      storage.setItem(PENDING_DRAWING_DELIVERIES_STORAGE_KEY, JSON.stringify(envelope));
    }
  } catch {
    // An unreadable record remains fail-closed; callers do not mint a new ID.
  }
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Secure draft hashing is unavailable in this browser.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createDrawingDeliveryIdentity(
  serializedScene: string,
  instruction: string,
): Promise<DrawingDeliveryIdentity> {
  const instructionHash = await sha256(`codex-pad-instruction-v1\0${instruction}`);
  const draftIdentity = await sha256(
    `codex-pad-drawing-draft-v1\0${serializedScene}\0${instructionHash}`,
  );
  return { instructionHash, draftIdentity };
}

export function bindingMatchesDrawingDraft(
  binding: PendingDrawingDeliveryBinding,
  identity: DrawingDeliveryIdentity,
): boolean {
  return binding.instructionHash === identity.instructionHash
    && binding.draftIdentity === identity.draftIdentity;
}

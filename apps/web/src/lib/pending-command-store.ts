import { CommandIdSchema } from "@codex-pad/protocol";

export const PENDING_COMMAND_IDS_STORAGE_KEY = "codex-pad.pending-command-ids.v1";
export const MAX_PERSISTED_PENDING_COMMAND_IDS = 64;

interface PendingCommandEnvelope {
  readonly version: 1;
  readonly commandIds: readonly string[];
}

function runtimeStorage(override: Storage | null | undefined): Storage | null {
  if (override !== undefined) return override;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function sanitizeCommandIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const unique = new Set<string>();
  for (const value of values) {
    const parsed = CommandIdSchema.safeParse(value);
    if (!parsed.success) continue;
    unique.delete(parsed.data);
    unique.add(parsed.data);
  }
  return [...unique].slice(-MAX_PERSISTED_PENDING_COMMAND_IDS);
}

/**
 * Loads opaque idempotency keys only. Mutation bodies are deliberately never
 * stored, so a page restart can reconcile delivery without replaying it.
 */
export function loadPendingCommandIds(storageOverride?: Storage | null): string[] {
  const storage = runtimeStorage(storageOverride);
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_COMMAND_IDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PendingCommandEnvelope>;
    if (parsed.version !== 1) return [];
    return sanitizeCommandIds(parsed.commandIds);
  } catch {
    return [];
  }
}

/** Returns the exact bounded list written to storage. */
export function savePendingCommandIds(
  commandIds: Iterable<string>,
  storageOverride?: Storage | null,
): string[] {
  const sanitized = sanitizeCommandIds([...commandIds]);
  const storage = runtimeStorage(storageOverride);
  if (!storage) return sanitized;
  try {
    if (sanitized.length === 0) {
      storage.removeItem(PENDING_COMMAND_IDS_STORAGE_KEY);
    } else {
      const envelope: PendingCommandEnvelope = { version: 1, commandIds: sanitized };
      storage.setItem(PENDING_COMMAND_IDS_STORAGE_KEY, JSON.stringify(envelope));
    }
  } catch {
    // The live in-memory set remains authoritative if Safari blocks storage.
  }
  return sanitized;
}

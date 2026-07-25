import { ContextRoomStatusSchema, type ContextRoomStatus } from "@codex-pad/protocol";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeContextRoomOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  if (
    url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new Error("Context Room origin must be an exact loopback HTTP origin");
  }
  return url.origin;
}

function roomName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const name = value.split(/[\\/]/u).filter(Boolean).at(-1)?.trim();
  return name ? name.slice(0, 100) : null;
}

export class ContextRoomAdapter {
  readonly origin: string | null;

  constructor(origin: string | null) {
    this.origin = origin;
  }

  async status(): Promise<ContextRoomStatus> {
    const checkedAt = Date.now();
    if (this.origin === null) {
      return ContextRoomStatusSchema.parse({
        configured: false,
        available: false,
        checkedAt,
        roomName: null,
        version: null,
        reason: "Set CODEX_PAD_CONTEXT_ROOM_ORIGIN to an exact local Context Room origin.",
      });
    }
    try {
      const response = await fetch(`${this.origin}/api/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2_500),
      });
      if (!response.ok) throw new Error(`Context Room health returned HTTP ${response.status}`);
      const payload = record(await response.json());
      const data = record(payload.data);
      const version = typeof payload.version === "string"
        ? payload.version
        : typeof data.version === "string"
          ? data.version
          : null;
      return ContextRoomStatusSchema.parse({
        configured: true,
        available: true,
        checkedAt,
        roomName: roomName(payload.root ?? data.root),
        version: version?.slice(0, 100) ?? null,
        reason: null,
      });
    } catch (error) {
      return ContextRoomStatusSchema.parse({
        configured: true,
        available: false,
        checkedAt,
        roomName: null,
        version: null,
        reason: error instanceof Error ? error.message.slice(0, 300) : "Context Room is unavailable.",
      });
    }
  }
}

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_SESSION_SUMMARIES,
  SessionSummarySchema,
  type SessionSummary,
} from "@codex-pad/protocol";
import { z } from "zod";

import { assertPrivateRegularFile, atomicWritePrivateJson } from "./atomic-file.js";
import type { BridgeDataPaths } from "./paths.js";

const CACHE_VERSION = 1 as const;
const MAX_CACHE_BYTES = 1024 * 1024;

const StoredSessionCatalogSchema = z.object({
  version: z.literal(CACHE_VERSION),
  updatedAt: z.number().int().nonnegative().safe(),
  sessions: z.array(SessionSummarySchema).max(MAX_SESSION_SUMMARIES),
}).strict();

type StoredSessionCatalog = z.infer<typeof StoredSessionCatalogSchema>;

function displayOnlySession(session: SessionSummary): SessionSummary {
  return SessionSummarySchema.parse({
    ...session,
    activityLabel: null,
    selected: false,
    microSlot: null,
    siteAssociations: [],
    siteAssociation: null,
  });
}

export class SessionCatalogCache {
  readonly filePath: string;
  readonly #now: () => number;

  constructor(paths: BridgeDataPaths, now: () => number = Date.now) {
    this.filePath = join(paths.cache, "session-catalog.json");
    this.#now = now;
  }

  async read(): Promise<readonly SessionSummary[] | null> {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Refusing a non-regular or symlinked session catalog cache");
    }
    await assertPrivateRegularFile(this.filePath);
    if (details.size > MAX_CACHE_BYTES) throw new Error("Session catalog cache is too large");
    const stored = StoredSessionCatalogSchema.parse(
      JSON.parse(await readFile(this.filePath, "utf8")) as unknown,
    );
    return stored.sessions.map(displayOnlySession);
  }

  async write(sessions: readonly SessionSummary[]): Promise<void> {
    const stored: StoredSessionCatalog = StoredSessionCatalogSchema.parse({
      version: CACHE_VERSION,
      updatedAt: this.#now(),
      sessions: sessions.map(displayOnlySession),
    });
    await atomicWritePrivateJson(this.filePath, stored);
  }
}

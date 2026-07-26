import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DiagramDocumentSchema,
  DiagramListSchema,
  DiagramPublishRequestSchema,
  DiagramUpdateRequestSchema,
  type DiagramDocument,
  type DiagramPublishRequest,
  type DiagramUpdateRequest,
} from "@codex-pad/protocol";
import { z } from "zod";

import {
  assertPrivateRegularFile,
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  withPrivateFileLock,
} from "./atomic-file.js";
import { defaultDataPaths, type BridgeDataPaths } from "./paths.js";

const MAX_DIAGRAMS = 48;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_INDEX_BYTES = 32 * 1024;
const MAX_TOTAL_RECORD_BYTES = 8 * 1024 * 1024;

const DiagramIndexSchema = z.object({
  version: z.literal(1),
  diagramIds: z.array(z.uuid()).max(MAX_DIAGRAMS),
}).strict();

type DiagramIndex = z.infer<typeof DiagramIndexSchema>;
type DiagramActor = "codex" | "ipad";

export class DiagramCapacityError extends Error {
  readonly statusCode = 409;

  constructor(message = "Diagram storage is full; remove an older diagram before publishing another") {
    super(message);
    this.name = "DiagramCapacityError";
  }
}

export class DiagramNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super("Diagram was not found");
    this.name = "DiagramNotFoundError";
  }
}

export class DiagramConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly current: DiagramDocument) {
    super("Diagram changed since this revision was opened; reload before saving again");
    this.name = "DiagramConflictError";
  }
}

export interface DiagramStoreOptions {
  readonly paths?: BridgeDataPaths;
  readonly directory?: string;
  readonly now?: () => number;
}

export class DiagramStore {
  readonly directory: string;
  readonly indexPath: string;
  readonly #now: () => number;

  constructor(options: DiagramStoreOptions = {}) {
    this.directory = options.directory
      ?? options.paths?.diagrams
      ?? defaultDataPaths().diagrams;
    this.indexPath = join(this.directory, "index.json");
    this.#now = options.now ?? Date.now;
  }

  async list(threadIdValue: string): Promise<readonly DiagramDocument[]> {
    const threadId = z.uuid().parse(threadIdValue).toLowerCase();
    const index = await this.#readIndex();
    const records = await Promise.all(index.diagramIds.map((id) => this.#readRecord(id)));
    return DiagramListSchema.parse({
      diagrams: records
        .filter((diagram) => diagram.threadId === threadId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    }).diagrams;
  }

  async get(idValue: string): Promise<DiagramDocument> {
    const id = z.uuid().parse(idValue).toLowerCase();
    const index = await this.#readIndex();
    if (!index.diagramIds.includes(id)) throw new DiagramNotFoundError();
    return this.#readRecord(id);
  }

  async publish(
    inputValue: DiagramPublishRequest,
    actor: DiagramActor = "codex",
  ): Promise<DiagramDocument> {
    const input = DiagramPublishRequestSchema.parse(inputValue);
    if (input.diagramId && input.expectedRevision !== undefined) {
      return this.update(
        input.diagramId,
        input.threadId,
        {
          expectedRevision: input.expectedRevision,
          title: input.title,
          nodes: input.nodes,
          edges: input.edges,
        },
        actor,
        input.sourceLabel,
      );
    }

    return withPrivateFileLock(this.indexPath, async () => {
      const index = await this.#readIndex();
      if (index.diagramIds.length >= MAX_DIAGRAMS) throw new DiagramCapacityError();
      const id = randomUUID();
      const now = this.#now();
      const document = DiagramDocumentSchema.parse({
        version: 2,
        diagramId: id,
        threadId: input.threadId,
        revision: 0,
        title: input.title,
        nodes: input.nodes,
        edges: input.edges,
        createdAt: now,
        updatedAt: now,
        createdBy: actor,
        lastEditedBy: actor,
        sourceLabel: input.sourceLabel ?? null,
      });
      const currentBytes = await this.#totalBytes(index);
      const nextBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
      if (nextBytes > MAX_RECORD_BYTES) {
        throw new DiagramCapacityError("Diagram exceeds the 512 KiB structured-document limit");
      }
      if (currentBytes + nextBytes > MAX_TOTAL_RECORD_BYTES) {
        throw new DiagramCapacityError("Diagram storage reached its 8 MiB structured-document limit");
      }
      await ensurePrivateDirectory(this.directory);
      await atomicWritePrivateJson(this.#recordPath(id), document);
      await atomicWritePrivateJson(this.indexPath, {
        version: 1,
        diagramIds: [id, ...index.diagramIds],
      } satisfies DiagramIndex);
      return document;
    });
  }

  async update(
    idValue: string,
    threadIdValue: string,
    inputValue: DiagramUpdateRequest,
    actor: DiagramActor = "ipad",
    sourceLabel?: string | null,
  ): Promise<DiagramDocument> {
    const id = z.uuid().parse(idValue).toLowerCase();
    const threadId = z.uuid().parse(threadIdValue).toLowerCase();
    const input = DiagramUpdateRequestSchema.parse(inputValue);
    return withPrivateFileLock(this.indexPath, async () => {
      const index = await this.#readIndex();
      if (!index.diagramIds.includes(id)) throw new DiagramNotFoundError();
      const current = await this.#readRecord(id);
      if (current.threadId !== threadId) throw new DiagramNotFoundError();
      if (current.revision !== input.expectedRevision) throw new DiagramConflictError(current);
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Diagram revision is exhausted");
      }
      const next = DiagramDocumentSchema.parse({
        ...current,
        title: input.title,
        nodes: input.nodes,
        edges: input.edges,
        revision: current.revision + 1,
        updatedAt: this.#now(),
        lastEditedBy: actor,
        sourceLabel: sourceLabel === undefined ? current.sourceLabel : sourceLabel,
      });
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_RECORD_BYTES) {
        throw new DiagramCapacityError("Diagram exceeds the 512 KiB structured-document limit");
      }
      await atomicWritePrivateJson(this.#recordPath(id), next);
      return next;
    });
  }

  #recordPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  async #totalBytes(index: DiagramIndex): Promise<number> {
    const records = await Promise.all(index.diagramIds.map((id) => this.#fileSize(this.#recordPath(id))));
    return records.reduce((total, size) => total + size, 0);
  }

  async #fileSize(path: string): Promise<number> {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Refusing a non-regular or symlinked diagram file");
    }
    await assertPrivateRegularFile(path);
    return details.size;
  }

  async #readIndex(): Promise<DiagramIndex> {
    return this.#readJsonFile(this.indexPath, MAX_INDEX_BYTES, DiagramIndexSchema, {
      version: 1,
      diagramIds: [],
    });
  }

  async #readRecord(id: string): Promise<DiagramDocument> {
    return this.#readJsonFile(this.#recordPath(id), MAX_RECORD_BYTES, DiagramDocumentSchema);
  }

  async #readJsonFile<T>(
    path: string,
    maximumBytes: number,
    schema: z.ZodType<T>,
    missingValue?: T,
  ): Promise<T> {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingValue !== undefined) {
        await ensurePrivateDirectory(dirname(path));
        return missingValue;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DiagramNotFoundError();
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Refusing a non-regular or symlinked diagram file");
    }
    if (details.size <= 0 || details.size > maximumBytes) {
      throw new Error("Diagram file exceeds its private storage limit");
    }
    await assertPrivateRegularFile(path);
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  }
}

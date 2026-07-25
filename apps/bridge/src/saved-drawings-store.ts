import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SavedDrawingCreateRequestSchema,
  SavedDrawingDetailSchema,
  SavedDrawingSummarySchema,
  SavedDrawingsListSchema,
  type SavedDrawingCreateRequest,
  type SavedDrawingDetail,
  type SavedDrawingSummary,
} from "@codex-pad/protocol";
import sharp from "sharp";
import { z } from "zod";

import {
  assertPrivateRegularFile,
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  withPrivateFileLock,
} from "./atomic-file.js";
import { defaultDataPaths, type BridgeDataPaths } from "./paths.js";

const MAX_DRAWINGS = 48;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 18 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024;

const SavedDrawingIndexSchema = z.object({
  version: z.literal(1),
  drawingIds: z.array(z.uuid()).max(MAX_DRAWINGS),
}).strict();

type SavedDrawingIndex = z.infer<typeof SavedDrawingIndexSchema>;

export class SavedDrawingCapacityError extends Error {
  readonly statusCode = 409;

  constructor(message = "Saved Drawings is full; delete one before keeping another") {
    super(message);
    this.name = "SavedDrawingCapacityError";
  }
}

export class SavedDrawingNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super("Saved drawing was not found");
    this.name = "SavedDrawingNotFoundError";
  }
}

export class SavedDrawingInputError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "SavedDrawingInputError";
  }
}

export interface SavedDrawingsStoreOptions {
  readonly paths?: BridgeDataPaths;
  readonly directory?: string;
  readonly now?: () => number;
}

function canonicalBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new SavedDrawingInputError("Drawing PNG is not canonical base64");
  return bytes;
}

function summaryOf(detail: SavedDrawingDetail): SavedDrawingSummary {
  const { pngBase64: _pngBase64, sceneJson: _sceneJson, ...summary } = detail;
  return SavedDrawingSummarySchema.parse(summary);
}

export class SavedDrawingsStore {
  readonly directory: string;
  readonly indexPath: string;
  readonly #now: () => number;

  constructor(options: SavedDrawingsStoreOptions = {}) {
    this.directory = options.directory
      ?? options.paths?.savedDrawings
      ?? defaultDataPaths().savedDrawings;
    this.indexPath = join(this.directory, "index.json");
    this.#now = options.now ?? Date.now;
  }

  async list(): Promise<readonly SavedDrawingSummary[]> {
    const index = await this.#readIndex();
    const records = await Promise.all(index.drawingIds.map((id) => this.#readRecord(id)));
    return SavedDrawingsListSchema.parse({ drawings: records.map(summaryOf) }).drawings;
  }

  async get(id: string): Promise<SavedDrawingDetail> {
    const parsedId = z.uuid().parse(id).toLowerCase();
    const index = await this.#readIndex();
    if (!index.drawingIds.includes(parsedId)) throw new SavedDrawingNotFoundError();
    return this.#readRecord(parsedId);
  }

  async create(inputValue: SavedDrawingCreateRequest): Promise<SavedDrawingDetail> {
    const input = SavedDrawingCreateRequestSchema.parse(inputValue);
    try {
      JSON.parse(input.sceneJson) as unknown;
    } catch {
      throw new SavedDrawingInputError("Drawing scene is not valid JSON");
    }
    const png = canonicalBase64(input.pngBase64);
    if (png.byteLength > MAX_PNG_BYTES) throw new SavedDrawingCapacityError("Drawing PNG exceeds the 8 MiB keep limit");

    const image = sharp(png, { failOn: "warning", limitInputPixels: 4_096 * 4_096 });
    let metadata: Awaited<ReturnType<typeof image.metadata>>;
    try {
      metadata = await image.metadata();
    } catch {
      throw new SavedDrawingInputError("Saved Drawings accepts validated PNG images only");
    }
    if (metadata.format !== "png" || !metadata.width || !metadata.height) {
      throw new SavedDrawingInputError("Saved Drawings accepts validated PNG images only");
    }
    if (metadata.width !== input.width || metadata.height !== input.height) {
      throw new SavedDrawingInputError("Drawing PNG dimensions do not match its declared canvas");
    }
    const thumbnail = await image
      .clone()
      .resize({ width: 360, height: 260, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 74, effort: 4 })
      .toBuffer();
    const id = randomUUID();
    const detail = SavedDrawingDetailSchema.parse({
      id,
      sourceThreadId: input.sourceThreadId,
      sourceThreadTitle: input.sourceThreadTitle,
      instruction: input.instruction,
      background: input.background,
      width: metadata.width,
      height: metadata.height,
      byteLength: png.byteLength,
      createdAt: this.#now(),
      thumbnailBase64: thumbnail.toString("base64"),
      pngBase64: png.toString("base64"),
      sceneJson: input.sceneJson,
    });

    return withPrivateFileLock(this.indexPath, async () => {
      const index = await this.#readIndex();
      if (index.drawingIds.length >= MAX_DRAWINGS) throw new SavedDrawingCapacityError();
      const existing = await Promise.all(index.drawingIds.map((drawingId) => this.#readRecord(drawingId)));
      const usedBytes = existing.reduce((total, drawing) => total + drawing.byteLength, 0);
      if (usedBytes + detail.byteLength > MAX_TOTAL_PNG_BYTES) {
        throw new SavedDrawingCapacityError("Saved Drawings reached its 128 MiB image limit");
      }
      await ensurePrivateDirectory(this.directory);
      await atomicWritePrivateJson(this.#recordPath(id), detail);
      await atomicWritePrivateJson(this.indexPath, {
        version: 1,
        drawingIds: [id, ...index.drawingIds],
      } satisfies SavedDrawingIndex);
      return detail;
    });
  }

  async delete(id: string): Promise<void> {
    const parsedId = z.uuid().parse(id).toLowerCase();
    await withPrivateFileLock(this.indexPath, async () => {
      const index = await this.#readIndex();
      if (!index.drawingIds.includes(parsedId)) throw new SavedDrawingNotFoundError();
      await atomicWritePrivateJson(this.indexPath, {
        version: 1,
        drawingIds: index.drawingIds.filter((candidate) => candidate !== parsedId),
      } satisfies SavedDrawingIndex);
      await rm(this.#recordPath(parsedId), { force: true });
    });
  }

  #recordPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  async #readIndex(): Promise<SavedDrawingIndex> {
    return this.#readJsonFile(this.indexPath, MAX_INDEX_BYTES, SavedDrawingIndexSchema, {
      version: 1,
      drawingIds: [],
    });
  }

  async #readRecord(id: string): Promise<SavedDrawingDetail> {
    return this.#readJsonFile(this.#recordPath(id), MAX_RECORD_BYTES, SavedDrawingDetailSchema);
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SavedDrawingNotFoundError();
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Refusing a non-regular or symlinked Saved Drawings file");
    }
    if (details.size <= 0 || details.size > maximumBytes) {
      throw new Error("Saved Drawings file exceeds its private storage limit");
    }
    await assertPrivateRegularFile(path);
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  }
}

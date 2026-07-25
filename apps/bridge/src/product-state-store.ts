import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ProductStateSchema,
  ProductStateUpdateRequestSchema,
  type ProductState,
  type ProductStateUpdateRequest,
} from "@codex-pad/protocol";

import {
  assertPrivateRegularFile,
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  withPrivateFileLock,
} from "./atomic-file.js";
import { defaultDataPaths, type BridgeDataPaths } from "./paths.js";

const MAX_PRODUCT_STATE_BYTES = 256 * 1024;

export class ProductStateConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly current: ProductState) {
    super("Product state changed on another device; refresh before saving again");
    this.name = "ProductStateConflictError";
  }
}

export interface ProductStateStoreOptions {
  readonly paths?: BridgeDataPaths;
  readonly filePath?: string;
  readonly now?: () => number;
}

export function defaultProductState(now = Date.now()): ProductState {
  return ProductStateSchema.parse({
    version: 1,
    revision: 0,
    updatedAt: now,
    homeLayout: {
      version: 1,
      mode: "manual",
      pinnedThreadIds: [],
      manual: { sections: [], looseThreadIds: [] },
      automaticOrder: ["needs-approval", "error", "working", "waiting", "completed", "idle"],
    },
    preferences: {
      compactControls: false,
      keepAwake: false,
      allSessionsEnabled: true,
      theme: "system",
      cardDensity: "rich",
      motion: "system",
      haptics: true,
      notifications: {
        needsApproval: true,
        completed: true,
        error: true,
        waiting: true,
      },
      defaultHomeMode: "manual",
      modelReasoningPresets: [],
      siteFavorites: [],
    },
  });
}

export class ProductStateStore {
  readonly filePath: string;
  readonly #now: () => number;

  constructor(options: ProductStateStoreOptions = {}) {
    this.filePath = options.filePath
      ?? options.paths?.productState
      ?? defaultDataPaths().productState;
    this.#now = options.now ?? Date.now;
  }

  async read(): Promise<ProductState> {
    return this.#readUnlocked();
  }

  async update(inputValue: ProductStateUpdateRequest): Promise<ProductState> {
    const input = ProductStateUpdateRequestSchema.parse(inputValue);
    return withPrivateFileLock(this.filePath, async () => {
      const current = await this.#readUnlocked();
      if (current.revision !== input.expectedRevision) {
        throw new ProductStateConflictError(current);
      }
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Product state revision is exhausted");
      }
      const next = ProductStateSchema.parse({
        version: 1,
        revision: current.revision + 1,
        updatedAt: this.#now(),
        homeLayout: input.homeLayout,
        preferences: input.preferences,
      });
      await atomicWritePrivateJson(this.filePath, next);
      return next;
    });
  }

  async #readUnlocked(): Promise<ProductState> {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await ensurePrivateDirectory(dirname(this.filePath));
        return defaultProductState(this.#now());
      }
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Refusing a non-regular or symlinked product-state file");
    }
    await assertPrivateRegularFile(this.filePath);
    if (details.size > MAX_PRODUCT_STATE_BYTES) {
      throw new Error("Product-state file exceeds the private storage limit");
    }
    return ProductStateSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
  }
}

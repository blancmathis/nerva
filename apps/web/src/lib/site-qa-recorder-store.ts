import { openDB } from "idb";
import type { SiteQaManifest } from "@codex-pad/protocol";
import type { SiteQaDeliveryIdentity, SiteQaManifestStep, SiteQaOutboundFrame } from "./site-qa-types";
import type { BrowserTabFrame } from "./bridge-client";

const DATABASE = "nerva-site-qa-recorder";
const STORE = "recordings";
const VERSION = 1;
const MAX_RECORDINGS = 20;
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

export interface SiteQaEvidenceFrame {
  readonly id: string;
  readonly role: "start" | "step" | "issue" | "final";
  readonly frame: BrowserTabFrame;
}

export interface SiteQaDraftIssue {
  readonly issueId: string;
  readonly frameId: string;
  readonly expected: string;
  readonly actual: string;
  readonly explanation: string;
  readonly annotationPngBase64: string | null;
  readonly voiceMimeType: string | null;
  readonly voiceBytes: ArrayBuffer | null;
}

export interface SiteQaFrozenDelivery {
  readonly createdAt: number;
  readonly manifest: SiteQaManifest;
  readonly frames: readonly SiteQaOutboundFrame[];
  readonly delivery: SiteQaDeliveryIdentity;
}

export interface SiteQaRecordingDraft {
  readonly version: 1;
  readonly id: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly tabTitle: string;
  readonly status: "recording" | "paused" | "review" | "delivery-unknown";
  readonly intent: "diagnose-and-fix" | "regression-test" | "both";
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly steps: readonly SiteQaManifestStep[];
  readonly frames: readonly SiteQaEvidenceFrame[];
  readonly issues: readonly SiteQaDraftIssue[];
  /** Exact payload checkpointed before the first delivery attempt. */
  readonly frozenDelivery?: SiteQaFrozenDelivery | null;
}

interface StoredSiteQaOutboundFrame extends Omit<SiteQaOutboundFrame, "blob"> {
  readonly blobBytes: ArrayBuffer;
  readonly blobType: string;
}

interface StoredSiteQaFrozenDelivery extends Omit<SiteQaFrozenDelivery, "frames"> {
  readonly frames: readonly StoredSiteQaOutboundFrame[];
}

interface StoredSiteQaRecordingDraft extends Omit<SiteQaRecordingDraft, "frozenDelivery"> {
  readonly frozenDelivery?: StoredSiteQaFrozenDelivery | null;
}

async function database() {
  return openDB(DATABASE, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    },
  });
}

function estimatedBytes(draft: SiteQaRecordingDraft): number {
  const imageBytes = draft.frames.reduce((sum, value) => sum + Math.ceil(value.frame.imageBase64.length * .75), 0)
    + draft.issues.reduce((sum, value) => sum + Math.ceil((value.annotationPngBase64?.length ?? 0) * .75), 0);
  const voiceBytes = draft.issues.reduce((sum, value) => sum + (value.voiceBytes?.byteLength ?? 0), 0);
  const frozenBytes = draft.frozenDelivery?.frames.reduce((sum, value) => sum + value.blob.size, 0) ?? 0;
  const metadataBytes = JSON.stringify({
    ...draft,
    frames: draft.frames.map((value) => ({ ...value, frame: { ...value.frame, imageBase64: "" } })),
    issues: draft.issues.map((value) => ({ ...value, annotationPngBase64: null, voiceBytes: null })),
    frozenDelivery: draft.frozenDelivery
      ? { ...draft.frozenDelivery, frames: draft.frozenDelivery.frames.map((value) => ({ ...value, blob: null })) }
      : null,
  }).length * 2;
  return imageBytes + voiceBytes + frozenBytes + metadataBytes;
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("The frozen QA evidence could not be read."));
    }, { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("The frozen QA evidence could not be read.")), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

async function storedDraft(draft: SiteQaRecordingDraft): Promise<StoredSiteQaRecordingDraft> {
  if (!draft.frozenDelivery) {
    const { frozenDelivery, ...base } = draft;
    return frozenDelivery === null ? { ...base, frozenDelivery: null } : base;
  }
  return {
    ...draft,
    frozenDelivery: {
      ...draft.frozenDelivery,
      frames: await Promise.all(draft.frozenDelivery.frames.map(async ({ blob, ...frame }) => ({
        ...frame,
        blobBytes: await readBlobBytes(blob),
        blobType: blob.type || "application/octet-stream",
      }))),
    },
  };
}

function restoredDraft(value: unknown): SiteQaRecordingDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as StoredSiteQaRecordingDraft & {
    readonly frozenDelivery?: (Omit<SiteQaFrozenDelivery, "frames"> & {
      readonly frames: readonly (StoredSiteQaOutboundFrame | SiteQaOutboundFrame)[];
    }) | null;
  };
  if (stored.version !== 1 || typeof stored.id !== "string" || typeof stored.threadId !== "string" || typeof stored.tabId !== "string") return null;
  if (!stored.frozenDelivery) return stored as SiteQaRecordingDraft;
  const frames: SiteQaOutboundFrame[] = [];
  for (const frame of stored.frozenDelivery.frames) {
    if ("blob" in frame && frame.blob instanceof Blob) {
      frames.push(frame);
      continue;
    }
    if (
      !("blobBytes" in frame)
      || !(frame.blobBytes instanceof ArrayBuffer || Object.prototype.toString.call(frame.blobBytes) === "[object ArrayBuffer]")
      || typeof frame.blobType !== "string"
    ) return null;
    const { blobBytes, blobType, ...metadata } = frame;
    frames.push({ ...metadata, blob: new Blob([blobBytes], { type: blobType }) });
  }
  return {
    ...stored,
    frozenDelivery: { ...stored.frozenDelivery, frames },
  } as SiteQaRecordingDraft;
}

export async function saveSiteQaDraft(draft: SiteQaRecordingDraft): Promise<void> {
  if (estimatedBytes(draft) > MAX_RECORDING_BYTES) {
    throw new Error("This recording reached the 64 MB local evidence limit. Review or send it before recording more steps.");
  }
  const db = await database();
  try {
    const existing = await db.get(STORE, draft.id) as StoredSiteQaRecordingDraft | undefined;
    if (!existing && await db.count(STORE) >= MAX_RECORDINGS) {
      throw new Error("Nerva already has 20 local QA recordings. Send or delete one before starting another.");
    }
    await db.put(STORE, await storedDraft(draft));
  } finally {
    db.close();
  }
}

export async function loadSiteQaDraft(id: string): Promise<SiteQaRecordingDraft | null> {
  const db = await database();
  try {
    return restoredDraft(await db.get(STORE, id));
  } finally {
    db.close();
  }
}

export async function findSiteQaDraft(threadId: string, tabId: string): Promise<SiteQaRecordingDraft | null> {
  const db = await database();
  try {
    const drafts = (await db.getAll(STORE))
      .map(restoredDraft)
      .filter((draft): draft is SiteQaRecordingDraft => draft !== null);
    return drafts
      .filter((draft) => draft.version === 1 && draft.threadId === threadId && draft.tabId === tabId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  } finally {
    db.close();
  }
}

export async function deleteSiteQaDraft(id: string): Promise<void> {
  const db = await database();
  try {
    await db.delete(STORE, id);
  } finally {
    db.close();
  }
}

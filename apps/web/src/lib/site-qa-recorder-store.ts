import { openDB } from "idb";
import type { SiteQaManifestStep } from "./site-qa-types";
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

export interface SiteQaRecordingDraft {
  readonly version: 1;
  readonly id: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly tabTitle: string;
  readonly status: "recording" | "paused" | "review";
  readonly intent: "diagnose-and-fix" | "regression-test" | "both";
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly steps: readonly SiteQaManifestStep[];
  readonly frames: readonly SiteQaEvidenceFrame[];
  readonly issues: readonly SiteQaDraftIssue[];
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
  const metadataBytes = JSON.stringify({
    ...draft,
    frames: draft.frames.map((value) => ({ ...value, frame: { ...value.frame, imageBase64: "" } })),
    issues: draft.issues.map((value) => ({ ...value, annotationPngBase64: null, voiceBytes: null })),
  }).length * 2;
  return imageBytes + voiceBytes + metadataBytes;
}

export async function saveSiteQaDraft(draft: SiteQaRecordingDraft): Promise<void> {
  if (estimatedBytes(draft) > MAX_RECORDING_BYTES) {
    throw new Error("This recording reached the 64 MB local evidence limit. Review or send it before recording more steps.");
  }
  const db = await database();
  const existing = await db.get(STORE, draft.id) as SiteQaRecordingDraft | undefined;
  if (!existing && await db.count(STORE) >= MAX_RECORDINGS) {
    throw new Error("Nerva already has 20 local QA recordings. Send or delete one before starting another.");
  }
  await db.put(STORE, draft);
}

export async function loadSiteQaDraft(id: string): Promise<SiteQaRecordingDraft | null> {
  const db = await database();
  return (await db.get(STORE, id) as SiteQaRecordingDraft | undefined) ?? null;
}

export async function findSiteQaDraft(threadId: string, tabId: string): Promise<SiteQaRecordingDraft | null> {
  const db = await database();
  const drafts = await db.getAll(STORE) as SiteQaRecordingDraft[];
  return drafts
    .filter((draft) => draft.version === 1 && draft.threadId === threadId && draft.tabId === tabId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

export async function deleteSiteQaDraft(id: string): Promise<void> {
  const db = await database();
  await db.delete(STORE, id);
}


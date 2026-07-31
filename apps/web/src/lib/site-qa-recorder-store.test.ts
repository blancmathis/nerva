import { afterEach, describe, expect, it } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import {
  deleteSiteQaDraft,
  findSiteQaDraft,
  loadSiteQaDraft,
  saveSiteQaDraft,
  type SiteQaRecordingDraft,
} from "./site-qa-recorder-store";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const TAB_ID = `tab_${"1".repeat(24)}`;
const savedIds: string[] = [];

async function browserBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => reader.result instanceof ArrayBuffer
      ? resolve(reader.result)
      : reject(new Error("Expected ArrayBuffer")), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

afterEach(async () => {
  await Promise.all(savedIds.splice(0).map((id) => deleteSiteQaDraft(id)));
});

function draft(id: string): SiteQaRecordingDraft {
  return {
    version: 1,
    id,
    threadId: THREAD_ID,
    tabId: TAB_ID,
    tabTitle: "Fixture page",
    status: "recording",
    intent: "both",
    startedAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_100,
    steps: [],
    frames: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "start",
      frame: {
        tabId: TAB_ID,
        title: "Fixture page",
        url: "https://example.test/",
        imageBase64: "YWJjZGVmZ2hpamtsbW5vcA==",
        mimeType: "image/jpeg",
        width: 1_024,
        height: 768,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
        capturedAt: 1_750_000_000_000,
      },
    }],
    issues: [],
  };
}

describe("Site QA recorder store", () => {
  it("restores an unsent exact-task draft without sending or mutating it", async () => {
    const value = draft("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    savedIds.push(value.id);
    await saveSiteQaDraft(value);
    expect(await loadSiteQaDraft(value.id)).toEqual(value);
    expect(await findSiteQaDraft(THREAD_ID, TAB_ID)).toEqual(value);
    expect(await findSiteQaDraft("cccccccc-cccc-4ccc-8ccc-cccccccccccc", TAB_ID)).toBeNull();
  });

  it("persists the exact frozen delivery after an uncertain send without changing its blob", async () => {
    const value = draft("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    // The public draft keeps a Blob, while the store serializes its bytes so
    // WebKit never has to structured-clone Blob/File values into IndexedDB.
    const blob = new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }) as Blob;
    const frozen: SiteQaRecordingDraft = {
      ...value,
      status: "delivery-unknown",
      frozenDelivery: {
        createdAt: value.updatedAt,
        delivery: {
          commandId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          expectedBridgeInstanceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          snapshotSeq: 73,
          instructionSuffix: "",
          skillIds: [],
        },
        manifest: {
          version: 1,
          recordingId: value.id,
          sourceThreadId: value.threadId,
          startedAt: value.startedAt,
          durationMs: 100,
          intent: "both",
          environment: { viewport: { width: 1_024, height: 768 }, deviceScaleFactor: 1, controllerOrientation: "landscape" },
          steps: [],
          issues: [],
        },
        frames: [{
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          title: "Exact evidence",
          url: "https://example.test/",
          blob,
          width: 1_024,
          height: 768,
          deviceScaleFactor: 1,
          scrollX: 0,
          scrollY: 0,
        }],
      },
    };
    savedIds.push(frozen.id);
    await saveSiteQaDraft(frozen);

    const restored = await loadSiteQaDraft(frozen.id);
    expect(restored?.status).toBe("delivery-unknown");
    expect(restored?.frozenDelivery?.manifest.recordingId).toBe(frozen.id);
    expect(new Uint8Array(await browserBlobBytes(restored!.frozenDelivery!.frames[0]!.blob))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

import { afterEach, describe, expect, it } from "vitest";
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
});

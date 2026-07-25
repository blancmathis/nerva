import { createScene } from "@codex-pad/drawing";
import { describe, expect, it } from "vitest";

import {
  REVIEW_DRAFT_VERSION,
  REVIEW_LIMITS,
  REVIEW_SEND_INSTRUCTION_MAX_CHARACTERS,
  ReviewDraftSchema,
  ReviewFrameSchema,
  ReviewTargetMismatchError,
  assertDraftTarget,
  createAtomicSendManifest,
  createReviewDraft,
  migrateReviewDraft,
  reviewDraftReducer,
  type ReviewDraft,
  type ReviewFrame,
  type ReviewImage,
} from "../src/index.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";

function image(id: string): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef: `blob-${id}` },
    metadata: {
      mimeType: "image/png",
      byteLength: 128,
      pixelWidth: 1_024,
      pixelHeight: 768,
      fileName: `${id}.png`,
      sha256: null,
      capturedAt: 1_000,
    },
  };
}

function frame(
  id: string,
  patch: Partial<Omit<ReviewFrame, "id">> = {},
): ReviewFrame {
  return ReviewFrameSchema.parse({
    id,
    kind: "blank",
    title: null,
    url: null,
    viewport: { width: 1_024, height: 768, deviceScaleFactor: 2 },
    scroll: { x: 0, y: 0 },
    capturedImage: null,
    drawing: null,
    photos: [],
    instruction: "",
    comparison: { mode: "none", before: null, after: null },
    ...patch,
  });
}

function draftWithFrames(...frames: ReviewFrame[]): ReviewDraft {
  return ReviewDraftSchema.parse({
    ...createReviewDraft({ id: "review-1", targetThreadId: THREAD_ID, now: 1_000 }),
    frames,
  });
}

describe("ReviewDraft domain", () => {
  it("rejects embedded URL credentials before a site frame can enter a draft", () => {
    expect(() => frame("credentialed-site", {
      kind: "site-snapshot",
      url: "https://user:secret@example.test/dashboard",
      capturedImage: image("credentialed-capture"),
    })).toThrow(/embedded credentials/);
  });

  it("keeps same-URL, same-state captures as distinct ordered frames", () => {
    const first = frame("frame-a", {
      kind: "site-snapshot",
      title: "First observation",
      url: "https://example.test/dashboard",
      capturedImage: image("capture-a"),
    });
    const second = frame("frame-b", {
      kind: "site-snapshot",
      title: "Second observation",
      url: first.url,
      viewport: first.viewport,
      scroll: first.scroll,
      capturedImage: image("capture-b"),
    });

    const parsed = draftWithFrames(first, second);

    expect(parsed.frames.map((candidate) => candidate.id)).toEqual(["frame-a", "frame-b"]);
    expect(parsed.frames[0]?.url).toBe(parsed.frames[1]?.url);
  });

  it("adds, updates, reorders, and deletes frames without changing their stable identity", () => {
    let draft = createReviewDraft({ id: "review-1", targetThreadId: THREAD_ID, now: 1_000 });
    draft = reviewDraftReducer(draft, { type: "addFrame", frame: frame("a") }, 1_001);
    draft = reviewDraftReducer(
      draft,
      { type: "addFrame", frame: frame("b"), atIndex: 0 },
      1_002,
    );
    draft = reviewDraftReducer(
      draft,
      { type: "updateFrame", frameId: "a", patch: { title: "Keep this id" } },
      1_003,
    );
    draft = reviewDraftReducer(
      draft,
      { type: "reorderFrame", frameId: "a", toIndex: 0 },
      1_004,
    );
    draft = reviewDraftReducer(draft, { type: "deleteFrame", frameId: "b" }, 1_005);

    expect(draft.frames).toHaveLength(1);
    expect(draft.frames[0]).toMatchObject({ id: "a", title: "Keep this id" });
    expect(draft.updatedAt).toBe(1_005);
  });
});

describe("atomic send manifest", () => {
  it("generates one textual instruction and deterministic ordered image refs", () => {
    const annotatedFrame = frame("frame-a", {
      kind: "site-snapshot",
      title: "Homepage",
      url: "https://example.test/",
      capturedImage: image("capture"),
      photos: [image("photo-1")],
      drawing: {
        kind: "scene",
        scene: createScene({ width: 1_024, height: 768 }),
        renderedImage: image("annotation"),
      },
      instruction: "Fix the alignment marked in blue.",
      comparison: {
        mode: "side-by-side",
        before: { label: "Production", image: image("before") },
        after: { label: "Candidate", image: image("after") },
      },
    });
    const draft = ReviewDraftSchema.parse({
      ...draftWithFrames(annotatedFrame),
      generalInstruction: "Apply all observations together.",
    });

    const manifest = createAtomicSendManifest(draft, THREAD_ID);

    expect(typeof manifest.instruction).toBe("string");
    expect(manifest.instruction).toContain("one atomic review");
    expect(manifest.instruction).toContain("[F1:composite]");
    expect(manifest.instruction).not.toContain("[F1:capture]");
    expect(manifest.instruction).toContain('title="Homepage"');
    expect(manifest.instruction).toContain('url="https://example.test/"');
    expect(manifest.instruction).toContain('note="Fix the alignment marked in blue."');
    expect(manifest.images.map((entry) => entry.imageId)).toEqual([
      "annotation",
      "before",
      "after",
      "photo-1",
    ]);
    expect(manifest.images.map((entry) => entry.order)).toEqual([0, 1, 2, 3]);
    expect(manifest).not.toHaveProperty("voice");
    expect(manifest.instruction).not.toContain("Voice index");
  });

  it("sends an unannotated capture as the frame's single primary image", () => {
    const draft = draftWithFrames(frame("plain-capture", {
      kind: "site-snapshot",
      url: "https://example.test/plain",
      capturedImage: image("capture-only"),
    }));

    const manifest = createAtomicSendManifest(draft);

    expect(manifest.images).toMatchObject([
      { order: 0, label: "[F1:capture]", imageId: "capture-only" },
    ]);
  });

  it("counts an annotated capture as one composite while preserving explicit extra images", () => {
    const draft = draftWithFrames(frame("annotated-capture", {
      kind: "site-snapshot",
      url: "https://example.test/annotated",
      capturedImage: image("source-capture"),
      drawing: {
        kind: "scene",
        scene: createScene({ width: 1_024, height: 768 }),
        renderedImage: image("flattened-composite"),
      },
      photos: [image("explicit-photo")],
      comparison: {
        mode: "side-by-side",
        before: { label: "Before", image: image("explicit-before") },
        after: { label: "After", image: image("explicit-after") },
      },
    }));

    const manifest = createAtomicSendManifest(draft);

    expect(manifest.images.map(({ label, imageId }) => ({ label, imageId }))).toEqual([
      { label: "[F1:composite]", imageId: "flattened-composite" },
      { label: "[F1:before]", imageId: "explicit-before" },
      { label: "[F1:after]", imageId: "explicit-after" },
      { label: "[F1:photo-1]", imageId: "explicit-photo" },
    ]);
  });

  it("fails closed when the requested destination differs from the draft target", () => {
    const draft = createReviewDraft({ id: "review-1", targetThreadId: THREAD_ID, now: 1_000 });

    expect(() => assertDraftTarget(draft, OTHER_THREAD_ID)).toThrow(ReviewTargetMismatchError);
    expect(() => createAtomicSendManifest(draft, OTHER_THREAD_ID)).toThrow(
      /targets thread/,
    );
  });

  it("represents all twelve frames and twenty ordered images without sacrificing ordering", () => {
    const frames = Array.from({ length: REVIEW_LIMITS.frames }, (_, index) =>
      frame(`max-frame-${index + 1}`, {
        kind: "site-snapshot",
        title: `TITLE-${index + 1}`,
        url: `https://example.test/frame-${index + 1}`,
        capturedImage: image(`max-capture-${index + 1}`),
        photos: index === 0
          ? Array.from({ length: 8 }, (_, photoIndex) => image(`max-photo-${photoIndex + 1}`))
          : [],
        instruction: `NOTE-F${index + 1}`,
      }),
    );
    const maximalDraft = ReviewDraftSchema.parse({
      ...draftWithFrames(...frames),
      generalInstruction: "GENERAL-PRIORITY",
    });

    const first = createAtomicSendManifest(maximalDraft);
    const second = createAtomicSendManifest(maximalDraft);

    expect(first.instruction.length).toBeLessThanOrEqual(
      REVIEW_SEND_INSTRUCTION_MAX_CHARACTERS,
    );
    expect(first.instruction).toBe(second.instruction);
    expect(first.instruction).toContain("GENERAL-PRIORITY");
    for (let index = 1; index <= REVIEW_LIMITS.frames; index += 1) {
      expect(first.instruction).toContain(`F${index}|kind=site`);
      expect(first.instruction).toContain(`NOTE-F${index}`);
    }
    expect(first.images).toHaveLength(REVIEW_LIMITS.images);
    let previousLabelPosition = -1;
    for (const imageRef of first.images) {
      const labelPosition = first.instruction.indexOf(imageRef.label);
      expect(labelPosition).toBeGreaterThan(previousLabelPosition);
      expect(first.instruction.split(imageRef.label)).toHaveLength(2);
      previousLabelPosition = labelPosition;
    }
  });

  it("keeps long user-authored text exact near 8k, then fails without clipping", () => {
    const longUrl = `https://example.test/${"u".repeat(1_900)}`;
    const title = "Exact title with a | delimiter";
    const note = "Keep this exact note, including\na line break.";
    const draftForInstructionLength = (length: number) => ReviewDraftSchema.parse({
      ...draftWithFrames(frame("budget-frame", {
        kind: "site-snapshot",
        title,
        url: longUrl,
        capturedImage: image("budget-image"),
        instruction: note,
      })),
      generalInstruction: "x".repeat(length),
    });

    let low = 1;
    let high = REVIEW_SEND_INSTRUCTION_MAX_CHARACTERS;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try {
        createAtomicSendManifest(draftForInstructionLength(middle));
        low = middle;
      } catch {
        high = middle - 1;
      }
    }

    const exactInstruction = "x".repeat(low);
    const manifest = createAtomicSendManifest(draftForInstructionLength(low));
    expect(manifest.instruction.length).toBeGreaterThan(7_900);
    expect(manifest.instruction).toContain(`title=${JSON.stringify(title)}`);
    expect(manifest.instruction).toContain(`url=${JSON.stringify(longUrl)}`);
    expect(manifest.instruction).toContain(`note=${JSON.stringify(note)}`);
    expect(manifest.instruction).toContain(`instruction=${JSON.stringify(exactInstruction)}`);
    expect(() => createAtomicSendManifest(draftForInstructionLength(low + 1))).toThrow(
      /Nothing was clipped/,
    );
  });
});

describe("before/after comparison", () => {
  it.each(["side-by-side", "overlay", "swipe", "blink", "diff"] as const)(
    "requires both variants for %s compare mode",
    (mode) => {
      expect(() =>
        frame("compare", {
          comparison: {
            mode,
            before: { label: "Before", image: image("before") },
            after: null,
          },
        }),
      ).toThrow(/Before and after/);

      const compared = frame("compare", {
        comparison: {
          mode,
          before: { label: "Before", image: image("before") },
          after: { label: "After", image: image("after") },
        },
      });
      expect(compared.comparison.mode).toBe(mode);
    },
  );
});

describe("migration", () => {
  it("migrates a strict v1 draft, its thread target, comparison, and drawing ref", () => {
    const migrated = migrateReviewDraft({
      version: 1,
      id: "legacy-review",
      threadId: THREAD_ID.toUpperCase(),
      createdAt: 1_000,
      instruction: "Legacy instruction",
      frames: [
        {
          id: "legacy-frame",
          kind: "site-snapshot",
          title: "Legacy frame",
          url: "https://example.test/legacy",
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
          scroll: { x: 10, y: 20 },
          image: image("legacy-capture"),
          drawing: { drawingDraftRef: "legacy-drawing" },
          before: image("legacy-before"),
          after: image("legacy-after"),
          compareMode: "overlay",
        },
      ],
      voiceSegments: [
        {
          id: "legacy-voice",
          blobRef: "legacy-audio",
          mimeType: "audio/mp4",
          durationMs: 4_000,
          frameId: "legacy-frame",
          userTranscript: "Legacy voice note",
        },
      ],
    });

    expect(migrated.version).toBe(REVIEW_DRAFT_VERSION);
    expect(migrated.targetThreadId).toBe(THREAD_ID);
    expect(migrated.generalInstruction).toBe("Legacy instruction");
    expect(migrated.frames[0]).toMatchObject({
      capturedImage: { id: "legacy-capture" },
      drawing: { kind: "drawingDraftRef", drawingDraftRef: "legacy-drawing" },
      comparison: {
        mode: "overlay",
        before: { label: "Before", image: { id: "legacy-before" } },
        after: { label: "After", image: { id: "legacy-after" } },
      },
    });
    expect(migrated).not.toHaveProperty("voiceSegments");
  });

  it("drops retired voice fields while migrating a strict v2 draft", () => {
    const migrated = migrateReviewDraft({
      version: 2,
      id: "previous-review",
      targetThreadId: THREAD_ID,
      createdAt: 1_000,
      updatedAt: 2_000,
      generalInstruction: "Keep the visual observations.",
      frames: [frame("previous-frame")],
      voiceSegments: [
        {
          id: "previous-voice",
          blobRef: "previous-audio",
          mimeType: "audio/webm",
          durationMs: 5_000,
          timelineOrder: 0,
          startedAt: 1_500,
          anchors: [{ frameId: "previous-frame", offsetMs: 100 }],
          browserTranscript: "Retired browser transcript",
        },
      ],
    });

    expect(migrated).toEqual({
      version: REVIEW_DRAFT_VERSION,
      id: "previous-review",
      targetThreadId: THREAD_ID,
      createdAt: 1_000,
      updatedAt: 2_000,
      generalInstruction: "Keep the visual observations.",
      frames: [frame("previous-frame")],
    });
  });

  it("rejects unsupported or shape-drifting legacy records", () => {
    expect(() => migrateReviewDraft({ version: 99 })).toThrow();
    expect(() =>
      migrateReviewDraft({
        version: 1,
        id: "legacy-review",
        threadId: THREAD_ID,
        createdAt: 1_000,
        frames: [],
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("hard limits", () => {
  it("accepts twelve frames and rejects a thirteenth", () => {
    const base = createReviewDraft({ id: "review", targetThreadId: THREAD_ID, now: 1_000 });
    const atLimit = ReviewDraftSchema.parse({
      ...base,
      frames: Array.from({ length: REVIEW_LIMITS.frames }, (_, index) => frame(`f-${index}`)),
    });
    expect(atLimit.frames).toHaveLength(12);
    expect(() =>
      ReviewDraftSchema.parse({ ...atLimit, frames: [...atLimit.frames, frame("f-12")] }),
    ).toThrow();
  });

  it("accepts twenty images globally and rejects the twenty-first", () => {
    const firstTen = frame("first", {
      photos: Array.from({ length: 10 }, (_, index) => image(`a-${index}`)),
    });
    const secondTen = frame("second", {
      photos: Array.from({ length: 10 }, (_, index) => image(`b-${index}`)),
    });
    const base = createReviewDraft({ id: "review", targetThreadId: THREAD_ID, now: 1_000 });
    expect(() => ReviewDraftSchema.parse({ ...base, frames: [firstTen, secondTen] })).not.toThrow();

    const twentyOne = frame("second", {
      photos: Array.from({ length: 11 }, (_, index) => image(`b-${index}`)),
    });
    expect(() => ReviewDraftSchema.parse({ ...base, frames: [firstTen, twentyOne] })).toThrow(
      /at most 20 images/,
    );
  });
});

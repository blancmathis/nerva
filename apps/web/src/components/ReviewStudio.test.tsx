import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createScene, createShapeElement } from "@codex-pad/drawing";
import { createReviewDraft, reviewDraftReducer, type ReviewImage } from "@codex-pad/review";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewStudio, type AtomicReviewSend } from "./ReviewStudio";
import { makeSiteReviewFrame } from "./review-state";
import {
  getReviewBlob,
  loadPendingReviewDelivery,
  loadReviewDraft,
  putReviewBlob,
  savePendingReviewDelivery,
  saveReviewDraft,
  sweepReviewOrphanBlobs,
} from "../lib/review-store";
import { pngBytes } from "../test/image-fixtures";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
const REMOTE_REASON = "Exact task-to-tab mapping has not been proven for this session.";
const INTERACTION_MODES = {
  selected: "none",
  direct: {
    status: "unavailable",
    reason: "same-host-storage-boundary",
    detail: "Live preview requires a separately verified browser storage boundary.",
  },
  remoteBrowser: {
    status: "unavailable",
    reason: "thread-tab-mapping-unproven",
    detail: REMOTE_REASON,
    association: {
      status: "unavailable",
      reason: "thread-tab-mapping-unproven",
      detail: REMOTE_REASON,
    },
  },
} as const;

function capturedImage(id: string, blobRef: string, size: number): ReviewImage {
  return {
    id,
    source: { kind: "blobRef", blobRef },
    metadata: {
      mimeType: "image/png",
      byteLength: size,
      pixelWidth: 820,
      pixelHeight: 1_180,
      fileName: `${id}.png`,
      sha256: null,
      capturedAt: 1_000,
    },
  };
}

beforeAll(() => {
  const context = new Proxy({}, { get: () => vi.fn(), set: () => true }) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1_024,
    bottom: 768,
    width: 1_024,
    height: 768,
    toJSON: () => ({}),
  });
});

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:review-capture") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "indexedDB");
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("ReviewStudio", () => {
  it("opens an exact-thread persistent draft with the complete responsive review surface", async () => {
    const send = vi.fn();
    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:client-new-thread:${THREAD_ID}`}
        threadTitle="Review task"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={17}
        onSendReview={send}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Review task" })).toBeInTheDocument();
    expect(screen.getByText(/Exact agent thread/)).toHaveTextContent(THREAD_ID.slice(-8));
    expect(screen.getByRole("button", { name: "Pencil draws · finger navigates" })).toBeInTheDocument();
    expect(screen.getByLabelText("Photo / Files")).toHaveAttribute("accept", "image/*,.heic,.heif");
    expect(screen.getByLabelText("Camera")).toHaveAttribute("accept", "image/*,.heic,.heif");
    expect(document.querySelector("style")?.textContent).toContain(".review-main-layout");
    expect(screen.queryByRole("button", { name: /record|microphone|dictate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /transcription/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/voice trail|voice notes|transcript/i)).not.toBeInTheDocument();
    expect(document.querySelector("audio")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview atomic send" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/screenshot, photo, or annotation/i));
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps registered-site context visible without embedding or opening the shared host", async () => {
    const windowOpen = vi.spyOn(window, "open");
    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:${THREAD_ID}`}
        threadTitle="Site review"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={18}
        site={{
          url: "https://mac.example.ts.net:3000/dashboard",
          allowedOrigin: "https://mac.example.ts.net:3000",
          captureCapability: "degraded",
          captureDetail: "Live preview and route capture are unavailable on the shared host.",
          interactionModes: INTERACTION_MODES,
        }}
        onSendReview={vi.fn()}
      />,
    );

    expect(await screen.findByRole("region", { name: "Registered site context" })).toBeInTheDocument();
    expect(screen.getByText(/Live preview unavailable on shared host/i)).toBeInTheDocument();
    expect(screen.getByText("https://mac.example.ts.net:3000/dashboard")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("[src='https://mac.example.ts.net:3000/dashboard']")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /approved site route/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /capture registered route/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/capture viewport/i)).not.toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it("captures the same approved frame route as a fresh after image without claiming the site changed", async () => {
    const beforeBlob = new Blob(["before"], { type: "image/png" });
    const afterBlob = new Blob(["after"], { type: "image/png" });
    const frameGeometry = {
      viewport: { width: 820, height: 1_180, deviceScaleFactor: 2 },
      scroll: { x: 3, y: 140 },
    } as const;
    let seededDraft = createReviewDraft({ id: "review-before-after", targetThreadId: THREAD_ID, now: 1_000 });
    seededDraft = reviewDraftReducer(seededDraft, {
      type: "addFrame",
      frame: makeSiteReviewFrame({
        id: "site-frame",
        url: "https://mac.example.ts.net:3000/dashboard?state=before",
        title: "Before state",
        capturedImage: capturedImage("before-image", "before-ref", beforeBlob.size),
        geometry: frameGeometry,
      }),
    }, 1_001);
    await putReviewBlob("before-ref", beforeBlob);
    await saveReviewDraft(seededDraft);
    const capture = vi.fn().mockResolvedValue({
      image: capturedImage("after-image", "after-ref", afterBlob.size),
      blob: afterBlob,
      geometry: frameGeometry,
      finalPath: "/dashboard?state=after",
      title: "After state",
    });

    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:${THREAD_ID}`}
        threadTitle="Site comparison"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={19}
        agentUpdated
        site={{
          url: "https://mac.example.ts.net:3000/dashboard",
          allowedOrigin: "https://mac.example.ts.net:3000",
          captureCapability: "available",
          interactionModes: INTERACTION_MODES,
        }}
        onCaptureSite={capture}
        onSendReview={vi.fn()}
      />,
    );

    await screen.findByRole("region", { name: "Registered site context" });
    fireEvent.click(screen.getByRole("button", { name: "Saved frame" }));
    const latestButton = await screen.findByRole("button", { name: "Capture registered route as After" });
    expect(screen.getByText("Agent updated — capture or import an after state.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing was captured automatically/)).toBeInTheDocument();

    fireEvent.click(latestButton);
    expect(await screen.findByRole("heading", { name: "Before / after" })).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith({
      url: "https://mac.example.ts.net:3000/dashboard?state=before",
      title: "Before state",
      viewport: frameGeometry.viewport,
      scroll: frameGeometry.scroll,
    });
    expect(await getReviewBlob("after-ref")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Capture registered route as After" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Store after as a new iteration" }));
    expect(await screen.findByText("2 frames · saved locally")).toBeInTheDocument();
    await waitFor(async () => {
      const stored = await loadReviewDraft(THREAD_ID);
      expect(stored?.frames).toHaveLength(2);
      expect(stored?.frames[0]?.comparison.after?.image.id).toBe("after-image");
      expect(stored?.frames[1]?.capturedImage?.source).toEqual({ kind: "blobRef", blobRef: "after-ref" });
      expect(stored?.frames[1]?.comparison.mode).toBe("none");
    });
  });

  it("keeps local editing and atomic preview available while bridge delivery is disabled", async () => {
    const imageBlob = new Blob(["offline"], { type: "image/png" });
    let seededDraft = createReviewDraft({ id: "review-offline", targetThreadId: THREAD_ID, now: 2_000 });
    seededDraft = reviewDraftReducer(seededDraft, {
      type: "addFrame",
      frame: makeSiteReviewFrame({
        id: "offline-frame",
        url: "https://mac.example.ts.net:3000/offline",
        capturedImage: capturedImage("offline-image", "offline-ref", imageBlob.size),
      }),
    }, 2_001);
    await putReviewBlob("offline-ref", imageBlob);
    await saveReviewDraft(seededDraft);
    const send = vi.fn();

    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:${THREAD_ID}`}
        threadTitle="Offline review"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={20}
        sendEnabled={false}
        onSendReview={send}
      />,
    );

    const title = await screen.findByLabelText(/Frame title/);
    expect(title).toBeEnabled();
    fireEvent.change(title, { target: { value: "Edited offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview atomic send" }));
    const dialog = await screen.findByRole("dialog", { name: "Send one review to Offline review" });
    expect(dialog).toHaveTextContent(/preview remains saved locally/i);
    expect(screen.getByRole("button", { name: "Send unavailable" })).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a sent mono review for before/after until explicit confirmed local cleanup", async () => {
    const imageBlob = new Blob(["mono"], { type: "image/png" });
    const compositeBlob = new Blob(["mono-composite"], { type: "image/png" });
    let seededDraft = createReviewDraft({ id: "review-mono", targetThreadId: THREAD_ID, now: 2_100 });
    seededDraft = reviewDraftReducer(seededDraft, {
      type: "addFrame",
      frame: {
        ...makeSiteReviewFrame({
          id: "mono-frame",
          url: "https://mac.example.ts.net:3000/mono",
          capturedImage: capturedImage("mono-image", "mono-ref", imageBlob.size),
        }),
        drawing: {
          kind: "scene",
          scene: {
            ...createScene({ width: 820, height: 1_180 }),
            elements: [createShapeElement({
              id: "mono-mark",
              shape: "ellipse",
              x: 40,
              y: 50,
              width: 160,
              height: 100,
              strokeColor: "#f97316",
              strokeWidth: 4,
            })],
          },
          renderedImage: capturedImage("mono-composite", "mono-composite-ref", compositeBlob.size),
        },
      },
    }, 2_101);
    await putReviewBlob("mono-ref", imageBlob);
    await putReviewBlob("mono-composite-ref", compositeBlob);
    await saveReviewDraft(seededDraft);
    const send = vi.fn(async (_payload: AtomicReviewSend) => ({ ok: true, message: "Sent" }));
    const close = vi.fn();

    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:${THREAD_ID}`}
        threadTitle="Mono review"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={21}
        reviewMaxImages={1}
        onClose={close}
        onSendReview={send}
      />,
    );

    await screen.findByRole("heading", { name: "Mono review" });
    fireEvent.click(screen.getByRole("button", { name: "Preview atomic send" }));
    const confirm = await screen.findByRole(
      "button",
      { name: "Send review" },
      { timeout: 5_000 },
    );
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    const sentPayload = send.mock.calls[0]?.[0];
    expect(sentPayload?.manifest.images).toHaveLength(1);
    expect(sentPayload?.manifest.images[0]).toMatchObject({
      label: "[F1:composite]",
      imageId: "mono-composite",
    });
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ id: "review-mono" });
    await expect(getReviewBlob("mono-ref")).resolves.not.toBeNull();
    await expect(getReviewBlob("mono-composite-ref")).resolves.not.toBeNull();
    await waitFor(async () => {
      await expect(loadPendingReviewDelivery(THREAD_ID, sentPayload!.draft.updatedAt)).resolves.toBeNull();
    });

    fireEvent.click(await screen.findByRole("button", { name: "Clear local review" }));
    expect(screen.getByText(/permanently removes this local review/i)).toBeInTheDocument();
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ id: "review-mono" });
    fireEvent.click(screen.getByRole("button", { name: "Delete local review" }));

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    await expect(loadReviewDraft(THREAD_ID)).resolves.toBeNull();
    await expect(getReviewBlob("mono-ref")).resolves.toBeNull();
    await expect(getReviewBlob("mono-composite-ref")).resolves.toBeNull();
    await expect(loadPendingReviewDelivery(THREAD_ID, sentPayload!.draft.updatedAt)).resolves.toBeNull();
  });

  it.each([
    ["an in-flight acknowledgement", { ok: true, pending: true, message: "Still in progress" }],
    ["an unknown acknowledgement", { ok: false, pending: true, message: "Delivery is unknown" }],
    ["a definitive error", { ok: false, pending: false, message: "Delivery failed" }],
  ] as const)("keeps the draft, media, and retry identity after %s", async (_label, outcome) => {
    const imageBlob = new Blob(["retry"], { type: "image/png" });
    let seededDraft = createReviewDraft({ id: "review-retry", targetThreadId: THREAD_ID, now: 2_150 });
    seededDraft = reviewDraftReducer(seededDraft, {
      type: "addFrame",
      frame: makeSiteReviewFrame({
        id: "retry-frame",
        url: "https://mac.example.ts.net:3000/retry",
        capturedImage: capturedImage("retry-image", "retry-ref", imageBlob.size),
      }),
    }, 2_151);
    await putReviewBlob("retry-ref", imageBlob);
    await saveReviewDraft(seededDraft);
    const send = vi.fn(async (_payload: AtomicReviewSend) => outcome);

    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:${THREAD_ID}`}
        threadTitle="Retry review"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={21}
        reviewMaxImages={1}
        onSendReview={send}
      />,
    );

    await screen.findByRole("heading", { name: "Retry review" });
    fireEvent.click(screen.getByRole("button", { name: "Preview atomic send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send review" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    const payload = send.mock.calls[0]?.[0];
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ id: "review-retry" });
    await expect(getReviewBlob("retry-ref")).resolves.not.toBeNull();
    await expect(loadPendingReviewDelivery(THREAD_ID, payload!.draft.updatedAt)).resolves.toBe(payload!.commandId);
    expect(screen.queryByRole("button", { name: "Clear local review" })).not.toBeInTheDocument();

    if (!outcome.ok) {
      fireEvent.click(screen.getByRole("button", { name: "Retry same command" }));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[1]?.[0].commandId).toBe(payload!.commandId);
      await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ id: "review-retry" });
      await expect(getReviewBlob("retry-ref")).resolves.not.toBeNull();
      await expect(loadPendingReviewDelivery(THREAD_ID, payload!.draft.updatedAt)).resolves.toBe(payload!.commandId);
    }
  });

  it("preserves a newer tab's draft, media, and delivery when an old send panel receives success", async () => {
    const imageBlob = new Blob(["race"], { type: "image/png" });
    let seededDraft = createReviewDraft({ id: "review-cross-tab", targetThreadId: THREAD_ID, now: 2_180 });
    seededDraft = reviewDraftReducer(seededDraft, {
      type: "addFrame",
      frame: makeSiteReviewFrame({
        id: "race-frame",
        url: "https://mac.example.ts.net:3000/race",
        capturedImage: capturedImage("race-image", "race-ref", imageBlob.size),
      }),
    }, 2_181);
    await putReviewBlob("race-ref", imageBlob);
    await saveReviewDraft(seededDraft);
    const newerCommandId = "019f7ec2-68eb-7183-bb3a-0e67312a8bb2";
    let newerDraft = seededDraft;
    const send = vi.fn(async (_payload: AtomicReviewSend) => {
      const current = await loadReviewDraft(THREAD_ID);
      if (!current) throw new Error("Expected the first tab's draft.");
      newerDraft = reviewDraftReducer(current, {
        type: "setGeneralInstruction",
        instruction: "Second tab update",
      }, current.updatedAt + 1);
      await saveReviewDraft(newerDraft);
      await savePendingReviewDelivery(THREAD_ID, newerDraft.updatedAt, newerCommandId);
      return { ok: true, pending: false, message: "Old command completed" };
    });
    const close = vi.fn();

    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:${THREAD_ID}`}
        threadTitle="Cross-tab review"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={21}
        reviewMaxImages={1}
        onClose={close}
        onSendReview={send}
      />,
    );

    await screen.findByRole("heading", { name: "Cross-tab review" });
    fireEvent.click(screen.getByRole("button", { name: "Preview atomic send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send review" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    const clearButton = await screen.findByRole("button", { name: "Clear local review" });
    await expect(loadReviewDraft(THREAD_ID)).resolves.toEqual(newerDraft);
    await expect(loadPendingReviewDelivery(THREAD_ID, newerDraft.updatedAt)).resolves.toBe(newerCommandId);

    fireEvent.click(clearButton);
    fireEvent.click(screen.getByRole("button", { name: "Delete local review" }));

    expect(await screen.findByText(/changed in another tab/i)).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    await expect(loadReviewDraft(THREAD_ID)).resolves.toEqual(newerDraft);
    await expect(getReviewBlob("race-ref")).resolves.not.toBeNull();
    await expect(loadPendingReviewDelivery(THREAD_ID, newerDraft.updatedAt)).resolves.toBe(newerCommandId);
  });

  it("keeps a multi-image deck local when only mono delivery is verified", async () => {
    let seededDraft = createReviewDraft({ id: "review-local-deck", targetThreadId: THREAD_ID, now: 2_200 });
    for (const index of [0, 1]) {
      const blobRef = `deck-ref-${index}`;
      const imageBlob = new Blob([`deck-${index}`], { type: "image/png" });
      seededDraft = reviewDraftReducer(seededDraft, {
        type: "addFrame",
        frame: makeSiteReviewFrame({
          id: `deck-frame-${index}`,
          url: `https://mac.example.ts.net:3000/deck-${index}`,
          capturedImage: capturedImage(`deck-image-${index}`, blobRef, imageBlob.size),
        }),
      }, 2_201 + index);
      await putReviewBlob(blobRef, imageBlob);
    }
    await saveReviewDraft(seededDraft);
    const send = vi.fn();

    render(
      <ReviewStudio
        threadId={THREAD_ID}
        threadKey={`local:${THREAD_ID}`}
        threadTitle="Local deck"
        bridgeInstanceId={BRIDGE_INSTANCE_ID}
        snapshotSeq={22}
        reviewMaxImages={1}
        onSendReview={send}
      />,
    );

    await screen.findByRole("heading", { name: "Local deck" });
    expect(screen.getByText("2 frames · saved locally")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview atomic send" }));
    const dialog = await screen.findByRole("dialog", { name: "Send one review to Local deck" });
    expect(dialog).toHaveTextContent(/can send one image per review/i);
    expect(dialog).toHaveTextContent(/will not drop, flatten, or split/i);
    expect(screen.getByRole("button", { name: "Multi-image send unavailable" })).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
    await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ frames: { length: 2 } });
  });

  it("rejects an overflowing photo import before preparing or storing its Blob", async () => {
    let seededDraft = createReviewDraft({ id: "review-frame-cap", targetThreadId: THREAD_ID, now: 3_000 });
    for (let index = 0; index < 12; index += 1) {
      seededDraft = reviewDraftReducer(seededDraft, {
        type: "addFrame",
        frame: makeSiteReviewFrame({
          id: `cap-frame-${index}`,
          url: `https://mac.example.ts.net:3000/frame-${index}`,
        }),
      }, 3_001 + index);
    }
    await saveReviewDraft(seededDraft);
    const decode = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });

    try {
      render(
        <ReviewStudio
          threadId={THREAD_ID}
          threadKey={`local:${THREAD_ID}`}
          threadTitle="Capped review"
          bridgeInstanceId={BRIDGE_INSTANCE_ID}
          snapshotSeq={21}
          onSendReview={vi.fn()}
        />,
      );
      await screen.findByRole("heading", { name: "Capped review" });
      fireEvent.change(screen.getByLabelText("Photo / Files"), {
        target: { files: [new File(["not-decoded"], "overflow.png", { type: "image/png" })] },
      });

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/at most 12 frames/i));
      expect(decode).not.toHaveBeenCalled();
      await expect(loadReviewDraft(THREAD_ID)).resolves.toMatchObject({ frames: { length: 12 } });
      await expect(sweepReviewOrphanBlobs({ graceMs: 0 })).resolves.toMatchObject({ deleted: 0 });
    } finally {
      Reflect.deleteProperty(globalThis, "createImageBitmap");
    }
  });

  it("rolls back a comparison Blob when its before frame is deleted during the atomic save", async () => {
    const beforeBlob = new Blob(["before-race"], { type: "image/png" });
    let seededDraft = createReviewDraft({ id: "review-after-race", targetThreadId: THREAD_ID, now: 4_000 });
    seededDraft = reviewDraftReducer(seededDraft, {
      type: "addFrame",
      frame: makeSiteReviewFrame({
        id: "race-before-frame",
        url: "https://mac.example.ts.net:3000/before",
        capturedImage: capturedImage("race-before-image", "race-before-ref", beforeBlob.size),
      }),
    }, 4_001);
    seededDraft = reviewDraftReducer(seededDraft, {
      type: "addFrame",
      frame: makeSiteReviewFrame({ id: "race-fallback-frame", url: "https://mac.example.ts.net:3000/fallback" }),
    }, 4_002);
    await putReviewBlob("race-before-ref", beforeBlob);
    await saveReviewDraft(seededDraft);

    let resolveDecode!: (value: { width: number; height: number; close: () => void }) => void;
    const decode = vi.fn(() => new Promise<{ width: number; height: number; close: () => void }>((resolve) => {
      resolveDecode = resolve;
    }));
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    const originalAdd = IDBObjectStore.prototype.add;
    let frameDeleted = false;
    const addSpy = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
      if (this.name === "blobs" && !frameDeleted) {
        frameDeleted = true;
        fireEvent.click(screen.getByRole("button", { name: "Delete frame" }));
      }
      return request;
    });

    try {
      render(
        <ReviewStudio
          threadId={THREAD_ID}
          threadKey={`local:${THREAD_ID}`}
          threadTitle="After race"
          bridgeInstanceId={BRIDGE_INSTANCE_ID}
          snapshotSeq={22}
          onSendReview={vi.fn()}
        />,
      );
      await screen.findByRole("heading", { name: "After race" });
      fireEvent.change(screen.getByLabelText("Import after image"), {
        target: { files: [new File([pngBytes(2, 2)], "after.png", { type: "image/png" })] },
      });
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
      resolveDecode({ width: 2, height: 2, close: () => undefined });

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/before frame changed/i));
      expect(frameDeleted).toBe(true);
      await waitFor(async () => {
        const stored = await loadReviewDraft(THREAD_ID);
        expect(stored?.frames.map((frame) => frame.id)).toEqual(["race-fallback-frame"]);
      });
      await expect(getReviewBlob("race-before-ref")).resolves.toBeNull();
      await expect(sweepReviewOrphanBlobs({ graceMs: 0 })).resolves.toMatchObject({ deleted: 0 });
    } finally {
      addSpy.mockRestore();
      Reflect.deleteProperty(globalThis, "createImageBitmap");
    }
  });
});

import { createExportGeometry, createScene } from "@codex-pad/drawing";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { listCaptureInboxItems, saveCaptureInboxItem, type CaptureInboxItem } from "../lib/capture-inbox-store";
import { CaptureInboxPage } from "./CaptureInboxPage";
import { exportSceneToBoundedPng } from "./drawing-export";

vi.mock("../lib/capture-inbox-store", () => ({
  listCaptureInboxItems: vi.fn(),
  saveCaptureInboxItem: vi.fn(),
  loadCaptureInboxItem: vi.fn(),
  deleteCaptureInboxItems: vi.fn(),
}));

vi.mock("./drawing-export", () => ({ exportSceneToBoundedPng: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const savedCapture: CaptureInboxItem = {
  id: "test-local-capture",
  kind: "note",
  title: "Compare the two onboarding flows",
  text: "Compare the two onboarding flows before the next review.",
  createdAt: 1_000,
  updatedAt: 1_000,
  byteLength: 0,
  fileName: null,
  mimeType: null,
};

const exportedSketch = {
  blob: new Blob(["synthetic-sketch-png"], { type: "image/png" }),
  geometry: createExportGeometry(createScene(), {}),
};

beforeAll(() => {
  const context = new Proxy({}, { get: () => vi.fn(), set: () => true }) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1_000, bottom: 625, width: 1_000, height: 625,
    toJSON: () => ({}),
  });
});

beforeEach(() => {
  vi.mocked(listCaptureInboxItems).mockReset().mockResolvedValue([]);
  vi.mocked(saveCaptureInboxItem).mockReset().mockResolvedValue(savedCapture);
  vi.mocked(exportSceneToBoundedPng).mockReset().mockResolvedValue(exportedSketch);
});

afterEach(cleanup);
afterAll(() => vi.restoreAllMocks());

async function openCapture(kind: "note" | "sketch") {
  render(
    <CaptureInboxPage
      targetSession={null}
      macUnavailable
      onUseInSession={vi.fn()}
      onAttachFiles={vi.fn()}
      onBackToSession={vi.fn()}
    />,
  );
  await waitFor(() => expect(listCaptureInboxItems).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: kind === "note" ? /^Note/ : /^Sketch/ }));
  return screen.getByRole("dialog");
}

function pencil(canvas: HTMLElement, type: string, x: number, y: number, pointerId = 7) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "pen" },
    clientX: { value: x },
    clientY: { value: y },
    pressure: { value: 0.72 },
    tiltX: { value: 11 },
    tiltY: { value: -7 },
    timeStamp: { value: x },
    button: { value: 0 },
    getCoalescedEvents: { value: () => [] },
  });
  fireEvent(canvas, event);
}

function drawStroke(dialog: HTMLElement, pointerId = 7) {
  const canvas = within(dialog).getByRole("img", { name: /Frame annotation canvas/ });
  pencil(canvas, "pointerdown", 140, 180, pointerId);
  pencil(canvas, "pointermove", 220, 230, pointerId);
  pencil(canvas, "pointerup", 260, 240, pointerId);
}

describe("CaptureInboxPage save recovery", () => {
  it("keeps a note immutable and open until its local save completes", async () => {
    const save = deferred<CaptureInboxItem>();
    vi.mocked(saveCaptureInboxItem).mockReturnValueOnce(save.promise);
    const dialog = await openCapture("note");
    const input = within(dialog).getByRole("textbox", { name: "Quick note text" });
    const text = "Compare the two onboarding flows before the next review.";
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save to Inbox" }));

    expect(input).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close quick note" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.change(input, { target: { value: `${text} And keep this extra sentence.` } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close quick note" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(input).toHaveValue(text);
    expect(saveCaptureInboxItem).toHaveBeenCalledExactlyOnceWith({ kind: "note", title: text, text });

    await act(async () => save.resolve(savedCapture));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Quick note saved locally.");
  });

  it("shows a note save error inside the dialog and keeps the text for editing and retry", async () => {
    const save = deferred<CaptureInboxItem>();
    vi.mocked(saveCaptureInboxItem).mockReturnValueOnce(save.promise);
    const dialog = await openCapture("note");
    const input = within(dialog).getByRole("textbox", { name: "Quick note text" });
    fireEvent.change(input, { target: { value: "Keep the onboarding comparison for tomorrow." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save to Inbox" }));
    await act(async () => save.reject(new Error("Local storage is full.")));

    expect(within(dialog).getByRole("alert")).toHaveTextContent("Local storage is full.");
    expect(input).toHaveValue("Keep the onboarding comparison for tomorrow.");
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Keep the revised onboarding comparison." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save to Inbox" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveCaptureInboxItem).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Keep the revised onboarding comparison." }));
    expect(saveCaptureInboxItem).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("locks sketch edits and dismissal throughout PNG export and local persistence", async () => {
    const exported = deferred<Awaited<ReturnType<typeof exportSceneToBoundedPng>>>();
    const save = deferred<CaptureInboxItem>();
    vi.mocked(exportSceneToBoundedPng).mockReturnValueOnce(exported.promise);
    vi.mocked(saveCaptureInboxItem).mockReturnValueOnce(save.promise);
    const dialog = await openCapture("sketch");
    drawStroke(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep in Inbox" }));

    const assertLocked = () => {
      expect(within(dialog).getByRole("button", { name: "Close sketch" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Clear" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: /^(Pencil only|Finger \+ Pencil)$/ })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Pen" })).toBeDisabled();
      expect(within(dialog).getByRole("img", { name: /Frame annotation canvas/ }).closest("[inert]")).not.toBeNull();
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(dialog).toHaveFocus();
      fireEvent.click(within(dialog).getByRole("button", { name: "Close sketch" }));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.getByRole("dialog")).toBe(dialog);
    };
    assertLocked();
    drawStroke(dialog, 8);
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    expect(exportSceneToBoundedPng).toHaveBeenCalledOnce();
    expect(vi.mocked(exportSceneToBoundedPng).mock.calls[0]![0].elements).toHaveLength(1);
    expect(saveCaptureInboxItem).not.toHaveBeenCalled();

    await act(async () => exported.resolve(exportedSketch));
    assertLocked();
    expect(saveCaptureInboxItem).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "sketch", blob: exportedSketch.blob }));
    await act(async () => save.resolve(savedCapture));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Sketch saved locally.");
  });

  it.each(["export", "persistence"] as const)("preserves a sketch after %s fails and retries the same scene", async (stage) => {
    const exported = deferred<Awaited<ReturnType<typeof exportSceneToBoundedPng>>>();
    const save = deferred<CaptureInboxItem>();
    if (stage === "export") vi.mocked(exportSceneToBoundedPng).mockReturnValueOnce(exported.promise);
    else vi.mocked(saveCaptureInboxItem).mockReturnValueOnce(save.promise);
    const dialog = await openCapture("sketch");
    drawStroke(dialog);
    const canvas = within(dialog).getByRole("img", { name: /Frame annotation canvas/ });
    // A second pointer can already be captured when another finger presses Save.
    pencil(canvas, "pointerdown", 320, 280, 8);
    pencil(canvas, "pointermove", 360, 310, 8);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep in Inbox" }));
    const originalScene = vi.mocked(exportSceneToBoundedPng).mock.calls[0]![0];
    pencil(canvas, "pointerup", 390, 330, 8);
    const error = new Error(stage === "export" ? "PNG export could not finish." : "Local storage is full.");
    if (stage === "export") await act(async () => exported.reject(error));
    else {
      await waitFor(() => expect(saveCaptureInboxItem).toHaveBeenCalledOnce());
      await act(async () => save.reject(error));
    }

    expect(within(dialog).getByRole("alert")).toHaveTextContent(error.message);
    expect(within(dialog).getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Pen" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Close sketch" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep in Inbox" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vi.mocked(exportSceneToBoundedPng).mock.calls[1]![0]).toEqual(originalScene);
    expect(originalScene.elements).toHaveLength(1);
    expect(saveCaptureInboxItem).toHaveBeenCalledTimes(stage === "export" ? 1 : 2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

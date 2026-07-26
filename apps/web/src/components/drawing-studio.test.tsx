import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deserializeScene } from "@codex-pad/drawing";
import { DiagramDocumentSchema } from "@codex-pad/protocol";
import { deleteDrawingDraft, loadDrawingDraft, loadPendingDrawingBoardExport } from "../lib/draft-store";
import { loadPendingDrawingDelivery } from "../lib/drawing-delivery-store";
import { DrawingStudio, type DrawingTarget } from "./DrawingStudio";

const firstTarget: DrawingTarget = {
  bridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
  slotId: "AG01",
  threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  title: "Original task",
  snapshotSeq: 10,
};

beforeAll(() => {
  const context = new Proxy(
    {},
    {
      get: () => vi.fn(),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1_000,
    bottom: 625,
    width: 1_000,
    height: 625,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["png"], { type: "image/png" }));
  });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => "blob:codex-pad-preview") },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  localStorage.clear();
  await deleteDrawingDraft(firstTarget.threadId);
});

function sendWholeBoard(): void {
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  fireEvent.click(screen.getByRole("button", { name: "Prepare & Send" }));
}

describe("DrawingStudio routing", () => {
  it("opens an exact-task agent diagram, syncs structural edits, and sends one combined annotated PNG", async () => {
    const agentDiagram = DiagramDocumentSchema.parse({
      version: 1,
      diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
      threadId: firstTarget.threadId,
      revision: 0,
      title: "Agent round trip",
      nodes: [
        {
          id: "codex",
          label: "Codex proposes",
          x: 140,
          y: 200,
          width: 260,
          height: 112,
          shape: "rectangle",
          tone: "blue",
        },
        {
          id: "ipad",
          label: "iPad refines",
          x: 720,
          y: 200,
          width: 260,
          height: 112,
          shape: "ellipse",
          tone: "violet",
        },
      ],
      edges: [
        { id: "handoff", from: "codex", to: "ipad", label: "structured", style: "solid" },
      ],
      createdAt: 1,
      updatedAt: 1,
      createdBy: "codex",
      lastEditedBy: "codex",
      sourceLabel: "Codex diagram",
    });
    const onUpdateDiagram = vi.fn(async (_diagramId, _threadId, input) => {
      const { expectedRevision: _expectedRevision, ...editable } = input;
      return {
        ...agentDiagram,
        ...editable,
        revision: 1,
        updatedAt: 2,
        lastEditedBy: "ipad" as const,
      };
    });
    const onSend = vi.fn().mockResolvedValue({
      ok: false,
      deliveryUnknown: true,
      message: "Keep the combined draft for inspection",
    });

    render(
      <DrawingStudio
        open
        target={firstTarget}
        connected
        onClose={vi.fn()}
        onSend={onSend}
        onListDiagrams={vi.fn().mockResolvedValue([agentDiagram])}
        onUpdateDiagram={onUpdateDiagram}
      />,
    );

    expect(await screen.findByText("Agent round trip")).toBeVisible();
    expect(screen.getByRole("button", { name: "Draw on top" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit selected diagram block" }));
    const blockLabel = screen.getByRole("textbox", { name: "Selected block" });
    fireEvent.change(blockLabel, { target: { value: "Codex proposes a flow" } });
    fireEvent.blur(blockLabel);
    fireEvent.click(screen.getByRole("button", { name: "Close inspector and draw" }));

    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, {
      pointerId: { value: 91 }, pointerType: { value: "pen" }, clientX: { value: 200 },
      clientY: { value: 180 }, pressure: { value: 0.7 }, tiltX: { value: 4 },
      tiltY: { value: -2 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, down);
    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, {
      pointerId: { value: 91 }, pointerType: { value: "pen" }, clientX: { value: 270 },
      clientY: { value: 230 }, pressure: { value: 0.4 }, tiltX: { value: 3 },
      tiltY: { value: -1 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, up);

    sendWholeBoard();
    await waitFor(() => expect(onUpdateDiagram).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onUpdateDiagram).toHaveBeenCalledWith(
      agentDiagram.diagramId,
      firstTarget.threadId,
      expect.objectContaining({
        expectedRevision: 0,
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "codex", label: "Codex proposes a flow" }),
        ]),
      }),
    );
    expect(onUpdateDiagram.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]!);
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({
      instruction: "",
      images: [expect.objectContaining({ kind: "overview", tileNumber: 1 })],
      manifest: expect.objectContaining({ version: 1 }),
    });
    expect(onSend.mock.calls[0]?.[0].images?.[0]?.fileName).toMatch(/01-map\.png$/u);
    const sentScene = onSend.mock.calls[0]?.[0].scene as {
      elements: readonly { id: string; kind: string }[];
    };
    expect(sentScene.elements.some((element) => element.id.includes(":node:codex"))).toBe(true);
    expect(sentScene.elements.some((element) => element.kind === "stroke")).toBe(true);
  }, 10_000);

  it("keeps the Mac confirmation visible when parent callbacks change during Keep", async () => {
    let resolveKeep: ((value: { ok: true; message: string }) => void) | undefined;
    const onKeep = vi.fn(() => new Promise<{ ok: true; message: string }>((resolve) => {
      resolveKeep = resolve;
    }));
    const view = render(
      <DrawingStudio
        open
        target={firstTarget}
        connected
        onClose={vi.fn()}
        onSend={vi.fn()}
        onKeep={onKeep}
        onReconcileDelivery={vi.fn()}
      />,
    );
    await screen.findByText("Apple Pencil ready", {}, { timeout: 3_000 });
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, {
      pointerId: { value: 51 }, pointerType: { value: "pen" }, clientX: { value: 180 },
      clientY: { value: 180 }, pressure: { value: 0.6 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, down);
    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, {
      pointerId: { value: 51 }, pointerType: { value: "pen" }, clientX: { value: 260 },
      clientY: { value: 230 }, pressure: { value: 0.45 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, up);

    fireEvent.click(screen.getByRole("button", { name: "Keep in Saved Drawings" }));
    await waitFor(() => expect(onKeep).toHaveBeenCalledTimes(1));
    view.rerender(
      <DrawingStudio
        open
        target={firstTarget}
        connected
        onClose={vi.fn()}
        onSend={vi.fn()}
        onKeep={onKeep}
        onReconcileDelivery={vi.fn()}
      />,
    );
    resolveKeep?.({ ok: true, message: "Kept in Saved Drawings on the Mac" });

    expect(await screen.findByText("Kept in Saved Drawings on the Mac")).toBeVisible();
    expect(screen.queryByText("Loading saved page…")).not.toBeInTheDocument();
  });

  it("does not restore cleared marks when a photo is imported", async () => {
    const photoTarget: DrawingTarget = {
      ...firstTarget,
      slotId: "AG05",
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba5",
      title: "Photo replacement task",
    };
    await deleteDrawingDraft(photoTarget.threadId);
    const bitmap = {
      width: 1,
      height: 1,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const firstView = render(
      <DrawingStudio
        open
        target={photoTarget}
        connected
        onClose={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    await screen.findByText("Apple Pencil ready");
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });

    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, {
      pointerId: { value: 61 }, pointerType: { value: "pen" }, clientX: { value: 180 },
      clientY: { value: 180 }, pressure: { value: 0.6 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, down);
    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, {
      pointerId: { value: 61 }, pointerType: { value: "pen" }, clientX: { value: 260 },
      clientY: { value: 230 }, pressure: { value: 0.45 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, up);

    firstView.unmount();
    await waitFor(async () => {
      const draft = await loadDrawingDraft(photoTarget.threadId);
      expect(deserializeScene(draft?.scene ?? "").elements).toHaveLength(1);
    });

    const view = render(
      <DrawingStudio
        open
        target={photoTarget}
        connected
        onClose={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    await screen.findByText("Draft restored on this iPad");

    fireEvent.click(screen.getByRole("button", { name: "Clear page…" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear page" }));
    await screen.findByText("Apple Pencil ready", {}, { timeout: 3_000 });

    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
      (character) => character.charCodeAt(0),
    );
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    fireEvent.change(inputs[1]!, {
      target: { files: [new File([png], "replacement.png", { type: "image/png" })] },
    });
    await screen.findByText("replacement.png added behind your annotations");

    view.unmount();
    await waitFor(async () => {
      const draft = await loadDrawingDraft(photoTarget.threadId);
      const restored = deserializeScene(draft?.scene ?? "");
      expect(restored.elements).toHaveLength(1);
      expect(restored.elements[0]?.kind).toBe("image");
    });
  });

  it("keeps the canvas pinned and locks sending when the selected thread changes", async () => {
    const send = vi.fn();
    const { rerender } = render(
      <DrawingStudio
        open
        target={firstTarget}
        connected
        onClose={vi.fn()}
        onSend={send}
      />,
    );

    expect(await screen.findByText("Original task")).toBeInTheDocument();
    rerender(
      <DrawingStudio
        open
        target={{
          ...firstTarget,
          title: "Different task",
          threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
          snapshotSeq: 11,
        }}
        connected
        onClose={vi.fn()}
        onSend={send}
      />,
    );

    expect(screen.getByText("Original task")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Dashboard selection changed");
    expect(send).not.toHaveBeenCalled();
  });

  it("commits and persists an active Pencil stroke before iPad suspension", async () => {
    const suspensionTarget: DrawingTarget = {
      ...firstTarget,
      slotId: "AG03",
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba3",
      title: "Suspension task",
    };
    await deleteDrawingDraft(suspensionTarget.threadId);
    render(
      <DrawingStudio
        open
        target={suspensionTarget}
        connected
        onClose={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    await screen.findByText("Apple Pencil ready");
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });

    function pointer(type: string, x: number, y: number) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
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

    pointer("pointerdown", 140, 180);
    pointer("pointermove", 220, 230);
    fireEvent(window, new Event("pagehide"));

    await waitFor(async () => {
      const draft = await loadDrawingDraft(suspensionTarget.threadId);
      expect(draft).not.toBeNull();
      expect(deserializeScene(draft?.scene ?? "").elements).toHaveLength(1);
    });
  });

  it("keeps one touch passive and starts Pencil-mode navigation only with two fingers", async () => {
    render(
      <DrawingStudio
        open
        target={firstTarget}
        connected
        onClose={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    await screen.findByText("Apple Pencil ready");
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(canvas, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
      hasPointerCapture: { configurable: true, value: () => true },
    });

    function touch(type: string, pointerId: number, x: number, y: number) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: "touch" },
        clientX: { value: x },
        clientY: { value: y },
        pressure: { value: 1 },
        button: { value: 0 },
      });
      fireEvent(canvas, event);
    }

    touch("pointerdown", 101, 120, 420);
    touch("pointermove", 101, 180, 420);
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    touch("pointerdown", 102, 360, 420);
    expect(setPointerCapture).toHaveBeenCalledWith(101);
    expect(setPointerCapture).toHaveBeenCalledWith(102);

    touch("pointerup", 102, 360, 420);
    setPointerCapture.mockClear();
    touch("pointermove", 101, 240, 420);
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("retries an unknown delivery with the exact same command ID", async () => {
    const send = vi.fn().mockResolvedValue({
      ok: false,
      deliveryUnknown: true,
      message: "Delivery status is unknown",
    });
    render(
      <DrawingStudio
        open
        target={firstTarget}
        connected
        onClose={vi.fn()}
        onSend={send}
      />,
    );
    await screen.findByText("Apple Pencil ready");
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });

    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, {
      pointerId: { value: 9 },
      pointerType: { value: "pen" },
      clientX: { value: 180 },
      clientY: { value: 180 },
      pressure: { value: 0.6 },
      tiltX: { value: 0 },
      tiltY: { value: 0 },
      button: { value: 0 },
      getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, down);
    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, {
      pointerId: { value: 9 },
      pointerType: { value: "pen" },
      clientX: { value: 260 },
      clientY: { value: 230 },
      pressure: { value: 0.45 },
      tiltX: { value: 0 },
      tiltY: { value: 0 },
      button: { value: 0 },
      getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, up);
    sendWholeBoard();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0].instruction).toBe("");
    const retryButton = await screen.findByRole("button", { name: "Retry Send" });
    fireEvent.click(retryButton);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    expect(send.mock.calls[1]?.[0].commandId).toBe(send.mock.calls[0]?.[0].commandId);
    expect(screen.queryByText(/Instruction (attached|sent) with this PNG/i)).not.toBeInTheDocument();
  });

  it("clears the working draft after a confirmed send and does not recreate it on close", async () => {
    const deliveredTarget: DrawingTarget = {
      ...firstTarget,
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8bd1",
      threadKey: "native:019f7ec2-68eb-7183-bb3a-0e67312a8bd1",
      title: "Delivered drawing task",
    };
    await deleteDrawingDraft(deliveredTarget.threadId);
    const onClose = vi.fn();
    const view = render(
      <DrawingStudio
        open
        target={deliveredTarget}
        connected
        onClose={onClose}
        onSend={vi.fn().mockResolvedValue({ ok: true, message: "Attached" })}
      />,
    );
    await screen.findByText("Apple Pencil ready");
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, {
      pointerId: { value: 19 }, pointerType: { value: "pen" }, clientX: { value: 180 },
      clientY: { value: 180 }, pressure: { value: 0.6 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, down);
    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, {
      pointerId: { value: 19 }, pointerType: { value: "pen" }, clientX: { value: 260 },
      clientY: { value: 230 }, pressure: { value: 0.45 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, up);
    sendWholeBoard();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await loadDrawingDraft(deliveredTarget.threadId)).toBeNull());
    view.unmount();
    await waitFor(async () => expect(await loadDrawingDraft(deliveredTarget.threadId)).toBeNull());

    render(
      <DrawingStudio
        open
        target={deliveredTarget}
        connected
        onClose={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    await screen.findByText("Apple Pencil ready");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("restores an unresolved binding after reload and retries without minting a new ID", async () => {
    const reloadTarget: DrawingTarget = {
      ...firstTarget,
      slotId: "AG04",
      threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba4",
      threadKey: "native:019f7ec2-68eb-7183-bb3a-0e67312a8ba4",
      title: "Reload task",
    };
    await deleteDrawingDraft(reloadTarget.threadId);
    const firstSend = vi.fn().mockResolvedValue({
      ok: false,
      deliveryUnknown: true,
      message: "Delivery status is unknown",
    });
    const firstRender = render(
      <DrawingStudio
        open
        target={reloadTarget}
        connected
        onClose={vi.fn()}
        onSend={firstSend}
      />,
    );
    await screen.findByText("Apple Pencil ready");
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, {
      pointerId: { value: 21 }, pointerType: { value: "pen" }, clientX: { value: 180 },
      clientY: { value: 180 }, pressure: { value: 0.6 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, down);
    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, {
      pointerId: { value: 21 }, pointerType: { value: "pen" }, clientX: { value: 260 },
      clientY: { value: 230 }, pressure: { value: 0.45 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, up);
    sendWholeBoard();
    await waitFor(() => expect(firstSend).toHaveBeenCalledTimes(1));

    const firstCommandId = firstSend.mock.calls[0]?.[0].commandId as string;
    expect(loadPendingDrawingDelivery(reloadTarget.threadId)?.commandId).toBe(firstCommandId);
    firstRender.unmount();
    await expect(loadPendingDrawingBoardExport(reloadTarget.threadId)).resolves.toMatchObject({ commandId: firstCommandId });

    const retry = vi.fn().mockResolvedValue({ ok: true, message: "Completed" });
    const reconcile = vi.fn().mockResolvedValue({
      state: "unknown" as const,
      ok: false,
      message: "Command outcome remains unknown",
    });
    render(
      <DrawingStudio
        open
        target={reloadTarget}
        connected
        onClose={vi.fn()}
        onSend={retry}
        onReconcileDelivery={reconcile}
      />,
    );

    await screen.findByText(/retry will keep its delivery ID/i);
    expect(screen.getByRole("button", { name: "Pen" })).toBeDisabled();
    const retryButton = await screen.findByRole("button", { name: "Retry Send" });
    fireEvent.click(retryButton);
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));

    expect(retry.mock.calls[0]?.[0].commandId).toBe(firstCommandId);
    expect(reconcile).toHaveBeenCalledWith(firstCommandId);
    await waitFor(() => expect(loadPendingDrawingDelivery(reloadTarget.threadId)).toBeNull());
  }, 10_000);

  it("contains focus in confirmation sheets and restores the main dialog trigger", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    opener.textContent = "Open drawing";
    document.body.append(opener);
    opener.focus();
    const view = render(
      <DrawingStudio open target={firstTarget} connected onClose={onClose} onSend={vi.fn()} />,
    );
    await screen.findByText("Apple Pencil ready");
    const canvas = screen.getByRole("img", { name: /Sketch canvas/ });
    await waitFor(() => expect(canvas).toHaveFocus());

    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperties(down, {
      pointerId: { value: 31 }, pointerType: { value: "pen" }, clientX: { value: 180 },
      clientY: { value: 180 }, pressure: { value: 0.6 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, down);
    const up = new Event("pointerup", { bubbles: true, cancelable: true });
    Object.defineProperties(up, {
      pointerId: { value: 31 }, pointerType: { value: "pen" }, clientX: { value: 260 },
      clientY: { value: 230 }, pressure: { value: 0.45 }, tiltX: { value: 0 },
      tiltY: { value: 0 }, button: { value: 0 }, getCoalescedEvents: { value: () => [] },
    });
    fireEvent(canvas, up);

    const clearTrigger = screen.getByRole("button", { name: "Clear page…" });
    clearTrigger.focus();
    fireEvent.click(clearTrigger);
    const keep = screen.getByRole("button", { name: "Keep drawing" });
    const clear = screen.getByRole("button", { name: "Clear page" });
    await waitFor(() => expect(keep).toHaveFocus());
    clear.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(keep).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(clearTrigger).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(
      <DrawingStudio open={false} target={firstTarget} connected onClose={onClose} onSend={vi.fn()} />,
    );
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});

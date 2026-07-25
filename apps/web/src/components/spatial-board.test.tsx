import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSlot } from "../lib/model";
import type { SpatialLayout } from "../lib/spatial-model";
import type { SpatialLayoutStorage } from "../lib/spatial-storage";
import { SpatialBoard } from "./SpatialBoard";

function slot(
  threadId: string,
  title: string,
  index: number,
  status: AgentSlot["status"] = "idle",
): AgentSlot {
  return {
    slotId: `AG0${index}`,
    index,
    title,
    threadKey: `thread:${threadId}`,
    threadId,
    suffix: threadId.slice(-8),
    status,
    selected: false,
    activityLabel: null,
    activityAt: null,
  };
}

function memoryStorage(): SpatialLayoutStorage {
  let saved: SpatialLayout | null = null;
  return {
    async load() {
      return saved;
    },
    async save(layout) {
      saved = layout;
    },
  };
}

const baseLayout: SpatialLayout = {
  version: 2,
  boxes: [
    {
      id: "focus",
      name: "Focus",
      color: "cobalt",
      size: "standard",
      threadIds: [],
    },
  ],
  unassignedThreadIds: ["thread-alpha"],
};

afterEach(cleanup);

describe("SpatialBoard", () => {
  it("shows the all-session privacy control off by default and requires an explicit change", () => {
    const onAllSessionsEnabledChange = vi.fn();
    const view = render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Alpha", 0)]}
        initialLayout={baseLayout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
        onAllSessionsEnabledChange={onAllSessionsEnabledChange}
      />,
    );

    const toggle = screen.getByRole("checkbox", { name: "Include all Codex sessions" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Off · no all-session request is sent.")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onAllSessionsEnabledChange).toHaveBeenCalledWith(true);

    view.rerender(
      <SpatialBoard
        slots={[slot("thread-alpha", "Alpha", 0)]}
        initialLayout={baseLayout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
        allSessionsEnabled
        allSessionsAvailable
        onAllSessionsEnabledChange={onAllSessionsEnabledChange}
      />,
    );
    expect(toggle).toBeChecked();
    expect(screen.getByText("On · catalog summaries are loaded in memory only.")).toBeInTheDocument();
  });

  it("creates an arbitrary named box", () => {
    render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Alpha", 0)]}
        initialLayout={baseLayout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create box" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Box name" }), {
      target: { value: "Release checks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add box" }));

    expect(screen.getByRole("textbox", { name: "Rename Release checks" })).toBeInTheDocument();
  });

  it("touch-moves a session into a box with Pointer Events", () => {
    render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Alpha", 0, "awaiting-approval")]}
        initialLayout={baseLayout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
      />,
    );

    const handle = screen.getByRole("button", { name: "Touch and move Alpha" });
    const setPointerCapture = vi.fn();
    Object.defineProperty(handle, "setPointerCapture", { value: setPointerCapture });
    const target = screen.getByLabelText("Focus session drop zone");
    fireEvent.pointerDown(handle, {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(target, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 40,
      clientY: 40,
    });
    fireEvent.pointerUp(target, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 40,
      clientY: 40,
    });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(within(target).getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Move Alpha to a box" })).toHaveValue("focus");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("releases pointer capture and clears drag state when capture is cancelled or lost", () => {
    render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Alpha", 0)]}
        initialLayout={baseLayout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
      />,
    );

    const handle = screen.getByRole("button", { name: "Touch and move Alpha" });
    const card = screen.getByRole("article", { name: "Alpha, Idle" });
    const board = screen.getByRole("region", { name: "Spatial session organizer" });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => false);
    Object.defineProperties(handle, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
      hasPointerCapture: { configurable: true, value: hasPointerCapture },
    });

    fireEvent.pointerDown(handle, {
      pointerId: 11, pointerType: "touch", isPrimary: true, button: 0, clientX: 10, clientY: 10,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(11);
    expect(card).toHaveClass("is-dragging");
    fireEvent.pointerLeave(board, { pointerId: 11, pointerType: "touch" });
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
    expect(card).not.toHaveClass("is-dragging");

    fireEvent.pointerDown(handle, {
      pointerId: 12, pointerType: "touch", isPrimary: true, button: 0, clientX: 10, clientY: 10,
    });
    expect(card).toHaveClass("is-dragging");
    fireEvent.lostPointerCapture(handle, { pointerId: 12, pointerType: "touch" });
    expect(card).not.toHaveClass("is-dragging");
  });

  it("moves a session between adjacent boxes from the keyboard", () => {
    const onOpen = vi.fn();
    const layout: SpatialLayout = {
      ...baseLayout,
      boxes: [
        baseLayout.boxes[0]!,
        { id: "later", name: "Later", color: "slate", size: "compact", threadIds: [] },
      ],
    };
    render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Keyboard task", 0)]}
        initialLayout={layout}
        storage={memoryStorage()}
        onOpenSession={onOpen}
      />,
    );

    const openButton = screen.getByRole("button", { name: /Keyboard task.*ad-alpha/i });
    fireEvent.keyDown(openButton, { key: "ArrowRight", altKey: true });
    expect(screen.getByRole("combobox", { name: "Move Keyboard task to a box" })).toHaveValue("focus");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Keyboard task.*ad-alpha/i }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-alpha",
      nativeSlotId: "AG00",
    }));
  });

  it("reorders sessions inside a box from the keyboard", () => {
    const layout: SpatialLayout = {
      ...baseLayout,
      boxes: [{
        ...baseLayout.boxes[0]!,
        threadIds: ["thread-alpha", "thread-beta"],
      }],
      unassignedThreadIds: [],
    };
    render(
      <SpatialBoard
        slots={[
          slot("thread-alpha", "Alpha", 0),
          slot("thread-beta", "Beta", 1),
        ]}
        initialLayout={layout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
      />,
    );

    const focus = screen.getByRole("group", { name: "Focus session drop zone" });
    const names = () => within(focus).getAllByRole("article").map((card) => card.getAttribute("aria-label"));
    expect(names()).toEqual(["Alpha, Idle", "Beta, Idle"]);

    fireEvent.keyDown(screen.getByRole("button", { name: /Alpha.*ad-alpha/i }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(names()).toEqual(["Beta, Idle", "Alpha, Idle"]);

    fireEvent.keyDown(screen.getByRole("button", { name: /Alpha.*ad-alpha/i }), {
      key: "ArrowUp",
      altKey: true,
    });
    expect(names()).toEqual(["Alpha, Idle", "Beta, Idle"]);
  });

  it("shows catalog-only sessions without granting them a native slot", () => {
    const onOpen = vi.fn();
    const layout: SpatialLayout = {
      version: 2,
      boxes: [],
      unassignedThreadIds: ["thread-alpha", "thread-catalog"],
    };
    render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Native task", 0)]}
        sessions={[{
          threadId: "thread-catalog",
          title: "Catalog task",
          status: "idle",
          project: "Atlas",
        }]}
        initialLayout={layout}
        storage={memoryStorage()}
        onOpenSession={onOpen}
      />,
    );

    const catalogCard = screen.getByRole("article", { name: "Catalog task, Idle" });
    expect(within(catalogCard).queryByText(/Native slot/)).not.toBeInTheDocument();
    expect(within(catalogCard).getByText(/Atlas/)).toBeInTheDocument();

    fireEvent.click(within(catalogCard).getByRole("button", { name: /Catalog task.*-catalog/i }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-catalog",
      nativeSlotId: null,
      nativeSlotIndex: null,
    }));
  });

  it("confirms deletion of a non-empty box and returns its sessions to Unassigned", () => {
    const layout: SpatialLayout = {
      ...baseLayout,
      boxes: [{ ...baseLayout.boxes[0]!, threadIds: ["thread-alpha"] }],
      unassignedThreadIds: [],
    };
    render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Alpha", 0)]}
        initialLayout={layout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Focus" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Focus?" });
    expect(within(dialog).getByText(/No Codex task is changed or deleted/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Rename Focus" })).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Delete Focus?" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Rename Focus" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete Focus" }));
    const reopenedDialog = screen.getByRole("dialog", { name: "Delete Focus?" });
    fireEvent.click(within(reopenedDialog).getByRole("button", { name: "Delete box" }));
    expect(screen.queryByRole("textbox", { name: "Rename Focus" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Unassigned session drop zone")).getByText("Alpha")).toBeInTheDocument();
  });

  it("contains delete-dialog focus, closes with Escape, and restores the delete trigger", () => {
    const layout: SpatialLayout = {
      ...baseLayout,
      boxes: [{ ...baseLayout.boxes[0]!, threadIds: ["thread-alpha"] }],
      unassignedThreadIds: [],
    };
    render(
      <SpatialBoard
        slots={[slot("thread-alpha", "Alpha", 0)]}
        initialLayout={layout}
        storage={memoryStorage()}
        onOpenSession={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Delete Focus" });
    trigger.focus();
    fireEvent.click(trigger);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete box" });
    expect(cancel).toHaveFocus();
    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Delete Focus?" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

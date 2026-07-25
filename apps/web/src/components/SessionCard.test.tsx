import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductSession } from "../lib/session-presentation";
import { SessionCard } from "./SessionCard";

const session: ProductSession = {
  threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  threadKey: "thread:019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  title: "Release checklist",
  status: "working",
  nativeStatus: "working",
  activityAt: Date.now(),
  projectId: "project:test",
  project: "codex-pad",
  selected: true,
  activeOnMac: true,
  nativeSlot: null,
  ownedByHost: true,
  siteAssociations: [],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionCard touch arrangement", () => {
  it("holds a card for direct movement without entering a separate mode or opening the session", () => {
    vi.useFakeTimers();
    const open = vi.fn();
    render(<SessionCard session={session} dragEnabled onOpen={open} onMove={vi.fn()} />);
    const button = screen.getByRole("button", { name: /Open Release checklist/ });
    Object.defineProperty(button, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(button, "releasePointerCapture", { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(button, { pointerId: 7, pointerType: "touch", clientX: 20, clientY: 20 });
    vi.advanceTimersByTime(421);
    fireEvent.pointerUp(button, { pointerId: 7, pointerType: "touch", clientX: 20, clientY: 20 });
    fireEvent.click(button);

    expect(open).not.toHaveBeenCalled();
  });

  it("starts drag on the same long press, suppresses its following click, and preserves a short tap", () => {
    vi.useFakeTimers();
    const move = vi.fn();
    const open = vi.fn();
    render(<SessionCard
      session={session}
      dragEnabled
      onOpen={open}
      onMove={move}
    />);
    const button = screen.getByRole("button", { name: /Open Release checklist/ });
    Object.defineProperty(button, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(button, "releasePointerCapture", { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(button, { pointerId: 8, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerUp(button, { pointerId: 8, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.click(button);
    expect(open).toHaveBeenCalledOnce();

    const drop = document.createElement("section");
    drop.dataset.homeDropTarget = "case-review";
    document.body.append(drop);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => drop),
    });

    fireEvent.pointerDown(button, { pointerId: 9, pointerType: "touch", clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(421);
    fireEvent.pointerMove(button, { pointerId: 9, pointerType: "touch", clientX: 60, clientY: 40 });
    fireEvent.pointerUp(button, { pointerId: 9, pointerType: "touch", clientX: 60, clientY: 40 });
    fireEvent.click(button);

    expect(move).toHaveBeenCalledWith(session.threadId, "case-review", undefined);
    expect(open).toHaveBeenCalledOnce();
    drop.remove();
  });
});

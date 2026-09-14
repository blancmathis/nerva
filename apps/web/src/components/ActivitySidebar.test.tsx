import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductSession } from "../lib/session-presentation";
import { ActivitySidebar } from "./ActivitySidebar";

const session: ProductSession = {
  threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  threadKey: "thread:019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  title: "Release checklist", status: "working", nativeStatus: "working", activityAt: Date.now(),
  projectId: "project:test", project: "nerva", selected: true, activeOnMac: true,
  nativeSlot: null, ownedByHost: true, siteAssociations: [],
};
function setup() {
  const close = vi.fn(); const open = vi.fn(); const pin = vi.fn();
  render(<ActivitySidebar open sessions={[session]} currentThreadId={session.threadId}
    pinnedThreadIds={[]} onClose={close} onOpenConversations={vi.fn()}
    onOpenSession={open} onPinSession={pin} onUnpinSession={vi.fn()} />);
  return { close, open, pin };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Activity accessible actions", () => {
  it("exposes a single-tap action button without opening or mutating a session", () => {
    const { open, pin } = setup();
    const trigger = screen.getByRole("button", { name: "Actions for Release checklist" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Actions for Release checklist" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Open conversation" })).toHaveFocus();
    expect(open).not.toHaveBeenCalled(); expect(pin).not.toHaveBeenCalled();
  });

  it("supports arrow navigation, Escape and restoration without closing Activity", () => {
    const { close } = setup();
    const trigger = screen.getByRole("button", { name: "Actions for Release checklist" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Open conversation" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Pin to Home" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Pin to Home" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus(); expect(close).not.toHaveBeenCalled();
  });

  it("pins only the exact session and retains keyboard focus", () => {
    const { pin } = setup();
    const trigger = screen.getByRole("button", { name: "Actions for Release checklist" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin to Home" }));
    expect(pin).toHaveBeenCalledExactlyOnceWith(session.threadId);
    expect(trigger).toHaveFocus();
  });
  it("keeps a normal row tap available after opening explicit actions", () => {
    const { open } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Release checklist" }));
    fireEvent.click(screen.getByRole("button", { name: /Open Release checklist from Activity/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith(session);
  });

});

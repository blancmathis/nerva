import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UnpinnedSessionsDrawer } from "./UnpinnedSessionsDrawer";

afterEach(cleanup);
it("explains a genuinely empty catalog without claiming all conversations are pinned", () => {
  render(<UnpinnedSessionsDrawer open sessions={[]} pinnedThreadIds={[]}
    onClose={vi.fn()} activityCount={0} onOpenActivity={vi.fn()}
    onOpenSession={vi.fn()} onPin={vi.fn()} />);
  expect(screen.getByText("No conversations yet")).toBeVisible();
  expect(screen.getByText(/Start a conversation in Codex on your Mac/)).toBeVisible();
  expect(screen.queryByText("Everything is pinned")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "missing" } });
  expect(screen.getByText("No matching sessions")).toBeVisible();
});


it("keeps pinned conversations searchable and opens the exact result", () => {
  const open = vi.fn();
  const unpin = vi.fn();
  const session = {
    threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    threadKey: "thread:019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    title: "Release checklist", status: "working" as const, nativeStatus: "working" as const,
    activityAt: Date.now(), projectId: "project:test", project: "Nerva",
    selected: true, activeOnMac: true, nativeSlot: null, ownedByHost: true, siteAssociations: [],
  };
  render(<UnpinnedSessionsDrawer open sessions={[session]} pinnedThreadIds={[session.threadId]}
    onClose={vi.fn()} activityCount={0} onOpenActivity={vi.fn()}
    onOpenSession={open} onPin={vi.fn()} onUnpin={unpin} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "Release" } });
  fireEvent.click(screen.getByRole("button", { name: /^Release checklist/ }));
  expect(open).toHaveBeenCalledWith(session);
  fireEvent.click(screen.getByRole("button", { name: "Unpin Release checklist from Home" }));
  expect(unpin).toHaveBeenCalledWith(session.threadId);
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByText("Release checklist")).toBeVisible();
});

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

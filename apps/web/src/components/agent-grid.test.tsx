import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSlot } from "../lib/model";
import { AgentGrid } from "./AgentGrid";

function slot(status: AgentSlot["status"]): AgentSlot {
  return {
    slotId: "AG00",
    index: 0,
    title: "Exact task",
    threadKey: "local:019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    suffix: "312a8ba1",
    status,
    selected: true,
    activityLabel: null,
    activityAt: null,
  };
}

describe("AgentGrid state duration", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("never renders transcript-like activity text", () => {
    const unsafe = {
      ...slot("working"),
      activityLabel: "Dictated prompt: publish the private draft",
    } as unknown as AgentSlot;

    render(
      <AgentGrid slots={[unsafe]} canSelect selectingSlotId={null} onSelect={vi.fn()} />,
    );

    expect(screen.queryByText(/publish the private draft/i)).not.toBeInTheDocument();
  });

  it("labels the exact task currently active on the Mac without selecting it", () => {
    const current = { ...slot("working"), selected: false };

    render(
      <AgentGrid
        slots={[current]}
        activeThreadId={current.threadId}
        canSelect={false}
        selectingSlotId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /active on Mac/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("On Mac")).toBeInTheDocument();
  });

  it("measures a state only while that exact state remains observed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
    const view = render(
      <AgentGrid slots={[slot("idle")]} canSelect selectingSlotId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("State seen").nextSibling).toHaveTextContent("now");

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByText("State seen").nextSibling).toHaveTextContent("1m");

    view.rerender(
      <AgentGrid slots={[slot("working")]} canSelect selectingSlotId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("State seen").nextSibling).toHaveTextContent("now");
  });
});

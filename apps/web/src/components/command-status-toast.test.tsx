import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { commandAckFromProtocol } from "../lib/bridge-client";
import { CommandStatusToast } from "./CommandStatusToast";

describe("CommandStatusToast", () => {
  it("labels an in-flight acknowledgement as active work, never as waiting or queued", () => {
    const ack = commandAckFromProtocol({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb2",
      disposition: "accepted",
      status: "inFlight",
      sequence: 73,
      targetThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      error: null,
    });

    render(<CommandStatusToast ack={ack} onDismiss={vi.fn()} />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Command in progress");
    expect(status).toHaveTextContent("Command is in progress on the selected task");
    expect(status).not.toHaveTextContent(/waiting|queued/i);
  });

  it("dismisses a completed acknowledgement after a short confirmation", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    render(<CommandStatusToast ack={{
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb3",
      ok: true,
      pending: false,
      message: "Exact Codex session opened on the Mac",
    }} onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(2_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps a rejected command visible until the user dismisses it", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    render(<CommandStatusToast ack={{
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb4",
      ok: false,
      pending: false,
      message: "The exact target changed",
    }} onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(30_000));
    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

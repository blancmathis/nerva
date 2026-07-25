import { render, screen } from "@testing-library/react";
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
});

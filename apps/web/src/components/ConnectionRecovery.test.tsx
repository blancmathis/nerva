import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionRecovery } from "./ConnectionRecovery";

afterEach(cleanup);

describe("ConnectionRecovery", () => {
  it("explains the private connection checks without claiming Tailscale is certainly the cause", () => {
    render(<ConnectionRecovery phase="offline" onRetry={async () => false} />);

    expect(screen.getByRole("heading", { name: "Can’t reach your Mac." })).toBeVisible();
    expect(screen.getByText(/most common cause/)).toHaveTextContent("Tailscale");
    expect(screen.getByText(/cannot identify the exact broken link/)).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("keeps a failed retry actionable", async () => {
    const onRetry = vi.fn(async () => false);
    render(<ConnectionRecovery phase="reconnecting" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/still unavailable/)).toBeVisible();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});

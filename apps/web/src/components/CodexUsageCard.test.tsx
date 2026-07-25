import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexUsageCard, resetLabel, usageWindowLabel } from "./CodexUsageCard";

afterEach(cleanup);

describe("CodexUsageCard", () => {
  it("renders the real rolling windows and exposes a touch refresh action", () => {
    const refresh = vi.fn();
    render(<CodexUsageCard
      loaded
      onRefresh={refresh}
      usage={{
        available: true,
        stale: false,
        fetchedAt: Date.now(),
        planType: "pro",
        limitName: "Codex",
        primary: { usedPercent: 28, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 },
        secondary: { usedPercent: 62, windowMinutes: 10_080, resetsAt: Date.now() + 86_400_000 },
        credits: null,
        rateLimitReached: false,
      }}
    />);

    expect(screen.getByText("5-hour limit")).toBeInTheDocument();
    expect(screen.getByText("Weekly limit")).toBeInTheDocument();
    expect(screen.getByText("72% remaining")).toBeInTheDocument();
    expect(screen.getByText("38% remaining")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")[0]).toHaveAccessibleName("Weekly limit remaining");
    expect(screen.getByRole("progressbar", { name: "5-hour limit remaining" })).toHaveAttribute("aria-valuenow", "72");
    expect(screen.getByRole("progressbar", { name: "5-hour limit remaining" })).toHaveAttribute("aria-valuetext", "72% remaining");
    expect(screen.queryByText("Pro plan")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Codex usage" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("never invents a percentage when Codex usage is unavailable", () => {
    render(<CodexUsageCard
      loaded
      onRefresh={vi.fn()}
      usage={{ available: false, stale: false, fetchedAt: Date.now(), reason: "app-server-unavailable" }}
    />);
    expect(screen.getByText("Usage unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("formats known Codex windows and bounded reset text", () => {
    expect(usageWindowLabel(300, 0)).toBe("5-hour limit");
    expect(usageWindowLabel(10_080, 1)).toBe("Weekly limit");
    expect(resetLabel(1_060_000, 1_000_000)).toBe("Resets in 1 minute");
  });
});

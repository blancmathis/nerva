import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppBootBoundary } from "./AppBootBoundary";

function BrokenApp(): never {
  throw new Error("fixture startup failure");
}

describe("AppBootBoundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("leaves a healthy application untouched", () => {
    render(<AppBootBoundary><p>Healthy Nerva</p></AppBootBoundary>);
    expect(screen.getByText("Healthy Nerva")).toBeVisible();
  });

  it("replaces a startup crash with a clear recovery action", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<AppBootBoundary><BrokenApp /></AppBootBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("Startup was interrupted");
    expect(screen.getByRole("button", { name: "Repair and reopen" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reload only" })).toBeEnabled();
  });
});

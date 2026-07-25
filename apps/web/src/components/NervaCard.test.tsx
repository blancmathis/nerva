import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NervaCard } from "./NervaCard";

describe("Nerva Card", () => {
  it("renders bounded schema content and rejects arbitrary HTML documents", () => {
    const { rerender } = render(<NervaCard document={{
      version: 1,
      id: "context-room",
      source: "context-room",
      title: "Context Room",
      subtitle: null,
      tone: "success",
      blocks: [{ type: "status", label: "Room", value: "Available", tone: "success" }],
    }} />);
    expect(screen.getByText("Available")).toBeInTheDocument();
    rerender(<NervaCard document={{ html: "<script>unsafe()</script>" }} />);
    expect(screen.queryByText("Available")).not.toBeInTheDocument();
  });
});

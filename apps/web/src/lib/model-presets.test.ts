import { describe, expect, it } from "vitest";
import { resolveModelReasoningPresets } from "./model-presets";

const models = [{
  model: "sol",
  displayName: "Sol",
  supportedReasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "low",
  isDefault: true,
}, {
  model: "luna",
  displayName: "Luna",
  supportedReasoningEfforts: ["medium", "high"],
  defaultReasoningEffort: "medium",
  isDefault: false,
}] as const;

describe("resolveModelReasoningPresets", () => {
  it("never leaks unselected catalog models into a configured slider", () => {
    expect(resolveModelReasoningPresets([{
      id: "sol-low",
      model: "sol",
      reasoning: "low",
      enabled: true,
    }], models)).toEqual([{
      id: "sol-low",
      model: "sol",
      reasoning: "low",
      enabled: true,
    }]);
  });

  it("does not replace temporarily unavailable or disabled configured presets with the full catalog", () => {
    expect(resolveModelReasoningPresets([{
      id: "sol-ultra",
      model: "sol",
      reasoning: "ultra",
      enabled: true,
    }], models)).toEqual([]);
    expect(resolveModelReasoningPresets([{
      id: "sol-low",
      model: "sol",
      reasoning: "low",
      enabled: false,
    }], models)).toEqual([]);
  });

  it("uses a bounded live-catalog default only before any preset is configured", () => {
    expect(resolveModelReasoningPresets([], models).map((preset) => `${preset.model}:${preset.reasoning}`)).toEqual([
      "sol:low",
      "sol:high",
      "luna:medium",
      "luna:high",
    ]);
  });
});

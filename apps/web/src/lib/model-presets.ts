import type { ModelCapability } from "./model";
import type { ModelReasoningPreset } from "./storage";

/**
 * A configured slider is an allowlist. A temporarily unavailable or disabled
 * preset must never be replaced by unselected models from the live catalog.
 */
export function resolveModelReasoningPresets(
  configuredPresets: readonly ModelReasoningPreset[],
  models: readonly ModelCapability[],
): readonly ModelReasoningPreset[] {
  const catalog = new Map(models.map((model) => [model.model, model]));
  if (configuredPresets.length > 0) {
    return configuredPresets.filter((preset) => (
      preset.enabled
      && catalog.get(preset.model)?.supportedReasoningEfforts.includes(preset.reasoning)
    ));
  }
  return models.flatMap((model) => model.supportedReasoningEfforts.map((reasoning) => ({
    id: `${model.model}:${reasoning}`,
    model: model.model,
    reasoning: reasoning as ModelReasoningPreset["reasoning"],
    enabled: true,
  }))).slice(0, 24);
}

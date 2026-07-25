import type { SkillInfo } from "./thread-transport.js";

const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function safeGroupId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/_/gu, "-");
  return GROUP_ID.test(normalized) ? normalized : null;
}

/**
 * Projects only a bounded provider identity from a skill path. Absolute paths,
 * versions and user directories never cross the bridge API.
 */
export function skillGroupId(skill: Pick<SkillInfo, "name" | "path">): string {
  const segments = skill.path.split(/[\\/]+/u).filter(Boolean);
  const pluginsIndex = segments.lastIndexOf("plugins");
  if (pluginsIndex >= 0 && segments[pluginsIndex + 1] === "cache") {
    const pluginId = safeGroupId(segments[pluginsIndex + 3]);
    if (pluginId) return pluginId;
  }

  const codexIndex = segments.lastIndexOf(".codex");
  if (codexIndex >= 0 && segments[codexIndex + 1] === "skills") {
    return segments[codexIndex + 2] === ".system" ? "system" : "personal";
  }

  const namespace = skill.name.includes(":") ? skill.name.split(":", 1)[0] : null;
  const namespaceId = safeGroupId(namespace ?? undefined);
  if (namespaceId) return namespaceId;
  if (skill.name.startsWith("artifact-template-")) return "openai-templates";
  if (skill.name === "github" || skill.name.startsWith("gh-")) return "github";
  return "project";
}

import type { SkillCapability } from "./model";

export interface SkillGroup {
  readonly id: string;
  readonly label: string;
  readonly skills: readonly SkillCapability[];
  readonly selectedCount: number;
}

const SPECIAL_LABELS: Readonly<Record<string, string>> = {
  "computer-use": "Computer Use",
  github: "GitHub",
  "openai-templates": "OpenAI Templates",
  personal: "My Skills",
  project: "Project Skills",
  system: "System Skills",
  other: "Other Skills",
};

function safeGroupId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/_/gu, "-");
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(normalized) ? normalized : null;
}

export function fallbackSkillGroupId(skill: SkillCapability): string {
  const provided = safeGroupId(skill.group);
  if (provided) return provided;
  const namespace = skill.id.includes(":") ? skill.id.split(":", 1)[0] : null;
  const namespaceId = safeGroupId(namespace ?? undefined);
  if (namespaceId) return namespaceId;
  if (skill.id.startsWith("artifact-template-")) return "openai-templates";
  if (skill.id === "github" || skill.id.startsWith("gh-")) return "github";
  if (skill.id.includes("computer-use")) return "computer-use";
  return "other";
}

export function skillGroupLabel(groupId: string): string {
  const special = SPECIAL_LABELS[groupId];
  if (special) return special;
  return groupId
    .split("-")
    .filter(Boolean)
    .map((word) => word === "openai" ? "OpenAI" : word === "ui" ? "UI" : word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

export function groupSkills(
  skills: readonly SkillCapability[],
  selectedSkillIds: readonly string[],
): SkillGroup[] {
  const selected = new Set(selectedSkillIds);
  const grouped = new Map<string, SkillCapability[]>();
  for (const skill of skills) {
    const groupId = fallbackSkillGroupId(skill);
    const group = grouped.get(groupId) ?? [];
    group.push(skill);
    grouped.set(groupId, group);
  }
  return [...grouped.entries()]
    .map(([id, group]) => ({
      id,
      label: skillGroupLabel(id),
      skills: group.slice().sort((left, right) => left.label.localeCompare(right.label)),
      selectedCount: group.filter((skill) => selected.has(skill.id)).length,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

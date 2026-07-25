import { describe, expect, it } from "vitest";
import { fallbackSkillGroupId, groupSkills, skillGroupLabel } from "./skill-groups";

describe("skill groups", () => {
  const skills = [
    { id: "gh-fix-ci", label: "Fix CI", enabled: true, group: "github" },
    { id: "artifact-template-letterhead", label: "Letterhead", enabled: true, group: "openai-templates" },
    { id: "gh-address-comments", label: "Address comments", enabled: true, group: "github" },
  ] as const;

  it("groups and alphabetizes skills without changing their exact ids", () => {
    expect(groupSkills(skills, ["gh-fix-ci"])).toEqual([
      {
        id: "github",
        label: "GitHub",
        selectedCount: 1,
        skills: [skills[2], skills[0]],
      },
      {
        id: "openai-templates",
        label: "OpenAI Templates",
        selectedCount: 0,
        skills: [skills[1]],
      },
    ]);
  });

  it("keeps older bridges useful with bounded name-based fallbacks", () => {
    expect(fallbackSkillGroupId({ id: "github:github", label: "GitHub", enabled: true })).toBe("github");
    expect(fallbackSkillGroupId({ id: "artifact-template-report", label: "Report", enabled: true })).toBe("openai-templates");
    expect(fallbackSkillGroupId({ id: "custom-review", label: "Review", enabled: true })).toBe("other");
  });

  it("formats provider ids for the English interface", () => {
    expect(skillGroupLabel("computer-use")).toBe("Computer Use");
    expect(skillGroupLabel("openai-templates")).toBe("OpenAI Templates");
  });
});

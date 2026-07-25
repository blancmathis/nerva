import { describe, expect, it } from "vitest";
import { skillGroupId } from "../src/skill-groups.js";

describe("skill provider grouping", () => {
  it("projects the plugin identity without exposing its absolute path or version", () => {
    expect(skillGroupId({
      name: "artifact-template-project-kickoff",
      path: "/fixtures/home/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.0/skills/artifact-template-project-kickoff/SKILL.md",
    })).toBe("openai-templates");
    expect(skillGroupId({
      name: "computer-use",
      path: "/fixtures/home/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/computer-use/SKILL.md",
    })).toBe("computer-use");
  });

  it("separates system, personal and project skills", () => {
    expect(skillGroupId({
      name: "openai-docs",
      path: "/fixtures/home/.codex/skills/.system/openai-docs/SKILL.md",
    })).toBe("system");
    expect(skillGroupId({
      name: "documentation-excellence",
      path: "/fixtures/home/.codex/skills/documentation-excellence/SKILL.md",
    })).toBe("personal");
    expect(skillGroupId({
      name: "release-checklist",
      path: "/workspace/project/.agents/skills/release-checklist/SKILL.md",
    })).toBe("project");
  });

  it("uses a safe namespace fallback when plugin provenance is unavailable", () => {
    expect(skillGroupId({
      name: "github:github",
      path: "/skills/github/SKILL.md",
    })).toBe("github");
  });
});

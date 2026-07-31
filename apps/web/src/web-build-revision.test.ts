import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  configuredWebBuildRevision,
  E2E_FIXTURE_BUILD_MODE,
  E2E_FIXTURE_BUILD_REVISION,
} from "./web-build-revision";

const repositoryRoot = existsSync(resolve(process.cwd(), "scripts/build-revision.mjs"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("web build revision selection", () => {
  it("uses the deterministic revision only for the exact E2E fixture mode", () => {
    vi.stubEnv("CODEX_PAD_BUILD_REVISION", E2E_FIXTURE_BUILD_REVISION);

    expect(configuredWebBuildRevision("build", E2E_FIXTURE_BUILD_MODE, repositoryRoot))
      .toBe(E2E_FIXTURE_BUILD_REVISION);
    expect(configuredWebBuildRevision("build", "production", repositoryRoot))
      .not.toBe(E2E_FIXTURE_BUILD_REVISION);
    expect(configuredWebBuildRevision("build", `${E2E_FIXTURE_BUILD_MODE}-production`, repositoryRoot))
      .not.toBe(E2E_FIXTURE_BUILD_REVISION);
  });

  it("keeps the development server identity separate from fixture builds", () => {
    expect(configuredWebBuildRevision("serve", E2E_FIXTURE_BUILD_MODE, repositoryRoot)).toBe("development");
  });

  it("preserves non-fixture overrides for coordinated production builds", () => {
    const releaseRevision = "abcdef1234567890";
    vi.stubEnv("CODEX_PAD_BUILD_REVISION", releaseRevision);

    expect(configuredWebBuildRevision("build", "production", repositoryRoot)).toBe(releaseRevision);
  });
});

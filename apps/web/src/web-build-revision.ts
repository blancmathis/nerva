import { resolveBuildRevision } from "../../../scripts/build-revision.mjs";

export const E2E_FIXTURE_BUILD_MODE = "nerva-e2e-fixture";
export const E2E_FIXTURE_BUILD_REVISION = "0000000000000000";

export function configuredWebBuildRevision(
  command: string,
  mode: string,
  repositoryRoot: string,
  override = process.env.CODEX_PAD_BUILD_REVISION,
): string {
  if (command === "serve") return "development";
  if (mode === E2E_FIXTURE_BUILD_MODE) return E2E_FIXTURE_BUILD_REVISION;
  // The all-zero fixture sentinel is never a valid production identity, even
  // when it leaks through an inherited environment. Other explicit revisions
  // remain available for coordinated release builds.
  return resolveBuildRevision(
    repositoryRoot,
    override?.trim() === E2E_FIXTURE_BUILD_REVISION ? "" : override,
  );
}

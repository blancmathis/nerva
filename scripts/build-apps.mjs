import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveBuildRevision } from "./build-revision.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), "..");
const APP_BUILD_WORKSPACES = ["@codex-pad/web", "@codex-pad/bridge"];

export function runCoordinatedAppBuild({
  repositoryRoot,
  buildRevision,
  environment = process.env,
  run = spawnSync,
}) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const workspace of APP_BUILD_WORKSPACES) {
    const result = run(npmCommand, ["run", "build", "--workspace", workspace], {
      cwd: repositoryRoot,
      env: {
        ...environment,
        CODEX_PAD_BUILD_REVISION: buildRevision,
      },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${workspace} build failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status ?? "unknown"}`}.`);
    }
  }
}

export async function verifyBuiltRuntimeIdentity(repositoryRoot, expectedRevision) {
  const webMetadataPath = resolve(repositoryRoot, "apps/web/dist/app-meta.json");
  const bridgeIdentityPath = resolve(repositoryRoot, "apps/bridge/dist/runtime-identity.js");
  const webMetadata = JSON.parse(await readFile(webMetadataPath, "utf8"));
  const bridgeModule = await import(`${pathToFileURL(bridgeIdentityPath).href}?revision=${encodeURIComponent(expectedRevision)}`);
  const bridgeIdentity = bridgeModule.BRIDGE_RUNTIME_IDENTITY;

  if (webMetadata.buildRevision !== expectedRevision) {
    throw new Error(`Web build identity mismatch: expected ${expectedRevision}, received ${String(webMetadata.buildRevision)}.`);
  }
  if (bridgeIdentity?.buildRevision !== expectedRevision) {
    throw new Error(`Bridge build identity mismatch: expected ${expectedRevision}, received ${String(bridgeIdentity?.buildRevision)}.`);
  }
  if (webMetadata.apiContractVersion !== bridgeIdentity.apiContractVersion) {
    throw new Error(`API contract mismatch: web ${String(webMetadata.apiContractVersion)}, bridge ${String(bridgeIdentity.apiContractVersion)}.`);
  }
}

export async function buildApps(repositoryRoot = defaultRepositoryRoot) {
  const buildRevision = resolveBuildRevision(repositoryRoot);
  runCoordinatedAppBuild({ repositoryRoot, buildRevision });
  await verifyBuiltRuntimeIdentity(repositoryRoot, buildRevision);
  console.log(`Verified coordinated Nerva build identity ${buildRevision}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await buildApps();
}

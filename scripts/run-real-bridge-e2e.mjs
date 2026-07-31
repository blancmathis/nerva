import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveBuildRevision } from "./build-revision.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const buildRoot = await mkdtemp(join(tmpdir(), "nerva-real-bridge-build-"));
const webRoot = join(buildRoot, "web");
const buildRevision = resolveBuildRevision(repositoryRoot);

if (buildRevision === "development") {
  throw new Error("Could not derive an exact source identity for the real bridge harness");
}

const environment = {
  ...process.env,
  CODEX_PAD_BUILD_REVISION: buildRevision,
  CODEX_PAD_REAL_BRIDGE_WEB_ROOT: webRoot,
};

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        signal
          ? `${command} ${args.join(" ")} stopped by ${signal}`
          : `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
      ));
    });
  });
}

try {
  await run("npm", ["run", "build:packages"]);
  await run("npm", [
    "run",
    "build",
    "--workspace",
    "@codex-pad/web",
    "--",
    "--outDir",
    webRoot,
  ]);
  await run("npm", ["run", "build", "--workspace", "@codex-pad/bridge"]);
  await run("npm", [
    "exec",
    "--",
    "playwright",
    "test",
    "--config=playwright.real-bridge.config.ts",
    ...process.argv.slice(2),
  ]);
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

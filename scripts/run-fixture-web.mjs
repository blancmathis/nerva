import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const buildRoot = await mkdtemp(join(tmpdir(), "nerva-fixture-web-"));
const webRoot = join(buildRoot, "web");
const environment = {
  ...process.env,
  CODEX_PAD_FIXTURE_WEB_ROOT: webRoot,
};

let activeChild = null;
let requestedSignal = null;

function stop(signal) {
  requestedSignal = signal;
  activeChild?.kill(signal);
}

const onSigint = () => stop("SIGINT");
const onSigterm = () => stop("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

function run(command, arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0 || (requestedSignal !== null && signal === requestedSignal)) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        signal
          ? `${command} ${arguments_.join(" ")} stopped by ${signal}`
          : `${command} ${arguments_.join(" ")} exited with code ${code ?? "unknown"}`,
      ));
    });
  });
}

try {
  await run("npm", ["run", "build:packages"]);
  if (requestedSignal === null) {
    await run("npm", [
      "run",
      "build",
      "--workspace",
      "@codex-pad/web",
      "--",
      "--mode",
      "nerva-e2e-fixture",
      "--outDir",
      webRoot,
      "--emptyOutDir",
    ]);
  }
  if (requestedSignal === null) {
    await run("npm", ["exec", "--", "tsx", "apps/web/e2e/fixture-server.ts"]);
  }
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  activeChild?.kill("SIGTERM");
  await rm(buildRoot, { recursive: true, force: true });
}

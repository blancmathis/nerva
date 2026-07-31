#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredSourceTools = ["tsc", "tsup"];

async function defaultDependenciesReady(repositoryRoot) {
  try {
    await Promise.all(requiredSourceTools.map((tool) => access(
      join(repositoryRoot, "node_modules", ".bin", tool),
      fsConstants.X_OK,
    )));
    return true;
  } catch {
    return false;
  }
}

function defaultRunCommand(repositoryRoot, arguments_) {
  const npmCli = process.env.npm_execpath?.trim();
  const executable = npmCli ? process.execPath : "npm";
  const childArguments = npmCli
    ? [npmCli, "run", "codex-pad", "--", "setup-check", ...arguments_]
    : ["run", "codex-pad", "--", "setup-check", ...arguments_];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, childArguments, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Nerva setup check was interrupted by ${signal}.`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

function missingDependenciesReport() {
  return {
    installationState: "blocked",
    nativeIntegration: {
      state: "limited",
      reasons: [],
    },
    blockers: [{
      code: "source-dependencies-unavailable",
      detail: "This source checkout has not installed the npm dependencies required by setup:check.",
      remediation: ["Run `npm ci`, then rerun `npm run setup:check`."],
    }],
  };
}

export async function runSetupCheckFromSource(arguments_ = process.argv.slice(2), dependencies = {}) {
  const repositoryRoot = dependencies.repositoryRoot ?? defaultRepositoryRoot;
  const writeOut = dependencies.writeOut ?? ((message) => console.log(message));
  const dependenciesReady = dependencies.dependenciesReady ?? defaultDependenciesReady;
  if (!(await dependenciesReady(repositoryRoot))) {
    const report = missingDependenciesReport();
    if (arguments_.includes("--json")) {
      writeOut(JSON.stringify(report, null, 2));
    } else {
      writeOut([
        "Nerva setup check: BLOCKED",
        `- [${report.blockers[0].code}] ${report.blockers[0].detail}`,
        `  Next: ${report.blockers[0].remediation[0]}`,
      ].join("\n"));
    }
    return 1;
  }
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  return runCommand(repositoryRoot, arguments_);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await runSetupCheckFromSource();
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCoordinatedAppBuild, verifyBuiltRuntimeIdentity } from "./build-apps.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("passes one immutable revision to both application builds", () => {
  const calls = [];
  runCoordinatedAppBuild({
    repositoryRoot: "/safe/repository",
    buildRevision: "abcdef1",
    environment: { PATH: "/usr/bin" },
    run(command, arguments_, options) {
      calls.push({ command, arguments_, options });
      return { status: 0, signal: null };
    },
  });

  assert.deepEqual(calls.map((call) => call.arguments_.at(-1)), ["@codex-pad/web", "@codex-pad/bridge"]);
  assert.deepEqual(calls.map((call) => call.options.env.CODEX_PAD_BUILD_REVISION), ["abcdef1", "abcdef1"]);
  assert.ok(calls.every((call) => call.options.cwd === "/safe/repository"));
});

test("rejects output whose web and bridge identities differ", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "nerva-coordinated-build-"));
  temporaryDirectories.push(repositoryRoot);
  await mkdir(join(repositoryRoot, "apps/web/dist"), { recursive: true });
  await mkdir(join(repositoryRoot, "apps/bridge/dist"), { recursive: true });
  await writeFile(join(repositoryRoot, "apps/web/dist/app-meta.json"), JSON.stringify({
    buildRevision: "abcdef1",
    apiContractVersion: 1,
  }));
  await writeFile(join(repositoryRoot, "apps/bridge/dist/runtime-identity.js"), [
    "export const BRIDGE_RUNTIME_IDENTITY = {",
    "  buildRevision: '7654321',",
    "  apiContractVersion: 1,",
    "};",
  ].join("\n"));

  await assert.rejects(
    verifyBuiltRuntimeIdentity(repositoryRoot, "abcdef1"),
    /Bridge build identity mismatch/u,
  );
});

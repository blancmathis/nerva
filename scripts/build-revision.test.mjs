import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { resolveBuildRevision } from "./build-revision.mjs";

const repositories = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function git(repositoryRoot, ...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "nerva-build-revision-"));
  repositories.push(repositoryRoot);
  git(repositoryRoot, "init", "--quiet");
  git(repositoryRoot, "config", "user.name", "Nerva Tests");
  git(repositoryRoot, "config", "user.email", "nerva-tests@example.invalid");
  await writeFile(join(repositoryRoot, "tracked.txt"), "initial\n");
  git(repositoryRoot, "add", "tracked.txt");
  git(repositoryRoot, "commit", "--quiet", "-m", "baseline");
  return repositoryRoot;
}

test("uses the exact Git revision for a clean checkout", async () => {
  const repositoryRoot = await createRepository();

  assert.equal(resolveBuildRevision(repositoryRoot, ""), git(repositoryRoot, "rev-parse", "HEAD"));
});

test("keeps a stable dirty identity when a tracked file is deleted", async () => {
  const repositoryRoot = await createRepository();
  await unlink(join(repositoryRoot, "tracked.txt"));

  const first = resolveBuildRevision(repositoryRoot, "");
  const second = resolveBuildRevision(repositoryRoot, "");

  assert.match(first, /^[0-9a-f]{64}-dirty$/u);
  assert.equal(second, first);
  assert.notEqual(first, "development");
});

test("distinguishes modified and deleted working trees at the same commit", async () => {
  const repositoryRoot = await createRepository();
  await writeFile(join(repositoryRoot, "tracked.txt"), "modified\n");
  const modified = resolveBuildRevision(repositoryRoot, "");

  await unlink(join(repositoryRoot, "tracked.txt"));
  const deleted = resolveBuildRevision(repositoryRoot, "");

  assert.match(modified, /^[0-9a-f]{64}-dirty$/u);
  assert.match(deleted, /^[0-9a-f]{64}-dirty$/u);
  assert.notEqual(deleted, modified);
});

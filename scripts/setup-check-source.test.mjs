import assert from "node:assert/strict";
import test from "node:test";

import { runSetupCheckFromSource } from "./setup-check-source.mjs";

test("fresh source checkout reports the exact read-only dependency prerequisite", async () => {
  const output = [];
  let delegated = false;
  const code = await runSetupCheckFromSource([], {
    repositoryRoot: "/tmp/nerva-source-checkout",
    dependenciesReady: async () => false,
    runCommand: async () => {
      delegated = true;
      return 0;
    },
    writeOut: (message) => output.push(message),
  });

  assert.equal(code, 1);
  assert.equal(delegated, false);
  assert.deepEqual(output, [
    "Nerva setup check: BLOCKED\n"
      + "- [source-dependencies-unavailable] This source checkout has not installed the npm dependencies required by setup:check.\n"
      + "  Next: Run `npm ci`, then rerun `npm run setup:check`.",
  ]);
});

test("fresh source checkout emits the same prerequisite as structured JSON", async () => {
  const output = [];
  const code = await runSetupCheckFromSource(["--json"], {
    repositoryRoot: "/tmp/nerva-source-checkout",
    dependenciesReady: async () => false,
    writeOut: (message) => output.push(message),
  });

  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(output.join("\n")), {
    installationState: "blocked",
    nativeIntegration: { state: "limited", reasons: [] },
    blockers: [{
      code: "source-dependencies-unavailable",
      detail: "This source checkout has not installed the npm dependencies required by setup:check.",
      remediation: ["Run `npm ci`, then rerun `npm run setup:check`."],
    }],
  });
});

test("installed source checkout delegates arguments and preserves the CLI exit code", async () => {
  const calls = [];
  const code = await runSetupCheckFromSource(["--json"], {
    repositoryRoot: "/tmp/nerva-source-checkout",
    dependenciesReady: async () => true,
    runCommand: async (...arguments_) => {
      calls.push(arguments_);
      return 7;
    },
  });

  assert.equal(code, 7);
  assert.deepEqual(calls, [["/tmp/nerva-source-checkout", ["--json"]]]);
});

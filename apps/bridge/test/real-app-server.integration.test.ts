import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const enabled = process.env.CODEX_PAD_REAL_INTEGRATION === "1";
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const spikePath = fileURLToPath(new URL("../../../scripts/feasibility-spike.mjs", import.meta.url));

interface SpikeResult {
  readonly ok: boolean;
  readonly mode: string;
  readonly initialize: boolean;
  readonly threadResumeSameId: boolean;
  readonly startAcknowledged: boolean;
  readonly receivedExpectedReply: boolean;
  readonly liveDesktopCopresenceProven: boolean;
  readonly testThreadDeleted: boolean;
}

describe.skipIf(!enabled)("installed Codex app-server", () => {
  it("resumes one disposable thread and sends text plus localImage", async () => {
    const { stdout } = await execFileAsync(process.execPath, [spikePath], {
      cwd: repositoryRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 1_000_000,
      timeout: 150_000,
    });
    const result = JSON.parse(stdout) as SpikeResult;

    expect(result).toMatchObject({
      ok: true,
      mode: "isolated-test-thread",
      initialize: true,
      threadResumeSameId: true,
      startAcknowledged: true,
      receivedExpectedReply: true,
      liveDesktopCopresenceProven: false,
      testThreadDeleted: true,
    });
  }, 160_000);
});

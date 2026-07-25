#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const DEFAULT_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const EXPECTED_REPLY = "CODEX_PAD_IMAGE_OK_BLUE";
const TIMEOUT_MS = 120_000;

// A generated 1x1 blue PNG. It is intentionally tiny: the spike proves that
// app-server accepts and routes localImage input without retaining user data.
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==",
  "base64",
);

const codexBinary = process.env.CODEX_PAD_CODEX_BINARY || DEFAULT_CODEX;
const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-pad-spike-"));
const imagePath = join(temporaryRoot, "probe.png");
await chmod(temporaryRoot, 0o700);
await writeFile(imagePath, BLUE_PNG, { mode: 0o600 });

let child;
try {
  const result = await runSpike();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  child?.kill("SIGTERM");
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runSpike() {
  child = spawn(codexBinary, ["app-server"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = readline.createInterface({ input: child.stdout });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  let threadId = "";
  let seedTurnId = "";
  let turnId = "";
  let agentText = "";
  let resumeMatched = false;
  let startAcknowledged = false;
  let stage = "initialize";
  let cleanupTimer;
  let pendingFinal;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupAndFinish({ ...summary("timeout", false), stage });
    }, TIMEOUT_MS);

    const finish = (value) => {
      clearTimeout(timer);
      lines.close();
      child.kill("SIGTERM");
      resolve(value);
    };

    const cleanupAndFinish = (value) => {
      if (!threadId) {
        finish({ ...value, testThreadDeleted: true });
        return;
      }
      pendingFinal = value;
      stage = "thread/delete";
      send({ method: "thread/delete", id: 99, params: { threadId } });
      cleanupTimer = setTimeout(() => {
        finish({ ...value, testThreadDeleted: false });
      }, 5_000);
    };

    const summary = (turnStatus, completed) => ({
      ok:
        completed &&
        turnStatus === "completed" &&
        resumeMatched &&
        startAcknowledged &&
        agentText.includes(EXPECTED_REPLY),
      mode: "isolated-test-thread",
      initialize: true,
      threadResumeSameId: resumeMatched,
      threadSuffix: threadId.slice(-8),
      turnSuffix: turnId.slice(-8),
      turnStatus,
      startAcknowledged,
      receivedExpectedReply: agentText.includes(EXPECTED_REPLY),
      liveDesktopCopresenceProven: false,
    });

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 1 && message.result) {
        stage = "thread/start";
        send({ method: "initialized", params: {} });
        send({
          method: "thread/start",
          id: 2,
          params: {
            approvalPolicy: "never",
            cwd: temporaryRoot,
            developerInstructions:
              "Do not use tools. Answer only the exact token requested by the user.",
            ephemeral: false,
            sandbox: "read-only",
          },
        });
        return;
      }

      if (message.id === 2 && message.result?.thread?.id) {
        threadId = message.result.thread.id;
        stage = "seed-turn/start";
        send({
          method: "turn/start",
          id: 20,
          params: {
            threadId,
            input: [
              {
                type: "text",
                text: "Respond with exactly CODEX_PAD_SEED_READY and nothing else.",
                text_elements: [],
              },
            ],
          },
        });
        return;
      }

      if (message.id === 2 && message.error) {
        cleanupAndFinish({ ...summary("thread/start-error", false), stage, error: safeError(message) });
        return;
      }

      if (message.id === 3 && message.result?.thread?.id) {
        resumeMatched = message.result.thread.id === threadId;
        stage = "turn/start";
        send({
          method: "turn/start",
          id: 4,
          params: {
            threadId,
            input: [
              {
                type: "text",
                text: `Inspect the attached image. Respond with exactly ${EXPECTED_REPLY} and nothing else.`,
                text_elements: [],
              },
              { type: "localImage", path: imagePath },
            ],
          },
        });
        return;
      }

      if (message.id === 20 && message.result?.turn?.id) {
        seedTurnId = message.result.turn.id;
        stage = "seed-turn/completed";
        return;
      }

      if (message.id === 20 && message.error) {
        cleanupAndFinish({ ...summary("seed-turn-error", false), stage, error: safeError(message) });
        return;
      }

      if (message.id === 3 && message.error) {
        cleanupAndFinish({ ...summary("thread/resume-error", false), stage, error: safeError(message) });
        return;
      }

      if (message.id === 4) {
        if (message.error) {
          cleanupAndFinish({
            ...summary("turn/start-error", false),
            error: {
              code: message.error.code,
              message: message.error.message,
            },
          });
          return;
        }
        startAcknowledged = true;
        turnId = message.result?.turn?.id || "";
        stage = "turn/completed";
        return;
      }

      if (message.method === "item/agentMessage/delta") {
        agentText += message.params?.delta || "";
        return;
      }

      if (
        message.method === "item/completed" &&
        message.params?.item?.type === "agentMessage"
      ) {
        agentText +=
          message.params.item.text || message.params.item.content || "";
        return;
      }

      if (message.method === "turn/completed") {
        if (message.params?.turn?.id === seedTurnId) {
          stage = "thread/resume";
          send({ method: "thread/resume", id: 3, params: { threadId } });
          return;
        }
        cleanupAndFinish(summary(message.params?.turn?.status || "unknown", true));
        return;
      }

      if (message.id === 99 && pendingFinal) {
        clearTimeout(cleanupTimer);
        finish({
          ...pendingFinal,
          testThreadDeleted: !message.error,
        });
      }
    });

    child.once("error", reject);
    child.stderr.on("data", () => {
      // App-server diagnostics may include local paths. The spike deliberately
      // keeps them out of normal output and reports typed protocol errors only.
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "codex_pad_feasibility",
          title: "Codex Pad Feasibility",
          version: "0.1.0",
        },
      },
    });
  });
}

function safeError(message) {
  return {
    code: message.error?.code,
    message: message.error?.message,
  };
}

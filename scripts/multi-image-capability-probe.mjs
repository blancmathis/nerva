#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import readline from "node:readline";
import { deflateSync } from "node:zlib";
import {
  canonicalImageInputAttestationPath,
  invalidateCanonicalImageInputAttestation,
  writeCanonicalImageInputAttestation,
} from "./multi-image-attestation-store.mjs";

const DEFAULT_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
const PROBE = "runtime-disposable-thread-bounded-multi-local-image";
const MAX_START_IMAGES = 12;
const TOTAL_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 120_000;
const DELETE_TIMEOUT_MS = 10_000;
const SAFE_TURN_ITEM_TYPES = new Set([
  "agentMessage",
  "contextCompaction",
  "plan",
  "reasoning",
  "userMessage",
]);

class ProbeError extends Error {
  constructor(code, stage) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
    this.stage = stage;
  }
}

async function main(parsedOptions) {
  const abortController = new AbortController();
  const onSignal = () => abortController.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let stage = "preflight";
  let temporaryRoot = null;
  let rpc = null;
  let threadId = null;
  let threadStartOutcome = null;
  let workingDirectory = null;
  let serverUserAgent = null;
  let singleImageStartVerified = false;
  let multiImageStartVerified = false;
  let disposableThreadDeleted = false;
  let attestationWritten = false;
  let failure = null;
  let codexBinaryPath = null;

  try {
    stage = "preflight";
    validateRuntime();
    validateRequiredOptions(parsedOptions);
    codexBinaryPath = await resolveCodexBinary(parsedOptions.codexBinary);

    // Writing is opt-in. Only after all non-mutating preflight validation may
    // the fixed current-user record be invalidated. Unsafe or malformed prior
    // evidence is never followed, replaced, or removed automatically.
    if (parsedOptions.writeAttestation) {
      stage = "attestation-invalidate";
      try {
        await invalidateCanonicalImageInputAttestation();
      } catch {
        throw new ProbeError("ATTESTATION_INVALIDATION_FAILED", stage);
      }
    }

    stage = "temporary-inputs";
    temporaryRoot = await mkdtemp(join(tmpdir(), "codex-pad-image-probe-"));
    await chmod(temporaryRoot, 0o700);
    workingDirectory = join(temporaryRoot, "workspace");
    const inputDirectory = join(temporaryRoot, "inputs");
    await mkdir(workingDirectory, { mode: 0o700 });
    await mkdir(inputDirectory, { mode: 0o700 });
    const imagePaths = await createProbeImages(inputDirectory);

    stage = "app-server-start";
    rpc = new AppServerRpc(codexBinaryPath, workingDirectory);

    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    stage = "initialize";
    const initializeResult = await rpc.request(
      "initialize",
      {
        clientInfo: {
          name: "codex_pad_multi_image_probe",
          title: "Codex Pad Multi-image Capability Probe",
          version: "1.0.0",
        },
      },
      boundedTimeout(deadline, REQUEST_TIMEOUT_MS),
      abortController.signal,
    );
    serverUserAgent = requireServerUserAgent(initializeResult);
    rpc.notify("initialized");

    stage = "thread-start";
    threadStartOutcome = rpc.request(
      "thread/start",
      {
        approvalPolicy: "never",
        cwd: workingDirectory,
        developerInstructions:
          "This is a disposable image-input capability probe. Do not use tools. " +
          "Inspect only the attached generated images and answer exactly as requested.",
        ephemeral: false,
        sandbox: "read-only",
      },
      boundedTimeout(deadline, REQUEST_TIMEOUT_MS + DELETE_TIMEOUT_MS),
      undefined,
    ).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );
    const threadStart = await waitForTrackedOutcome(
      threadStartOutcome,
      boundedTimeout(deadline, REQUEST_TIMEOUT_MS),
      "thread/start",
    );
    if (!threadStart.ok) throw threadStart.error;
    const threadResult = threadStart.result;
    threadId = requireThreadId(threadResult);

    stage = "single-image-turn";
    const singleReply = `CODEX_PAD_SINGLE_IMAGE_${imagePaths.single.label}_OK`;
    await runImageTurn({
      rpc,
      threadId,
      text:
        "Read the large two-digit label in the attached generated image. Respond as " +
        "CODEX_PAD_SINGLE_IMAGE_NN_OK, replacing NN with the observed label, and output " +
        "nothing else.",
      imagePaths: [imagePaths.single.path],
      expectedReply: singleReply,
      deadline,
      signal: abortController.signal,
    });
    singleImageStartVerified = true;

    stage = "multi-image-turn";
    const multiReply =
      `CODEX_PAD_MULTI_IMAGE_ORDER_${imagePaths.ordered.labels.join("_")}_OK`;
    await runImageTurn({
      rpc,
      threadId,
      text:
        "Read the large two-digit label in each of the twelve attached generated images, " +
        "preserving attachment order. Respond as " +
        "CODEX_PAD_MULTI_IMAGE_ORDER_NN_NN_NN_NN_NN_NN_NN_NN_NN_NN_NN_NN_OK, " +
        "replacing each NN with the corresponding observed label, and output nothing else.",
      imagePaths: imagePaths.ordered.paths,
      expectedReply: multiReply,
      deadline,
      signal: abortController.signal,
    });
    multiImageStartVerified = true;
  } catch (error) {
    failure = privacySafeFailure(error, stage);
  } finally {
    if (
      threadId === null &&
      threadStartOutcome !== null &&
      rpc !== null &&
      workingDirectory !== null
    ) {
      // Never retry thread/start. Reconcile only the original request so a
      // late acknowledgement cannot silently orphan its non-ephemeral thread.
      const lateStart = await waitForTrackedOutcome(
        threadStartOutcome,
        DELETE_TIMEOUT_MS,
        "thread/start-cleanup",
      ).catch(() => null);
      if (lateStart?.ok === true) {
        try {
          threadId = requireThreadId(lateStart.result);
        } catch {
          threadId = null;
        }
      }
      if (threadId === null) {
        threadId = await findUniqueProbeThread(rpc, workingDirectory).catch(() => null);
      }
    }

    if (threadId !== null && rpc !== null) {
      stage = "thread-delete";
      try {
        await rpc.request(
          "thread/delete",
          { threadId },
          DELETE_TIMEOUT_MS,
          undefined,
        );
        disposableThreadDeleted = true;
      } catch {
        disposableThreadDeleted = false;
        if (failure === null) {
          failure = { code: "THREAD_DELETE_UNCONFIRMED", stage: "thread-delete" };
        }
      }
    }

    if (rpc !== null) {
      try {
        await rpc.close();
      } catch {
        if (failure === null) {
          failure = { code: "APP_SERVER_CLEANUP_FAILED", stage: "app-server-cleanup" };
        }
      }
    }

    if (temporaryRoot !== null) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch {
        if (failure === null) {
          failure = { code: "TEMPORARY_INPUT_CLEANUP_FAILED", stage: "temporary-cleanup" };
        }
      }
    }

  }

  const probeSucceeded =
    failure === null &&
    singleImageStartVerified &&
    multiImageStartVerified &&
    disposableThreadDeleted &&
    typeof serverUserAgent === "string" &&
    codexBinaryPath !== null;

  if (probeSucceeded && parsedOptions.writeAttestation) {
    stage = "attestation-write";
    try {
      const attestation = {
        version: 1,
        codexBinaryPath,
        codexVersion: parsedOptions.codexVersion,
        schemaSha256: parsedOptions.schemaSha256.toLowerCase(),
        serverUserAgent,
        verifiedAt: new Date().toISOString(),
        probe: PROBE,
        singleImageStartVerified: true,
        maxStartImages: MAX_START_IMAGES,
        maxSteerImages: 0,
        disposableThreadDeleted: true,
      };
      await writeCanonicalImageInputAttestation(attestation);
      attestationWritten = true;
    } catch (error) {
      failure = privacySafeFailure(error, stage);
    }
  }

  const ok = probeSucceeded && failure === null &&
    (!parsedOptions.writeAttestation || attestationWritten);

  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);

  return {
    ok,
    probe: PROBE,
    singleImageStartVerified,
    orderedMultiImageStartVerified: multiImageStartVerified,
    maxStartImages: multiImageStartVerified ? MAX_START_IMAGES : 0,
    maxSteerImages: 0,
    disposableThreadDeleted,
    attestationRequested: parsedOptions.writeAttestation,
    attestationWritten,
    ...(failure === null ? {} : { failure }),
  };
}

async function runImageTurn({
  rpc,
  threadId,
  text,
  imagePaths,
  expectedReply,
  deadline,
  signal,
}) {
  const capture = rpc.beginAgentCapture(threadId);
  try {
    const result = await rpc.request(
      "turn/start",
      {
        threadId,
        input: [
          { type: "text", text, text_elements: [] },
          ...imagePaths.map((path) => ({ type: "localImage", path })),
        ],
      },
      boundedTimeout(deadline, REQUEST_TIMEOUT_MS),
      signal,
    );
    const turnId = requireTurnId(result);
    capture.setTurnId(turnId);
    const completion = await rpc.waitForTurnCompleted(
      threadId,
      turnId,
      boundedTimeout(deadline, TURN_TIMEOUT_MS),
      signal,
    );
    if (completion?.turn?.status !== "completed") {
      throw new ProbeError("TURN_NOT_COMPLETED", "turn-completed");
    }
    if (!capture.toolFree()) {
      throw new ProbeError("TOOL_ACTIVITY_DETECTED", "turn-response");
    }
    if (capture.text().trim() !== expectedReply) {
      throw new ProbeError("UNEXPECTED_MODEL_REPLY", "turn-response");
    }
  } finally {
    capture.stop();
  }
}

class AppServerRpc {
  constructor(binaryPath, cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.completedTurns = new Map();
    this.turnWaiters = new Map();
    this.activeCapture = null;
    this.closed = false;

    this.child = spawn(binaryPath, ["app-server"], {
      cwd,
      env: { ...process.env, TMPDIR: cwd },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stdin.on("error", () => this.failAll("APP_SERVER_WRITE_FAILED"));
    this.child.stderr.on("data", () => {
      // Diagnostics can contain private local paths. Deliberately discard them.
    });
    this.child.once("error", () => this.failAll("APP_SERVER_START_FAILED"));
    this.child.once("exit", () => this.failAll("APP_SERVER_EXITED"));
  }

  request(method, params, timeoutMs, signal) {
    if (this.closed) {
      return Promise.reject(new ProbeError("APP_SERVER_CLOSED", method));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      let abortListener = null;
      const settle = (callback, value) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (abortListener !== null && signal !== undefined) {
          signal.removeEventListener("abort", abortListener);
        }
        callback(value);
      };
      const timer = setTimeout(() => {
        settle(rejectPromise, new ProbeError("APP_SERVER_REQUEST_TIMEOUT", method));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: (value) => settle(resolvePromise, value),
        reject: (error) => settle(rejectPromise, error),
        stage: method,
      });
      if (signal !== undefined) {
        abortListener = () => {
          settle(rejectPromise, new ProbeError("PROBE_INTERRUPTED", method));
        };
        if (signal.aborted) {
          abortListener();
          return;
        }
        signal.addEventListener("abort", abortListener, { once: true });
      }
      try {
        this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      } catch {
        settle(rejectPromise, new ProbeError("APP_SERVER_WRITE_FAILED", method));
      }
    });
  }

  notify(method) {
    if (this.closed) throw new ProbeError("APP_SERVER_CLOSED", method);
    try {
      this.child.stdin.write(`${JSON.stringify({ method })}\n`);
    } catch {
      throw new ProbeError("APP_SERVER_WRITE_FAILED", method);
    }
  }

  beginAgentCapture(threadId) {
    if (this.activeCapture !== null) {
      throw new ProbeError("CAPTURE_ALREADY_ACTIVE", "turn-response");
    }
    const state = {
      threadId,
      turnId: null,
      delta: "",
      finalMessages: [],
      toolFree: true,
    };
    this.activeCapture = state;
    return {
      setTurnId: (turnId) => {
        state.turnId = turnId;
      },
      text: () => state.finalMessages.length > 0
        ? state.finalMessages.join("\n")
        : state.delta,
      toolFree: () => state.toolFree,
      stop: () => {
        if (this.activeCapture === state) this.activeCapture = null;
      },
    };
  }

  waitForTurnCompleted(threadId, turnId, timeoutMs, signal) {
    const key = turnKey(threadId, turnId);
    if (this.completedTurns.has(key)) {
      const completion = this.completedTurns.get(key);
      this.completedTurns.delete(key);
      return Promise.resolve(completion);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      let abortListener = null;
      const settle = (callback, value) => {
        const waiter = this.turnWaiters.get(key);
        if (waiter === undefined) return;
        this.turnWaiters.delete(key);
        clearTimeout(waiter.timer);
        if (abortListener !== null && signal !== undefined) {
          signal.removeEventListener("abort", abortListener);
        }
        callback(value);
      };
      const timer = setTimeout(() => {
        settle(rejectPromise, new ProbeError("TURN_COMPLETION_TIMEOUT", "turn-completed"));
      }, timeoutMs);
      this.turnWaiters.set(key, {
        timer,
        resolve: (value) => settle(resolvePromise, value),
        reject: (error) => settle(rejectPromise, error),
      });
      if (signal !== undefined) {
        abortListener = () => {
          settle(rejectPromise, new ProbeError("PROBE_INTERRUPTED", "turn-completed"));
        };
        if (signal.aborted) {
          abortListener();
          return;
        }
        signal.addEventListener("abort", abortListener, { once: true });
      }
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll("APP_SERVER_PROTOCOL_ERROR");
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.failAll("APP_SERVER_PROTOCOL_ERROR");
      return;
    }

    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      if (message.error !== undefined) {
        pending.reject(new ProbeError("APP_SERVER_RPC_ERROR", pending.stage));
      } else if (Object.hasOwn(message, "result")) {
        pending.resolve(message.result);
      } else {
        pending.reject(new ProbeError("APP_SERVER_PROTOCOL_ERROR", pending.stage));
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if (Object.hasOwn(message, "id")) {
      this.markUnsafeTurnActivity();
      try {
        this.child.stdin.write(`${JSON.stringify({
          id: message.id,
          error: { code: -32_601, message: "Probe refuses server requests." },
        })}\n`);
      } catch {
        this.failAll("APP_SERVER_WRITE_FAILED");
      }
      return;
    }
    this.detectUnsafeTurnActivity(message);
    this.captureAgentText(message);
    if (message.method !== "turn/completed") return;

    const threadId = message.params?.threadId;
    const turnId = message.params?.turn?.id;
    if (typeof threadId !== "string" || typeof turnId !== "string") return;
    const key = turnKey(threadId, turnId);
    const waiter = this.turnWaiters.get(key);
    if (waiter !== undefined) {
      waiter.resolve(message.params);
    } else {
      this.completedTurns.set(key, message.params);
    }
  }

  captureAgentText(message) {
    const capture = this.activeCapture;
    if (capture === null) return;
    const params = message.params;
    if (params === null || typeof params !== "object") return;
    if (typeof params.threadId === "string" && params.threadId !== capture.threadId) return;
    const notificationTurnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : null;
    if (
      capture.turnId !== null &&
      notificationTurnId !== null &&
      notificationTurnId !== capture.turnId
    ) {
      return;
    }

    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      capture.delta += params.delta;
      return;
    }
    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const text = extractAgentMessageText(params.item);
      if (text !== "") capture.finalMessages.push(text);
    }
  }

  detectUnsafeTurnActivity(message) {
    if (this.activeCapture === null) return;
    if (/command|tool|fileChange|webSearch|imageView|computer|browser|mcp/iu.test(message.method)) {
      this.markUnsafeTurnActivity();
      return;
    }
    if (message.method !== "item/started" && message.method !== "item/completed") return;
    const itemType = message.params?.item?.type;
    if (typeof itemType !== "string" || !SAFE_TURN_ITEM_TYPES.has(itemType)) {
      this.markUnsafeTurnActivity();
    }
  }

  markUnsafeTurnActivity() {
    if (this.activeCapture !== null) this.activeCapture.toolFree = false;
  }

  failAll(code) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new ProbeError(code, pending.stage));
    }
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new ProbeError(code, "turn-completed"));
    }
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new ProbeError("APP_SERVER_CLOSED", pending.stage));
      }
      for (const waiter of this.turnWaiters.values()) {
        waiter.reject(new ProbeError("APP_SERVER_CLOSED", "turn-completed"));
      }
    }
    this.lines.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    const exited = new Promise((resolvePromise) => {
      this.child.once("exit", resolvePromise);
    });
    this.child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
    ]);
    if (!graceful && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
      ]);
    }
  }
}

function parseArguments(arguments_) {
  const parsed = {
    acknowledgeDisposableThread: false,
    writeAttestation: false,
    codexBinary: process.env.CODEX_PAD_CODEX_BINARY || DEFAULT_CODEX_BINARY,
    codexVersion: process.env.CODEX_PAD_CODEX_VERSION || "",
    schemaSha256: process.env.CODEX_PAD_SCHEMA_SHA256 || "",
    help: false,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--acknowledge-disposable-thread") {
      parsed.acknowledgeDisposableThread = true;
    } else if (argument === "--write-attestation") {
      parsed.writeAttestation = true;
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--codex-binary") {
      parsed.codexBinary = requireArgumentValue(arguments_, ++index, argument);
    } else if (argument.startsWith("--codex-binary=")) {
      parsed.codexBinary = argument.slice("--codex-binary=".length);
    } else if (argument === "--codex-version") {
      parsed.codexVersion = requireArgumentValue(arguments_, ++index, argument);
    } else if (argument.startsWith("--codex-version=")) {
      parsed.codexVersion = argument.slice("--codex-version=".length);
    } else if (argument === "--schema-sha256") {
      parsed.schemaSha256 = requireArgumentValue(arguments_, ++index, argument);
    } else if (argument.startsWith("--schema-sha256=")) {
      parsed.schemaSha256 = argument.slice("--schema-sha256=".length);
    } else {
      throw new ProbeError("UNKNOWN_ARGUMENT", "arguments");
    }
  }
  return parsed;
}

function requireArgumentValue(arguments_, index, flag) {
  const value = arguments_[index];
  if (typeof value !== "string" || value === "" || value.startsWith("--")) {
    throw new ProbeError("MISSING_ARGUMENT_VALUE", flag);
  }
  return value;
}

function validateRuntime() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new ProbeError("NODE_22_REQUIRED", "preflight");
  }
}

function validateRequiredOptions(parsedOptions) {
  if (!parsedOptions.acknowledgeDisposableThread) {
    throw new ProbeError("DISPOSABLE_THREAD_ACKNOWLEDGEMENT_REQUIRED", "preflight");
  }
  if (
    typeof parsedOptions.codexVersion !== "string" ||
    parsedOptions.codexVersion.length === 0 ||
    parsedOptions.codexVersion.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(parsedOptions.codexVersion)
  ) {
    throw new ProbeError("CODEX_VERSION_REQUIRED", "preflight");
  }
  if (!/^[a-f0-9]{64}$/iu.test(parsedOptions.schemaSha256)) {
    throw new ProbeError("SCHEMA_SHA256_REQUIRED", "preflight");
  }
}

async function resolveCodexBinary(configuredPath) {
  if (
    typeof configuredPath !== "string" ||
    configuredPath.length === 0 ||
    configuredPath.includes("\0")
  ) {
    throw new ProbeError("CODEX_BINARY_UNAVAILABLE", "preflight");
  }
  const absolutePath = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
  try {
    const canonicalPath = await realpath(absolutePath);
    await access(canonicalPath, fsConstants.X_OK);
    return canonicalPath;
  } catch {
    throw new ProbeError("CODEX_BINARY_UNAVAILABLE", "preflight");
  }
}

function requireServerUserAgent(result) {
  const userAgent = result?.userAgent;
  if (
    typeof userAgent !== "string" ||
    userAgent.length === 0 ||
    userAgent.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(userAgent)
  ) {
    throw new ProbeError("INVALID_SERVER_USER_AGENT", "initialize");
  }
  return userAgent;
}

function requireThreadId(result) {
  const threadId = result?.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new ProbeError("INVALID_THREAD_START_RESPONSE", "thread-start");
  }
  return threadId;
}

function requireTurnId(result) {
  const turnId = result?.turn?.id;
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new ProbeError("INVALID_TURN_START_RESPONSE", "turn-start");
  }
  return turnId;
}

function boundedTimeout(deadline, maximum) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProbeError("PROBE_TIMEOUT", "deadline");
  return Math.max(1, Math.min(remaining, maximum));
}

async function waitForTrackedOutcome(outcomePromise, timeoutMs, stage) {
  let timer;
  try {
    return await Promise.race([
      outcomePromise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => {
          rejectPromise(new ProbeError("APP_SERVER_REQUEST_TIMEOUT", stage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function findUniqueProbeThread(rpc, workingDirectory) {
  const response = await rpc.request(
    "thread/list",
    {
      limit: 20,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    },
    DELETE_TIMEOUT_MS,
    undefined,
  );
  if (!Array.isArray(response?.data)) return null;
  const matches = response.data.filter((thread) =>
    thread !== null &&
    typeof thread === "object" &&
    thread.cwd === workingDirectory &&
    typeof thread.id === "string" &&
    thread.id.length > 0
  );
  return matches.length === 1 ? matches[0].id : null;
}

function privacySafeFailure(error, fallbackStage) {
  if (error instanceof ProbeError) {
    return { code: error.code, stage: error.stage || fallbackStage };
  }
  if (
    error !== null &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,64}$/u.test(error.code)
  ) {
    return { code: `SYSTEM_${error.code}`, stage: fallbackStage };
  }
  if (error instanceof TypeError) {
    return { code: "INTERNAL_TYPE_ERROR", stage: fallbackStage };
  }
  if (error instanceof RangeError) {
    return { code: "INTERNAL_RANGE_ERROR", stage: fallbackStage };
  }
  if (error instanceof ReferenceError) {
    return { code: "INTERNAL_REFERENCE_ERROR", stage: fallbackStage };
  }
  return { code: "INTERNAL_ERROR", stage: fallbackStage };
}

function argumentFailure(error) {
  return baseFailure(privacySafeFailure(error, "arguments"), false);
}

function baseFailure(failure, attestationRequested) {
  return {
    ok: false,
    probe: PROBE,
    singleImageStartVerified: false,
    orderedMultiImageStartVerified: false,
    maxStartImages: 0,
    maxSteerImages: 0,
    disposableThreadDeleted: false,
    attestationRequested,
    attestationWritten: false,
    failure,
  };
}

async function createProbeImages(temporaryRoot) {
  const labels = shuffledTwoDigitLabels(MAX_START_IMAGES + 1);
  const singleLabel = labels[0];
  const orderedLabels = labels.slice(1);
  const singlePath = join(temporaryRoot, "single.png");
  await writeFile(singlePath, createNumberPng(singleLabel, 12), { mode: 0o600 });

  const orderedPaths = [];
  for (let index = 0; index < orderedLabels.length; index += 1) {
    const label = orderedLabels[index];
    const path = join(temporaryRoot, `ordered-frame-${String(index + 1).padStart(2, "0")}.png`);
    await writeFile(path, createNumberPng(label, index), { mode: 0o600 });
    orderedPaths.push(path);
  }
  return {
    single: { path: singlePath, label: singleLabel },
    ordered: { paths: orderedPaths, labels: orderedLabels },
  };
}

function shuffledTwoDigitLabels(count) {
  const labels = Array.from({ length: 90 }, (_, index) => String(index + 10));
  for (let index = labels.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [labels[index], labels[swapIndex]] = [labels[swapIndex], labels[index]];
  }
  return labels.slice(0, count);
}

const PALETTE = [
  [181, 49, 53],
  [35, 117, 80],
  [40, 84, 148],
  [190, 133, 24],
  [30, 128, 143],
  [139, 67, 148],
  [204, 92, 36],
  [75, 63, 145],
  [61, 68, 76],
  [139, 116, 79],
  [70, 132, 57],
  [154, 55, 94],
  [23, 110, 120],
];

const DIGIT_SEGMENTS = {
  0: ["a", "b", "c", "d", "e", "f"],
  1: ["b", "c"],
  2: ["a", "b", "g", "e", "d"],
  3: ["a", "b", "c", "d", "g"],
  4: ["f", "g", "b", "c"],
  5: ["a", "f", "g", "c", "d"],
  6: ["a", "f", "g", "e", "c", "d"],
  7: ["a", "b", "c"],
  8: ["a", "b", "c", "d", "e", "f", "g"],
  9: ["a", "b", "c", "d", "f", "g"],
};

function createNumberPng(label, paletteIndex) {
  const width = 160;
  const height = 96;
  const pixels = Buffer.alloc(width * height * 4);
  const background = PALETTE[paletteIndex % PALETTE.length];
  fillRect(pixels, width, height, 0, 0, width, height, [...background, 255]);
  fillRect(pixels, width, height, 8, 8, width - 16, height - 16, [248, 246, 239, 255]);
  drawDigit(pixels, width, height, 29, 14, Number(label[0]));
  drawDigit(pixels, width, height, 87, 14, Number(label[1]));
  return encodePng(width, height, pixels);
}

function drawDigit(pixels, width, height, x, y, digit) {
  const segmentRects = {
    a: [x + 7, y, 32, 7],
    b: [x + 39, y + 7, 7, 25],
    c: [x + 39, y + 39, 7, 25],
    d: [x + 7, y + 64, 32, 7],
    e: [x, y + 39, 7, 25],
    f: [x, y + 7, 7, 25],
    g: [x + 7, y + 32, 32, 7],
  };
  for (const segment of DIGIT_SEGMENTS[digit]) {
    fillRect(pixels, width, height, ...segmentRects[segment], [24, 29, 35, 255]);
  }
}

function fillRect(pixels, width, height, x, y, rectangleWidth, rectangleHeight, rgba) {
  const maxX = Math.min(width, x + rectangleWidth);
  const maxY = Math.min(height, y + rectangleHeight);
  for (let row = Math.max(0, y); row < maxY; row += 1) {
    for (let column = Math.max(0, x); column < maxX; column += 1) {
      const offset = (row * width + column) * 4;
      pixels[offset] = rgba[0];
      pixels[offset + 1] = rgba[1];
      pixels[offset + 2] = rgba[2];
      pixels[offset + 3] = rgba[3];
    }
  }
}

function encodePng(width, height, pixels) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const destination = row * (width * 4 + 1);
    scanlines[destination] = 0;
    pixels.copy(scanlines, destination + 1, row * width * 4, (row + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractAgentMessageText(item) {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function turnKey(threadId, turnId) {
  return `${threadId}\u0000${turnId}`;
}

function usage() {
  return [
    "Usage: node scripts/multi-image-capability-probe.mjs \\",
    "  --acknowledge-disposable-thread \\",
    "  --codex-version <version> \\",
    "  --schema-sha256 <64-hex-digest> [options]",
    "",
    "Options:",
    "  --codex-binary <absolute-path>  Codex binary (or CODEX_PAD_CODEX_BINARY).",
    "  --write-attestation             Persist a private attestation after deletion.",
    "  --help                          Show this help without running the probe.",
    "",
    "Environment:",
    "  CODEX_PAD_CODEX_VERSION, CODEX_PAD_SCHEMA_SHA256,",
    "  CODEX_PAD_CODEX_BINARY",
    "",
    `Attestation: ${canonicalImageInputAttestationPath()} (fixed; no path override)`,
  ].join("\n");
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  const result = argumentFailure(error);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
}

if (options !== undefined) {
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    let result;
    try {
      result = await main(options);
    } catch (error) {
      result = baseFailure(privacySafeFailure(error, "startup"), options.writeAttestation);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}

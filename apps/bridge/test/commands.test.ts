import type { DesktopProcessIdentity } from "@codex-pad/codex-desktop";
import type { Command } from "@codex-pad/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ProtocolCommandExecutor,
  type ProtocolCommandExecutorOptions,
} from "../src/commands.js";
import { createExactTargetAuthorityDomain } from "../src/exact-target-authority.js";
import { IdempotencyLedger } from "../src/idempotency.js";
import { defaultDataPaths } from "../src/paths.js";
import type { SessionsService } from "../src/sessions.js";
import type { BridgeStateService } from "../src/state.js";
import type { ThreadTransport } from "../src/thread-transport.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const CREATED_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 42,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/Codex.app",
  executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  bundleId: "com.openai.codex",
};
const TEST_TARGET_AUTHORITY_DOMAIN = createExactTargetAuthorityDomain();

function testTargetAuthority() {
  return TEST_TARGET_AUTHORITY_DOMAIN.stateIssuer.issue(() => undefined);
}

function fixture(overrides: {
  sendSketch?: ThreadTransport["sendSketch"];
  sendReview?: ThreadTransport["sendReview"];
  startTurn?: ThreadTransport["startTurn"];
  selectThread?: ThreadTransport["selectThread"];
  runLibraryCommand?: ThreadTransport["runLibraryCommand"];
  invokeSkill?: ThreadTransport["invokeSkill"];
  approve?: ThreadTransport["approve"];
  reject?: ThreadTransport["reject"];
  openCreatedThread?: SessionsService["openCreatedThread"];
  refresh?: BridgeStateService["refresh"];
  assertExactTarget?: BridgeStateService["assertExactTarget"];
  revalidateExactTarget?: BridgeStateService["revalidateExactTarget"];
  invokeActionSlot?: BridgeStateService["invokeActionSlot"];
  attachImageToComposer?: BridgeStateService["attachImageToComposer"];
  assertSnapshotIdentity?: BridgeStateService["assertSnapshotIdentity"];
  current?: BridgeStateService["current"];
  normalizeSketch?: ProtocolCommandExecutorOptions["normalizeSketch"];
  normalizeReview?: ProtocolCommandExecutorOptions["normalizeReview"];
} = {}) {
  const state = {
    assertExactTarget: overrides.assertExactTarget ?? vi.fn(() => ({ slot: 0 }) as never),
    revalidateExactTarget: overrides.revalidateExactTarget
      ?? vi.fn(async () => testTargetAuthority()),
    assertSnapshotIdentity: overrides.assertSnapshotIdentity ?? vi.fn(),
    assertSequence: vi.fn(),
    current: overrides.current ?? vi.fn(() => ({
      bridgeInstanceId: BRIDGE_INSTANCE_ID,
      sequence: 12,
      pendingApprovals: [],
    }) as never),
    refresh: overrides.refresh ?? vi.fn(async () => ({ sequence: 13 })),
    invokeActionSlot: overrides.invokeActionSlot ?? vi.fn(async () => ({ sequence: 13 })),
    attachImageToComposer: overrides.attachImageToComposer ?? vi.fn(async () => ({ sequence: 13 })),
  } as unknown as BridgeStateService;
  const transport = {
    selectThread: overrides.selectThread ?? vi.fn(async () => undefined),
    sendSketch: overrides.sendSketch ?? vi.fn(async () => undefined),
    sendReview: overrides.sendReview ?? vi.fn(async () => undefined),
    runLibraryCommand: overrides.runLibraryCommand ?? vi.fn(async () => undefined),
    invokeSkill: overrides.invokeSkill ?? vi.fn(async () => undefined),
    approve: overrides.approve ?? vi.fn(async () => undefined),
    reject: overrides.reject ?? vi.fn(async () => undefined),
    newThread: vi.fn(async () => ({ threadId: CREATED_THREAD_ID })),
    startTurn: overrides.startTurn ?? vi.fn(async () => undefined),
  } as unknown as ThreadTransport;
  const sessions = {
    openCreatedThread: overrides.openCreatedThread ?? vi.fn(async () => undefined),
  } as unknown as SessionsService;
  const warn = vi.fn();
  const cleanup = vi.fn(async () => {
    throw new Error("sensitive path: /private/runtime/sketch.png");
  });
  const executor = new ProtocolCommandExecutor({
    state,
    transport,
    sessions,
    paths: defaultDataPaths("/tmp/codex-pad-command-test"),
    logger: { warn },
    normalizeSketch: overrides.normalizeSketch ?? (async () => ({
      path: "/private/runtime/sketch.png",
      pngBase64: sketchCommand().png,
      width: 1,
      height: 1,
      bytes: 24,
      cleanup,
    })),
    ...(overrides.normalizeReview === undefined
      ? {}
      : { normalizeReview: overrides.normalizeReview }),
  });
  return { cleanup, executor, state, transport, warn };
}

function sketchCommand(): Extract<Command, { type: "sendSketch" }> {
  return {
    type: "sendSketch",
    commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb0",
    expectedSequence: 12,
    expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
    expectedThreadId: THREAD_ID,
    targetThreadId: THREAD_ID,
    instruction: "Use this exact sketch",
    png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  };
}

function reviewCommand(): Extract<Command, { type: "sendReview" }> {
  return {
    type: "sendReview",
    commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb9",
    expectedSequence: 12,
    expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
    expectedThreadId: THREAD_ID,
    targetThreadId: THREAD_ID,
    snapshotSeq: 12,
    instruction: "Review this exact frame.",
    frames: [{
      frameId: "019f7ec2-68eb-7183-bb3a-0e67312a8bba",
      index: 0,
      kind: "siteSnapshot",
      image: { kind: "inlinePng", png: sketchCommand().png },
      url: null,
      title: null,
      viewport: { width: 1_024, height: 768, devicePixelRatio: 2 },
      scroll: { x: 0, y: 0, documentWidth: 1_024, documentHeight: 768 },
    }],
  };
}

describe("ProtocolCommandExecutor outcome preservation", () => {
  it("keeps one exact Dictation press active until the matching end command", async () => {
    const invokeActionSlot = vi.fn(async () => ({ sequence: 13 })) as unknown as BridgeStateService["invokeActionSlot"];
    const { executor } = fixture({ invokeActionSlot });
    const gestureId = "019f7ec2-68eb-7183-bb3a-0e67312a8bd1";
    const begin: Extract<Command, { type: "runMicroAction" }> = {
      type: "runMicroAction",
      commandId: gestureId,
      expectedSequence: 12,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      expectedThreadId: THREAD_ID,
      slot: 0,
      actionSlot: "ACT10_ACT11",
      expectedKeycapId: "MIC",
      expectedNativeCommandId: "dictation.toggle",
      gesture: "begin",
      gestureId,
    };
    const end: Extract<Command, { type: "runMicroAction" }> = {
      ...begin,
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bd2",
      gesture: "end",
    };

    await expect(executor.execute(begin)).resolves.toMatchObject({ message: "Mac Dictation started" });
    await expect(executor.execute(end)).resolves.toMatchObject({ message: "Mac Dictation stopped" });
    expect(invokeActionSlot).toHaveBeenNthCalledWith(
      1, 12, THREAD_ID, 0, "ACT10_ACT11", "MIC", "dictation.toggle", "begin",
    );
    expect(invokeActionSlot).toHaveBeenNthCalledWith(
      2, 12, THREAD_ID, 0, "ACT10_ACT11", "MIC", "dictation.toggle", "end",
    );
    await expect(executor.execute({
      ...end,
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bd3",
    })).rejects.toMatchObject({ code: "GESTURE_NOT_FOUND" });
  });

  it("revalidates native selection after selectThread before a library command can write", async () => {
    let authoritativeThreadId = THREAD_ID;
    const targetChanged = Object.assign(new Error("Native selection changed during selectThread."), {
      code: "TARGET_MISMATCH",
    });
    const runLibraryCommand = vi.fn<ThreadTransport["runLibraryCommand"]>(async (input) => {
      await input.assertTargetAuthority(DESKTOP_IDENTITY);
      return {
        commandId: input.commandId,
        threadId: input.threadId,
        turnId: null,
        disposition: "started",
        duplicate: false,
      };
    });
    const { executor, state } = fixture({
      assertExactTarget: vi.fn(() => ({ slot: 0 }) as never),
      revalidateExactTarget: vi.fn(async (threadId) => {
        if (threadId !== authoritativeThreadId) throw targetChanged;
        return testTargetAuthority();
      }),
      selectThread: vi.fn(async (_threadId, guard) => {
        authoritativeThreadId = CREATED_THREAD_ID;
        await guard?.(DESKTOP_IDENTITY);
        return undefined as never;
      }),
      runLibraryCommand,
      refresh: vi.fn(async () => ({ sequence: 13 }) as never),
    });

    await expect(executor.execute({
      type: "runLibraryCommand",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb8",
      expectedSequence: 12,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      expectedThreadId: THREAD_ID,
      snapshotSeq: 12,
      targetThreadId: THREAD_ID,
      libraryId: "global-fork",
      libraryCommandId: "global-fork-v1",
      prompt: "Fork the selected task.",
    })).rejects.toBe(targetChanged);
    expect(state.revalidateExactTarget).toHaveBeenCalledWith(
      THREAD_ID,
      0,
      true,
      DESKTOP_IDENTITY,
    );
    expect(runLibraryCommand).not.toHaveBeenCalled();
  });

  it("routes approval decisions only through the exact typed pending tuple", async () => {
    const approve = vi.fn<ThreadTransport["approve"]>(async (input) => {
      await input.assertTargetAuthority(DESKTOP_IDENTITY);
      return { commandId: input.commandId, threadId: input.threadId, duplicate: false };
    });
    const { executor } = fixture({
      current: vi.fn(() => ({
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        sequence: 12,
        pendingApprovals: [{
          requestId: 441,
          threadId: THREAD_ID,
          turnId: CREATED_THREAD_ID,
          itemId: "approval-item",
          kind: "commandExecution",
          actionable: true,
          summary: "Run tests",
        }],
      }) as never),
      selectThread: vi.fn(async (_threadId, guard) => {
        await guard?.(DESKTOP_IDENTITY);
        return undefined as never;
      }),
      approve,
    });

    await expect(executor.execute({
      type: "respondToApproval",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bbb",
      expectedSequence: 12,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      expectedThreadId: THREAD_ID,
      requestId: 441,
      turnId: CREATED_THREAD_ID,
      itemId: "approval-item",
      approvalKind: "commandExecution",
      decision: "accept",
    })).resolves.toMatchObject({
      targetThreadId: THREAD_ID,
      message: "Exact pending approval accepted",
    });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 441,
      threadId: THREAD_ID,
      turnId: CREATED_THREAD_ID,
      itemId: "approval-item",
      kind: "commandExecution",
    }));
  });

  it.each([
    ["request", { requestId: 442 }],
    ["thread", { expectedThreadId: CREATED_THREAD_ID }],
    ["turn", { turnId: THREAD_ID }],
    ["item", { itemId: "different-approval-item" }],
    ["kind", { approvalKind: "fileChange" as const }],
  ])("rejects an approval command when its exact %s identity changed", async (_field, mismatch) => {
    const approve = vi.fn<ThreadTransport["approve"]>();
    const reject = vi.fn<ThreadTransport["reject"]>();
    const selectThread = vi.fn<ThreadTransport["selectThread"]>();
    const { executor } = fixture({
      current: vi.fn(() => ({
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        sequence: 12,
        pendingApprovals: [{
          requestId: 441,
          threadId: THREAD_ID,
          turnId: CREATED_THREAD_ID,
          itemId: "approval-item",
          kind: "commandExecution",
          actionable: true,
          summary: "Run tests",
        }],
      }) as never),
      selectThread,
      approve,
      reject,
    });
    const command: Extract<Command, { type: "respondToApproval" }> = {
      type: "respondToApproval",
      commandId: `approval-mismatch-${_field}-0001`,
      expectedSequence: 12,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      expectedThreadId: THREAD_ID,
      requestId: 441,
      turnId: CREATED_THREAD_ID,
      itemId: "approval-item",
      approvalKind: "commandExecution",
      decision: "accept",
      ...mismatch,
    };

    await expect(executor.execute(command)).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    expect(selectThread).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("revalidates native selection after sketch normalization before composer attachment", async () => {
    let authoritativeThreadId = THREAD_ID;
    let wrote = false;
    const targetChanged = Object.assign(new Error("Native selection changed during sketch normalization."), {
      code: "TARGET_MISMATCH",
    });
    const attachImageToComposer = vi.fn<BridgeStateService["attachImageToComposer"]>(async (threadId) => {
      if (threadId !== authoritativeThreadId) throw targetChanged;
      wrote = true;
      return { sequence: 13 } as never;
    });
    const { executor } = fixture({
      normalizeSketch: vi.fn(async () => {
        authoritativeThreadId = CREATED_THREAD_ID;
        return {
          path: "/private/runtime/sketch.png",
          pngBase64: sketchCommand().png,
          width: 1,
          height: 1,
          bytes: 24,
          cleanup: async () => undefined,
        };
      }),
      attachImageToComposer,
    });

    await expect(executor.execute(sketchCommand())).rejects.toBe(targetChanged);
    expect(attachImageToComposer).toHaveBeenCalledOnce();
    expect(wrote).toBe(false);
  });

  it("revalidates native selection after review normalization before transport dispatch", async () => {
    let authoritativeThreadId = THREAD_ID;
    let wrote = false;
    const targetChanged = Object.assign(new Error("Native selection changed during review normalization."), {
      code: "TARGET_MISMATCH",
    });
    const sendReview = vi.fn<ThreadTransport["sendReview"]>(async (input) => {
      await input.assertTargetAuthority(DESKTOP_IDENTITY);
      wrote = true;
      return {
        commandId: input.commandId,
        threadId: input.threadId,
        turnId: null,
        disposition: "started",
        duplicate: false,
      };
    });
    const { executor } = fixture({
      revalidateExactTarget: vi.fn(async (threadId) => {
        if (threadId !== authoritativeThreadId) throw targetChanged;
        return testTargetAuthority();
      }),
      selectThread: vi.fn(async (_threadId, guard) => {
        await guard?.(DESKTOP_IDENTITY);
        return undefined as never;
      }),
      normalizeReview: vi.fn(async () => {
        authoritativeThreadId = CREATED_THREAD_ID;
        return {
          instruction: "Review this exact frame.",
          images: [{
            path: "/private/runtime/review.png",
            pngBase64: sketchCommand().png,
            width: 1,
            height: 1,
            bytes: 24,
            cleanup: async () => undefined,
          }],
          cleanup: async () => undefined,
        };
      }),
      sendReview,
    });

    await expect(executor.execute(reviewCommand())).rejects.toBe(targetChanged);
    expect(sendReview).toHaveBeenCalledOnce();
    expect(wrote).toBe(false);
  });

  it("keeps a successful sketch acknowledgement when PNG cleanup fails", async () => {
    const { cleanup, executor, state, transport, warn } = fixture();

    await expect(executor.execute(sketchCommand())).resolves.toMatchObject({
      targetThreadId: THREAD_ID,
      message: "Sketch attached to the exact Codex composer",
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(state.attachImageToComposer).toHaveBeenCalledWith(
      THREAD_ID,
      0,
      sketchCommand().png,
    );
    expect(transport.sendSketch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("startup scavenging"));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|sensitive|sketch\.png/u);
  });

  it("keeps DELIVERY_UNKNOWN authoritative when PNG cleanup also fails", async () => {
    const deliveryUnknown = Object.assign(new Error("delivery may have happened"), {
      code: "DELIVERY_UNKNOWN",
      retryable: true,
    });
    const { cleanup, executor, warn } = fixture({
      attachImageToComposer: vi.fn(async () => {
        throw deliveryUnknown;
      }),
    });

    await expect(executor.execute(sketchCommand())).rejects.toBe(deliveryUnknown);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects an old bridge generation before createTask can mutate", async () => {
    const staleGeneration = Object.assign(new Error("Bridge generation changed."), {
      code: "STALE_SNAPSHOT",
    });
    const { executor, transport } = fixture({
      assertSnapshotIdentity: vi.fn(() => {
        throw staleGeneration;
      }),
    });

    await expect(executor.execute({
      type: "createTask",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bbc",
      expectedBridgeInstanceId: "8d35b974-62cc-4db8-9b4e-5a8dc8a4d813",
      expectedSequence: 12,
      expectedThreadId: null,
      instruction: null,
    })).rejects.toBe(staleGeneration);
    expect(transport.newThread).not.toHaveBeenCalled();
  });

  it("returns the created thread ID when Desktop open and snapshot refresh fail", async () => {
    const { executor, transport, warn } = fixture({
      openCreatedThread: vi.fn(async () => {
        throw new Error("Desktop unavailable");
      }),
      refresh: vi.fn(async () => {
        throw new Error("native refresh unavailable");
      }),
    });

    await expect(executor.execute({
      type: "createTask",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb1",
      expectedSequence: 12,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      expectedThreadId: null,
      instruction: null,
    })).resolves.toMatchObject({
      sequence: 12,
      targetThreadId: CREATED_THREAD_ID,
      message: "New Codex task created",
    });
    expect(transport.newThread).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Desktop unavailable|native refresh unavailable/u);
  });

  it("re-selects a newly created thread after a periodic native refresh clears its premature transport selection", async () => {
    let transportSelectedThreadId: string | null = null;
    const events: string[] = [];
    let selectionGuard: Parameters<ThreadTransport["selectThread"]>[1] | null = null;
    const revalidateExactTarget = vi.fn(async () => testTargetAuthority());
    const selectThread = vi.fn<ThreadTransport["selectThread"]>(async (threadId, guard) => {
      events.push("transport-reselected");
      selectionGuard = guard;
      await guard(DESKTOP_IDENTITY);
      transportSelectedThreadId = threadId;
      return { threadId } as never;
    });
    const startTurn = vi.fn<ThreadTransport["startTurn"]>(async (input) => {
      events.push("initial-turn-dispatched");
      if (transportSelectedThreadId !== input.threadId) {
        throw Object.assign(new Error("The exact created thread is no longer selected."), {
          code: "TARGET_NOT_SELECTED",
        });
      }
      expect(input.assertTargetAuthority).not.toBe(selectionGuard);
      await input.assertTargetAuthority(DESKTOP_IDENTITY);
      return {
        commandId: input.commandId,
        threadId: input.threadId,
        turnId: THREAD_ID,
        disposition: "started",
        duplicate: false,
      };
    });
    const { executor, transport, warn } = fixture({
      openCreatedThread: vi.fn(async () => {
        events.push("deep-link-dispatched");
        // thread/start selected C in the app-server while native Desktop was
        // still on A. Reproduce the periodic refresh that correctly clears C.
        events.push("periodic-refresh-native-a");
        transportSelectedThreadId = null;
        events.push("deep-link-confirmed-native-c");
      }),
      refresh: vi.fn(async () => ({ sequence: 13 }) as never),
      assertExactTarget: vi.fn(() => ({ slot: 4 }) as never),
      revalidateExactTarget,
      selectThread,
      startTurn,
    });
    vi.mocked(transport.newThread).mockImplementation(async () => {
      events.push("thread-created-and-prematurely-selected-c");
      transportSelectedThreadId = CREATED_THREAD_ID;
      return { threadId: CREATED_THREAD_ID } as never;
    });

    await expect(executor.execute({
      type: "createTask",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb3",
      expectedSequence: 12,
      expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
      expectedThreadId: null,
      instruction: "Begin with this exact instruction.",
    })).resolves.toMatchObject({
      targetThreadId: CREATED_THREAD_ID,
      message: "New Codex task created",
    });
    expect(events).toEqual([
      "thread-created-and-prematurely-selected-c",
      "deep-link-dispatched",
      "periodic-refresh-native-a",
      "deep-link-confirmed-native-c",
      "transport-reselected",
      "initial-turn-dispatched",
    ]);
    expect(selectThread).toHaveBeenCalledWith(CREATED_THREAD_ID, expect.any(Function));
    expect(revalidateExactTarget).toHaveBeenCalledTimes(2);
    expect(revalidateExactTarget).toHaveBeenNthCalledWith(
      1,
      CREATED_THREAD_ID,
      4,
      true,
      DESKTOP_IDENTITY,
    );
    expect(revalidateExactTarget).toHaveBeenNthCalledWith(
      2,
      CREATED_THREAD_ID,
      4,
      true,
      DESKTOP_IDENTITY,
    );
    expect(startTurn).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("durably reconciles the created thread after a Desktop-open failure without creating another task", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-create-task-ledger-"));
    try {
      const command: Extract<Command, { type: "createTask" }> = {
        type: "createTask",
        commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb2",
        expectedSequence: 12,
        expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
        expectedThreadId: null,
        instruction: null,
      };
      const { executor, transport } = fixture({
        openCreatedThread: vi.fn(async () => {
          throw new Error("Desktop unavailable");
        }),
      });
      const persistencePath = join(root, "commands.json");
      const firstLedger = new IdempotencyLedger({ persistencePath });
      const first = await firstLedger.execute(
        "device-a",
        command.commandId,
        JSON.stringify(command),
        () => executor.execute(command),
      );
      await expect(first.promise).resolves.toMatchObject({ targetThreadId: CREATED_THREAD_ID });
      expect(transport.newThread).toHaveBeenCalledOnce();

      const restarted = new IdempotencyLedger({ persistencePath });
      const createAgain = vi.fn(async () => ({
        sequence: 99,
        targetThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba3",
        message: "duplicate",
      }));
      const replay = await restarted.execute(
        "device-a",
        command.commandId,
        JSON.stringify(command),
        createAgain,
      );
      expect(replay.duplicate).toBe(true);
      await expect(replay.promise).resolves.toMatchObject({ targetThreadId: CREATED_THREAD_ID });
      expect(createAgain).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

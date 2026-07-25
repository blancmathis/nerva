import { describe, expect, it, vi } from "vitest";
import type {
  AdapterState,
  CodexDesktopAdapter,
  DesktopProcessIdentity,
} from "@codex-pad/codex-desktop";

import {
  AppServerClient,
  type AppServerWriteAuthorityIssuer,
  type AppServerWriteAuthorityToken,
  type JsonlDuplex,
} from "./app-server-client.js";
import { createExactTargetAuthorityDomain } from "./exact-target-authority.js";
import { BridgeStateService } from "./state.js";
import {
  ManagedThreadTransport,
  ThreadTransportError,
  type CommandAck,
} from "./thread-transport.js";

type Frame = Record<string, unknown>;

const THREAD_A = "019f7ec2-68eb-7183-8b3a-0e67312a8ba1";
const THREAD_B = "019f7ec2-68eb-7183-9b3a-0e67312a8ba2";
const TURN_A = "019f7ec2-68eb-7183-ab3a-0e67312a8ba3";
const TURN_B = "019f7ec2-68eb-7183-bb3a-0e67312a8ba4";
const TURN_NEW = "019f7ec2-68eb-7183-8b3a-0e67312a8ba5";
const THREAD_C = "019f7ec2-68eb-7183-8b3a-0e67312a8ba6";
const ITEM_A = "approval-item-a";
const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 42,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/Codex.app",
  executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  bundleId: "com.openai.codex",
};
const TEST_WRITE_AUTHORITY = undefined as unknown as AppServerWriteAuthorityToken;
const TEST_TARGET_AUTHORITY_DOMAIN = createExactTargetAuthorityDomain();

function testTargetAuthority() {
  return TEST_TARGET_AUTHORITY_DOMAIN.stateIssuer.issue(() => undefined);
}

const testTargetGuard = async (_desktopIdentity?: DesktopProcessIdentity) => testTargetAuthority();

class FakeJsonlDuplex implements JsonlDuplex {
  readonly readable: AsyncIterable<Uint8Array | string>;
  readonly writes: Frame[] = [];
  onWrite: (frame: Frame) => void = () => undefined;
  private readonly heldResponseIds = new Set<string>();
  private readonly heldResponseWrites = new Map<string, () => void>();
  private readonly chunks: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;

  constructor() {
    const self = this;
    this.readable = {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        while (true) {
          const chunk = self.chunks.shift();
          if (chunk !== undefined) {
            yield chunk;
            continue;
          }
          if (self.ended) return;
          await new Promise<void>((resolve) => self.waiters.push(resolve));
        }
      },
    };
  }

  write(data: string): Promise<void> | void {
    let heldResponseKey: string | undefined;
    for (const line of data.split("\n")) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as Frame;
      this.writes.push(frame);
      this.onWrite(frame);
      if (
        frame.method === undefined
        && frame.id !== undefined
        && Object.hasOwn(frame, "result")
        && this.heldResponseIds.has(String(frame.id))
      ) {
        heldResponseKey = String(frame.id);
      }
    }
    if (heldResponseKey === undefined) return;
    return new Promise<void>((resolve) => {
      this.heldResponseWrites.set(heldResponseKey, resolve);
    });
  }

  close(): void {
    this.ended = true;
    this.waiters.shift()?.();
  }

  push(frame: unknown): void {
    this.chunks.push(`${JSON.stringify(frame)}\n`);
    this.waiters.shift()?.();
  }

  holdResponseWrite(id: string | number): void {
    this.heldResponseIds.add(String(id));
  }

  releaseResponseWrite(id: string | number): void {
    const key = String(id);
    const resolve = this.heldResponseWrites.get(key);
    if (resolve === undefined) throw new Error(`No held response write for ${key}`);
    this.heldResponseWrites.delete(key);
    this.heldResponseIds.delete(key);
    resolve();
  }
}

type RuntimeState = {
  status: "idle" | "active" | "notLoaded";
  activeTurnId: string | null;
};

class FakeAppServer {
  readonly duplex = new FakeJsonlDuplex();
  readonly client: AppServerClient;
  readonly writeAuthority: AppServerWriteAuthorityIssuer | undefined;
  readonly states = new Map<string, RuntimeState>([
    [THREAD_A, { status: "idle", activeTurnId: null }],
    [THREAD_B, { status: "idle", activeTurnId: null }],
  ]);
  startCount = 0;
  steerCount = 0;
  threadReadCount = 0;
  rejectNextSteer = false;
  holdTurnStarts = false;
  holdSkillLists = false;
  holdNextThreadReadFor: string | null = null;
  threadListPages: Frame[] = [];
  turnStartResponses: unknown[] = [];
  steerResponses: unknown[] = [];
  readonly threadListRequests: Frame[] = [];
  readonly heldTurnStarts: Frame[] = [];
  readonly heldThreadReads: Array<{ request: Frame; response: Frame }> = [];
  readonly heldSkillLists: Frame[] = [];

  constructor(transportKind: "managed-proxy" | "injected" = "injected") {
    if (transportKind === "managed-proxy") {
      const connection = AppServerClient.createOwnedManagedConnection(this.duplex, {
        requestTimeoutMs: 1_000,
      });
      this.client = connection.client;
      this.writeAuthority = connection.writeAuthority;
    } else {
      this.client = new AppServerClient(this.duplex, { requestTimeoutMs: 1_000 });
      this.writeAuthority = undefined;
    }
    this.duplex.onWrite = (frame) => this.handle(frame);
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  notify(method: string, params: unknown): void {
    this.duplex.push({ method, params });
  }

  releaseNextTurnStart(): void {
    const request = this.heldTurnStarts.shift();
    if (request === undefined) throw new Error("No held turn/start request");
    this.respond(request, { turn: { id: TURN_NEW, status: "inProgress" } });
  }

  releaseNextThreadRead(): void {
    const held = this.heldThreadReads.shift();
    if (held === undefined) throw new Error("No held thread/read request");
    this.respond(held.request, held.response);
  }

  releaseNextSkillList(): void {
    const request = this.heldSkillLists.shift();
    if (request === undefined) throw new Error("No held skills/list request");
    this.respondSkillList(request);
  }

  private handle(frame: Frame): void {
    if (frame.method === "initialize") {
      this.respond(frame, { userAgent: "codex-test/0.145.0" });
      return;
    }
    if (frame.method === "thread/read" || frame.method === "thread/resume") {
      const params = frame.params as Frame;
      const threadId = String(params.threadId);
      const state = this.states.get(threadId);
      if (state === undefined) {
        this.error(frame, -32_602, "thread not found");
        return;
      }
      const includeTurns = frame.method === "thread/read"
        ? params.includeTurns === true
        : params.excludeTurns !== true;
      const response = this.threadResponse(threadId, state, includeTurns);
      if (frame.method === "thread/resume" && params.initialTurnsPage !== undefined) {
        response.initialTurnsPage = this.turnsPage(state);
      }
      if (frame.method === "thread/read") {
        this.threadReadCount += 1;
        if (this.holdNextThreadReadFor === threadId) {
          this.holdNextThreadReadFor = null;
          this.heldThreadReads.push({ request: frame, response });
          return;
        }
      }
      this.respond(frame, response);
      return;
    }
    if (frame.method === "thread/turns/list") {
      const params = frame.params as Frame;
      const state = this.states.get(String(params.threadId));
      if (state === undefined) {
        this.error(frame, -32_602, "thread not found");
        return;
      }
      this.respond(frame, this.turnsPage(state));
      return;
    }
    if (frame.method === "thread/list") {
      this.threadListRequests.push(frame.params as Frame);
      const configured = this.threadListPages.shift();
      this.respond(
        frame,
        configured ?? {
          data: [
            {
              id: THREAD_A,
              name: "Selected build task",
              preview: "private transcript preview",
              cwd: "/private/tmp/codex-pad-test",
              updatedAt: 1_750_000_000,
              status: { type: this.states.get(THREAD_A)?.status ?? "notLoaded" },
              turns: [{ items: [{ private: "must not escape" }] }],
            },
          ],
          nextCursor: null,
        },
      );
      return;
    }
    if (frame.method === "skills/list") {
      if (this.holdSkillLists) {
        this.heldSkillLists.push(frame);
        return;
      }
      this.respondSkillList(frame);
      return;
    }
    if (frame.method === "model/list") {
      this.respond(frame, {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "low",
          isDefault: true,
        }],
        nextCursor: null,
      });
      return;
    }
    if (frame.method === "account/rateLimits/read") {
      this.respond(frame, {
        rateLimits: {
          limitId: "fallback",
          planType: "unknown",
          primary: null,
          secondary: null,
          credits: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 64, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
            credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            rateLimitReachedType: null,
          },
        },
      });
      return;
    }
    if (frame.method === "thread/settings/update") {
      this.respond(frame, {});
      return;
    }
    if (frame.method === "turn/start") {
      const params = frame.params as Frame;
      const threadId = String(params.threadId);
      this.startCount += 1;
      this.states.set(threadId, { status: "active", activeTurnId: TURN_NEW });
      if (this.holdTurnStarts) {
        this.heldTurnStarts.push(frame);
        return;
      }
      this.respond(
        frame,
        this.turnStartResponses.length > 0
          ? this.turnStartResponses.shift()
          : { turn: { id: TURN_NEW, status: "inProgress" } },
      );
      return;
    }
    if (frame.method === "turn/steer") {
      const params = frame.params as Frame;
      const threadId = String(params.threadId);
      this.steerCount += 1;
      if (this.rejectNextSteer) {
        this.rejectNextSteer = false;
        this.states.set(threadId, { status: "active", activeTurnId: TURN_B });
        this.error(frame, -32_602, "expected turn is stale");
      } else {
        this.respond(
          frame,
          this.steerResponses.length > 0
            ? this.steerResponses.shift()
            : { turnId: params.expectedTurnId },
        );
      }
      return;
    }
  }

  private respondSkillList(request: Frame): void {
    this.respond(request, {
      data: [
        {
          cwd: "/private/tmp/codex-pad-test",
          skills: [
            {
              name: "test-skill",
              description: "Test skill",
              path: "/private/tmp/codex-pad-test/SKILL.md",
              enabled: true,
            },
          ],
        },
      ],
    });
  }

  private turnsPage(state: RuntimeState): Frame {
    const turns =
      state.activeTurnId === null
        ? []
        : [{ id: state.activeTurnId, status: "inProgress", items: [] }];
    return { data: turns.slice(-1) };
  }

  private threadResponse(threadId: string, state: RuntimeState, includeTurns = true): Frame {
    const turns = includeTurns ? this.turnsPage(state).data : [];
    return {
      thread: {
        id: threadId,
        status: { type: state.status, ...(state.status === "active" ? { activeFlags: [] } : {}) },
        cwd: "/private/tmp/codex-pad-test",
        turns,
      },
    };
  }

  private respond(request: Frame, result: unknown): void {
    this.duplex.push({ id: request.id, result });
  }

  private error(request: Frame, code: number, message: string): void {
    this.duplex.push({ id: request.id, error: { code, message } });
  }
}

async function makeTransport(
  options: {
    steer?: boolean;
    queueWaitTimeoutMs?: number;
    multiImageMax?: number;
    mutationAuthority?: () => void | Promise<void>;
  } = {},
): Promise<{ server: FakeAppServer; transport: ManagedThreadTransport }> {
  const server = new FakeAppServer();
  await server.initialize();
  const transport = new ManagedThreadTransport(server.client, {
    maxQueuedSketchesPerThread: 8,
    queueWaitTimeoutMs: options.queueWaitTimeoutMs ?? 1_000,
    assertMutationAuthority: async (finalTargetGuard) => {
      await (options.mutationAuthority ?? (async () => undefined))();
      await finalTargetGuard?.(DESKTOP_IDENTITY);
      return TEST_WRITE_AUTHORITY;
    },
    ...(options.steer === true
      ? {
          localImageSteerCapability: {
            verified: true as const,
            serverUserAgent: "codex-test/0.145.0",
            verifiedAt: new Date().toISOString(),
            probe: "runtime-disposable-thread" as const,
          },
        }
      : {}),
    ...(options.multiImageMax === undefined
      ? {}
      : {
          multiImageInputCapability: {
            verified: true as const,
            serverUserAgent: "codex-test/0.145.0",
            verifiedAt: new Date().toISOString(),
            probe: "runtime-disposable-thread-bounded-multi-local-image" as const,
            maxImages: options.multiImageMax,
          },
        }),
  });
  return { server, transport };
}

function sketch(commandId: string, threadId = THREAD_A) {
  return {
    commandId,
    threadId,
    instruction: "Use this annotated sketch to adjust the selected task.",
    imagePath: "/private/tmp/codex-pad-test.png",
    assertTargetAuthority: testTargetGuard,
  };
}

function nativeSelection(threadId: string): AdapterState {
  return {
    stale: false,
    health: { status: "ready", reasons: [], changedAt: 1 },
    snapshot: {
      slots: [0, 1, 2, 3, 4, 5].map((index) => {
        const slotThreadId = index === 0 ? THREAD_A : index === 1 ? THREAD_B : null;
        return {
          index,
          key: `AG0${index}`,
          threadId: slotThreadId,
          title: slotThreadId === null ? null : `Task ${index}`,
          status: slotThreadId === null ? "off" : "idle",
          nativeStatus: slotThreadId === null ? "off" : "idle",
          selected: slotThreadId === threadId,
          activityAt: null,
          activityLabel: null,
        };
      }) as unknown as NonNullable<AdapterState["snapshot"]>["slots"],
      activeThreadId: threadId,
      agentSource: "pinned",
      actionLayout: null,
      joystickLayout: null,
      reasoning: null,
      theme: "dark",
      capabilities: {
        activeThread: true,
        activity: true,
        agentSource: true,
        composerAttachment: true,
        actionLayout: false,
        actionControl: false,
        joystickLayout: false,
        joystickControl: false,
        reasoning: false,
        reasoningControl: false,
        theme: true,
      },
      observedAt: 1,
    },
  };
}

describe("ManagedThreadTransport exact-thread routing", () => {
  it("keeps background thread reads metadata-only so large task histories cannot close the socket", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });

    await expect(transport.threadRead(THREAD_A)).resolves.toMatchObject({
      threadId: THREAD_A,
      status: "active",
      activeTurnId: TURN_A,
    });
    expect(server.duplex.writes).toContainEqual(expect.objectContaining({
      method: "thread/read",
      params: { threadId: THREAD_A, includeTurns: false },
    }));
    expect(server.duplex.writes).toContainEqual(expect.objectContaining({
      method: "thread/turns/list",
      params: {
        threadId: THREAD_A,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    }));
    await expect(transport.selectThread(THREAD_A, testTargetGuard)).resolves.toMatchObject({
      threadId: THREAD_A,
      status: "active",
      activeTurnId: TURN_A,
    });
    expect(server.duplex.writes).toContainEqual(expect.objectContaining({
      method: "thread/resume",
      params: {
        threadId: THREAD_A,
        excludeTurns: true,
        initialTurnsPage: {
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
      },
    }));
    await server.client.close();
  });

  it("fails closed before thread/resume when selectThread has no ownership authority", async () => {
    const server = new FakeAppServer();
    await server.initialize();
    const transport = new ManagedThreadTransport(server.client);
    await expect(transport.listSessions()).resolves.toHaveLength(1);
    await expect(transport.selectThread(THREAD_A, testTargetGuard)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    await expect(
      transport.newThread({ commandId: "command-no-authority-new-0001" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(server.threadReadCount).toBe(1);
    expect(server.threadListRequests).toHaveLength(1);
    expect(server.duplex.writes.filter((frame) => frame.method === "thread/resume")).toEqual([]);
    expect(
      server.duplex.writes.filter((frame) =>
        ["turn/start", "turn/steer", "thread/start", "thread/fork", "thread/settings/update"]
          .includes(String(frame.method)),
      ),
    ).toEqual([]);
    await expect(transport.health()).resolves.toMatchObject({
      connected: true,
      desktopOwnershipVerified: false,
    });
    await server.client.close();
  });

  it("does not resume a thread when native selection changes during selectThread", async () => {
    const { server, transport } = await makeTransport();
    server.holdNextThreadReadFor = THREAD_A;
    let nativeThreadId = THREAD_A;
    const pending = transport.selectThread(THREAD_A, async () => {
      if (nativeThreadId !== THREAD_A) {
        throw new ThreadTransportError("TARGET_NOT_SELECTED", "Native selection changed.");
      }
      return testTargetAuthority();
    });
    await vi.waitFor(() => expect(server.heldThreadReads).toHaveLength(1));
    nativeThreadId = THREAD_B;
    server.releaseNextThreadRead();

    await expect(pending).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(server.duplex.writes.filter((frame) => frame.method === "thread/resume")).toEqual([]);
    await expect(transport.health()).resolves.toMatchObject({ selectedThreadId: null });
    await server.client.close();
  });

  it("gates every command family and approval response before its app-server write", async () => {
    let authorityGranted = true;
    const authority = vi.fn(async () => {
      if (authorityGranted) return;
      throw new ThreadTransportError(
        "CAPABILITY_UNAVAILABLE",
        "Desktop ownership is stale.",
      );
    });
    const { server, transport } = await makeTransport({ steer: true, mutationAuthority: authority });
    await transport.selectThread(THREAD_A, testTargetGuard);
    authorityGranted = false;

    await expect(
      transport.startTurn({
        commandId: "command-guard-start-0001",
        threadId: THREAD_A,
        input: [{ type: "text", text: "Start", text_elements: [] }],
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      transport.forkThread({
        commandId: "command-guard-fork-0001",
        threadId: THREAD_A,
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      transport.setReasoning({
        commandId: "command-guard-reasoning-0001",
        threadId: THREAD_A,
        effort: "high",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      transport.setModelReasoning({
        commandId: "command-guard-model-0001",
        threadId: THREAD_A,
        model: "gpt-test",
        effort: "high",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      transport.invokeSkill({
        commandId: "command-guard-skill-0001",
        threadId: THREAD_A,
        skillName: "test-skill",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      transport.newThread({ commandId: "command-guard-new-0001" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await expect(
      transport.steerTurn({
        commandId: "command-guard-steer-0001",
        threadId: THREAD_A,
        expectedTurnId: TURN_A,
        input: [{ type: "text", text: "Steer", text_elements: [] }],
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      transport.runLibraryCommand({
        commandId: "command-guard-library-0001",
        threadId: THREAD_A,
        text: "Run the saved command.",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    server.duplex.push({
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD_A, turnId: TURN_A, itemId: ITEM_A, command: "safe test" },
    });
    await vi.waitFor(() => expect(transport.listPendingApprovals(THREAD_A)).toHaveLength(1));
    await expect(
      transport.approve({
        commandId: "command-guard-approval-0001",
        requestId: 900,
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: ITEM_A,
        kind: "commandExecution",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    const mutatingMethods = new Set([
      "turn/start",
      "turn/steer",
      "thread/start",
      "thread/fork",
      "thread/settings/update",
    ]);
    expect(server.duplex.writes.filter((frame) => mutatingMethods.has(String(frame.method)))).toEqual([]);
    expect(server.duplex.writes).not.toContainEqual({ id: 900, result: { decision: "accept" } });
    expect(authority).toHaveBeenCalled();
    await server.client.close();
  });

  it("lists the live model catalog and applies one exact supported preset", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);

    await expect(transport.listModels()).resolves.toEqual([{
      model: "gpt-test",
      displayName: "GPT Test",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      isDefault: true,
    }]);
    await expect(transport.setModelReasoning({
      commandId: "command-model-preset-0001",
      threadId: THREAD_A,
      model: "gpt-test",
      effort: "high",
      assertTargetAuthority: testTargetGuard,
    })).resolves.toMatchObject({ commandId: "command-model-preset-0001", threadId: THREAD_A });
    expect(server.duplex.writes).toContainEqual(expect.objectContaining({
      method: "thread/settings/update",
      params: { threadId: THREAD_A, model: "gpt-test", effort: "high" },
    }));
    await server.client.close();
  });

  it("reads the exact Codex account limit windows without mutation authority", async () => {
    const { server, transport } = await makeTransport();

    await expect(transport.readCodexUsage()).resolves.toMatchObject({
      planType: "pro",
      limitName: "Codex",
      primary: { usedPercent: 27, windowMinutes: 300, resetsAt: 1_800_000_000_000 },
      secondary: { usedPercent: 64, windowMinutes: 10_080, resetsAt: 1_800_500_000_000 },
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
      rateLimitReached: false,
    });
    expect(server.duplex.writes).toContainEqual(expect.objectContaining({
      method: "account/rateLimits/read",
    }));
    await server.client.close();
  });

  it("starts an image turn only on the exact selected idle thread", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);
    const ack = await transport.sendSketch(sketch("command-idle-0001"));

    expect(ack).toEqual({
      commandId: "command-idle-0001",
      threadId: THREAD_A,
      turnId: TURN_NEW,
      disposition: "started",
      duplicate: false,
    });
    const start = server.duplex.writes.find((frame) => frame.method === "turn/start");
    expect(start?.params).toMatchObject({
      threadId: THREAD_A,
      input: [
        { type: "text" },
        { type: "localImage", path: "/private/tmp/codex-pad-test.png" },
      ],
    });
    await server.client.close();
  });

  it("starts an image-only turn without inventing an instruction", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);
    await transport.sendSketch({
      ...sketch("command-image-only-0001"),
      instruction: "",
    });

    const start = server.duplex.writes.find((frame) => frame.method === "turn/start");
    expect(start?.params).toMatchObject({
      threadId: THREAD_A,
      input: [{ type: "localImage", path: "/private/tmp/codex-pad-test.png" }],
    });
    await server.client.close();
  });

  it("returns immediate AGENT_BUSY with production defaults instead of retaining visual media", async () => {
    const server = new FakeAppServer();
    await server.initialize();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    const transport = new ManagedThreadTransport(server.client, {
      assertMutationAuthority: async () => TEST_WRITE_AUTHORITY,
    });
    await transport.selectThread(THREAD_A, testTargetGuard);
    const queueEvent = vi.fn();
    transport.onQueuedDispatch(queueEvent);

    await expect(
      transport.sendSketch(sketch("command-agent-busy-0001")),
    ).rejects.toMatchObject({ code: "AGENT_BUSY" });
    expect(queueEvent).not.toHaveBeenCalled();
    expect(server.startCount).toBe(0);
    await expect(transport.health()).resolves.toMatchObject({ queuedSketches: 0 });
    await server.client.close();
  });

  it("routes ordered review images atomically in one turn", async () => {
    const { server, transport } = await makeTransport({ multiImageMax: 12 });
    await transport.selectThread(THREAD_A, testTargetGuard);
    await expect(
      transport.sendReview({
        commandId: "command-review-0001",
        threadId: THREAD_A,
        instruction: "Review these frames in order.",
        imagePaths: ["/private/tmp/frame-1.png", "/private/tmp/frame-2.png"],
        assertTargetAuthority: testTargetGuard,
      }),
    ).resolves.toMatchObject({ disposition: "started", turnId: TURN_NEW });

    const start = server.duplex.writes.find((frame) => frame.method === "turn/start");
    expect(start?.params).toMatchObject({
      threadId: THREAD_A,
      input: [
        { type: "text", text: "Review these frames in order." },
        { type: "localImage", path: "/private/tmp/frame-1.png" },
        { type: "localImage", path: "/private/tmp/frame-2.png" },
      ],
    });
    expect(server.startCount).toBe(1);
    await server.client.close();
  });

  it("fails closed as delivery-unknown when idle turn/start applied but returned a malformed acknowledgement", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.turnStartResponses.push({ turn: { status: "inProgress" } });

    const command = sketch("command-malformed-idle-0001");
    await expect(transport.sendSketch(command)).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { phase: "post-response", clientCode: "THREAD_RESPONSE_MISMATCH" },
    });
    await expect(transport.sendSketch(command)).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
    });
    expect(server.startCount).toBe(1);
    expect(server.states.get(THREAD_A)).toEqual({ status: "active", activeTurnId: TURN_NEW });
    await server.client.close();
  });

  it("fails closed before routing multiple images without a bounded runtime proof", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);

    await expect(transport.health()).resolves.toMatchObject({ multiImageInputVerified: false });
    await expect(
      transport.sendReview({
        commandId: "command-review-unverified-0001",
        threadId: THREAD_A,
        instruction: "This unverified multi-image review must not be routed.",
        imagePaths: ["/private/tmp/frame-1.png", "/private/tmp/frame-2.png"],
        assertTargetAuthority: testTargetGuard,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(server.startCount).toBe(0);
    await server.client.close();
  });

  it("does not advertise or trust a proof below the full supported review bound", async () => {
    const { server, transport } = await makeTransport({ multiImageMax: 2 });
    await transport.selectThread(THREAD_A, testTargetGuard);

    await expect(transport.health()).resolves.toMatchObject({ multiImageInputVerified: false });
    await expect(
      transport.sendReview({
        commandId: "command-review-over-proof-bound-0001",
        threadId: THREAD_A,
        instruction: "This partial proof must not enable the full review feature.",
        imagePaths: [
          "/private/tmp/frame-1.png",
          "/private/tmp/frame-2.png",
          "/private/tmp/frame-3.png",
        ],
        assertTargetAuthority: testTargetGuard,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(server.startCount).toBe(0);
    await server.client.close();
  });

  it("accepts twelve ordered review frames but rejects a thirteenth", async () => {
    const { server, transport } = await makeTransport({ multiImageMax: 12 });
    await transport.selectThread(THREAD_A, testTargetGuard);
    const imagePaths = Array.from(
      { length: 12 },
      (_, index) => `/private/tmp/frame-${index + 1}.png`,
    );

    await expect(
      transport.sendReview({
        commandId: "command-review-twelve-0001",
        threadId: THREAD_A,
        instruction: "Review all twelve frames in order.",
        imagePaths,
        assertTargetAuthority: testTargetGuard,
      }),
    ).resolves.toMatchObject({ disposition: "started", turnId: TURN_NEW });
    const start = server.duplex.writes.find((frame) => frame.method === "turn/start");
    expect((start?.params as Frame).input).toEqual([
      { type: "text", text: "Review all twelve frames in order.", text_elements: [] },
      ...imagePaths.map((path) => ({ type: "localImage", path })),
    ]);

    await expect(
      transport.sendReview({
        commandId: "command-review-thirteen-0001",
        threadId: THREAD_A,
        instruction: "This must fail before routing.",
        imagePaths: [...imagePaths, "/private/tmp/frame-13.png"],
        assertTargetAuthority: testTargetGuard,
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(server.startCount).toBe(1);
    await server.client.close();
  });

  it("projects session metadata without transcript content", async () => {
    const { server, transport } = await makeTransport();
    await expect(transport.listSessions()).resolves.toEqual([
      {
        threadId: THREAD_A,
        title: "Selected build task",
        cwd: "/private/tmp/codex-pad-test",
        updatedAt: 1_750_000_000,
        status: "idle",
      },
    ]);
    await server.client.close();
  });

  it("paginates two session pages, preserves order, and removes duplicate UUIDs", async () => {
    const { server, transport } = await makeTransport();
    server.threadListPages = [
      {
        data: [
          {
            id: THREAD_A,
            name: "Newest",
            cwd: "/a",
            updatedAt: 300,
            status: { type: "idle" },
          },
          {
            id: THREAD_B,
            name: "Middle",
            cwd: "/b",
            updatedAt: 200,
            status: { type: "active", activeFlags: [] },
          },
        ],
        nextCursor: "page-two",
      },
      {
        data: [
          {
            id: THREAD_B.toUpperCase(),
            name: "Duplicate must not replace first",
            cwd: "/duplicate",
            updatedAt: 201,
            status: { type: "idle" },
          },
          {
            id: THREAD_C,
            name: "Oldest",
            cwd: "/c",
            updatedAt: 100,
            status: { type: "notLoaded" },
          },
        ],
        nextCursor: null,
      },
    ];

    const sessions = await transport.listSessions();
    expect(sessions.map((session) => session.threadId)).toEqual([THREAD_A, THREAD_B, THREAD_C]);
    expect(sessions.map((session) => session.title)).toEqual(["Newest", "Middle", "Oldest"]);
    expect(server.threadListRequests).toHaveLength(2);
    expect(server.threadListRequests[0]).not.toHaveProperty("cursor");
    expect(server.threadListRequests[1]).toMatchObject({
      cursor: "page-two",
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
    await server.client.close();
  });

  it("rejects malformed and cyclic pagination cursors", async () => {
    const malformed = await makeTransport();
    malformed.server.threadListPages = [{ data: [], nextCursor: { unexpected: true } }];
    await expect(malformed.transport.listSessions()).rejects.toMatchObject({
      code: "THREAD_RESPONSE_MISMATCH",
    });
    expect(malformed.server.threadListRequests).toHaveLength(1);
    await malformed.server.client.close();

    const cyclic = await makeTransport();
    cyclic.server.threadListPages = [
      { data: [], nextCursor: "same-cursor" },
      { data: [], nextCursor: "same-cursor" },
    ];
    await expect(cyclic.transport.listSessions()).rejects.toMatchObject({
      code: "THREAD_RESPONSE_MISMATCH",
    });
    expect(cyclic.server.threadListRequests).toHaveLength(2);
    await cyclic.server.client.close();
  });

  it("stops session pagination at five pages and 500 unique threads", async () => {
    const { server, transport } = await makeTransport();
    const sessionRecord = (index: number): Frame => ({
      id: `00000000-0000-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      name: `Task ${index + 1}`,
      cwd: "/bounded",
      updatedAt: 10_000 - index,
      status: { type: "idle" },
    });
    server.threadListPages = Array.from({ length: 6 }, (_, page) => ({
      data: Array.from({ length: 100 }, (__, offset) => sessionRecord(page * 100 + offset)),
      nextCursor: `cursor-${page + 1}`,
    }));

    const sessions = await transport.listSessions();
    expect(sessions).toHaveLength(500);
    expect(sessions[0]?.title).toBe("Task 1");
    expect(sessions[499]?.title).toBe("Task 500");
    expect(new Set(sessions.map((session) => session.threadId)).size).toBe(500);
    expect(server.threadListRequests).toHaveLength(5);
    expect(server.threadListRequests[4]).toMatchObject({ cursor: "cursor-4", limit: 100 });
    expect(server.threadListPages).toHaveLength(1);
    await server.client.close();
  });

  it("steers the exact active turn only with a runtime-verified image capability", async () => {
    const { server, transport } = await makeTransport({ steer: true });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);

    const ack = await transport.sendSketch(sketch("command-steer-0001"));
    expect(ack).toMatchObject({ disposition: "steered", turnId: TURN_A, threadId: THREAD_A });
    expect(server.steerCount).toBe(1);
    expect(server.duplex.writes.find((frame) => frame.method === "turn/steer")?.params).toMatchObject({
      threadId: THREAD_A,
      expectedTurnId: TURN_A,
      input: expect.arrayContaining([{ type: "localImage", path: "/private/tmp/codex-pad-test.png" }]),
    });
    await server.client.close();
  });

  it("fails closed as delivery-unknown when turn/steer applied but acknowledged a different turn", async () => {
    const { server, transport } = await makeTransport({ steer: true });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.steerResponses.push({ turnId: TURN_B });

    await expect(transport.sendSketch(sketch("command-malformed-steer-0001"))).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { phase: "post-response", clientCode: "THREAD_RESPONSE_MISMATCH" },
    });
    expect(server.steerCount).toBe(1);
    await server.client.close();
  });

  it("revalidates native authority immediately before direct image start and steer RPCs", async () => {
    const idle = await makeTransport();
    await idle.transport.selectThread(THREAD_A, testTargetGuard);
    await expect(
      idle.transport.sendSketch({
        ...sketch("command-direct-guard-start-0001"),
        assertTargetAuthority: () => {
          throw new ThreadTransportError("TARGET_NOT_SELECTED", "Native selection changed.");
        },
      }),
    ).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(idle.server.startCount).toBe(0);
    await idle.server.client.close();

    const active = await makeTransport({ steer: true });
    active.server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await active.transport.selectThread(THREAD_A, testTargetGuard);
    await expect(
      active.transport.sendSketch({
        ...sketch("command-direct-guard-steer-0001"),
        assertTargetAuthority: () => {
          throw new ThreadTransportError("TARGET_NOT_SELECTED", "Native selection changed.");
        },
      }),
    ).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(active.server.steerCount).toBe(0);
    await active.server.client.close();
  });

  it("routes a validated library command as one text-only input", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);

    await expect(
      transport.runLibraryCommand({
        commandId: "command-library-0001",
        threadId: THREAD_A,
        text: "Fork the selected task.",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).resolves.toMatchObject({ disposition: "steered", turnId: TURN_A });
    expect(server.duplex.writes.find((frame) => frame.method === "turn/steer")?.params).toMatchObject({
      threadId: THREAD_A,
      expectedTurnId: TURN_A,
      input: [{ type: "text", text: "Fork the selected task.", text_elements: [] }],
    });
    await server.client.close();
  });

  it("does not write a library command when native selection changes during target refresh", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.holdNextThreadReadFor = THREAD_A;
    let nativeThreadId = THREAD_A;

    const pending = transport.runLibraryCommand({
      commandId: "command-library-target-race-0001",
      threadId: THREAD_A,
      text: "Run only on the exact selected task.",
      assertTargetAuthority: async () => {
        if (nativeThreadId !== THREAD_A) {
          throw new ThreadTransportError("TARGET_NOT_SELECTED", "Native selection changed.");
        }
        return testTargetAuthority();
      },
    });
    await vi.waitFor(() => expect(server.heldThreadReads).toHaveLength(1));
    nativeThreadId = THREAD_B;
    server.releaseNextThreadRead();

    await expect(pending).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(server.startCount).toBe(0);
    expect(server.steerCount).toBe(0);
    await server.client.close();
  });

  it("does not write when ownership topology changes during the final native target refresh", async () => {
    const server = new FakeAppServer("managed-proxy");
    await server.initialize();
    let topologyGeneration = 1;
    const transport = new ManagedThreadTransport(server.client, {
      assertMutationAuthority: async (finalTargetGuard) => {
        const capturedGeneration = topologyGeneration;
        await finalTargetGuard?.(DESKTOP_IDENTITY);
        return server.writeAuthority!.issue(() => {
          if (topologyGeneration !== capturedGeneration) {
            throw new Error("Topology changed.");
          }
        });
      },
    });
    await transport.selectThread(THREAD_A, testTargetGuard);
    let targetChecks = 0;

    await expect(transport.runLibraryCommand({
      commandId: "command-library-topology-race-0001",
      threadId: THREAD_A,
      text: "Run only while the exact ownership topology is current.",
      assertTargetAuthority: async () => {
        targetChecks += 1;
        // The first check gates queue/direct-dispatch eligibility. Inject the
        // race into the second, final check whose issued token reaches JSONL.
        if (targetChecks === 2) topologyGeneration += 1;
        return testTargetAuthority();
      },
    })).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    expect(targetChecks).toBe(2);
    expect(server.startCount).toBe(0);
    expect(server.duplex.writes.filter((frame) => frame.method === "turn/start")).toEqual([]);
    await server.client.close();
  });

  it("writes no frame when target generation changes after the final guard returns", async () => {
    const server = new FakeAppServer("managed-proxy");
    await server.initialize();
    const targetAuthority = createExactTargetAuthorityDomain();
    let nativeThreadId = THREAD_A;
    let injectTargetRace = false;
    let state!: BridgeStateService;
    const adapter = {
      refresh: vi.fn(async () => nativeSelection(nativeThreadId)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const transport = new ManagedThreadTransport(server.client, {
      assertMutationAuthority: async (finalTargetGuard) => {
        const exactTarget = await finalTargetGuard?.(DESKTOP_IDENTITY);
        if (injectTargetRace) {
          nativeThreadId = THREAD_B;
          await state.revalidateExactTarget(THREAD_B, 1, true, DESKTOP_IDENTITY);
        }
        return server.writeAuthority!.issue(() => {
          if (exactTarget !== undefined) targetAuthority.providerConsumer(exactTarget);
        });
      },
    });
    state = new BridgeStateService({
      adapter,
      transport,
      targetAuthorityIssuer: targetAuthority.stateIssuer,
    });
    await state.refresh();
    const assertTargetAuthority = (desktopIdentity?: DesktopProcessIdentity) =>
      state.revalidateExactTarget(THREAD_A, 0, true, desktopIdentity);
    await transport.selectThread(THREAD_A, assertTargetAuthority);

    injectTargetRace = true;
    await expect(transport.startTurn({
      commandId: "command-target-generation-race-0001",
      threadId: THREAD_A,
      input: [{ type: "text", text: "Do not route after reselection.", text_elements: [] }],
      assertTargetAuthority,
    })).rejects.toMatchObject({ code: "APP_SERVER_AUTHORITY_STALE" });
    expect(server.startCount).toBe(0);
    expect(server.duplex.writes.filter((frame) => frame.method === "turn/start")).toEqual([]);
    await server.client.close();
  });

  it("does not write a skill when native selection changes during skill resolution", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.holdSkillLists = true;
    let nativeThreadId = THREAD_A;

    const pending = transport.invokeSkill({
      commandId: "command-skill-target-race-0001",
      threadId: THREAD_A,
      skillName: "test-skill",
      assertTargetAuthority: async () => {
        if (nativeThreadId !== THREAD_A) {
          throw new ThreadTransportError("TARGET_NOT_SELECTED", "Native selection changed.");
        }
        return testTargetAuthority();
      },
    });
    await vi.waitFor(() => expect(server.heldSkillLists).toHaveLength(1));
    nativeThreadId = THREAD_B;
    server.releaseNextSkillList();

    await expect(pending).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(server.startCount).toBe(0);
    expect(server.steerCount).toBe(0);
    await server.client.close();
  });

  it("keeps a busy fallback pending until its later turn/start is acknowledged", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    const queueEvents: string[] = [];
    transport.onQueuedDispatch((event) => queueEvents.push(event.type));

    let settled = false;
    const pending = transport.sendSketch(sketch("command-queue-0001")).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(queueEvents).toContain("queued"));
    expect(settled).toBe(false);
    expect(server.startCount).toBe(0);

    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });

    await expect(pending).resolves.toMatchObject({
      disposition: "queued",
      turnId: TURN_NEW,
      threadId: THREAD_A,
    });
    expect(queueEvents).toEqual(["queued", "dispatched"]);
    expect(server.startCount).toBe(1);
    await server.client.close();
  });

  it("allows an unrelated snapshot sequence change while the exact native target stays queued", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    const nativeThreadId = THREAD_A;
    let snapshotSequence = 12;
    const observedSequences: number[] = [];
    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });
    const pending = transport.sendSketch({
      ...sketch("command-queue-unrelated-sequence-0001"),
      assertTargetAuthority: async () => {
        observedSequences.push(snapshotSequence);
        if (nativeThreadId !== THREAD_A) {
          throw new ThreadTransportError("TARGET_NOT_SELECTED", "Native selection changed.");
        }
        return testTargetAuthority();
      },
    });
    await vi.waitFor(() => expect(queued).toBe(true));

    snapshotSequence = 13;
    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });

    await expect(pending).resolves.toMatchObject({ disposition: "queued", threadId: THREAD_A });
    expect(observedSequences).toContain(12);
    expect(observedSequences).toContain(13);
    expect(server.startCount).toBe(1);
    await server.client.close();
  });

  it("revalidates ownership after a queue wait and rejects without dispatch", async () => {
    let ownershipVerified = true;
    const { server, transport } = await makeTransport({
      mutationAuthority: async () => {
        if (!ownershipVerified) {
          throw new ThreadTransportError(
            "CAPABILITY_UNAVAILABLE",
            "Desktop ownership changed while the command was queued.",
          );
        }
      },
    });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });
    const pending = transport.sendSketch(sketch("command-queue-ownership-0001"));
    await vi.waitFor(() => expect(queued).toBe(true));

    ownershipVerified = false;
    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });

    await expect(pending).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(server.startCount).toBe(0);
    expect(server.duplex.writes.some((frame) => frame.method === "turn/start")).toBe(false);
    await server.client.close();
  });

  it("fails a queued dispatch as delivery-unknown after a malformed turn/start acknowledgement", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.turnStartResponses.push({ accepted: true });

    const pending = transport.sendSketch(sketch("command-malformed-queued-0001"));
    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });

    await expect(pending).rejects.toMatchObject({
      code: "APP_SERVER_DELIVERY_UNKNOWN",
      detail: { phase: "post-response", clientCode: "THREAD_RESPONSE_MISMATCH" },
    });
    expect(server.startCount).toBe(1);
    expect(server.states.get(THREAD_A)).toEqual({ status: "active", activeTurnId: TURN_NEW });
    await server.client.close();
  });

  it("keeps shifted review media owned until its in-flight turn/start is acknowledged", async () => {
    const { server, transport } = await makeTransport({ queueWaitTimeoutMs: 300 });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.holdTurnStarts = true;

    let callerCleanupRan = false;
    let settled = false;
    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });
    const pending = transport.sendSketch(sketch("command-queue-in-flight-0001")).finally(() => {
      callerCleanupRan = true;
    });
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(queued).toBe(true));

    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });
    await vi.waitFor(() => expect(server.heldTurnStarts).toHaveLength(1));

    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    expect(settled).toBe(false);
    expect(callerCleanupRan).toBe(false);

    server.releaseNextTurnStart();
    await expect(pending).resolves.toMatchObject({
      commandId: "command-queue-in-flight-0001",
      disposition: "queued",
      threadId: THREAD_A,
      turnId: TURN_NEW,
    });
    expect(callerCleanupRan).toBe(true);
    await server.client.close();
  });

  it("promptly rejects queued visual work when an accepted native snapshot selects another thread", async () => {
    const { server, transport } = await makeTransport({ queueWaitTimeoutMs: 5_000 });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });
    const pending = transport.sendSketch(sketch("command-queue-native-reselection-0001"));
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(queued).toBe(true));

    const adapter = {
      refresh: vi.fn(async () => nativeSelection(THREAD_B)),
      close: vi.fn(),
    } as unknown as CodexDesktopAdapter;
    const state = new BridgeStateService({ adapter, transport });
    await state.refresh();

    const result = await outcome;
    expect(result).toHaveProperty("error");
    expect((result as { error: unknown }).error).toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(server.startCount).toBe(0);
    await expect(transport.health()).resolves.toMatchObject({ selectedThreadId: null });
    await server.client.close();
  });

  it("does not dispatch a queued review after selection changes during refresh", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);

    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });
    const pending = transport.sendSketch(sketch("command-queue-reselect-0001"));
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(queued).toBe(true));
    server.holdNextThreadReadFor = THREAD_A;
    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });
    await vi.waitFor(() => expect(server.heldThreadReads).toHaveLength(1));

    await transport.selectThread(THREAD_B, testTargetGuard);
    const result = await outcome;
    expect(result).toHaveProperty("error");
    expect((result as { error: unknown }).error).toMatchObject({ code: "TARGET_NOT_SELECTED" });

    server.releaseNextThreadRead();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(server.startCount).toBe(0);
    expect(server.states.get(THREAD_B)).toEqual({ status: "idle", activeTurnId: null });
    await server.client.close();
  });

  it("fails a queued review when native authority changes but transport selection stays stale", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    let authoritativeThreadId = THREAD_A;
    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });

    const pending = transport.sendSketch({
      ...sketch("command-queue-native-authority-0001"),
      assertTargetAuthority: async () => {
        await Promise.resolve();
        if (authoritativeThreadId !== THREAD_A) {
          throw new ThreadTransportError(
            "TARGET_NOT_SELECTED",
            "The native selection changed before queued dispatch.",
          );
        }
        return testTargetAuthority();
      },
    });
    await vi.waitFor(() => expect(queued).toBe(true));

    authoritativeThreadId = THREAD_B;
    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });

    await expect(pending).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect((await transport.health()).selectedThreadId).toBe(THREAD_A);
    expect(server.startCount).toBe(0);
    await server.client.close();
  });

  it("rechecks queued native target after the delayed ownership probe and before turn/start", async () => {
    let pauseOwnership = false;
    let releaseOwnership: (() => void) | undefined;
    let enteredOwnership: (() => void) | undefined;
    const ownershipEntered = new Promise<void>((resolve) => { enteredOwnership = resolve; });
    const ownershipRelease = new Promise<void>((resolve) => { releaseOwnership = resolve; });
    const { server, transport } = await makeTransport({
      mutationAuthority: async () => {
        if (!pauseOwnership) return;
        enteredOwnership?.();
        await ownershipRelease;
      },
    });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    let nativeThreadId = THREAD_A;
    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });
    const pending = transport.sendSketch({
      ...sketch("command-queue-ownership-race-0001"),
      assertTargetAuthority: async () => {
        if (nativeThreadId !== THREAD_A) {
          throw new ThreadTransportError("TARGET_NOT_SELECTED", "Native selection changed.");
        }
        return testTargetAuthority();
      },
    });
    await vi.waitFor(() => expect(queued).toBe(true));

    pauseOwnership = true;
    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });
    await ownershipEntered;
    nativeThreadId = THREAD_B;
    releaseOwnership?.();

    await expect(pending).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    expect(server.startCount).toBe(0);
    await server.client.close();
  });

  it("waits when an authoritative refresh reports a newer active turn", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    let queued = false;
    transport.onQueuedDispatch((event) => {
      if (event.type === "queued") queued = true;
    });
    const pending = transport.sendSketch(sketch("command-queue-authority-0001"));
    await vi.waitFor(() => expect(queued).toBe(true));
    const readsBeforeCompletion = server.threadReadCount;

    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_B });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: "completed" },
    });
    await vi.waitFor(() => expect(server.threadReadCount).toBeGreaterThan(readsBeforeCompletion));
    expect(server.startCount).toBe(0);

    server.states.set(THREAD_A, { status: "idle", activeTurnId: null });
    server.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: TURN_B, status: "completed" },
    });
    await expect(pending).resolves.toMatchObject({ disposition: "queued", threadId: THREAD_A });
    expect(server.startCount).toBe(1);
    await server.client.close();
  });

  it("fails closed when the expected active turn becomes stale during steer", async () => {
    const { server, transport } = await makeTransport({ steer: true });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.rejectNextSteer = true;

    const input = sketch("command-stale-0001");
    await expect(transport.sendSketch(input)).rejects.toMatchObject({
      code: "STALE_EXPECTED_TURN",
    });
    await expect(transport.sendSketch(input)).rejects.toMatchObject({
      code: "STALE_EXPECTED_TURN",
    });
    expect(server.startCount).toBe(0);
    expect(server.steerCount).toBe(1);
    expect(server.states.get(THREAD_A)?.activeTurnId).toBe(TURN_B);
    await server.client.close();
  });

  it("coalesces duplicate command IDs and never repeats the effect", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);
    const first = await transport.sendSketch(sketch("command-duplicate-0001"));
    const duplicate = await transport.sendSketch(sketch("command-duplicate-0001"));

    expect(first.duplicate).toBe(false);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(server.startCount).toBe(1);
    await server.client.close();
  });

  it("rejects a valid but non-selected target without any app-server mutation", async () => {
    const { server, transport } = await makeTransport();
    await transport.selectThread(THREAD_A, testTargetGuard);
    const writesBefore = server.duplex.writes.length;

    await expect(transport.sendSketch(sketch("command-wrong-target-0001", THREAD_B))).rejects.toBeInstanceOf(
      ThreadTransportError,
    );
    await expect(transport.sendSketch(sketch("command-wrong-target-0002", THREAD_B))).rejects.toMatchObject({
      code: "TARGET_NOT_SELECTED",
    });
    expect(server.duplex.writes).toHaveLength(writesBefore);
    await server.client.close();
  });

  it("binds approval decisions to the exact server request, thread, turn, and item", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.notify("unused", {});
    server.duplex.push({
      id: 991,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: ITEM_A,
        command: "npm test",
      },
    });
    await vi.waitFor(() => expect(transport.listPendingApprovals(THREAD_A)).toHaveLength(1));

    await expect(
      transport.approve({
        commandId: "command-approve-wrong-kind-0001",
        requestId: 991,
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: ITEM_A,
        kind: "fileChange",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    expect(server.duplex.writes).not.toContainEqual({ id: 991, result: { decision: "accept" } });

    await expect(
      transport.approve({
        commandId: "command-approve-0001",
        requestId: 991,
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: ITEM_A,
        kind: "commandExecution",
        assertTargetAuthority: async () => testTargetAuthority(),
      }),
    ).resolves.toMatchObject({ threadId: THREAD_A, duplicate: false });
    expect(server.duplex.writes).toContainEqual({ id: 991, result: { decision: "accept" } });
    expect(transport.listPendingApprovals(THREAD_A)).toHaveLength(0);
    await server.client.close();
  });

  it("does not answer when the exact pending request changes during authority revalidation", async () => {
    let pauseOwnership = false;
    let ownershipEntered: (() => void) | undefined;
    let releaseOwnership: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { ownershipEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseOwnership = resolve; });
    const { server, transport } = await makeTransport({
      mutationAuthority: async () => {
        if (!pauseOwnership) return;
        ownershipEntered?.();
        await release;
      },
    });
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.duplex.push({
      id: 992,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: ITEM_A,
        command: "npm test",
      },
    });
    await vi.waitFor(() => expect(transport.listPendingApprovals(THREAD_A)).toHaveLength(1));

    pauseOwnership = true;
    const pending = transport.approve({
      commandId: "command-approve-request-race-0001",
      requestId: 992,
      threadId: THREAD_A,
      turnId: TURN_A,
      itemId: ITEM_A,
      kind: "commandExecution",
      assertTargetAuthority: async () => testTargetAuthority(),
    });
    await entered;
    server.duplex.push({
      id: 992,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: `${ITEM_A}-replacement`,
        reason: "Replacement request",
      },
    });
    await vi.waitFor(() => expect(transport.listPendingApprovals(THREAD_A)[0]).toMatchObject({
      kind: "fileChange",
    }));
    releaseOwnership?.();

    await expect(pending).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    expect(server.duplex.writes).not.toContainEqual({ id: 992, result: { decision: "accept" } });
    await server.client.close();
  });

  it("preserves a same-id replacement that arrives while an approval response write is in flight", async () => {
    const { server, transport } = await makeTransport();
    server.states.set(THREAD_A, { status: "active", activeTurnId: TURN_A });
    await transport.selectThread(THREAD_A, testTargetGuard);
    server.duplex.push({
      id: 993,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: ITEM_A,
        command: "npm test",
      },
    });
    await vi.waitFor(() => expect(transport.listPendingApprovals(THREAD_A)).toHaveLength(1));

    server.duplex.holdResponseWrite(993);
    const pending = transport.approve({
      commandId: "command-approve-response-race-0001",
      requestId: 993,
      threadId: THREAD_A,
      turnId: TURN_A,
      itemId: ITEM_A,
      kind: "commandExecution",
      assertTargetAuthority: async () => testTargetAuthority(),
    });
    await vi.waitFor(() => expect(server.duplex.writes).toContainEqual({
      id: 993,
      result: { decision: "accept" },
    }));

    server.duplex.push({
      id: 993,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: THREAD_A,
        turnId: TURN_A,
        itemId: `${ITEM_A}-replacement`,
        reason: "Replacement request",
      },
    });
    await vi.waitFor(() => expect(transport.listPendingApprovals(THREAD_A)[0]).toMatchObject({
      kind: "fileChange",
      itemId: `${ITEM_A}-replacement`,
    }));

    server.duplex.releaseResponseWrite(993);
    await expect(pending).resolves.toMatchObject({ threadId: THREAD_A, duplicate: false });
    expect(transport.listPendingApprovals(THREAD_A)).toEqual([
      expect.objectContaining({
        requestId: 993,
        kind: "fileChange",
        itemId: `${ITEM_A}-replacement`,
      }),
    ]);
    await server.client.close();
  });
});

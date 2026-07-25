import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CodexDesktopAdapter,
  type DesktopProcessIdentity,
  type NativeComposerImageAttachment,
  type NativeDispatch,
  type NativeMicroRuntime,
} from "../src/index.js";

const DESKTOP_A: DesktopProcessIdentity = {
  pid: 4242,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleId: "com.openai.chatgpt",
};
const DESKTOP_B: DesktopProcessIdentity = {
  ...DESKTOP_A,
  pid: 4343,
  startedAt: "Sun Jul 20 12:35:57 2026",
};

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("./fixtures/native-six.json", import.meta.url), "utf8")) as Record<string, unknown>;
}

class FakeRuntime implements NativeMicroRuntime {
  readonly dispatches: NativeDispatch[] = [];
  readonly attachments: NativeComposerImageAttachment[] = [];
  readonly desktopIdentity?: DesktopProcessIdentity;
  reads = 0;
  closes = 0;
  failAfter = Number.POSITIVE_INFINITY;

  constructor(private readonly value: unknown, desktopIdentity?: DesktopProcessIdentity) {
    if (desktopIdentity !== undefined) this.desktopIdentity = desktopIdentity;
  }

  async readSnapshot(): Promise<unknown> {
    this.reads += 1;
    if (this.reads > this.failAfter) throw new Error("fixture CDP disappeared");
    return structuredClone(this.value);
  }

  async dispatch(event: NativeDispatch): Promise<void> {
    this.dispatches.push(event);
  }

  async attachImageToComposer(attachment: NativeComposerImageAttachment): Promise<void> {
    this.attachments.push(attachment);
  }

  close(): void { this.closes += 1; }
}

describe("CodexDesktopAdapter", () => {
  it("attaches one PNG to the exact native composer without invoking submit", async () => {
    const runtime = new FakeRuntime(await fixture());
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    const authority = vi.fn();
    const attachment: NativeComposerImageAttachment = {
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      fileName: "Codex Pad Drawing.png",
      pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XqZ8WQAAAABJRU5ErkJggg==",
    };

    await expect(adapter.attachImageToComposer(attachment, authority)).resolves.toMatchObject({ stale: false });
    expect(authority).toHaveBeenCalledOnce();
    expect(runtime.attachments).toEqual([attachment]);
    expect(runtime.dispatches).toEqual([]);
  });

  it("serializes refreshes so an older read cannot overwrite newer authority", async () => {
    const first = await fixture();
    const second = await fixture();
    first.theme = "dark";
    second.theme = "light";
    let reads = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtime: NativeMicroRuntime = {
      async readSnapshot() {
        reads += 1;
        if (reads === 1) {
          markFirstStarted?.();
          await firstGate;
          return structuredClone(first);
        }
        return structuredClone(second);
      },
      async dispatch() {},
      close() {},
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    const older = adapter.refresh();
    await firstStarted;
    const newer = adapter.refresh();
    await Promise.resolve();
    expect(reads).toBe(1);
    releaseFirst?.();
    await older;
    await newer;
    expect(reads).toBe(2);
    expect(adapter.snapshot().snapshot?.theme).toBe("light");
  });

  it("consumes a synchronous authority guard at the final native dispatch boundary", async () => {
    const order: string[] = [];
    const raw = await fixture();
    const runtime: NativeMicroRuntime = {
      async readSnapshot() {
        order.push("read");
        return structuredClone(raw);
      },
      async dispatch() { order.push("dispatch"); },
      close() {},
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await adapter.execute({
      action: "select-slot",
      slotIndex: 0,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    }, () => { order.push("authority"); });
    expect(order.slice(0, 3)).toEqual(["read", "authority", "dispatch"]);
  });

  it("dispatches nothing when final synchronous mutation authority is stale", async () => {
    const runtime = new FakeRuntime(await fixture());
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await expect(adapter.execute({
      action: "select-slot",
      slotIndex: 0,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    }, () => { throw new Error("revoked listener generation"); })).rejects.toMatchObject({
      code: "mutation-authority-stale",
    });
    expect(runtime.dispatches).toEqual([]);
  });

  it("rebinds from an alternate Desktop and dispatches only to the attested process", async () => {
    const raw = await fixture();
    const alternate = new FakeRuntime(raw, DESKTOP_B);
    const attested = new FakeRuntime(raw, DESKTOP_A);
    const requested: Array<DesktopProcessIdentity | undefined> = [];
    const adapter = new CodexDesktopAdapter({
      runtimeFactory: async (identity) => {
        requested.push(identity);
        return identity?.pid === DESKTOP_A.pid ? attested : alternate;
      },
    });
    await adapter.refresh();
    await adapter.execute({
      action: "select-slot",
      slotIndex: 0,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    }, () => undefined, DESKTOP_A);
    expect(requested).toEqual([undefined, DESKTOP_A]);
    expect(alternate.closes).toBe(1);
    expect(alternate.dispatches).toEqual([]);
    expect(attested.dispatches).toHaveLength(1);
  });

  it("fails closed when runtime discovery returns a different Desktop generation", async () => {
    const alternate = new FakeRuntime(await fixture(), DESKTOP_B);
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => alternate });
    await expect(adapter.execute({
      action: "select-slot",
      slotIndex: 0,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    }, () => undefined, DESKTOP_A)).rejects.toMatchObject({ code: "snapshot-stale" });
    expect(alternate.dispatches).toEqual([]);
    expect(alternate.closes).toBe(1);
    expect(adapter.snapshot().health.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cdp-unavailable" }),
    ]));
  });

  it("backs failed CDP discovery off exponentially and resets after a healthy read", async () => {
    let now = 0;
    const runtime = new FakeRuntime(await fixture());
    runtime.failAfter = 1;
    const runtimeFactory = vi.fn()
      .mockRejectedValueOnce(new Error("CDP unavailable"))
      .mockRejectedValueOnce(new Error("CDP still unavailable"))
      .mockResolvedValue(runtime);
    const adapter = new CodexDesktopAdapter({
      runtimeFactory,
      now: () => now,
      random: () => 1,
      retryDelayMs: 100,
      retryMaxDelayMs: 400
    });

    await adapter.refresh();
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    now = 99;
    await adapter.refresh();
    expect(runtimeFactory).toHaveBeenCalledTimes(1);

    now = 100;
    await adapter.refresh();
    expect(runtimeFactory).toHaveBeenCalledTimes(2);
    now = 299;
    await adapter.refresh();
    expect(runtimeFactory).toHaveBeenCalledTimes(2);

    now = 300;
    expect((await adapter.refresh()).health.status).toBe("ready");
    expect(runtimeFactory).toHaveBeenCalledTimes(3);

    now = 301;
    expect((await adapter.refresh()).stale).toBe(true);
    now = 400;
    await adapter.refresh();
    expect(runtimeFactory).toHaveBeenCalledTimes(3);
    now = 401;
    await adapter.refresh();
    expect(runtimeFactory).toHaveBeenCalledTimes(4);
  });

  it("preserves the last validated snapshot when CDP disappears", async () => {
    const runtime = new FakeRuntime(await fixture());
    runtime.failAfter = 1;
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime, now: () => 500 });
    expect((await adapter.refresh()).health.status).toBe("ready");
    const degraded = await adapter.refresh();
    expect(degraded.health.status).toBe("degraded");
    expect(degraded.stale).toBe(true);
    expect(degraded.snapshot?.slots).toHaveLength(6);
    expect(degraded.health.reasons.map(({ code }) => code)).toContain("snapshot-stale");
  });

  it("selects an exact fresh native slot with one typed gesture", async () => {
    const runtime = new FakeRuntime(await fixture());
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    const state = await adapter.execute({
      action: "select-slot",
      slotIndex: 0,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    });
    expect(runtime.dispatches).toEqual([{
      kind: "agent",
      key: "AG00",
      index: 0,
      threadKey: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    }]);
    expect(state.stale).toBe(false);
  });

  it("does not authorize a replacement thread when the selected slot changes after dispatch", async () => {
    const first = await fixture();
    const second = await fixture();
    const nextThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const secondSlots = second.slots as Array<Record<string, unknown>>;
    secondSlots[0] = { ...secondSlots[0], threadKey: nextThreadId };
    second.activeThreadKey = nextThreadId;
    let source = first;
    const dispatches: NativeDispatch[] = [];
    const runtime: NativeMicroRuntime = {
      async readSnapshot() { return structuredClone(source); },
      async dispatch(event) {
        dispatches.push(event);
        source = second;
      },
      close() {},
    };
    const adapter = new CodexDesktopAdapter({
      runtimeFactory: async () => runtime,
      targetTransitionTimeoutMs: 4,
      targetTransitionPollMs: 1,
    });
    await expect(adapter.execute({
      action: "select-slot",
      slotIndex: 0,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    })).rejects.toMatchObject({ code: "delivery-unknown" });
    expect(dispatches).toEqual([{
      kind: "agent",
      key: "AG00",
      index: 0,
      threadKey: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    }]);
    expect(adapter.snapshot().stale).toBe(true);
    expect(adapter.snapshot().snapshot?.slots[0]?.threadId).toBe("019f7ec2-68eb-7183-bb3a-0e67312a8ba1");
  });

  it("fails closed when the expected slot thread is malformed or changed", async () => {
    const runtime = new FakeRuntime(await fixture());
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await expect(adapter.execute({ action: "select-slot", slotIndex: 0, expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2" })).rejects.toMatchObject({ code: "thread-changed" });
    await expect(adapter.execute({ action: "select-slot", slotIndex: 0, expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1;alert(1)" })).rejects.toMatchObject({ code: "invalid-thread-key" });
    expect(runtime.dispatches).toEqual([]);
  });

  it("never resolves approval decisions to generic native HID actions", async () => {
    const runtime = new FakeRuntime(await fixture());
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await expect(adapter.execute({
      action: "invoke-control",
      control: "approve",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "control-not-configured" });
    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT07",
      expectedKeycapId: "APPR",
      expectedNativeCommandId: "approval.accept",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "control-not-configured" });

    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 1,
      slot: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.fast",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "thread-changed" });
    expect(runtime.dispatches).toEqual([]);
  });

  it("dispatches a skill through its explicitly configured live joystick assignment", async () => {
    const runtime = new FakeRuntime(await fixture());
    const adapter = new CodexDesktopAdapter({
      runtimeFactory: async () => runtime,
      controlBindings: { "skill-1": { kind: "joystick", direction: "down", assignment: { type: "command", commandId: "skill.one" } } }
    });
    await adapter.execute({ action: "invoke-control", control: "skill-1", expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1" });
    expect(runtime.dispatches[0]).toEqual({
      kind: "joystick",
      direction: "down",
      expectedAssignment: { type: "command", commandId: "skill.one" },
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    });
  });

  it("allows an allowlisted command moved to another live joystick direction", async () => {
    const raw = await fixture();
    raw.joystickLayout = {
      up: { direction: "up", type: "command", commandId: "nav.back" },
      right: { direction: "right", type: "command", commandId: "nav.forward" },
      down: { direction: "down", type: "command", commandId: "skill.one" },
      left: { direction: "left", type: "command", commandId: "mode.plan" },
    };
    const runtime = new FakeRuntime(raw);
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });

    await adapter.execute({
      action: "invoke-joystick",
      direction: "left",
      expectedAssignment: { type: "command", commandId: "mode.plan" },
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    });

    expect(runtime.dispatches[0]).toMatchObject({
      kind: "joystick",
      direction: "left",
      expectedAssignment: { type: "command", commandId: "mode.plan" },
    });
  });

  it("invokes an arbitrary configured action slot only while its live assignment still matches", async () => {
    const runtime = new FakeRuntime(await fixture());
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.fast",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    });
    expect(runtime.dispatches[0]).toEqual({
      kind: "action",
      expectedAgentSlot: 0,
      slot: "ACT06",
      key: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.fast",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    });

    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "A_DIFFERENT_ASSIGNMENT",
      expectedNativeCommandId: "mode.fast",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "control-not-configured" });

    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.changed-behind-same-keycap",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "control-not-configured" });
    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: null,
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "control-not-configured" });
  });

  it("never positively attributes a stable interleaved selection to navigation", async () => {
    const first = await fixture();
    const second = await fixture();
    const nextThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const secondSlots = second.slots as Array<Record<string, unknown>>;
    secondSlots[0] = { ...secondSlots[0], selected: false };
    secondSlots[1] = {
      ...secondSlots[1],
      threadKey: nextThreadId,
      title: "Next task",
      status: "idle",
      selected: true,
    };
    second.activeThreadKey = nextThreadId;
    let dispatched = false;
    let postDispatchReads = 0;
    const dispatches: NativeDispatch[] = [];
    const runtime: NativeMicroRuntime = {
      async readSnapshot() {
        if (!dispatched || postDispatchReads++ === 0) return structuredClone(first);
        return structuredClone(second);
      },
      async dispatch(event) {
        dispatches.push(event);
        dispatched = true;
      },
      close() {},
    };
    const adapter = new CodexDesktopAdapter({
      runtimeFactory: async () => runtime,
      targetTransitionTimeoutMs: 20,
      targetTransitionPollMs: 1,
    });
    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "right",
      expectedAssignment: { type: "command", commandId: "nav.changed-behind-same-keycap" },
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "control-not-configured" });
    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "right",
      expectedAssignment: { type: "command", commandId: "nav.forward" },
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "delivery-unknown" });
    expect(dispatches[0]).toEqual({
      kind: "joystick",
      direction: "right",
      expectedAssignment: { type: "command", commandId: "nav.forward" },
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    });
    expect(adapter.snapshot().snapshot?.activeThreadId).toBe(nextThreadId);
    expect(adapter.snapshot().stale).toBe(false);
    expect(postDispatchReads).toBeGreaterThanOrEqual(3);
  });

  it("keeps fork and navigation delivery untrusted while the old selection remains visible", async () => {
    const threadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
    const cases = [
      {
        action: "invoke-action-slot" as const,
        expectedAgentSlot: 0 as const,
        slot: "ACT09" as const,
        expectedKeycapId: "SPLIT",
        expectedNativeCommandId: "thread.fork",
        expectedThreadId: threadId,
      },
      {
        action: "invoke-joystick" as const,
        direction: "left" as const,
        expectedAssignment: { type: "command" as const, commandId: "nav.back" },
        expectedThreadId: threadId,
      },
    ];
    for (const command of cases) {
      const runtime = new FakeRuntime(await fixture());
      const adapter = new CodexDesktopAdapter({
        runtimeFactory: async () => runtime,
        targetTransitionTimeoutMs: 4,
        targetTransitionPollMs: 1,
      });
      await expect(adapter.execute(command)).rejects.toMatchObject({ code: "delivery-unknown" });
      expect(runtime.dispatches).toHaveLength(1);
      expect(adapter.snapshot().stale).toBe(true);
      expect(adapter.snapshot().health.reasons).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "delivery-unknown" }),
      ]));
    }
  });

  it("rejects exact-match unknown future action and joystick assignments", async () => {
    const raw = await fixture();
    raw.actionLayout = [
      { slot: "ACT06", keycapId: "FUTURE", commandId: "future.action" },
      { slot: "ACT07", keycapId: "FAST", commandId: "mode.fast" },
      { slot: "ACT08", keycapId: "SPLIT", commandId: "thread.fork" },
      { slot: "ACT09", keycapId: "MIC", commandId: "dictation.toggle" },
      { slot: "ACT10_ACT11", keycapId: "CODEX", commandId: "composer.submit" },
      { slot: "ACT12", keycapId: "FAST", commandId: "mode.fast" },
    ];
    raw.joystickLayout = {
      up: { direction: "up", type: "command", commandId: "future.joystick" },
      right: { direction: "right", type: "command", commandId: "nav.forward" },
      down: { direction: "down", type: "command", commandId: "skill.one" },
      left: { direction: "left", type: "command", commandId: "nav.back" },
    };
    const runtime = new FakeRuntime(raw);
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "FUTURE",
      expectedNativeCommandId: "future.action",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    })).rejects.toMatchObject({ code: "control-not-configured" });
    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "up",
      expectedAssignment: { type: "command", commandId: "future.joystick" },
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    })).rejects.toMatchObject({ code: "control-not-configured" });
    expect(runtime.dispatches).toEqual([]);
  });

  it("blocks action, joystick, and reasoning HID while the selected slot awaits approval", async () => {
    const raw = await fixture();
    const slots = raw.slots as Array<Record<string, unknown>>;
    slots[0] = { ...slots[0], status: "awaiting-approval" };
    const runtime = new FakeRuntime(raw);
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    const expectedThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.fast",
      expectedThreadId,
    })).rejects.toMatchObject({ code: "control-not-configured" });
    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "left",
      expectedAssignment: { type: "command", commandId: "nav.back" },
      expectedThreadId,
    })).rejects.toMatchObject({ code: "control-not-configured" });
    await expect(adapter.execute({
      action: "invoke-control",
      control: "reasoning-increase",
      expectedThreadId,
    })).rejects.toMatchObject({ code: "control-not-configured" });
    expect(runtime.dispatches).toEqual([]);
  });

  it("refuses direct slot and joystick commands when their native handlers are not proven", async () => {
    const raw = await fixture();
    raw.handlers = { hid: false, joystick: false };
    const runtime = new FakeRuntime(raw);
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await expect(adapter.execute({
      action: "invoke-action-slot",
      expectedAgentSlot: 0,
      slot: "ACT06",
      expectedKeycapId: "FAST",
      expectedNativeCommandId: "mode.fast",
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "action-handler-unavailable" });
    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "right",
      expectedAssignment: { type: "command", commandId: "nav.forward" },
      expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    })).rejects.toMatchObject({ code: "joystick-handler-unavailable" });
    expect(runtime.dispatches).toEqual([]);
  });
});

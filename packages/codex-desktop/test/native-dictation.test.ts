import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CodexDesktopAdapter,
  CodexDesktopAdapterError,
  isAllowlistedNativeAction,
  type DesktopProcessIdentity,
  type NativeDispatch,
  type NativeMicroRuntime,
} from "../src/index.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 4242,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleId: "com.openai.chatgpt",
};

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL("./fixtures/native-six.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function dictationCommand() {
  return {
    action: "invoke-action-slot" as const,
    expectedAgentSlot: 0 as const,
    slot: "ACT10_ACT11" as const,
    expectedKeycapId: "MIC",
    expectedNativeCommandId: "dictation.toggle",
    expectedThreadId: THREAD_ID,
  };
}

describe("native Codex dictation", () => {
  it("allowlists the exact MIC slot with both legacy and current command identity shapes", () => {
    expect(isAllowlistedNativeAction("ACT10_ACT11", "MIC", "dictation.toggle")).toBe(true);
    expect(isAllowlistedNativeAction("ACT10_ACT11", "VOICE", "dictation.toggle")).toBe(false);
    expect(isAllowlistedNativeAction("ACT10_ACT11", "MIC", "composer.dictate")).toBe(false);
    expect(isAllowlistedNativeAction("ACT10_ACT11", "MIC", null)).toBe(true);
  });

  it("dispatches one exact native Micro gesture to the attested Desktop generation", async () => {
    const dispatches: NativeDispatch[] = [];
    const runtime: NativeMicroRuntime = {
      desktopIdentity: DESKTOP_IDENTITY,
      async readSnapshot() { return structuredClone(await fixture()); },
      async dispatch(event) { dispatches.push(event); },
      close() {},
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    let authorityChecks = 0;

    await adapter.execute(
      dictationCommand(),
      () => { authorityChecks += 1; },
      DESKTOP_IDENTITY,
    );

    expect(authorityChecks).toBe(1);
    expect(dispatches).toEqual([{
      kind: "action",
      expectedAgentSlot: 0,
      slot: "ACT10_ACT11",
      key: "ACT10",
      expectedKeycapId: "MIC",
      expectedNativeCommandId: "dictation.toggle",
      expectedThreadId: THREAD_ID,
    }]);
  });

  it("fails before dispatch when the native HID handler is not observed", async () => {
    const raw = await fixture();
    raw.handlers = { hid: false, joystick: true };
    const dispatches: NativeDispatch[] = [];
    const runtime: NativeMicroRuntime = {
      desktopIdentity: DESKTOP_IDENTITY,
      async readSnapshot() { return structuredClone(raw); },
      async dispatch(event) { dispatches.push(event); },
      close() {},
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });

    await expect(adapter.execute(
      dictationCommand(),
      () => undefined,
      DESKTOP_IDENTITY,
    )).rejects.toMatchObject({ code: "action-handler-unavailable" });
    expect(dispatches).toEqual([]);
  });

  it("reports delivery-unknown without retrying when the one gesture may have partially fired", async () => {
    const dispatches: NativeDispatch[] = [];
    const runtime: NativeMicroRuntime = {
      desktopIdentity: DESKTOP_IDENTITY,
      async readSnapshot() { return structuredClone(await fixture()); },
      async dispatch(event) {
        dispatches.push(event);
        throw new CodexDesktopAdapterError(
          "delivery-unknown",
          "The dictation gesture may have partially fired.",
        );
      },
      close() {},
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });

    await expect(adapter.execute(
      dictationCommand(),
      () => undefined,
      DESKTOP_IDENTITY,
    )).rejects.toMatchObject({ code: "delivery-unknown" });
    expect(dispatches).toHaveLength(1);
    expect(adapter.snapshot().health.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "delivery-unknown" }),
    ]));
  });
});

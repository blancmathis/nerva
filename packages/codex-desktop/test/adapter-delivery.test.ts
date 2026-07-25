import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  CodexDesktopAdapter,
  CodexDesktopAdapterError,
  type DesktopProcessIdentity,
  type NativeDispatch,
  type NativeMicroRuntime,
} from "../src/index.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const OTHER_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
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

describe("CodexDesktopAdapter native delivery propagation", () => {
  it("preserves delivery-unknown from a dispatch that may have fired", async () => {
    const snapshot = JSON.parse(
      await readFile(new URL("./fixtures/native-six.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const runtime: NativeMicroRuntime = {
      readSnapshot: async () => structuredClone(snapshot),
      dispatch: async (_event: NativeDispatch) => {
        throw new CodexDesktopAdapterError(
          "delivery-unknown",
          "Renderer disconnected after Runtime.evaluate dispatch.",
        );
      },
      close: () => undefined,
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });

    await expect(adapter.execute({
      action: "invoke-control",
      control: "fast",
      expectedThreadId: THREAD_ID,
    })).rejects.toMatchObject({ code: "delivery-unknown" });
    const state = adapter.snapshot();
    expect(state.stale).toBe(true);
    expect(state.health.status).toBe("degraded");
    expect(state.health.reasons.map((reason) => reason.code)).toContain("delivery-unknown");
  });

  it("clears a target-transition latch after a definitive pre-fire rejection", async () => {
    const snapshot = JSON.parse(
      await readFile(new URL("./fixtures/native-six.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const runtime: NativeMicroRuntime = {
      readSnapshot: async () => structuredClone(snapshot),
      dispatch: async () => {
        throw new CodexDesktopAdapterError(
          "native-discovery-failed",
          "Renderer rejected the gesture before any native event fired.",
        );
      },
      close: () => undefined,
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });

    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "right",
      expectedAssignment: { type: "command", commandId: "nav.forward" },
      expectedThreadId: THREAD_ID,
    })).rejects.toMatchObject({ code: "native-discovery-failed" });

    const recovered = await adapter.refresh();
    expect(recovered.stale).toBe(false);
    expect(recovered.snapshot?.activeThreadId).toBe(THREAD_ID);
  });

  it("blocks a newer external selection while an old gesture may still fire in the same generation", async () => {
    const snapshot = JSON.parse(
      await readFile(new URL("./fixtures/native-six.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const runtime: NativeMicroRuntime = {
      desktopIdentity: DESKTOP_A,
      readSnapshot: async () => structuredClone(snapshot),
      dispatch: async () => {
        throw new CodexDesktopAdapterError(
          "delivery-unknown",
          "Navigation may have fired before the renderer disconnected.",
        );
      },
      close: () => undefined,
    };
    const adapter = new CodexDesktopAdapter({ runtimeFactory: async () => runtime });
    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "right",
      expectedAssignment: { type: "command", commandId: "nav.forward" },
      expectedThreadId: THREAD_ID,
    }, () => undefined, DESKTOP_A)).rejects.toMatchObject({ code: "delivery-unknown" });
    expect((await adapter.refresh(DESKTOP_A)).stale).toBe(true);

    expect(() => adapter.supersedePendingTargetTransition(DESKTOP_A)).toThrow(
      expect.objectContaining({ code: "delivery-unknown" }),
    );
    expect((await adapter.refresh(DESKTOP_A)).stale).toBe(true);
  });

  it("does not carry an unresolved target transition across Desktop generations", async () => {
    const first = JSON.parse(
      await readFile(new URL("./fixtures/native-six.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const second = structuredClone(first);
    const secondSlots = second.slots as Array<Record<string, unknown>>;
    secondSlots[0] = { ...secondSlots[0], threadKey: OTHER_THREAD_ID };
    second.activeThreadKey = OTHER_THREAD_ID;
    const runtimeA: NativeMicroRuntime = {
      desktopIdentity: DESKTOP_A,
      readSnapshot: async () => structuredClone(first),
      dispatch: async () => {
        throw new CodexDesktopAdapterError("delivery-unknown", "Navigation on A may have fired.");
      },
      close: () => undefined,
    };
    const runtimeB: NativeMicroRuntime = {
      desktopIdentity: DESKTOP_B,
      readSnapshot: async () => structuredClone(second),
      dispatch: async () => undefined,
      close: () => undefined,
    };
    const adapter = new CodexDesktopAdapter({
      runtimeFactory: async (identity) => identity?.pid === DESKTOP_B.pid ? runtimeB : runtimeA,
    });
    await expect(adapter.execute({
      action: "invoke-joystick",
      direction: "right",
      expectedAssignment: { type: "command", commandId: "nav.forward" },
      expectedThreadId: THREAD_ID,
    }, () => undefined, DESKTOP_A)).rejects.toMatchObject({ code: "delivery-unknown" });

    const rebound = await adapter.refresh(DESKTOP_B);
    expect(rebound.stale).toBe(false);
    expect(rebound.snapshot?.activeThreadId).toBe(OTHER_THREAD_ID);
  });
});

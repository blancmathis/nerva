import { describe, expect, it } from "vitest";
import { resolveControlAction } from "./App";
import type { BridgeCapabilities } from "./lib/model";

function capabilities(): BridgeCapabilities {
  return {
    commands: ["createTask"],
    microActions: [{
      actionSlot: "ACT12",
      keycapId: "keycap.native.new",
      nativeCommandId: "new-thread",
      label: "New",
      enabled: true,
    }],
    joystickActions: [],
    reasoningModes: [],
    currentReasoningMode: null,
    skills: [],
    drawing: false,
    review: false,
    reviewMaxImages: 0,
    siteCapture: { available: false, reason: null },
    libraries: [],
  };
}

describe("resolveControlAction", () => {
  it("falls back to typed createTask when a native New identity is not positively verified", () => {
    expect(resolveControlAction(capabilities(), "new", true)).toBe("semantic:createTask");
  });

  it("falls back to app-server createTask when no target is selected", () => {
    expect(resolveControlAction(capabilities(), "new", false)).toBe("semantic:createTask");
  });

  it.each([
    ["approve", "ACT07", "APPR", null],
    ["decline", "ACT08", "REJ", null],
    ["fork", "ACT09", "SPLIT", "micro:ACT09:SPLIT:thread.fork"],
  ] as const)("resolves only safe installed native %s bindings", (canonical, actionSlot, keycapId, expected) => {
    const configured: BridgeCapabilities = {
      ...capabilities(),
      commands: ["createTask", "runMicroAction"],
      microActions: [{
        actionSlot,
        keycapId,
        nativeCommandId: keycapId === "SPLIT" ? "thread.fork" : `native-${keycapId.toLowerCase()}`,
        label: keycapId,
        enabled: true,
      }],
    };

    expect(resolveControlAction(configured, canonical, true)).toBe(expected);
  });

  it("requires the exact advertised capability for selection, reasoning, joystick, and native actions", () => {
    const configured: BridgeCapabilities = {
      ...capabilities(),
      commands: ["selectAgent", "adjustReasoning", "runJoystickAction", "runMicroAction"],
      reasoningModes: ["medium", "high"],
      microActions: [{
        actionSlot: "ACT06",
        keycapId: "FAST",
        nativeCommandId: "mode.fast",
        label: "Fast",
        enabled: true,
      }],
    };

    expect(resolveControlAction(configured, "select", true)).toBe("semantic:selectAgent");
    expect(resolveControlAction(configured, "reasoning", true)).toBe("semantic:adjustReasoning");
    expect(resolveControlAction(configured, "joystick", true)).toBe("semantic:runJoystickAction");
    expect(resolveControlAction(configured, "fast", true)).toBe("micro:ACT06:FAST:mode.fast");

    const absent = { ...configured, commands: [] };
    expect(resolveControlAction(absent, "select", true)).toBeNull();
    expect(resolveControlAction(absent, "reasoning", true)).toBeNull();
    expect(resolveControlAction(absent, "joystick", true)).toBeNull();
    expect(resolveControlAction(absent, "fast", true)).toBeNull();
  });

  it("resolves Mac microphone dictation only from the exact live native identity and command capability", () => {
    const configured: BridgeCapabilities = {
      ...capabilities(),
      commands: ["runMicroAction"],
      microActions: [{
        actionSlot: "ACT10_ACT11",
        keycapId: "MIC",
        nativeCommandId: "dictation.toggle",
        label: "MIC",
        enabled: true,
      }],
    };

    expect(resolveControlAction(configured, "dictate", true)).toBe(
      "micro:ACT10_ACT11:MIC:dictation.toggle",
    );
    expect(resolveControlAction(configured, "dictate", false)).toBeNull();
    expect(resolveControlAction({ ...configured, commands: [] }, "dictate", true)).toBeNull();
  });

  it.each([
    ["VOICE", "dictation.toggle"],
    ["MIC", "composer.dictate"],
  ] as const)("rejects deceptive dictation identity %s / %s", (keycapId, nativeCommandId) => {
    const configured: BridgeCapabilities = {
      ...capabilities(),
      commands: ["runMicroAction"],
      microActions: [{
        actionSlot: "ACT10_ACT11",
        keycapId,
        nativeCommandId,
        label: "Dictate",
        enabled: true,
      }],
    };

    expect(resolveControlAction(configured, "dictate", true)).toBeNull();
  });

  it("accepts the current exact Mac dictation slot when Codex omits a command id", () => {
    const configured: BridgeCapabilities = {
      ...capabilities(),
      commands: ["runMicroAction"],
      microActions: [{
        actionSlot: "ACT10_ACT11",
        keycapId: "MIC",
        nativeCommandId: null,
        label: "MIC",
        enabled: true,
      }],
    };

    expect(resolveControlAction(configured, "dictate", true)).toBe("micro:ACT10_ACT11:MIC:");
  });

  it("resolves Send only from the exact native Codex composer binding", () => {
    const configured: BridgeCapabilities = {
      ...capabilities(),
      commands: ["runMicroAction"],
      microActions: [{
        actionSlot: "ACT12",
        keycapId: "CODEX",
        nativeCommandId: "composer.submit",
        label: "Send",
        enabled: true,
      }],
    };

    expect(resolveControlAction(configured, "send", true)).toBe("micro:ACT12:CODEX:composer.submit");
    expect(resolveControlAction(configured, "send", false)).toBeNull();
    expect(resolveControlAction({
      ...configured,
      microActions: [{ ...configured.microActions[0]!, nativeCommandId: "turn/start" }],
    }, "send", true)).toBeNull();
  });
});

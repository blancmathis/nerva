import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CodexDesktopAdapterError, parseNativeSnapshot, projectNativeStatus } from "../src/index.js";

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("./fixtures/native-six.json", import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("native Micro snapshot projection", () => {
  it("strictly projects all six slots and live capability context", async () => {
    const parsed = parseNativeSnapshot(await fixture(), 123);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.snapshot.slots.map(({ key }) => key)).toEqual(["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"]);
    expect(parsed.snapshot.slots[0].activityAt).toBe(Date.parse("2026-07-20T09:30:00.000Z"));
    expect(parsed.snapshot.slots[0].activityLabel).toBeNull();
    expect(parsed.snapshot.slots[1].activityAt).toBe(1_784_540_000_000);
    expect(parsed.snapshot.slots[5].activityLabel).toBeNull();
    expect(parsed.snapshot.agentSource).toBe("priority");
    expect(parsed.snapshot.actionLayout?.map(({ slot }) => slot)).toEqual(["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"]);
    expect(Object.keys(parsed.snapshot.joystickLayout ?? {})).toEqual(["up", "right", "down", "left"]);
    expect(parsed.snapshot.joystickLayout?.up).toEqual({
      direction: "up",
      type: "command",
      commandId: "mode.plan",
    });
    expect(parsed.snapshot.reasoning).toEqual({ effort: "high", adjustable: true });
    expect(parsed.snapshot.theme).toBe("dark");
    expect(parsed.snapshot.capabilities).toEqual({
      activeThread: true,
      activity: true,
      agentSource: true,
      composerAttachment: true,
      actionLayout: true,
      actionControl: true,
      joystickLayout: true,
      joystickControl: true,
      reasoning: true,
      reasoningControl: true,
      theme: true
    });
  });

  it.each([
    { type: "keycap", commandId: "mode.plan" },
    { type: "command" },
    { keycapId: "PLAN", commandId: "mode.plan" },
    { type: "command", commandId: "bad\u0000id" },
  ])("rejects a non-exact layout-v1 joystick assignment: %o", async (invalid) => {
    const raw = await fixture();
    (raw.joystickLayout as Record<string, unknown>).up = { direction: "up", ...invalid };

    const parsed = parseNativeSnapshot(raw, 123);

    expect(parsed.snapshot.joystickLayout).toBeNull();
    expect(parsed.warnings).toContainEqual(expect.objectContaining({ code: "joystick-layout-unavailable" }));
  });

  it("projects an unknown status as degraded instead of guessing", async () => {
    const raw = await fixture();
    (raw.slots as Array<Record<string, unknown>>)[2]!.status = "future-native-state";
    const parsed = parseNativeSnapshot(raw, 123);
    expect(parsed.snapshot.slots[2].status).toBe("degraded");
    expect(parsed.warnings).toContainEqual(expect.objectContaining({ code: "unknown-status", slotKey: "AG02" }));
    expect(projectNativeStatus("future-native-state").known).toBe(false);
  });

  it.each([
    ["running", "working"],
    ["input", "awaiting-response"],
  ] as const)("keeps the native %s alias while projecting the canonical %s state", async (nativeStatus, status) => {
    const raw = await fixture();
    (raw.slots as Array<Record<string, unknown>>)[0]!.status = nativeStatus;

    const parsed = parseNativeSnapshot(raw, 123);

    expect(parsed.snapshot.slots[0]).toMatchObject({ nativeStatus, status });
    expect(parsed.warnings).not.toContainEqual(expect.objectContaining({ code: "unknown-status", slotKey: "AG00" }));
  });

  it("degrades only absent optional native capabilities", async () => {
    const raw = await fixture();
    delete raw.actionLayout;
    delete raw.joystickLayout;
    delete raw.reasoning;
    delete raw.theme;
    delete (raw.slots as Array<Record<string, unknown>>)[1]!.activityAt;
    raw.handlers = { hid: false, joystick: false };
    const parsed = parseNativeSnapshot(raw, 123);
    expect(parsed.snapshot.slots).toHaveLength(6);
    expect(parsed.snapshot.actionLayout).toBeNull();
    expect(parsed.snapshot.capabilities.activity).toBe(false);
    expect(parsed.warnings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "activity-unavailable",
      "action-layout-unavailable",
      "action-handler-unavailable",
      "joystick-layout-unavailable",
      "joystick-handler-unavailable",
      "reasoning-unavailable",
      "theme-unavailable"
    ]));
  });

  it("drops every activity label without falling back to prompt or transcript content", async () => {
    const raw = await fixture();
    const slots = raw.slots as Array<Record<string, unknown>>;
    slots[0]!.activityLabel = "Dictated prompt: publish the private draft";
    slots[1]!.currentActionLabel = "Transcript: send the unreleased plan";
    slots[2]!.prompt = "private prompt content";
    const parsed = parseNativeSnapshot(raw, 123);
    expect(JSON.stringify(parsed.snapshot)).not.toContain("private draft");
    expect(JSON.stringify(parsed.snapshot)).not.toContain("unreleased plan");
    expect(JSON.stringify(parsed.snapshot)).not.toContain("private prompt content");
    expect(parsed.snapshot.slots[0].activityLabel).toBeNull();
    expect(parsed.snapshot.slots[1].activityLabel).toBeNull();
    expect(parsed.snapshot.slots[2].activityLabel).toBeNull();
  });

  it("rejects non-six and duplicate slot sets", async () => {
    const tooShort = await fixture();
    (tooShort.slots as unknown[]).pop();
    expect(() => parseNativeSnapshot(tooShort, 123)).toThrowError(expect.objectContaining({ code: "invalid-slot-count" }));

    const duplicate = await fixture();
    const slots = duplicate.slots as Array<Record<string, unknown>>;
    slots[5] = { ...slots[4] };
    expect(() => parseNativeSnapshot(duplicate, 123)).toThrowError(expect.objectContaining({ code: "invalid-slot-key" }));
  });

  it("rejects malformed thread keys", async () => {
    const raw = await fixture();
    (raw.slots as Array<Record<string, unknown>>)[0]!.threadKey = "../../not-a-thread";
    expect(() => parseNativeSnapshot(raw, 123)).toThrow(CodexDesktopAdapterError);
    expect(() => parseNativeSnapshot(raw, 123)).toThrowError(expect.objectContaining({ code: "invalid-thread-key" }));
  });
});

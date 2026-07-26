import { describe, expect, it } from "vitest";
import {
  buildFixedComposerAttachmentExpression,
  buildFixedComposerBatchAttachmentExpression,
  buildFixedDispatchExpression,
  FIXED_NATIVE_SNAPSHOT_EXPRESSION,
} from "../src/renderer-expression.js";

const EXPECTED_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const TEMP_THREAD_KEY = "local:client-new-thread:18db55f3-f40e-4ad0-a812-82e5ae0e2092";
const ACTION_IDENTITY = {
  expectedAgentSlot: 0,
  expectedKeycapId: "FAST",
  expectedNativeCommandId: "mode.fast",
} as const;

function rendererNamespace(
  dispatchHostMessage: (message: unknown) => void,
  readLayout: () => unknown = () => ({
    version: 1,
    slots: { ACT06: { keycapId: "FAST", commandId: "mode.fast" } },
    analogStick: { left: { type: "command", commandId: "nav.back" } },
  }),
) {
  const layout = { key: "codex-micro-layout", default: null };
  const getSetting = async (definition: unknown) => {
    void "get-setting";
    return definition === layout ? readLayout() : null;
  };
  return {
    nativeBus: {
      handlers: new Map([
        ["codex-micro-hid-event", new Set([true])],
        ["codex-micro-joystick-event", new Set([true])],
      ]),
      dispatchHostMessage,
    },
    definitions: { layout },
    getSetting,
  };
}

function liveReactRoot(
  readThreadId: (index: number) => string | null = (index) => index === 0 ? EXPECTED_THREAD_ID : null,
  readStatus: (index: number) => string = (index) => index === 0 ? "idle" : "off",
  readSelected: (index: number) => boolean = (index) => index === 0,
): Record<string, unknown> {
  const memoizedProps: Record<string, unknown> = {};
  Object.defineProperty(memoizedProps, "slots", {
    configurable: true,
    get: () => [0, 1, 2, 3, 4, 5].map((index) => ({
      index,
      key: `AG0${index}`,
      threadId: readThreadId(index),
      status: readStatus(index),
      selected: readSelected(index),
    })),
  });
  return {
    "__reactFiber$codexPadTest": {
      memoizedProps,
      child: null,
      sibling: null,
    },
  };
}

describe("fixed renderer expressions", () => {
  it("builds one bounded batch paste without any composer submission primitive", () => {
    const expression = buildFixedComposerBatchAttachmentExpression({
      expectedThreadId: EXPECTED_THREAD_ID,
      images: [1, 2].map((index) => ({
        expectedThreadId: EXPECTED_THREAD_ID,
        fileName: `Nerva Board ${String(index).padStart(2, "0")}-detail.png` as const,
        pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      })),
    });
    expect(expression).toContain("transfer.items.add");
    expect(expression).toContain("new ClipboardEvent('paste'");
    expect(expression).toContain("CODEX_PAD_BATCH_NONE:");
    expect(expression).toContain("CODEX_PAD_BATCH_PARTIAL:");
    expect(expression).not.toMatch(/requestSubmit|\.submit\(|keydown|turn\/start/u);
  });

  it("appends one image through the exact composer paste handler without submitting", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalFile = Object.getOwnPropertyDescriptor(globalThis, "File");
    const originalDataTransfer = Object.getOwnPropertyDescriptor(globalThis, "DataTransfer");
    const originalClipboardEvent = Object.getOwnPropertyDescriptor(globalThis, "ClipboardEvent");
    const attachedNames: string[] = [];
    let submitCount = 0;
    const pasteTarget = {
      parentElement: null,
      "__reactProps$codexPadTest": {
        onPaste(event: { preventDefault(): void; clipboardData: { files: ArrayLike<{ name: string }> } }) {
          event.preventDefault();
          attachedNames.push(event.clipboardData.files[0]?.name ?? "");
        },
        onSubmit() { submitCount += 1; },
      },
      dispatchEvent(event: { clipboardData: unknown }) {
        this["__reactProps$codexPadTest"].onPaste(event as never);
        return false;
      },
    };
    const addControl = { parentElement: pasteTarget };
	    const sidebarSignal = { getAttribute: () => TEMP_THREAD_KEY };
	    const composerSignal = { getAttribute: () => EXPECTED_THREAD_ID };
    const removeButton = { getAttribute: (name: string) => name === "aria-label" ? "Remove Codex Pad Drawing.png" : null };

    class TestFile {
      readonly name: string;
      constructor(_parts: unknown[], name: string) { this.name = name; }
    }
    class TestDataTransfer {
      readonly files: TestFile[] = [];
      readonly items = { add: (file: TestFile) => { this.files.push(file); } };
    }
    class TestClipboardEvent {
      defaultPrevented = false;
      readonly clipboardData: TestDataTransfer;
      constructor(_type: string, init: { clipboardData: TestDataTransfer }) {
        this.clipboardData = init.clipboardData;
      }
      preventDefault() { this.defaultPrevented = true; }
    }

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
	        querySelector: (selector: string) => selector.includes("sidebar-thread-id") ? sidebarSignal : composerSignal,
        querySelectorAll: (selector: string) => selector.includes("add-context")
          ? [addControl]
          : selector === "button" && attachedNames.length > 0 ? [removeButton] : [],
      },
    });
    Object.defineProperty(globalThis, "File", { configurable: true, value: TestFile });
    Object.defineProperty(globalThis, "DataTransfer", { configurable: true, value: TestDataTransfer });
    Object.defineProperty(globalThis, "ClipboardEvent", { configurable: true, value: TestClipboardEvent });

    try {
      const expression = buildFixedComposerAttachmentExpression({
        expectedThreadId: EXPECTED_THREAD_ID,
        fileName: "Codex Pad Drawing.png",
        pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XqZ8WQAAAABJRU5ErkJggg==",
      });
      await expect((0, eval)(expression) as Promise<unknown>).resolves.toBe(true);
      expect(attachedNames).toEqual(["Codex Pad Drawing.png"]);
      expect(submitCount).toBe(0);
      expect(expression).not.toContain("composer.submit");
      expect(expression).not.toContain("turn/start");
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalFile) Object.defineProperty(globalThis, "File", originalFile);
      else Reflect.deleteProperty(globalThis, "File");
      if (originalDataTransfer) Object.defineProperty(globalThis, "DataTransfer", originalDataTransfer);
      else Reflect.deleteProperty(globalThis, "DataTransfer");
      if (originalClipboardEvent) Object.defineProperty(globalThis, "ClipboardEvent", originalClipboardEvent);
      else Reflect.deleteProperty(globalThis, "ClipboardEvent");
    }
  });

  it("discovers Vite and webpack modules without caller-supplied JavaScript", () => {
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).toContain("performance.getEntriesByType('resource')");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).toContain("webpackChunk");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).toContain("new Set(indexes).size === 6");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).toContain("codex-micro-agent-source");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).toContain("analogStick");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).toContain("activityAt");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).not.toContain("activityLabel");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).not.toContain("currentActionLabel");
    expect(FIXED_NATIVE_SNAPSHOT_EXPRESSION).not.toContain("actionLabel");
  });

  it("does not accept module-exported slots as live snapshot routing authority", async () => {
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const staleSlots = [0, 1, 2, 3, 4, 5].map((index) => ({
      index,
      key: `AG0${index}`,
      threadId: index === 0 ? EXPECTED_THREAD_ID : null,
      status: index === 0 ? "idle" : "off",
      selected: index === 0,
    }));
    const root = { "__reactFiber$codexPadTest": { memoizedProps: {}, child: null, sibling: null } };
    fixtureGlobals.__codexPadImportFixture = async () => ({ staleDefault: { slots: staleSlots } });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [],
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });

    try {
      const expression = FIXED_NATIVE_SNAPSHOT_EXPRESSION.replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
        "Six live Codex Micro slots were not found.",
      );
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("uses the current sidebar task for navigation even when it is outside the native six", async () => {
    const otherThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const originalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    const root = liveReactRoot();
    const documentElement = { dataset: {}, className: "" };
    const body = { dataset: {}, className: "" };
    let sidebarThreadId = EXPECTED_THREAD_ID;
    let composerThreadId = otherThreadId;
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace(() => undefined);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement,
        body,
        querySelectorAll: () => [],
        querySelector: (selector: string) => selector.includes("sidebar-thread-id")
          ? { getAttribute: () => sidebarThreadId }
          : selector.includes("above-composer")
            ? { getAttribute: () => composerThreadId }
            : null,
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: () => ({ colorScheme: "dark", backgroundColor: "rgb(0, 0, 0)" }),
    });

    try {
      const expression = FIXED_NATIVE_SNAPSHOT_EXPRESSION.replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      const snapshot = await ((0, eval)(expression) as Promise<Record<string, unknown>>);
      expect(snapshot.activeThreadKey).toBe(EXPECTED_THREAD_ID);
      expect(snapshot.activeThreadObserved).toBe(true);

      sidebarThreadId = otherThreadId;
      composerThreadId = EXPECTED_THREAD_ID;
      const outsideNativeSix = await ((0, eval)(expression) as Promise<Record<string, unknown>>);
      expect(outsideNativeSix.activeThreadKey).toBe(otherThreadId);
      expect(outsideNativeSix.activeThreadObserved).toBe(true);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      if (originalGetComputedStyle) Object.defineProperty(globalThis, "getComputedStyle", originalGetComputedStyle);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("ignores non-canonical auxiliary DOM signals when the selected native slot is exact", async () => {
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const originalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    const root = liveReactRoot();
    const documentElement = { dataset: {}, className: "" };
    const body = { dataset: {}, className: "" };
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace(() => undefined);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement,
        body,
        querySelectorAll: () => [],
        querySelector: (selector: string) => selector.includes("sidebar-thread-id")
          ? { getAttribute: () => "local:client-new-thread" }
          : null,
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: () => ({ colorScheme: "dark", backgroundColor: "rgb(0, 0, 0)" }),
    });

    try {
      const expression = FIXED_NATIVE_SNAPSHOT_EXPRESSION.replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      const snapshot = await ((0, eval)(expression) as Promise<Record<string, unknown>>);
      expect(snapshot.activeThreadKey).toBe(EXPECTED_THREAD_ID);
      expect(snapshot.activeThreadObserved).toBe(true);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      if (originalGetComputedStyle) Object.defineProperty(globalThis, "getComputedStyle", originalGetComputedStyle);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("reconciles an exact selected client-new-thread slot with its canonical live composer", async () => {
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const originalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    const root = liveReactRoot((index) => index === 0 ? TEMP_THREAD_KEY : null);
    const documentElement = { dataset: {}, className: "" };
    const body = { dataset: {}, className: "" };
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace(() => undefined);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement,
        body,
        querySelectorAll: () => [],
        querySelector: (selector: string) => selector.includes("sidebar-thread-id")
          ? { getAttribute: () => TEMP_THREAD_KEY }
          : selector.includes("above-composer")
            ? { getAttribute: () => EXPECTED_THREAD_ID }
            : null,
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: () => ({ colorScheme: "dark", backgroundColor: "rgb(0, 0, 0)" }),
    });

    try {
      const expression = FIXED_NATIVE_SNAPSHOT_EXPRESSION.replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      const snapshot = await ((0, eval)(expression) as Promise<{ activeThreadKey: string | null; slots: Array<{ threadKey: string | null }> }>);
      expect(snapshot.activeThreadKey).toBe(EXPECTED_THREAD_ID);
      expect(snapshot.slots[0]?.threadKey).toBe(EXPECTED_THREAD_ID);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      if (originalGetComputedStyle) Object.defineProperty(globalThis, "getComputedStyle", originalGetComputedStyle);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("emits distinct validated HID, joystick, and reasoning event families", () => {
    const action = buildFixedDispatchExpression({ kind: "action", slot: "ACT06", key: "ACT06", ...ACTION_IDENTITY, expectedThreadId: EXPECTED_THREAD_ID });
    const joystick = buildFixedDispatchExpression({ kind: "joystick", direction: "left", expectedAssignment: { type: "command", commandId: "nav.back" }, expectedThreadId: EXPECTED_THREAD_ID });
    const reasoning = buildFixedDispatchExpression({ kind: "reasoning", direction: "increase", key: "ENC_CC", expectedThreadId: EXPECTED_THREAD_ID });
    expect(action).toContain("codex-micro-hid-event");
    expect(action).not.toContain("codex-micro-joystick-event')?.size");
    expect(joystick).toContain("codex-micro-joystick-event");
    expect(joystick).toContain("\"angle\":0.5");
    expect(reasoning).toContain("\"act\":2");
  });

  it("keeps native Dictation pressed until a separately authorized end gesture", () => {
    const identity = {
      kind: "action" as const,
      expectedAgentSlot: 0 as const,
      slot: "ACT10_ACT11" as const,
      key: "ACT10" as const,
      expectedKeycapId: "MIC",
      expectedNativeCommandId: "dictation.toggle",
      expectedThreadId: EXPECTED_THREAD_ID,
    };
    const begin = buildFixedDispatchExpression({ ...identity, gesture: "begin" });
    const end = buildFixedDispatchExpression({ ...identity, gesture: "end" });
    expect(begin).toContain("\"act\":1");
    expect(begin).not.toContain("\"act\":0");
    expect(end).toContain("\"act\":0");
    expect(end).not.toContain("\"act\":1");
  });

  it("always releases a fork gesture when its press synchronously changes the selected task", async () => {
    const nextThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    let activeThreadId = EXPECTED_THREAD_ID;
    let selectedIndex = 0;
    const dispatched: Array<{ event?: { act?: number } }> = [];
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot(
      (index) => index === 0 ? EXPECTED_THREAD_ID : index === 1 ? nextThreadId : null,
      (index) => index < 2 ? "idle" : "off",
      (index) => index === selectedIndex,
    );
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace(
      (message) => {
        const typed = message as { event?: { act?: number } };
        dispatched.push(typed);
        if (typed.event?.act === 1) {
          activeThreadId = nextThreadId;
          selectedIndex = 1;
        }
      },
      () => ({
        version: 1,
        slots: { ACT09: { keycapId: "SPLIT", commandId: "thread.fork" } },
        analogStick: {},
      }),
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [],
        querySelector: () => ({ getAttribute: () => activeThreadId }),
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });
    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        expectedAgentSlot: 0,
        slot: "ACT09",
        key: "ACT09",
        expectedKeycapId: "SPLIT",
        expectedNativeCommandId: "thread.fork",
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).resolves.toBe(true);
      expect(dispatched.map((message) => message.event?.act)).toEqual([1, 0]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("always releases navigation when its press synchronously changes the selected task", async () => {
    const nextThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    let activeThreadId = EXPECTED_THREAD_ID;
    let selectedIndex = 0;
    const dispatched: Array<{ event?: { distance?: number } }> = [];
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot(
      (index) => index === 0 ? EXPECTED_THREAD_ID : index === 1 ? nextThreadId : null,
      (index) => index < 2 ? "idle" : "off",
      (index) => index === selectedIndex,
    );
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace(
      (message) => {
        const typed = message as { event?: { distance?: number } };
        dispatched.push(typed);
        if (typed.event?.distance === 1) {
          activeThreadId = nextThreadId;
          selectedIndex = 1;
        }
      },
      () => ({
        version: 1,
        slots: {},
        analogStick: { right: { type: "command", commandId: "nav.forward" } },
      }),
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [],
        querySelector: () => ({ getAttribute: () => activeThreadId }),
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });
    try {
      const expression = buildFixedDispatchExpression({
        kind: "joystick",
        direction: "right",
        expectedAssignment: { type: "command", commandId: "nav.forward" },
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).resolves.toBe(true);
      expect(dispatched.map((message) => message.event?.distance)).toEqual([1, 0]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("fails closed before dispatch when sidebar and composer signals disagree", async () => {
    const otherThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const dispatches: unknown[] = [];
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: (selector: string) => selector.includes("sidebar-thread-id")
          ? { getAttribute: () => EXPECTED_THREAD_ID }
          : selector.includes("above-composer")
            ? { getAttribute: () => otherThreadId }
            : null,
      },
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId: EXPECTED_THREAD_ID,
      });
      await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
        "Active Codex thread changed before native dispatch.",
      );
      expect(dispatches).toEqual([]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("dispatches only when the selected client-new-thread slot, sidebar, and canonical composer agree", async () => {
    const dispatches: unknown[] = [];
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot((index) => index === 0 ? TEMP_THREAD_KEY : null);
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace((message) => dispatches.push(message));
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [],
        querySelector: (selector: string) => selector.includes("sidebar-thread-id")
          ? { getAttribute: () => TEMP_THREAD_KEY }
          : selector.includes("above-composer")
            ? { getAttribute: () => EXPECTED_THREAD_ID }
            : null,
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).resolves.toBe(true);
      expect(dispatches).toHaveLength(2);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("fails closed when the active DOM thread changes during asynchronous module discovery", async () => {
    const expectedThreadId = EXPECTED_THREAD_ID;
    const otherThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const dispatches: unknown[] = [];
    let activeThreadId = expectedThreadId;
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot();

    fixtureGlobals.__codexPadImportFixture = async () => {
      await Promise.resolve();
      activeThreadId = otherThreadId;
      return rendererNamespace((message) => dispatches.push(message));
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getAttribute: () => activeThreadId }),
        querySelectorAll: () => [],
        getElementById: (id: string) => id === "root" ? root : null,
      }
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: {
        getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }]
      }
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId
      });
      const instrumentedExpression = expression.replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);"
      );
      expect(instrumentedExpression).not.toBe(expression);
      const evaluation = (0, eval)(instrumentedExpression) as Promise<unknown>;

      await expect(evaluation).rejects.toThrow("Active Codex thread changed before native dispatch.");
      expect(dispatches).toEqual([]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("fires no native event when asynchronous discovery outlives the renderer pre-fire deadline", async () => {
    const dispatches: unknown[] = [];
    let now = 1_000;
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const originalDateNow = Date.now;
    const root = liveReactRoot();
    fixtureGlobals.__codexPadImportFixture = async () => {
      now = 6_001;
      return rendererNamespace((message) => dispatches.push(message));
    };
    Date.now = () => now;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [],
        querySelector: () => ({ getAttribute: () => EXPECTED_THREAD_ID }),
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });
    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
        "Codex native dispatch expired before any event fired.",
      );
      expect(dispatches).toEqual([]);
    } finally {
      Date.now = originalDateNow;
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("finishes an already-started action release when the active thread changes on press", async () => {
    const expectedThreadId = EXPECTED_THREAD_ID;
    const otherThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const dispatches: Array<{ event?: { act?: number } }> = [];
    let activeThreadId = expectedThreadId;
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot();

    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace((message) => {
      dispatches.push(message as { event?: { act?: number } });
      activeThreadId = otherThreadId;
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getAttribute: () => activeThreadId }),
        querySelectorAll: () => [],
        getElementById: (id: string) => id === "root" ? root : null,
      }
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] }
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);"
      );
      const evaluation = (0, eval)(expression) as Promise<unknown>;

      await expect(evaluation).resolves.toBe(true);
      expect(dispatches.map((message) => message.event?.act)).toEqual([1, 0]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("finishes an already-started selection release when the slot changes on press", async () => {
    const otherThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const dispatches: Array<{ event?: { act?: number } }> = [];
    let slotThreadId = EXPECTED_THREAD_ID;
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot((index) => index === 0 ? slotThreadId : null);
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace((message) => {
      dispatches.push(message as { event?: { act?: number } });
      slotThreadId = otherThreadId;
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [],
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "agent",
        key: "AG00",
        index: 0,
        threadKey: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).resolves.toBe(true);
      expect(dispatches.map((message) => message.event?.act)).toEqual([1, 0]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("fails closed when the exact action agent slot changes during discovery", async () => {
    const otherThreadId = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
    const dispatches: unknown[] = [];
    let slotThreadId = EXPECTED_THREAD_ID;
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot((index) => index === 0 ? slotThreadId : null);
    fixtureGlobals.__codexPadImportFixture = async () => {
      await Promise.resolve();
      slotThreadId = otherThreadId;
      return rendererNamespace((message) => dispatches.push(message));
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getAttribute: () => EXPECTED_THREAD_ID }),
        querySelectorAll: () => [],
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
        "Codex native agent slot changed before action dispatch.",
      );
      expect(dispatches).toEqual([]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("blocks action, joystick, and reasoning HID when the selected live slot awaits approval", async () => {
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const root = liveReactRoot(undefined, (index) => index === 0 ? "awaiting-approval" : "off");
    const dispatches: unknown[] = [];
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace((message) => dispatches.push(message));
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getAttribute: () => EXPECTED_THREAD_ID }),
        querySelectorAll: () => [],
        getElementById: (id: string) => id === "root" ? root : null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });
    const events = [
      { kind: "action", slot: "ACT06", key: "ACT06", ...ACTION_IDENTITY, expectedThreadId: EXPECTED_THREAD_ID },
      { kind: "joystick", direction: "left", expectedAssignment: { type: "command", commandId: "nav.back" }, expectedThreadId: EXPECTED_THREAD_ID },
      { kind: "reasoning", direction: "increase", key: "ENC_CC", expectedThreadId: EXPECTED_THREAD_ID },
    ] as const;

    try {
      for (const event of events) {
        const expression = buildFixedDispatchExpression(event).replace(
          "const namespace = await import(url);",
          "const namespace = await globalThis.__codexPadImportFixture(url);",
        );
        await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
          "Generic native controls are locked while an exact approval is pending.",
        );
      }
      expect(dispatches).toEqual([]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("fails closed when the exact native assignment changes during module discovery", async () => {
    const dispatches: unknown[] = [];
    let nativeCommandId: string = ACTION_IDENTITY.expectedNativeCommandId;
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");

    fixtureGlobals.__codexPadImportFixture = async () => {
      await Promise.resolve();
      nativeCommandId = "mode.rebound-behind-same-keycap";
      return rendererNamespace(
        (message) => dispatches.push(message),
        () => ({
          version: 1,
          slots: { ACT06: { keycapId: ACTION_IDENTITY.expectedKeycapId, commandId: nativeCommandId } },
          analogStick: {},
        }),
      );
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getAttribute: () => EXPECTED_THREAD_ID }),
        querySelectorAll: () => [],
        getElementById: () => null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
        "Codex native action assignment changed before dispatch.",
      );
      expect(dispatches).toEqual([]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it.each([
    { type: "command", commandId: "nav.rebound" },
    { type: "keycap", commandId: "nav.back" },
  ])("fires no joystick event when the live v1 assignment changes to %o", async (liveAssignment) => {
    const dispatches: unknown[] = [];
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    fixtureGlobals.__codexPadImportFixture = async () => rendererNamespace(
      (message) => dispatches.push(message),
      () => ({
        version: 1,
        slots: {},
        analogStick: { left: liveAssignment },
      }),
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getAttribute: () => EXPECTED_THREAD_ID }),
        querySelectorAll: () => [],
        getElementById: () => null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "joystick",
        direction: "left",
        expectedAssignment: { type: "command", commandId: "nav.back" },
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
        "Codex native joystick assignment changed before dispatch.",
      );
      expect(dispatches).toEqual([]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("does not trust a static module layout when no live reader is available", async () => {
    const dispatches: unknown[] = [];
    const fixtureGlobals = globalThis as typeof globalThis & {
      __codexPadImportFixture?: (url: string) => Promise<unknown>;
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
    fixtureGlobals.__codexPadImportFixture = async () => {
      const { getSetting: _liveReader, ...withoutLiveReader } = rendererNamespace((message) => dispatches.push(message));
      return {
        ...withoutLiveReader,
        staleDefaultLayout: {
          version: 1,
          slots: { ACT06: { keycapId: "FAST", commandId: "mode.fast" } },
          analogStick: {},
        },
      };
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({ getAttribute: () => EXPECTED_THREAD_ID }),
        querySelectorAll: () => [],
        getElementById: () => null,
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ name: "https://codex.invalid/assets/native.js" }] },
    });

    try {
      const expression = buildFixedDispatchExpression({
        kind: "action",
        slot: "ACT06",
        key: "ACT06",
        ...ACTION_IDENTITY,
        expectedThreadId: EXPECTED_THREAD_ID,
      }).replace(
        "const namespace = await import(url);",
        "const namespace = await globalThis.__codexPadImportFixture(url);",
      );
      await expect((0, eval)(expression) as Promise<unknown>).rejects.toThrow(
        "Codex native action assignment changed before dispatch.",
      );
      expect(dispatches).toEqual([]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
      else Reflect.deleteProperty(globalThis, "performance");
      Reflect.deleteProperty(fixtureGlobals, "__codexPadImportFixture");
    }
  });

  it("rejects malformed or non-canonical UUID dispatches", () => {
    expect(() => buildFixedDispatchExpression({
      kind: "agent",
      key: "AG00",
      index: 0,
      threadKey: "019F7EC2-68EB-7183-BB3A-0E67312A8BA1"
    })).toThrowError(expect.objectContaining({ code: "invalid-thread-key" }));
    expect(() => buildFixedDispatchExpression({
      kind: "agent",
      key: "AG00",
      index: 0,
      threadKey: "019f7ec2-68eb7183-bb3a-0e67312a8ba1-"
    })).toThrowError(expect.objectContaining({ code: "invalid-thread-key" }));
    expect(() => buildFixedDispatchExpression({ kind: "action", slot: "ACT07", key: "ACT08", ...ACTION_IDENTITY, expectedThreadId: EXPECTED_THREAD_ID })).toThrowError(expect.objectContaining({ code: "control-not-configured" }));
    expect(() => buildFixedDispatchExpression({
      kind: "action",
      expectedAgentSlot: 0,
      slot: "ACT06",
      key: "ACT06",
      expectedKeycapId: "FUTURE",
      expectedNativeCommandId: "future.action",
      expectedThreadId: EXPECTED_THREAD_ID,
    })).toThrowError(expect.objectContaining({ code: "control-not-configured" }));
    expect(() => buildFixedDispatchExpression({
      kind: "joystick",
      direction: "up",
      expectedAssignment: { type: "command", commandId: "future.joystick" },
      expectedThreadId: EXPECTED_THREAD_ID,
    })).toThrowError(expect.objectContaining({ code: "control-not-configured" }));
    expect(() => buildFixedDispatchExpression({
      kind: "action",
      expectedAgentSlot: 0,
      slot: "ACT07",
      key: "ACT07",
      expectedKeycapId: "APPROVE",
      expectedNativeCommandId: "native:approve",
      expectedThreadId: EXPECTED_THREAD_ID,
    })).toThrowError(expect.objectContaining({ code: "control-not-configured" }));
    expect(() => buildFixedDispatchExpression({ kind: "reasoning", direction: "increase", key: "ENC_CW", expectedThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1" })).toThrowError(expect.objectContaining({ code: "control-not-configured" }));
  });
});

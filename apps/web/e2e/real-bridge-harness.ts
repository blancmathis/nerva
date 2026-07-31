import { createServer } from "node:net";
import type {
  AdapterState,
  CodexDesktopAdapter,
  DesktopProcessIdentity,
  SemanticCommand,
} from "@codex-pad/codex-desktop";
import { startBridge, type BridgeHandle } from "@codex-pad/bridge";
import type {
  NativeMutationAuthorityToken,
  ThreadSnapshot,
  ThreadTransport,
} from "../../bridge/src/thread-transport.js";

export const REAL_BRIDGE_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
export const REAL_BRIDGE_COMMAND_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8bd1";
export const REAL_BRIDGE_PAIRING_ORIGIN = "https://pad.example.test";

const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 4242,
  startedAt: "2026-07-30T00:00:00.000Z",
  appPath: "/Applications/Codex.app",
  executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  bundleId: "com.openai.codex",
};

function deterministicAdapterState(): AdapterState {
  const slots = [0, 1, 2, 3, 4, 5].map((index) => ({
    index,
    key: `AG0${index}`,
    threadId: index === 0 ? REAL_BRIDGE_THREAD_ID : null,
    title: index === 0 ? "Real bridge integration" : null,
    status: index === 0 ? "idle" : "off",
    nativeStatus: index === 0 ? "idle" : "off",
    selected: index === 0,
    activityAt: index === 0 ? Date.parse("2026-07-30T12:00:00.000Z") : null,
    activityLabel: null,
  })) as NonNullable<AdapterState["snapshot"]>["slots"];

  return {
    stale: false,
    health: { status: "ready", reasons: [], changedAt: Date.parse("2026-07-30T12:00:00.000Z") },
    snapshot: {
      slots,
      activeThreadId: REAL_BRIDGE_THREAD_ID,
      agentSource: "pinned",
      actionLayout: [
        { slot: "ACT06", keycapId: "FAST", commandId: "mode.fast" },
        { slot: "ACT07", keycapId: "APPR", commandId: "approval.accept" },
        { slot: "ACT08", keycapId: "REJ", commandId: "approval.reject" },
        { slot: "ACT09", keycapId: "SPLIT", commandId: "thread.fork" },
        { slot: "ACT10_ACT11", keycapId: "MIC", commandId: "dictation.toggle" },
        { slot: "ACT12", keycapId: "CODEX", commandId: "composer.submit" },
      ],
      joystickLayout: {
        up: { direction: "up", type: "command", commandId: "mode.plan" },
        right: { direction: "right", type: "command", commandId: "nav.forward" },
        down: { direction: "down", type: "command", commandId: "skill.one" },
        left: { direction: "left", type: "command", commandId: "nav.back" },
      },
      reasoning: { effort: "high", adjustable: true },
      theme: "dark",
      capabilities: {
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
        theme: true,
      },
      observedAt: Date.parse("2026-07-30T12:00:00.000Z"),
    },
  };
}

function deterministicThreadSnapshot(): ThreadSnapshot {
  return {
    threadId: REAL_BRIDGE_THREAD_ID,
    status: "idle",
    activeTurnId: null,
    cwd: "/private/tmp/nerva-real-bridge-fixture",
    refreshedAt: "2026-07-30T12:00:00.000Z",
    raw: { threadSettings: { model: "gpt-test", effort: "high" } },
  };
}

export interface RealBridgeHarness {
  readonly handle: BridgeHandle;
  readonly adapterCommands: readonly SemanticCommand[];
  readonly transportSelections: readonly string[];
}

export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve).once("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (port === 0) throw new Error("Could not reserve a loopback port for the real bridge harness");
  return port;
}

export async function startRealBridgeHarness(options: {
  readonly dataRoot: string;
  readonly webRoot: string;
  readonly port: number;
}): Promise<RealBridgeHarness> {
  const adapterCommands: SemanticCommand[] = [];
  const transportSelections: string[] = [];
  const nativePermits = new WeakSet<object>();
  const state = deterministicAdapterState();
  const thread = deterministicThreadSnapshot();

  const adapter = {
    async refresh() { return state; },
    snapshot() { return state; },
    async execute(command: SemanticCommand, authorize?: () => void) {
      authorize?.();
      adapterCommands.push(command);
      return state;
    },
    async attachImageToComposer(_attachment: unknown, authorize?: () => void) {
      authorize?.();
      return state;
    },
    close() {},
  } as unknown as CodexDesktopAdapter;

  const transport: ThreadTransport = {
    async acquireNativeMutationAuthority(guard) {
      await guard?.(DESKTOP_IDENTITY);
      const authority = Object.freeze({});
      nativePermits.add(authority);
      return {
        authority: authority as NativeMutationAuthorityToken,
        desktopIdentity: DESKTOP_IDENTITY,
      };
    },
    consumeNativeMutationAuthority(authority) {
      if (!nativePermits.delete(authority as object)) throw new Error("The deterministic native permit was already consumed");
    },
    async health() {
      return {
        mode: "injected-test-transport" as const,
        connected: true,
        initialized: true,
        selectedThreadId: REAL_BRIDGE_THREAD_ID,
        localImageSteerVerified: true,
        multiImageInputVerified: false,
        desktopOwnershipVerified: true,
        serverUserAgent: "nerva-real-bridge-e2e",
        queuedSketches: 0,
      };
    },
    async selectThread(threadId, assertTargetAuthority) {
      await assertTargetAuthority(DESKTOP_IDENTITY);
      transportSelections.push(threadId);
      return thread;
    },
    clearSelectedThread() {},
    async threadRead() { return thread; },
    async resumeThread() { return thread; },
    async listSessions() {
      return [{
        threadId: REAL_BRIDGE_THREAD_ID,
        title: "Real bridge integration",
        cwd: thread.cwd,
        updatedAt: Date.parse("2026-07-30T12:00:00.000Z"),
        status: "idle" as const,
      }];
    },
    async sendSketch() {},
    async sendReview() {},
    async runLibraryCommand() {},
    async startTurn() {},
    async steerTurn() {},
    async newThread() { return thread; },
    async forkThread() { return thread; },
    async setReasoning() {},
    async setModelReasoning() {},
    async listModels() {
      return [{
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      }];
    },
    async readCodexUsage() {
      return {
        fetchedAt: Date.parse("2026-07-30T12:00:00.000Z"),
        planType: "pro",
        limitName: "Codex",
        primary: { usedPercent: 23, windowMinutes: 300, resetsAt: Date.parse("2026-07-30T17:00:00.000Z") },
        secondary: { usedPercent: 51, windowMinutes: 10_080, resetsAt: Date.parse("2026-08-06T12:00:00.000Z") },
        credits: null,
        rateLimitReached: false,
      };
    },
    async listSkills() { return []; },
    async invokeSkill() {},
    listPendingApprovals() { return []; },
    async approve() {},
    async reject() {},
  };

  const handle = await startBridge({
    host: "127.0.0.1",
    port: options.port,
    dataRoot: options.dataRoot,
    webRoot: options.webRoot,
    publicOrigin: REAL_BRIDGE_PAIRING_ORIGIN,
    // The production origin stays HTTPS. The harness reaches that same bridge
    // through one ephemeral loopback origin, which must be explicitly
    // allowlisted for authenticated HTTP mutations and the WebSocket ticket.
    allowedOrigins: [`http://127.0.0.1:${options.port}`],
    adapter,
    transport,
    codexVersion: "codex-cli 0.146.0-real-bridge-e2e",
    refreshIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    siteCaptureService: null,
    openExactThread: async () => undefined,
    openBrowserTabs: async () => ({
      tabs: [],
      detail: "No browser tabs are required for the real bridge integration harness.",
      capabilities: {
        discovery: { available: true, reason: null },
        open: { available: true, reason: null },
        control: { available: true, reason: null },
      },
    }),
    logger: {
      warn(message) {
        if (!message.includes("Context Room")) console.warn(message);
      },
      error(message) { console.error(message); },
    },
  });
  await handle.state.refresh();
  return { handle, adapterCommands, transportSelections };
}

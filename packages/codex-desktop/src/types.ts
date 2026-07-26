export const MICRO_SLOT_KEYS = ["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"] as const;

export type MicroSlotKey = (typeof MICRO_SLOT_KEYS)[number];
export type MicroSlotIndex = 0 | 1 | 2 | 3 | 4 | 5;

export type MicroStatus =
  | "off"
  | "idle"
  | "working"
  | "unread"
  | "awaiting-approval"
  | "awaiting-response"
  | "error"
  | "degraded";

export interface MicroSlot {
  readonly index: MicroSlotIndex;
  readonly key: MicroSlotKey;
  readonly threadId: string | null;
  readonly title: string | null;
  readonly status: MicroStatus;
  readonly nativeStatus: string;
  readonly selected: boolean;
  readonly activityAt: number | null;
  /** Deliberately redacted: renderer activity text may contain prompt or dictation content. */
  readonly activityLabel: null;
}

export type SixMicroSlots = readonly [MicroSlot, MicroSlot, MicroSlot, MicroSlot, MicroSlot, MicroSlot];

export interface MicroSnapshot {
  readonly slots: SixMicroSlots;
  readonly activeThreadId: string | null;
  readonly agentSource: AgentSource | null;
  readonly actionLayout: NativeActionLayout | null;
  readonly joystickLayout: NativeJoystickLayout | null;
  readonly reasoning: NativeReasoningState | null;
  readonly theme: NativeTheme | null;
  readonly capabilities: NativeCapabilities;
  readonly observedAt: number;
}

export type AgentSource = "pinned" | "recent" | "priority" | "custom";
export type NativeTheme = "light" | "dark";

export const NATIVE_ACTION_SLOTS = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"] as const;
export type NativeActionSlot = (typeof NATIVE_ACTION_SLOTS)[number];

export const JOYSTICK_DIRECTIONS = ["up", "right", "down", "left"] as const;
export type JoystickDirection = (typeof JOYSTICK_DIRECTIONS)[number];

export interface NativeAssignment {
  readonly keycapId: string;
  readonly commandId: string | null;
}

export interface NativeActionAssignment extends NativeAssignment {
  readonly slot: NativeActionSlot;
}

export type NativeActionLayout = readonly [
  NativeActionAssignment,
  NativeActionAssignment,
  NativeActionAssignment,
  NativeActionAssignment,
  NativeActionAssignment,
  NativeActionAssignment
];

export interface NativeJoystickAssignment {
  readonly direction: JoystickDirection;
  /** Exact Codex layout-v1 assignment discriminant; no keycap identity exists for joystick directions. */
  readonly type: "command";
  readonly commandId: string;
}

export type NativeJoystickLayout = Readonly<Record<JoystickDirection, NativeJoystickAssignment>>;

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "ultra" | "max";

export interface NativeReasoningState {
  readonly effort: ReasoningEffort;
  readonly adjustable: boolean;
}

export interface NativeCapabilities {
  readonly activeThread: boolean;
  readonly activity: boolean;
  readonly agentSource: boolean;
  readonly composerAttachment: boolean;
  readonly actionLayout: boolean;
  readonly actionControl: boolean;
  readonly joystickLayout: boolean;
  readonly joystickControl: boolean;
  readonly reasoning: boolean;
  readonly reasoningControl: boolean;
  readonly theme: boolean;
}

export type HealthStatus = "ready" | "degraded" | "offline";

export type HealthReasonCode =
  | "awaiting-snapshot"
  | "desktop-not-installed"
  | "cdp-unavailable"
  | "target-not-found"
  | "cdp-connection-failed"
  | "delivery-unknown"
  | "native-discovery-failed"
  | "invalid-slot-count"
  | "invalid-slot-key"
  | "invalid-thread-key"
  | "invalid-selection"
  | "unknown-status"
  | "activity-unavailable"
  | "active-thread-unavailable"
  | "agent-source-unavailable"
  | "composer-attachment-unavailable"
  | "action-layout-unavailable"
  | "action-handler-unavailable"
  | "joystick-layout-unavailable"
  | "joystick-handler-unavailable"
  | "reasoning-unavailable"
  | "reasoning-control-unavailable"
  | "theme-unavailable"
  | "snapshot-stale"
  | "control-not-configured"
  | "mutation-authority-stale"
  | "thread-changed";

export interface HealthReason {
  readonly code: HealthReasonCode;
  readonly message: string;
  readonly slotKey?: MicroSlotKey;
}

export interface AdapterHealth {
  readonly status: HealthStatus;
  readonly reasons: readonly HealthReason[];
  readonly changedAt: number;
}

export interface AdapterState {
  readonly snapshot: MicroSnapshot | null;
  readonly health: AdapterHealth;
  /** True only when `snapshot` is the last healthy value after a failed refresh. */
  readonly stale: boolean;
}

export const SEMANTIC_CONTROLS = [
  "fast",
  "approve",
  "reject",
  "fork",
  "dictate",
  "send",
  "new-task",
  "reasoning-increase",
  "reasoning-decrease",
  "skill-1",
  "skill-2",
  "skill-3",
  "skill-4"
] as const;

export type SemanticControl = (typeof SEMANTIC_CONTROLS)[number];

export const NATIVE_CONTROL_IDENTIFIERS = [
  "ACT06",
  "ACT07",
  "ACT08",
  "ACT09",
  "ACT10",
  "ACT12",
  "ENC_CW",
  "ENC_CC"
] as const;

export type NativeControlIdentifier = (typeof NATIVE_CONTROL_IDENTIFIERS)[number];

export type NativeControlTarget =
  | {
      readonly kind: "action";
      readonly slot: NativeActionSlot;
      /** The live keycap identity that must still occupy this slot. */
      readonly keycapId: string;
    }
  | {
      readonly kind: "joystick";
      readonly direction: JoystickDirection;
      /** The live layout-v1 command identity that must still occupy this direction. */
      readonly assignment: Pick<NativeJoystickAssignment, "type" | "commandId">;
    }
  | {
      readonly kind: "reasoning";
      readonly direction: "increase" | "decrease";
    };

export type ControlBindings = Readonly<Partial<Record<SemanticControl, NativeControlTarget>>>;

export type SemanticCommand =
  | {
      readonly action: "select-slot";
      readonly slotIndex: MicroSlotIndex;
      readonly expectedThreadId: string;
    }
  | {
      readonly action: "invoke-control";
      readonly control: SemanticControl;
      readonly expectedThreadId: string;
    }
  | {
      readonly action: "invoke-action-slot";
      readonly expectedAgentSlot: MicroSlotIndex;
      readonly slot: NativeActionSlot;
      readonly expectedKeycapId: string;
      readonly expectedNativeCommandId: string | null;
      readonly expectedThreadId: string;
      readonly gesture?: "tap" | "begin" | "end";
    }
  | {
      readonly action: "invoke-joystick";
      readonly direction: JoystickDirection;
      readonly expectedAssignment: Pick<NativeJoystickAssignment, "type" | "commandId">;
      readonly expectedThreadId: string;
    };

/** Synchronous one-shot proof consumed immediately before Runtime.evaluate. */
export type NativeDispatchAuthorityGuard = () => void;

export type NativeDispatch =
  | {
      readonly kind: "agent";
      readonly key: MicroSlotKey;
      readonly index: MicroSlotIndex;
      readonly threadKey: string;
    }
  | {
      readonly kind: "action";
      readonly expectedAgentSlot: MicroSlotIndex;
      readonly slot: NativeActionSlot;
      readonly key: Exclude<NativeControlIdentifier, "ENC_CW" | "ENC_CC">;
      readonly expectedKeycapId: string;
      readonly expectedNativeCommandId: string | null;
      readonly expectedThreadId: string;
      readonly gesture?: "tap" | "begin" | "end";
    }
  | {
      readonly kind: "joystick";
      readonly direction: JoystickDirection;
      readonly expectedAssignment: Pick<NativeJoystickAssignment, "type" | "commandId">;
      readonly expectedThreadId: string;
    }
  | {
      readonly kind: "reasoning";
      readonly direction: "increase" | "decrease";
      readonly key: "ENC_CW" | "ENC_CC";
      readonly expectedThreadId: string;
    };

export interface NativeComposerImageAttachment {
  readonly expectedThreadId: string;
  readonly fileName: "Codex Pad Drawing.png" | `Nerva Board ${string}.png`;
  readonly pngBase64: string;
}

export interface NativeComposerImageBatch {
  readonly expectedThreadId: string;
  readonly images: readonly NativeComposerImageAttachment[];
}

/** A semantic seam for tests; it intentionally exposes no arbitrary Runtime.evaluate API. */
export interface NativeMicroRuntime {
  readonly desktopIdentity?: DesktopProcessIdentity;
  readSnapshot(): Promise<unknown>;
  dispatch(event: NativeDispatch): Promise<void>;
  attachImageToComposer?(attachment: NativeComposerImageAttachment): Promise<void>;
  attachImagesToComposer?(batch: NativeComposerImageBatch): Promise<void>;
  close(): void;
}

export type NativeRuntimeFactory = (
  expectedDesktopIdentity?: DesktopProcessIdentity,
) => Promise<NativeMicroRuntime>;

export interface CodexDesktopAdapterOptions {
  readonly runtimeFactory?: NativeRuntimeFactory;
  readonly discovery?: CdpDiscoveryOptions;
  readonly controlBindings?: ControlBindings;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly random?: () => number;
  readonly logger?: (message: string) => void;
  /** Maximum time to prove a native selection-changing event settled. */
  readonly targetTransitionTimeoutMs?: number;
  /** Delay between independent post-dispatch selection observations. */
  readonly targetTransitionPollMs?: number;
}

export interface CdpTarget {
  readonly id?: string;
  readonly type: string;
  readonly title?: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface CdpCandidate {
  readonly port: number;
  readonly source:
    | "explicit"
    | "devtools-active-port"
    | "process-args"
    | "attested-process"
    | "attested-process-profile";
}

export interface DiscoveredCdpTarget {
  readonly candidate: CdpCandidate;
  readonly target: CdpTarget;
  readonly desktopIdentity?: DesktopProcessIdentity;
}

export interface DiscoveredCdpTargets {
  readonly candidate: CdpCandidate;
  /** Targets whose debugger sockets were proven to belong to the attested loopback listener. */
  readonly targets: readonly CdpTarget[];
  readonly desktopIdentity?: DesktopProcessIdentity;
}

/** Private process identity from the same verified Desktop ownership probe. */
export interface DesktopProcessIdentity {
  readonly pid: number;
  readonly startedAt: string;
  readonly appPath: string;
  readonly executablePath: string;
  readonly bundleId: "com.openai.codex" | "com.openai.chatgpt";
}

export interface CdpDiscoveryOptions {
  /** When present, ignore every endpoint not derived from this exact process. */
  readonly expectedDesktopIdentity?: DesktopProcessIdentity;
  readonly explicitPort?: number;
  readonly devToolsActivePortFiles?: readonly string[];
  /** Already-collected process command lines. Passing [] disables default process inspection. */
  readonly processArgs?: readonly string[];
  readonly inspectMacProcesses?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly readFile?: (path: string) => Promise<string>;
  readonly execFile?: (file: string, args: readonly string[]) => Promise<string>;
  readonly requestTimeoutMs?: number;
}

export interface DesktopInstallation {
  readonly appPath: string;
  readonly executablePath: string;
  readonly bundleIdentifier: "com.openai.codex" | "com.openai.chatgpt";
  readonly version: string;
  readonly build: string;
}

export interface DesktopDetectionOptions {
  readonly platform?: NodeJS.Platform;
  readonly appCandidates?: readonly string[];
  readonly access?: (path: string) => Promise<void>;
  readonly readPlistValue?: (plistPath: string, key: string) => Promise<string | null>;
}

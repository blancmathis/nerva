export const SLOT_COUNT = 6 as const;

export type SlotStatus =
  | "off"
  | "idle"
  | "working"
  | "unread"
  | "awaiting-approval"
  | "awaiting-response"
  | "error"
  | "degraded";

export type ConnectionPhase =
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline"
  | "pairing";

export type BridgeHealth = "ready" | "degraded" | "offline";

export interface AgentSlot {
  readonly slotId: string;
  readonly index: number;
  readonly title: string;
  readonly threadKey: string | null;
  readonly threadId: string | null;
  readonly suffix: string | null;
  readonly status: SlotStatus;
  readonly selected: boolean;
  /** Always null; native activity text is intentionally excluded for privacy. */
  readonly activityLabel: null;
  readonly activityAt: number | null;
  readonly nativeStatus?: string;
  readonly updatedAt?: string;
}

export interface SkillCapability {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly group?: string;
  readonly libraryId?: string;
  readonly prompt?: string;
}

export interface NativeActionBinding {
  readonly actionSlot: "ACT06" | "ACT07" | "ACT08" | "ACT09" | "ACT10_ACT11" | "ACT12";
  readonly keycapId: string | null;
  readonly nativeCommandId: string | null;
  readonly label: string | null;
  readonly enabled: boolean;
}

export interface NativeJoystickBinding {
  readonly direction: "up" | "right" | "down" | "left";
  readonly type: "command" | null;
  readonly commandId: string | null;
  readonly label: string | null;
  readonly enabled: boolean;
}

export interface LibraryCapability {
  readonly libraryId: string;
  readonly label: string;
  readonly prompt: string;
}

export interface PendingApproval {
  readonly requestId: string | number;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly kind: "commandExecution" | "fileChange" | "permissions";
  readonly actionable: boolean;
  readonly summary: string | null;
}

export interface ModelCapability {
  readonly model: string;
  readonly displayName: string;
  readonly supportedReasoningEfforts: readonly string[];
  readonly defaultReasoningEffort: string;
  readonly isDefault: boolean;
}

export interface BridgeCapabilities {
  readonly commands: readonly string[];
  readonly microActions: readonly NativeActionBinding[];
  readonly joystickActions: readonly NativeJoystickBinding[];
  readonly reasoningModes: readonly string[];
  readonly currentReasoningMode: string | null;
  readonly currentModel?: string | null;
  readonly models?: readonly ModelCapability[];
  readonly skills: readonly SkillCapability[];
  readonly drawing: boolean;
  readonly review: boolean;
  /** Exact atomic image count accepted by Review delivery: 0, 1, or 12. */
  readonly reviewMaxImages: 0 | 1 | 12;
  readonly composerAttachmentMaxImages?: 1 | 12;
  readonly siteCapture: { readonly available: boolean; readonly reason: string | null };
  readonly libraries: readonly LibraryCapability[];
}

export interface BridgeSnapshot {
  readonly bridgeInstanceId: string;
  readonly codexVersion?: string | null;
  readonly seq: number;
  readonly capturedAt: string;
  readonly theme: "light" | "dark";
  readonly health: BridgeHealth;
  readonly healthDetail: string | null;
  readonly slots: readonly AgentSlot[];
  /** Exact task currently observed in Codex Desktop; never grants mutation authority. */
  readonly activeThreadKey: string | null;
  readonly selectedSlotId: string | null;
  readonly selectedThreadKey: string | null;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly capabilities: BridgeCapabilities;
}

export interface CommandAck {
  readonly commandId: string;
  readonly ok: boolean;
  readonly pending?: boolean;
  readonly message: string;
  readonly sequence?: number;
}

export interface PairResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface SketchRequest {
  readonly commandId: string;
  readonly expectedBridgeInstanceId: string;
  readonly expectedSnapshotSeq: number;
  readonly slotId: string;
  readonly threadKey: string;
  readonly instruction: string;
  readonly png: Blob;
  readonly boardId?: string;
  readonly checkpointId?: string;
  readonly scope?: "board" | "area";
  readonly images?: readonly {
    readonly fileName: `Nerva Board ${string}.png`;
    readonly blob: Blob;
    readonly kind: "overview" | "detail" | "atlas";
    readonly tileNumber: number;
  }[];
  readonly manifest?: {
    readonly version: 1;
    readonly quality: "good" | "reduced" | "overview-detail";
    readonly overlap: number;
    readonly tiles: readonly {
      readonly tileNumber: number;
      readonly kind: "overview" | "detail" | "atlas";
      readonly minX: number;
      readonly minY: number;
      readonly maxX: number;
      readonly maxY: number;
    }[];
  };
  readonly scene?: unknown;
}

export const STATUS_LABELS: Record<SlotStatus, string> = {
  off: "Unassigned",
  idle: "Idle",
  working: "Working",
  unread: "Completed — unread",
  "awaiting-approval": "Approval required",
  "awaiting-response": "Response required",
  error: "Error",
  degraded: "Status unavailable",
};

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function threadIdFromKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return match?.[0] ?? null;
}

export function emptySlot(index: number): AgentSlot {
  return {
    slotId: `AG0${index}`,
    index,
    title: "Open channel",
    threadKey: null,
    threadId: null,
    suffix: null,
    status: "off",
    selected: false,
    activityLabel: null,
    activityAt: null,
  };
}

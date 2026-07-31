import { randomUUID } from "node:crypto";
import {
  BridgeInstanceIdSchema,
  MicroSnapshotSchema,
  PendingApprovalSchema,
  RuntimeIdentitySchema,
  type ActionAssignment,
  type ActionAssignments,
  type AgentSlot,
  type MicroSnapshot,
  type RuntimeIdentity,
} from "@codex-pad/protocol";
import type {
  AdapterState,
  CodexDesktopAdapter,
  DesktopProcessIdentity,
  MicroSlot as DesktopMicroSlot,
  MicroSnapshot as DesktopMicroSnapshot,
  NativeAssignment,
  NativeComposerImageAttachment,
  NativeComposerTextAppend,
  NativeComposerFileBatch,
  NativeJoystickAssignment,
  SemanticControl,
  NativeActionSlot,
  JoystickDirection,
} from "@codex-pad/codex-desktop";
import {
  isAllowlistedNativeAction,
  isAllowlistedNativeJoystickAction,
  nativeJoystickLabel,
} from "@codex-pad/codex-desktop";
import {
  createExactTargetAuthorityDomain,
  ExactTargetAuthorityError,
  type ExactTargetAuthorityIssuer,
  type ExactTargetAuthorityToken,
} from "./exact-target-authority.js";
import type {
  NativeMutationAuthority,
  NativeMutationAuthorityToken,
  ModelInfo,
  SkillInfo,
  ThreadSnapshot,
  ThreadTransport,
  TransportHealth,
} from "./thread-transport.js";
import { skillGroupId } from "./skill-groups.js";
import { BRIDGE_RUNTIME_IDENTITY } from "./runtime-identity.js";

export class SnapshotConflictError extends Error {
  readonly code: "STALE_SNAPSHOT" | "TARGET_MISMATCH" | "ADAPTER_DEGRADED";
  readonly statusCode = 409;
  constructor(code: SnapshotConflictError["code"], message: string) {
    super(message);
    this.name = "SnapshotConflictError";
    this.code = code;
  }
}

export interface StateServiceOptions {
  adapter: CodexDesktopAdapter;
  transport: ThreadTransport;
  bridgeInstanceId?: string;
  codexVersion?: string | null;
  runtimeIdentity?: RuntimeIdentity;
  now?: () => number;
  /** State-side half of the production exact-target authority domain. */
  targetAuthorityIssuer?: ExactTargetAuthorityIssuer;
  /** Test-only clock controls for the bounded deep-link postcondition poll. */
  selectionConfirmAttempts?: number;
  selectionConfirmPollMs?: number;
  /** Bounded app-server task/Skills catalog cadence; task changes still invalidate immediately. */
  skillsRefreshIntervalMs?: number;
}

export interface BridgeCapabilities {
  codexVersion: string | null;
  commands: readonly string[];
  reasoningModes: readonly string[];
  currentReasoningMode: string | null;
  currentModel: string | null;
  models: readonly ModelInfo[];
  skills: readonly { id: string; label: string; description: string; enabled: boolean; group: string }[];
  drawing: boolean;
  /** Fail-closed native composer batch capability; 12 only after exact Desktop attestation. */
  composerAttachmentMaxImages: 1 | 12;
  review: boolean;
  reviewMaxImages: 0 | 1 | 12;
  multiImageInputVerified: boolean;
  desktopOwnershipVerified: boolean;
}

/** Privacy-safe proof inputs for the authenticated runtime diagnostics view. */
export interface BridgeRuntimeProof {
  readonly slotsAuthoritative: boolean;
  readonly selectedAuthoritative: boolean;
  readonly transportConnected: boolean;
  readonly transportInitialized: boolean;
  readonly lastNativeProofAt: number | null;
  readonly skillsCatalogLoadedAt: number | null;
  readonly modelsCatalogLoadedAt: number | null;
}

type SnapshotListener = (snapshot: MicroSnapshot) => void;
type TargetSelectionTransition = {
  readonly expectedThreadId: string;
  readonly desktopIdentity: DesktopProcessIdentity;
  consecutiveIdentityBoundMatches: number;
};
const REASONING_MODES = ["minimal", "low", "medium", "high", "xhigh", "ultra", "max"] as const;
const SELECTION_CONFIRM_ATTEMPTS = 25;
const SELECTION_CONFIRM_POLL_MS = 200;
const DEFAULT_SKILLS_REFRESH_INTERVAL_MS = 15_000;

function sameDesktopIdentity(
  left: DesktopProcessIdentity,
  right: DesktopProcessIdentity,
): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.appPath === right.appPath
    && left.executablePath === right.executablePath
    && left.bundleId === right.bundleId;
}

function matchesActiveSelection(state: AdapterState, expectedThreadId: string): boolean {
  return state.snapshot !== null
    && !state.stale
    && state.snapshot.capabilities.activeThread === true
    && state.snapshot.activeThreadId === expectedThreadId;
}

function projectVisualStatus(status: DesktopMicroSlot["status"]): AgentSlot["visualStatus"] {
  switch (status) {
    case "off": return "empty";
    case "idle": return "idle";
    case "working": return "working";
    case "unread": return "completed";
    case "awaiting-approval":
    case "awaiting-response": return "needsInput";
    case "error": return "error";
    case "degraded": return "degraded";
  }
}

function presentSlot(slot: DesktopMicroSlot, stale: boolean, selected: boolean): AgentSlot {
  return {
    slot: slot.index,
    threadId: slot.threadId,
    title: slot.title,
    nativeStatus: stale ? "bridge-stale" : slot.nativeStatus,
    visualStatus: stale ? "degraded" : projectVisualStatus(slot.status),
    selected,
    activityAt: slot.activityAt,
    activityLabel: null,
    ownedByHost: true,
  };
}

function unavailableSlots(): MicroSnapshot["slots"] {
  return [0, 1, 2, 3, 4, 5].map((slot) => ({
    slot,
    threadId: null,
    title: null,
    nativeStatus: "unavailable",
    visualStatus: "degraded",
    selected: false,
    activityAt: null,
    activityLabel: null,
    ownedByHost: true,
  })) as MicroSnapshot["slots"];
}

function emptyAssignment(): ActionAssignment {
  return { keycapId: null, nativeCommandId: null, label: null, enabled: false };
}

function presentAssignment(assignment: NativeAssignment | undefined, enabled: boolean): ActionAssignment {
  if (assignment === undefined) return emptyAssignment();
  return {
    keycapId: assignment.keycapId,
    nativeCommandId: assignment.commandId,
    label: assignment.keycapId,
    enabled,
  };
}

function emptyJoystickAssignment(): ActionAssignments["joystick"]["up"] {
  return { type: null, commandId: null, label: null, enabled: false };
}

function presentJoystickAssignment(
  assignment: NativeJoystickAssignment | undefined,
  enabled: boolean,
): ActionAssignments["joystick"]["up"] {
  if (assignment === undefined) return emptyJoystickAssignment();
  return {
    type: assignment.type,
    commandId: assignment.commandId,
    label: nativeJoystickLabel(assignment.type, assignment.commandId),
    enabled,
  };
}

const GENERIC_APPROVAL_IDENTITIES = new Set([
  "appr",
  "approve",
  "accept",
  "approvalaccept",
  "rej",
  "reject",
  "decline",
  "deny",
  "approvalreject",
]);

function isGenericApprovalIdentity(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const withoutNativePrefix = normalized.startsWith("native")
    ? normalized.slice("native".length)
    : normalized;
  return GENERIC_APPROVAL_IDENTITIES.has(normalized)
    || GENERIC_APPROVAL_IDENTITIES.has(withoutNativePrefix);
}

function isGenericApprovalAssignment(assignment: ActionAssignment): boolean {
  return isGenericApprovalIdentity(assignment.keycapId)
    || isGenericApprovalIdentity(assignment.nativeCommandId);
}

function typedApprovalRequired(snapshot: MicroSnapshot, slot: AgentSlot): boolean {
  const nativeStatus = slot.nativeStatus.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return nativeStatus.includes("approval") || snapshot.pendingApprovals.length > 0;
}

function presentAssignments(
  snapshot: DesktopMicroSnapshot | null,
  hidEnabled = true,
): ActionAssignments {
  const micro = Object.fromEntries(
    (["ACT06", "ACT07", "ACT08", "ACT09", "ACT10_ACT11", "ACT12"] as const).map((slot) => [
      slot,
      (() => {
        const assignment = snapshot?.actionLayout?.find((candidate) => candidate.slot === slot);
        return presentAssignment(
          assignment,
          hidEnabled
            && assignment !== undefined
            && isAllowlistedNativeAction(slot, assignment.keycapId, assignment.commandId),
        );
      })(),
    ]),
  ) as ActionAssignments["micro"];
  const joystick = Object.fromEntries(
    (["up", "right", "down", "left"] as const).map((direction) => [
      direction,
      (() => {
        const assignment = snapshot?.joystickLayout?.[direction];
        return presentJoystickAssignment(
          assignment,
          hidEnabled
            && assignment !== undefined
            && isAllowlistedNativeJoystickAction(direction, assignment.type, assignment.commandId),
        );
      })(),
    ]),
  ) as ActionAssignments["joystick"];
  return { micro, joystick };
}

function presentPendingApprovals(
  transport: ThreadTransport,
  selectedThreadId: string | null,
): MicroSnapshot["pendingApprovals"] {
  if (selectedThreadId === null) return [];
  const projected: MicroSnapshot["pendingApprovals"] = [];
  for (const approval of transport.listPendingApprovals(selectedThreadId)) {
    const parsed = PendingApprovalSchema.safeParse({
      requestId: approval.requestId,
      threadId: approval.threadId,
      turnId: approval.turnId,
      itemId: approval.itemId,
      kind: approval.kind,
      // Permission grant semantics are intentionally not modeled. Preserve the
      // exact bounded request only as a read-only lock signal for the selected
      // thread, even if an upstream source ever marks it actionable.
      actionable: approval.kind === "permissions" ? false : approval.actionable,
      summary: approval.summary,
    });
    if (!parsed.success || parsed.data.threadId !== selectedThreadId) continue;
    projected.push(parsed.data);
    if (projected.length === 16) break;
  }
  return projected;
}

function configuredCommands(snapshot: DesktopMicroSnapshot | null, transport: TransportHealth): string[] {
  const commands = new Set<string>();
  // Opening a validated local thread deep-link is navigation-only. It never
  // writes to the app-server and therefore remains available when shared
  // writer ownership is intentionally unavailable.
  commands.add("openSession");
  if (snapshot !== null) {
    commands.add("selectAgent");
    const exactSelectedSlot = snapshot.capabilities.activeThread === true
      && snapshot.activeThreadId !== null
      && snapshot.slots.some((slot) => (
        slot.selected && slot.threadId === snapshot.activeThreadId
      ));
    if (exactSelectedSlot && snapshot.capabilities.actionControl && snapshot.actionLayout?.some((assignment) => (
      isAllowlistedNativeAction(assignment.slot, assignment.keycapId, assignment.commandId)
    ))) {
      commands.add("runMicroAction");
    }
    if (
      exactSelectedSlot
      &&
      snapshot.capabilities.joystickControl
      && snapshot.joystickLayout !== null
      && Object.values(snapshot.joystickLayout).some((assignment) => (
        isAllowlistedNativeJoystickAction(assignment.direction, assignment.type, assignment.commandId)
      ))
    ) commands.add("runJoystickAction");
    if (
      exactSelectedSlot
      && snapshot.capabilities.reasoningControl
      && snapshot.reasoning?.adjustable
    ) commands.add("adjustReasoning");
    if (exactSelectedSlot && snapshot.capabilities.composerAttachment) {
      commands.add("sendSketch");
      commands.add("attachCaptureFiles");
    }
  }
  if (transport.connected && transport.initialized) {
    commands.add("refreshSnapshot");
    if (
      snapshot?.capabilities.activeThread === true
      && snapshot.activeThreadId !== null
      && snapshot.slots.some((slot) => slot.selected && slot.threadId === snapshot.activeThreadId)
    ) {
      commands.add("adjustReasoning");
      commands.add("setModelReasoning");
    }
  }
  if (transport.connected && transport.initialized) {
    commands.add("sendReview");
    commands.add("runLibraryCommand");
    commands.add("runSkill");
  }
  if (transport.connected && transport.initialized && transport.desktopOwnershipVerified) {
    commands.add("createTask");
  }
  return [...commands];
}

function safeReason(state: AdapterState, transport: TransportHealth): string | null {
  if (!transport.connected || !transport.initialized) return "Managed Codex app-server is unavailable";
  return state.health.reasons[0]?.message ?? null;
}

export class BridgeStateService {
  readonly adapter: CodexDesktopAdapter;
  readonly transport: ThreadTransport;
  readonly #now: () => number;
  readonly #bridgeInstanceId: string;
  readonly #codexVersion: string | null;
  readonly #runtimeIdentity: RuntimeIdentity;
  readonly #targetAuthorityIssuer: ExactTargetAuthorityIssuer;
  readonly #selectionConfirmAttempts: number;
  readonly #selectionConfirmPollMs: number;
  readonly #skillsRefreshIntervalMs: number;
  readonly #listeners = new Set<SnapshotListener>();
  #snapshot: MicroSnapshot | null = null;
  #lastNative: DesktopMicroSnapshot | null = null;
  #lastSuccessfulRefreshAt: number | null = null;
  #fingerprint = "";
  #refreshPromise: Promise<MicroSnapshot> | null = null;
  #slotsAuthoritative = false;
  #selectedAuthoritative = false;
  #targetAuthorityEpoch = 0;
  #targetAuthoritySnapshot: DesktopMicroSnapshot | null = null;
  #targetSelectionTransition: TargetSelectionTransition | null = null;
  #skills: SkillInfo[] = [];
  #skillsLoadedAt = 0;
  #skillsRefreshAttemptedAt: number | null = null;
  #skillsContextKey: string | null = null;
  #models: ModelInfo[] = [];
  #modelsLoadedAt = 0;
  #modelsRefreshAttemptedAt: number | null = null;
  #transportModel: string | null = null;
  #transportReasoningMode: (typeof REASONING_MODES)[number] | null = null;
  #transportHealth: TransportHealth = {
    mode: "managed-control-socket",
    connected: false,
    initialized: false,
    selectedThreadId: null,
    localImageSteerVerified: false,
    multiImageInputVerified: false,
    desktopOwnershipVerified: false,
    serverUserAgent: null,
    queuedSketches: 0,
  };

  constructor(options: StateServiceOptions) {
    this.adapter = options.adapter;
    this.transport = options.transport;
    this.#now = options.now ?? Date.now;
    this.#bridgeInstanceId = BridgeInstanceIdSchema.parse(options.bridgeInstanceId ?? randomUUID());
    this.#runtimeIdentity = RuntimeIdentitySchema.parse(options.runtimeIdentity ?? BRIDGE_RUNTIME_IDENTITY);
    // Standalone tests may omit the domain because no managed provider consumes
    // their tokens. Production injects a domain shared only with that provider.
    this.#targetAuthorityIssuer = options.targetAuthorityIssuer
      ?? createExactTargetAuthorityDomain().stateIssuer;
    this.#selectionConfirmAttempts = Math.max(
      2,
      Math.min(SELECTION_CONFIRM_ATTEMPTS, Math.trunc(options.selectionConfirmAttempts ?? SELECTION_CONFIRM_ATTEMPTS)),
    );
    this.#selectionConfirmPollMs = Math.max(
      0,
      Math.min(SELECTION_CONFIRM_POLL_MS, Math.trunc(options.selectionConfirmPollMs ?? SELECTION_CONFIRM_POLL_MS)),
    );
    this.#skillsRefreshIntervalMs = Math.max(
      0,
      Math.trunc(options.skillsRefreshIntervalMs ?? DEFAULT_SKILLS_REFRESH_INTERVAL_MS),
    );
    const codexVersion = options.codexVersion?.trim();
    this.#codexVersion = codexVersion !== undefined && codexVersion.length > 0 && codexVersion.length <= 100
      ? codexVersion
      : null;
  }

  current(): MicroSnapshot {
    return this.#snapshot ?? this.#buildInitial();
  }

  /** Revoke every proof and latch closed before an external target-changing sink. */
  invalidateTargetAuthority(
    expectedThreadId?: string,
    desktopIdentity?: DesktopProcessIdentity,
  ): void {
    this.#closeTargetAuthority();
    if (expectedThreadId !== undefined && desktopIdentity !== undefined) {
      // A timed-out renderer expression cannot be cancelled. Refuse a newer
      // deep-link in the same process generation until that gesture settles;
      // a different attested generation safely supersedes it.
      this.adapter.supersedePendingTargetTransition(desktopIdentity);
      this.#targetSelectionTransition = {
        expectedThreadId,
        desktopIdentity: Object.freeze({ ...desktopIdentity }),
        consecutiveIdentityBoundMatches: 0,
      };
      this.#closeSelectionControls();
    }
  }

  #closeSelectionControls(): void {
    this.#selectedAuthoritative = false;
    if (this.#snapshot === null) return;
    const snapshot = MicroSnapshotSchema.parse({
      ...this.#snapshot,
      sequence: this.#snapshot.sequence + 1,
      timestamp: this.#now(),
      slots: this.#snapshot.slots.map((slot) => ({ ...slot, selected: false })),
      activeThreadId: null,
      selectedThreadId: null,
      pendingApprovals: [],
      actionAssignments: presentAssignments(this.#lastNative, false),
    });
    this.#snapshot = snapshot;
    this.#fingerprint = "";
    for (const listener of this.#listeners) listener(snapshot);
  }

  async confirmSelectedThread(
    expectedThreadId: string,
    expectedDesktopIdentity: DesktopProcessIdentity,
  ): Promise<MicroSnapshot> {
    const transition = this.#targetSelectionTransition;
    if (
      transition === null
      || transition.expectedThreadId !== expectedThreadId
      || !sameDesktopIdentity(transition.desktopIdentity, expectedDesktopIdentity)
    ) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "The exact Desktop selection transition is no longer current",
      );
    }
    for (let attempt = 0; attempt < this.#selectionConfirmAttempts; attempt += 1) {
      const refreshOwnershipIdentity = this.transport.refreshDesktopOwnershipIdentity;
      if (refreshOwnershipIdentity !== undefined) {
        const currentDesktopIdentity = await refreshOwnershipIdentity.call(this.transport).catch(() => null);
        if (
          currentDesktopIdentity === null
          || !sameDesktopIdentity(currentDesktopIdentity, expectedDesktopIdentity)
        ) {
          this.#closeTargetAuthority();
          throw new SnapshotConflictError(
            "ADAPTER_DEGRADED",
            "The attested Desktop process changed while confirming the selected task",
          );
        }
      }
      const state = await this.adapter.refresh(expectedDesktopIdentity);
      if (refreshOwnershipIdentity !== undefined) {
        const confirmedDesktopIdentity = await refreshOwnershipIdentity.call(this.transport).catch(() => null);
        if (
          confirmedDesktopIdentity === null
          || !sameDesktopIdentity(confirmedDesktopIdentity, expectedDesktopIdentity)
        ) {
          this.#closeTargetAuthority();
          throw new SnapshotConflictError(
            "ADAPTER_DEGRADED",
            "The attested Desktop process changed while confirming the selected task",
          );
        }
      }
      if (this.#recordIdentityBoundSelectionObservation(
        state,
        transition,
        expectedThreadId,
        expectedDesktopIdentity,
      )) {
        const authorityEpoch = this.#targetAuthorityEpoch;
        const transportHealth = await this.transport.health();
        if (transportHealth.connected && transportHealth.initialized) {
          this.#skills = await this.#loadSkillsForState(state, true);
        }
        const finalDesktopIdentity = refreshOwnershipIdentity === undefined
          ? expectedDesktopIdentity
          : await refreshOwnershipIdentity.call(this.transport).catch(() => null);
        if (
          this.#targetAuthorityEpoch !== authorityEpoch
          || !transportHealth.desktopOwnershipVerified
          || finalDesktopIdentity === null
          || !sameDesktopIdentity(finalDesktopIdentity, expectedDesktopIdentity)
        ) {
          this.#closeTargetAuthority();
          throw new SnapshotConflictError(
            "ADAPTER_DEGRADED",
            "The attested Desktop process changed before selected-task confirmation completed",
          );
        }
        return this.#accept(state, transportHealth, this.#skills, expectedThreadId);
      }
      if (this.#targetSelectionTransition !== transition) break;
      if (attempt + 1 < this.#selectionConfirmAttempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.#selectionConfirmPollMs));
      }
    }
    throw new SnapshotConflictError(
      "TARGET_MISMATCH",
      "Desktop did not confirm the exact selected task after the deep-link dispatch",
    );
  }

  capabilities(): BridgeCapabilities {
    const native = this.#slotsAuthoritative ? this.#lastNative : null;
    const reasoningAvailable = this.#selectedAuthoritative
      && this.#transportHealth.connected
      && this.#transportHealth.initialized;
    const selectedSlot = this.current().slots.find((slot) => slot.selected);
    const approvalBlocksHid = selectedSlot !== undefined
      && typedApprovalRequired(this.current(), selectedSlot);
    const commands = configuredCommands(native, this.#transportHealth).filter((command) => (
      (
        !approvalBlocksHid
        || (
          command !== "runMicroAction"
          && command !== "runJoystickAction"
          && command !== "adjustReasoning"
          && command !== "setModelReasoning"
        )
      )
      && (
        this.#selectedAuthoritative
        || (
          command !== "runMicroAction"
          && command !== "runJoystickAction"
          && command !== "adjustReasoning"
          && command !== "setModelReasoning"
        )
      )
    )).filter((command) => command !== "setModelReasoning" || this.#models.length > 0);
    if (
      this.#selectedAuthoritative
      && this.current().pendingApprovals.some((approval) => approval.actionable)
    ) {
      commands.push("respondToApproval");
    }
    const drawingAttachmentAvailable = this.#selectedAuthoritative
      && native?.capabilities.composerAttachment === true;
    const reviewDeliveryAvailable = this.#selectedAuthoritative
      && this.#transportHealth.connected
      && this.#transportHealth.initialized;
    return {
      codexVersion: this.#codexVersion,
      commands,
      reasoningModes: reasoningAvailable && !approvalBlocksHid ? REASONING_MODES : [],
      currentReasoningMode: reasoningAvailable && !approvalBlocksHid
        ? this.#transportReasoningMode ?? native?.reasoning?.effort ?? null
        : null,
      currentModel: reasoningAvailable && !approvalBlocksHid ? this.#transportModel : null,
      models: reasoningAvailable && !approvalBlocksHid ? this.#models : [],
      skills: this.#skills.slice(0, 128).map((skill) => ({
        id: skill.name,
        label: skill.name,
        description: skill.description,
        enabled: skill.enabled,
        group: skillGroupId(skill),
      })),
      drawing: drawingAttachmentAvailable,
      composerAttachmentMaxImages: 1,
      review: reviewDeliveryAvailable,
      reviewMaxImages: reviewDeliveryAvailable
        ? (this.#transportHealth.multiImageInputVerified ? 12 : 1)
        : 0,
      multiImageInputVerified: this.#transportHealth.multiImageInputVerified,
      desktopOwnershipVerified: this.#transportHealth.desktopOwnershipVerified,
    };
  }

  runtimeProof(): BridgeRuntimeProof {
    return {
      slotsAuthoritative: this.#slotsAuthoritative,
      selectedAuthoritative: this.#selectedAuthoritative,
      transportConnected: this.#transportHealth.connected,
      transportInitialized: this.#transportHealth.initialized,
      lastNativeProofAt: this.#lastSuccessfulRefreshAt,
      skillsCatalogLoadedAt: this.#skillsLoadedAt > 0 ? this.#skillsLoadedAt : null,
      modelsCatalogLoadedAt: this.#modelsLoadedAt > 0 ? this.#modelsLoadedAt : null,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(): Promise<MicroSnapshot> {
    if (this.#refreshPromise !== null) return this.#refreshPromise;
    this.#refreshPromise = this.#refresh().finally(() => {
      this.#refreshPromise = null;
    });
    return this.#refreshPromise;
  }

  assertExactTarget(expectedSequence: number, threadId: string, requireSelected = true): AgentSlot {
    const snapshot = this.assertSequence(expectedSequence);
    return this.#assertCurrentExactTarget(snapshot, threadId, undefined, requireSelected);
  }

  async revalidateExactTarget(
    threadId: string,
    expectedSlot: number,
    requireSelected = true,
    expectedDesktopIdentity?: DesktopProcessIdentity,
  ): Promise<ExactTargetAuthorityToken> {
    // Mutation authority uses a dedicated, non-coalesced native observation.
    // adapter.refresh() is deliberately the final external await: unrelated
    // transport health and skill reads cannot make an older native observation
    // look write-adjacent.
    // Capture the transition generation before awaiting the renderer. A late
    // observation from an older deep-link dispatch must never help a newer
    // transition satisfy its two-observation postcondition.
    const transition = this.#targetSelectionTransition;
    const state = await this.adapter.refresh(expectedDesktopIdentity);
    const recoveredTransition = expectedDesktopIdentity === undefined
      ? (this.#recordTargetAuthorityObservation(state), false)
      : this.#recordIdentityBoundSelectionObservation(
          state,
          transition,
          threadId,
          expectedDesktopIdentity,
        );
    if (
      transition !== null
      && this.#targetSelectionTransition !== transition
      && !recoveredTransition
    ) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "A newer native selection observation superseded this target revalidation",
      );
    }
    if (this.#targetSelectionTransition !== null) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "A native selection transition is still settling; no target authority was issued",
      );
    }
    if (state.snapshot === null || state.stale) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "Native slot state is not authoritative; no target was guessed",
      );
    }
    const slot = state.snapshot.slots.find((candidate) => candidate.threadId === threadId);
    if (slot === undefined) {
      throw new SnapshotConflictError(
        "TARGET_MISMATCH",
        "The exact thread is no longer in a native Codex Micro slot",
      );
    }
    if (slot.index !== expectedSlot) {
      throw new SnapshotConflictError(
        "TARGET_MISMATCH",
        "The exact thread moved to a different native Codex Micro slot",
      );
    }
    if (
      requireSelected
      && (
        state.snapshot.capabilities.activeThread !== true
        || state.snapshot.activeThreadId !== threadId
        || !slot.selected
      )
    ) {
      throw new SnapshotConflictError(
        "TARGET_MISMATCH",
        "The exact thread is no longer the selected native Codex thread",
      );
    }
    const authorityEpoch = this.#targetAuthorityEpoch;
    return this.#targetAuthorityIssuer.issue(() => {
      if (this.#targetAuthorityEpoch !== authorityEpoch) {
        throw new ExactTargetAuthorityError();
      }
      this.#assertObservedExactTarget(threadId, expectedSlot, requireSelected);
    });
  }

  #recordTargetAuthorityObservation(state: AdapterState): void {
    // Every native observation, including a degraded one, revokes older target
    // proofs. Only a fresh authoritative snapshot can mint the next proof.
    this.#closeTargetAuthority();
    if (this.#targetSelectionTransition !== null) {
      return;
    }
    this.#targetAuthoritySnapshot = state.snapshot !== null && !state.stale
      ? state.snapshot
      : null;
  }

  #closeTargetAuthority(): void {
    this.#targetAuthorityEpoch += 1;
    this.#targetAuthoritySnapshot = null;
  }

  #recordIdentityBoundSelectionObservation(
    state: AdapterState,
    transition: TargetSelectionTransition | null,
    expectedThreadId: string,
    expectedDesktopIdentity: DesktopProcessIdentity,
  ): boolean {
    // Always revoke an older exact-target proof, but only the exact transition
    // generation, target, and Desktop process captured before the await may
    // advance recovery. Ordinary refresh() calls never enter this method and
    // therefore neither advance nor reset the confirmation counter.
    if (transition !== null && this.#targetSelectionTransition !== transition) {
      this.#closeTargetAuthority();
      return false;
    }
    this.#recordTargetAuthorityObservation(state);
    if (
      transition === null
      || this.#targetSelectionTransition !== transition
      || transition.expectedThreadId !== expectedThreadId
      || !sameDesktopIdentity(transition.desktopIdentity, expectedDesktopIdentity)
    ) {
      return false;
    }
    transition.consecutiveIdentityBoundMatches = matchesActiveSelection(state, expectedThreadId)
      ? transition.consecutiveIdentityBoundMatches + 1
      : 0;
    if (transition.consecutiveIdentityBoundMatches < 2) return false;

    this.#targetSelectionTransition = null;
    // The second bound observation is also the only snapshot eligible to back
    // newly issued exact-target authority after the recovery latch reopens.
    this.#recordTargetAuthorityObservation(state);
    return true;
  }

  #assertObservedExactTarget(
    threadId: string,
    expectedSlot: number,
    requireSelected: boolean,
  ): void {
    const snapshot = this.#targetAuthoritySnapshot;
    const slot = snapshot?.slots.find((candidate) => candidate.threadId === threadId);
    if (snapshot === null || slot === undefined || slot.index !== expectedSlot) {
      throw new ExactTargetAuthorityError();
    }
    if (
      requireSelected
      && (
        snapshot.capabilities.activeThread !== true
        || snapshot.activeThreadId !== threadId
        || !slot.selected
      )
    ) {
      throw new ExactTargetAuthorityError();
    }
  }

  #assertCurrentExactTarget(
    snapshot: MicroSnapshot,
    threadId: string,
    expectedSlot: number | undefined,
    requireSelected: boolean,
  ): AgentSlot {
    if (!this.#slotsAuthoritative) {
      throw new SnapshotConflictError("ADAPTER_DEGRADED", "Native slot state is not authoritative; no target was guessed");
    }
    const slot = snapshot.slots.find((candidate) => candidate.threadId === threadId);
    if (slot === undefined) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The exact thread is no longer in a native Codex Micro slot");
    }
    if (expectedSlot !== undefined && slot.slot !== expectedSlot) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The exact thread moved to a different native Codex Micro slot");
    }
    if (requireSelected && (!this.#selectedAuthoritative || snapshot.selectedThreadId !== threadId)) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The exact thread is no longer the selected native Codex thread");
    }
    return slot;
  }

  assertSequence(expectedSequence: number): MicroSnapshot {
    const snapshot = this.current();
    if (snapshot.sequence !== expectedSequence) {
      throw new SnapshotConflictError("STALE_SNAPSHOT", "The native slot snapshot changed; refresh before retrying");
    }
    return snapshot;
  }

  assertSnapshotIdentity(expectedBridgeInstanceId: string, expectedSequence: number): MicroSnapshot {
    const snapshot = this.current();
    if (snapshot.bridgeInstanceId !== expectedBridgeInstanceId) {
      throw new SnapshotConflictError(
        "STALE_SNAPSHOT",
        "The bridge generation changed; refresh before retrying",
      );
    }
    if (snapshot.sequence !== expectedSequence) {
      throw new SnapshotConflictError(
        "STALE_SNAPSHOT",
        "The native slot snapshot changed; refresh before retrying",
      );
    }
    return snapshot;
  }

  async selectSlot(expectedSequence: number, slotIndex: number, expectedThreadId: string): Promise<MicroSnapshot> {
    const slot = this.assertExactTarget(expectedSequence, expectedThreadId, false);
    if (slot.slot !== slotIndex) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The native slot index changed before selection");
    }
    const command = {
      action: "select-slot",
      slotIndex: slotIndex as 0 | 1 | 2 | 3 | 4 | 5,
      expectedThreadId,
    } as const;
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, slotIndex, false);
          return this.adapter.execute(command, () => this.#consumeNativeMutationAuthority(authority.authority), authority.desktopIdentity);
        })()
      : await this.adapter.execute(command);
    this.#recordTargetAuthorityObservation(state);
    if (this.#targetSelectionTransition !== null) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "A native selection transition is still settling; no target authority was issued",
      );
    }
    this.#accept(state, await this.transport.health(), this.#skills, expectedThreadId);
    const selectedThread = await this.transport.selectThread(
      expectedThreadId,
      (desktopIdentity) => this.revalidateExactTarget(
        expectedThreadId,
        slotIndex,
        true,
        desktopIdentity,
      ),
    );
    if (selectedThread !== undefined) this.observeThreadSettings(selectedThread);
    return this.refresh();
  }

  observeThreadSettings(thread: ThreadSnapshot): void {
    const rawSettings = typeof thread.raw.threadSettings === "object" && thread.raw.threadSettings !== null
      ? thread.raw.threadSettings as Record<string, unknown>
      : typeof thread.raw.settings === "object" && thread.raw.settings !== null
        ? thread.raw.settings as Record<string, unknown>
        : {};
    const model = [rawSettings.model, thread.raw.model]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const effort = [
      rawSettings.effort,
      rawSettings.reasoningEffort,
      thread.raw.effort,
      thread.raw.reasoningEffort,
    ].find((value): value is string => typeof value === "string");
    if (model !== undefined) this.#transportModel = model.trim().slice(0, 100);
    if (effort !== undefined) {
      this.#transportReasoningMode = REASONING_MODES.includes(
        effort as (typeof REASONING_MODES)[number],
      ) ? effort as (typeof REASONING_MODES)[number] : null;
    }
  }

  rememberModelReasoning(model: string, effort: string): void {
    this.#transportModel = model;
    this.#transportReasoningMode = REASONING_MODES.includes(
      effort as (typeof REASONING_MODES)[number],
    ) ? effort as (typeof REASONING_MODES)[number] : null;
  }

  async invokeNative(
    expectedSequence: number,
    expectedThreadId: string,
    control: SemanticControl,
  ): Promise<MicroSnapshot> {
    const slot = this.assertExactTarget(expectedSequence, expectedThreadId, true);
    if (typedApprovalRequired(this.current(), slot)) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "Generic native HID controls are disabled while an exact typed approval is pending",
      );
    }
    const command = { action: "invoke-control", control, expectedThreadId } as const;
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, slot.slot, true);
          return this.adapter.execute(
            command,
            () => this.#consumeNativeMutationAuthority(authority.authority),
            authority.desktopIdentity,
          );
        })()
      : await this.adapter.execute(command);
    this.#recordTargetAuthorityObservation(state);
    return this.#accept(state, await this.transport.health(), this.#skills);
  }

  async attachImageToComposer(
    expectedThreadId: string,
    expectedSlot: number,
    pngBase64: string,
    fileName: NativeComposerImageAttachment["fileName"] = "Codex Pad Drawing.png",
  ): Promise<MicroSnapshot> {
    const slot = this.#assertCurrentExactTarget(
      this.current(),
      expectedThreadId,
      expectedSlot,
      true,
    );
    if (this.#lastNative?.capabilities.composerAttachment !== true) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "The native Codex composer image attachment handler is unavailable",
      );
    }
    const attachment: NativeComposerImageAttachment = {
      expectedThreadId,
      fileName,
      pngBase64,
    };
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, slot.slot, true);
          return this.adapter.attachImageToComposer(
            attachment,
            () => this.#consumeNativeMutationAuthority(authority.authority),
            authority.desktopIdentity,
          );
        })()
      : await this.adapter.attachImageToComposer(attachment);
    this.#recordTargetAuthorityObservation(state);
    return this.#accept(state, await this.transport.health(), this.#skills);
  }

  async appendTextToComposer(
    expectedSequence: number,
    expectedThreadId: string,
    expectedSlot: number,
    text: NativeComposerTextAppend["text"],
  ): Promise<MicroSnapshot> {
    const slot = this.assertExactTarget(expectedSequence, expectedThreadId, true);
    if (slot.slot !== expectedSlot) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The selected native agent slot changed before Skills insertion");
    }
    if (this.#lastNative?.capabilities.composerAttachment !== true) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "The exact native Codex composer paste handler is unavailable",
      );
    }
    const input: NativeComposerTextAppend = { expectedThreadId, text };
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, slot.slot, true);
          return this.adapter.appendTextToComposer(
            input,
            () => this.#consumeNativeMutationAuthority(authority.authority),
            authority.desktopIdentity,
          );
        })()
      : await this.adapter.appendTextToComposer(input);
    this.#recordTargetAuthorityObservation(state);
    return this.#accept(state, await this.transport.health(), this.#skills);
  }

  async attachImagesToComposer(
    expectedThreadId: string,
    expectedSlot: number,
    images: readonly { readonly fileName: `Nerva Board ${string}.png`; readonly pngBase64: string }[],
  ): Promise<MicroSnapshot> {
    const slot = this.#assertCurrentExactTarget(this.current(), expectedThreadId, expectedSlot, true);
    if (this.#lastNative?.capabilities.composerAttachment !== true) {
      throw new SnapshotConflictError("ADAPTER_DEGRADED", "The native Codex composer image attachment handler is unavailable");
    }
    const batch = {
      expectedThreadId,
      images: images.map((image) => ({ expectedThreadId, ...image })),
    } as const;
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, slot.slot, true);
          return this.adapter.attachImagesToComposer(batch, () => this.#consumeNativeMutationAuthority(authority.authority), authority.desktopIdentity);
        })()
      : await this.adapter.attachImagesToComposer(batch);
    this.#recordTargetAuthorityObservation(state);
    return this.#accept(state, await this.transport.health(), this.#skills);
  }

  async attachFilesToComposer(
    expectedSequence: number,
    expectedThreadId: string,
    expectedSlot: number,
    files: NativeComposerFileBatch["files"],
  ): Promise<MicroSnapshot> {
    const slot = this.assertExactTarget(expectedSequence, expectedThreadId, true);
    if (slot.slot !== expectedSlot) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The selected native agent slot changed before file attachment");
    }
    if (this.#lastNative?.capabilities.composerAttachment !== true) {
      throw new SnapshotConflictError("ADAPTER_DEGRADED", "The native Codex composer file attachment handler is unavailable");
    }
    const batch: NativeComposerFileBatch = { expectedThreadId, files };
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, slot.slot, true);
          return this.adapter.attachFilesToComposer(
            batch,
            () => this.#consumeNativeMutationAuthority(authority.authority),
            authority.desktopIdentity,
          );
        })()
      : await this.adapter.attachFilesToComposer(batch);
    this.#recordTargetAuthorityObservation(state);
    return this.#accept(state, await this.transport.health(), this.#skills);
  }

  async invokeActionSlot(
    expectedSequence: number,
    expectedThreadId: string,
    agentSlot: number,
    actionSlot: NativeActionSlot,
    expectedKeycapId: string,
    expectedNativeCommandId: string | null,
    gesture: "tap" | "begin" | "end" = "tap",
  ): Promise<MicroSnapshot> {
    const slot = this.assertExactTarget(expectedSequence, expectedThreadId, true);
    if (slot.slot !== agentSlot) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The selected native agent slot changed before action dispatch");
    }
    const snapshot = this.current();
    if (typedApprovalRequired(snapshot, slot)) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "Generic native HID controls are disabled while an exact typed approval is pending",
      );
    }
    const assignment = snapshot.actionAssignments.micro[actionSlot];
    if (isGenericApprovalAssignment(assignment)) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "Approval decisions require an exact typed pending app-server request",
      );
    }
    if (
      !assignment.enabled
      || assignment.keycapId !== expectedKeycapId
      || assignment.nativeCommandId !== expectedNativeCommandId
    ) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The native action assignment changed before dispatch");
    }
    if (
      gesture !== "tap"
      && (
        actionSlot !== "ACT10_ACT11"
        || expectedKeycapId !== "MIC"
        || (expectedNativeCommandId !== "dictation.toggle" && expectedNativeCommandId !== null)
      )
    ) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "Only the exact Dictation binding supports a held native gesture");
    }
    const command = {
      action: "invoke-action-slot",
      expectedAgentSlot: agentSlot as 0 | 1 | 2 | 3 | 4 | 5,
      slot: actionSlot,
      expectedKeycapId,
      expectedNativeCommandId,
      expectedThreadId,
      ...(gesture === "tap" ? {} : { gesture }),
    } as const;
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, agentSlot, true);
          return this.adapter.execute(command, () => this.#consumeNativeMutationAuthority(authority.authority), authority.desktopIdentity);
        })()
      : await this.adapter.execute(command);
    this.#recordTargetAuthorityObservation(state);
    return this.#accept(state, await this.transport.health(), this.#skills);
  }

  async invokeJoystick(
    expectedSequence: number,
    expectedThreadId: string,
    direction: JoystickDirection,
    expectedAssignment: { readonly type: "command"; readonly commandId: string },
  ): Promise<MicroSnapshot> {
    const slot = this.assertExactTarget(expectedSequence, expectedThreadId, true);
    const snapshot = this.current();
    if (typedApprovalRequired(snapshot, slot)) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "Generic native HID controls are disabled while an exact typed approval is pending",
      );
    }
    const assignment = snapshot.actionAssignments.joystick[direction];
    if (isGenericApprovalIdentity(assignment.commandId)) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "Approval decisions require an exact typed pending app-server request",
      );
    }
    if (
      !assignment.enabled
      || assignment.type !== expectedAssignment.type
      || assignment.commandId !== expectedAssignment.commandId
    ) {
      throw new SnapshotConflictError("TARGET_MISMATCH", "The native joystick assignment changed before dispatch");
    }
    const command = {
      action: "invoke-joystick",
      direction,
      expectedAssignment,
      expectedThreadId,
    } as const;
    const state = this.#transportHealth.desktopOwnershipVerified
      ? await (async () => {
          const authority = await this.#acquireNativeMutationAuthority(expectedThreadId, slot.slot, true);
          return this.adapter.execute(command, () => this.#consumeNativeMutationAuthority(authority.authority), authority.desktopIdentity);
        })()
      : await this.adapter.execute(command);
    this.#recordTargetAuthorityObservation(state);
    return this.#accept(state, await this.transport.health(), this.#skills);
  }

  async #refresh(): Promise<MicroSnapshot> {
    const transition = this.#targetSelectionTransition;
    const nativeState = (
      transition === null
        ? this.adapter.refresh()
        : this.#recoverSelectionTransition(transition)
    ).then((state) => {
      // Revoke old target proofs in the adapter promise continuation itself,
      // before a stalled transport health or skills read can keep them live.
      // An ordinary observation is deliberately unbound. Transition recovery
      // performs its own identity-bound accounting before this continuation.
      if (transition === null) this.#recordTargetAuthorityObservation(state);
      return state;
    });
    const [state, transportHealth] = await Promise.all([
      nativeState,
      this.transport.health().catch((): TransportHealth => ({
        mode: "managed-control-socket",
        connected: false,
        initialized: false,
        selectedThreadId: null,
        localImageSteerVerified: false,
        multiImageInputVerified: false,
        desktopOwnershipVerified: false,
        serverUserAgent: null,
        queuedSketches: 0,
        detail: "Managed Codex app-server health check failed",
      })),
    ]);
    if (transportHealth.connected && transportHealth.initialized) {
      const transportReconnected = !this.#transportHealth.connected || !this.#transportHealth.initialized;
      [this.#skills, this.#models] = await Promise.all([
        this.#loadSkillsForState(state, transportReconnected),
        this.#loadModels(transportReconnected),
      ]);
    }
    return this.#accept(state, transportHealth, this.#skills);
  }

  async #loadSkillsForState(state: AdapterState, force = false): Promise<SkillInfo[]> {
    const threadId = state.snapshot?.capabilities.activeThread === true
      ? state.snapshot.activeThreadId
      : null;
    const contextKey = threadId === null ? "global" : `thread:${threadId}`;
    const elapsed = this.#skillsRefreshAttemptedAt === null
      ? Number.POSITIVE_INFINITY
      : this.#now() - this.#skillsRefreshAttemptedAt;
    if (
      !force
      && this.#skillsContextKey === contextKey
      && elapsed >= 0
      && elapsed < this.#skillsRefreshIntervalMs
    ) return this.#skills;
    this.#skillsContextKey = contextKey;
    this.#skillsRefreshAttemptedAt = this.#now();
    if (threadId === null) {
      this.#transportModel = null;
      this.#transportReasoningMode = null;
      try {
        const skills = await this.transport.listSkills();
        this.#skillsLoadedAt = this.#now();
        return skills;
      } catch {
        return this.#skills;
      }
    }
    try {
      const thread = await this.transport.threadRead(threadId);
      this.observeThreadSettings(thread);
      const skills = await this.transport.listSkills(thread.cwd === null ? [] : [thread.cwd]);
      this.#skillsLoadedAt = this.#now();
      return skills;
    } catch {
      // Desktop can expose a selected native task before the managed app-server
      // can read that exact task. Keep the global user/system skill catalog
      // useful in that interval instead of pinning the UI to an empty cache.
      try {
        const skills = await this.transport.listSkills();
        this.#skillsLoadedAt = this.#now();
        return skills;
      } catch {
        return this.#skills;
      }
    }
  }

  async #loadModels(force = false): Promise<ModelInfo[]> {
    const elapsed = this.#modelsRefreshAttemptedAt === null
      ? Number.POSITIVE_INFINITY
      : this.#now() - this.#modelsRefreshAttemptedAt;
    if (!force && elapsed >= 0 && elapsed < 5 * 60_000) {
      return this.#models;
    }
    this.#modelsRefreshAttemptedAt = this.#now();
    try {
      const models = await this.transport.listModels();
      this.#modelsLoadedAt = this.#now();
      return models;
    } catch {
      return this.#models;
    }
  }

  async #recoverSelectionTransition(
    transition: TargetSelectionTransition,
  ): Promise<AdapterState> {
    const first = await this.adapter.refresh(transition.desktopIdentity);
    if (this.#recordIdentityBoundSelectionObservation(
      first,
      transition,
      transition.expectedThreadId,
      transition.desktopIdentity,
    )) return first;
    if (
      this.#targetSelectionTransition !== transition
      || !matchesActiveSelection(first, transition.expectedThreadId)
    ) return first;

    await new Promise<void>((resolve) => setTimeout(resolve, this.#selectionConfirmPollMs));
    const second = await this.adapter.refresh(transition.desktopIdentity);
    this.#recordIdentityBoundSelectionObservation(
      second,
      transition,
      transition.expectedThreadId,
      transition.desktopIdentity,
    );
    return second;
  }

  async #acquireNativeMutationAuthority(
    threadId: string,
    slot: number,
    requireSelected: boolean,
  ): Promise<NativeMutationAuthority> {
    const acquire = this.transport.acquireNativeMutationAuthority;
    const consume = this.transport.consumeNativeMutationAuthority;
    if (acquire === undefined || consume === undefined) {
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "The managed Desktop authority provider is unavailable; no native mutation was dispatched",
      );
    }
    try {
      const grant = await acquire.call(
        this.transport,
        (desktopIdentity) => this.revalidateExactTarget(
          threadId,
          slot,
          requireSelected,
          desktopIdentity,
        ),
      );
      return grant;
    } catch (error) {
      if (error instanceof SnapshotConflictError) throw error;
      throw new SnapshotConflictError(
        "ADAPTER_DEGRADED",
        "Shared Desktop ownership could not be revalidated; no native mutation was dispatched",
      );
    }
  }

  #consumeNativeMutationAuthority(authority: NativeMutationAuthorityToken): void {
    const consume = this.transport.consumeNativeMutationAuthority;
    if (consume === undefined) {
      throw new Error("Native mutation authority consumer disappeared before dispatch.");
    }
    consume.call(this.transport, authority);
    // Native controls are another selected-target mutation sink. Revoke every
    // older exact-target proof synchronously before the renderer receives the
    // event so an app-server write cannot reuse pre-dispatch authority.
    this.invalidateTargetAuthority();
  }

  #accept(
    state: AdapterState,
    transport: TransportHealth,
    skills: SkillInfo[],
    expectedSelectionTransition?: string,
  ): MicroSnapshot {
    const now = this.#now();
    if (state.snapshot !== null && !state.stale) {
      this.#lastNative = state.snapshot;
      this.#lastSuccessfulRefreshAt = now;
    }
    const native = state.snapshot ?? this.#lastNative;
    const stale = state.stale || state.snapshot === null;
    this.#slotsAuthoritative = state.snapshot !== null && !state.stale;
    const selectedNativeSlot = native?.slots.find((slot) => slot.selected);
    this.#selectedAuthoritative = this.#targetSelectionTransition === null
      && this.#slotsAuthoritative
      && state.snapshot?.capabilities.activeThread === true
      && selectedNativeSlot?.threadId !== null
      && selectedNativeSlot?.threadId === state.snapshot.activeThreadId;
    const nativeSelectedThreadId = this.#selectedAuthoritative
      ? selectedNativeSlot?.threadId ?? null
      : null;
    const activeThreadId = this.#slotsAuthoritative
      && state.snapshot?.capabilities.activeThread === true
      ? state.snapshot.activeThreadId
      : null;
    let acceptedTransport = transport;
    if (
      transport.selectedThreadId !== null
      && transport.selectedThreadId !== nativeSelectedThreadId
      && nativeSelectedThreadId !== expectedSelectionTransition
    ) {
      // Native selection is the routing authority. Reject any visual work still
      // queued against the transport's stale selection immediately instead of
      // leaving the caller and its mutation lease blocked until queue timeout.
      this.transport.clearSelectedThread();
      acceptedTransport = { ...transport, selectedThreadId: null, queuedSketches: 0 };
    }
    this.#transportHealth = acceptedTransport;
    this.#skills = skills;
    const pendingApprovals = presentPendingApprovals(this.transport, nativeSelectedThreadId);
    const approvalBlocksHid = pendingApprovals.length > 0
      || selectedNativeSlot?.nativeStatus.toLowerCase().replace(/[^a-z0-9]/gu, "").includes("approval") === true;
    const semantic = JSON.stringify({
      native: native === null ? null : {
        slots: native.slots,
        activeThreadId: native.activeThreadId,
        agentSource: native.agentSource,
        actionLayout: native.actionLayout,
        joystickLayout: native.joystickLayout,
        reasoning: native.reasoning,
        theme: native.theme,
      },
      stale,
      adapterHealth: state.health.status,
      reasons: state.health.reasons,
      pendingApprovals,
      transport: {
        connected: acceptedTransport.connected,
        initialized: acceptedTransport.initialized,
        selectedThreadId: acceptedTransport.selectedThreadId,
        multiImageInputVerified: acceptedTransport.multiImageInputVerified,
        desktopOwnershipVerified: acceptedTransport.desktopOwnershipVerified,
      },
      transportReasoningMode: this.#transportReasoningMode,
      transportModel: this.#transportModel,
      models: this.#models,
    });
    if (this.#snapshot !== null && semantic === this.#fingerprint) return this.#snapshot;

    const fullyLive = state.health.status === "ready"
      && !stale
      && acceptedTransport.connected
      && acceptedTransport.initialized
      && acceptedTransport.desktopOwnershipVerified;
    const offline = state.health.status === "offline" && !acceptedTransport.connected;
    const selectedThreadId = nativeSelectedThreadId;
    const slots = native === null
      ? unavailableSlots()
      : native.slots.map((slot) => presentSlot(slot, stale, this.#selectedAuthoritative && slot.threadId === selectedThreadId)) as MicroSnapshot["slots"];
    const reason = safeReason(state, acceptedTransport);
    const effectiveReasoning = this.#transportReasoningMode === null
      ? native?.reasoning ?? null
      : { effort: this.#transportReasoningMode, adjustable: true };
    const snapshot = MicroSnapshotSchema.parse({
      bridgeInstanceId: this.#bridgeInstanceId,
      sequence: (this.#snapshot?.sequence ?? 0) + 1,
      timestamp: now,
      ...this.#runtimeIdentity,
      codexVersion: this.#codexVersion,
      bridgeHealth: {
        state: fullyLive ? "live" : offline ? "offline" : stale ? "stale" : "degraded",
        reason,
        changedAt: now,
        lastSuccessfulRefreshAt: this.#lastSuccessfulRefreshAt,
      },
      agentSource: native?.agentSource ?? "custom",
      slots,
      actionAssignments: presentAssignments(
        native,
        this.#selectedAuthoritative && !approvalBlocksHid,
      ),
      activeThreadId,
      selectedThreadId,
      pendingApprovals,
      reasoning: effectiveReasoning,
      theme: native?.theme ?? "dark",
    });
    this.#snapshot = snapshot;
    this.#fingerprint = semantic;
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }

  #buildInitial(): MicroSnapshot {
    const now = this.#now();
    this.#snapshot = MicroSnapshotSchema.parse({
      bridgeInstanceId: this.#bridgeInstanceId,
      sequence: 1,
      timestamp: now,
      ...this.#runtimeIdentity,
      codexVersion: this.#codexVersion,
      bridgeHealth: {
        state: "offline",
        reason: "Bridge has not completed its first native refresh",
        changedAt: now,
        lastSuccessfulRefreshAt: null,
      },
      agentSource: "custom",
      slots: unavailableSlots(),
      actionAssignments: presentAssignments(null),
      activeThreadId: null,
      selectedThreadId: null,
      pendingApprovals: [],
      reasoning: null,
      theme: "dark",
    });
    return this.#snapshot;
  }
}

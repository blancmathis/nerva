import { connectCodexNativeRuntime } from "./cdp-runtime.js";
import { asAdapterError, CodexDesktopAdapterError } from "./errors.js";
import { isAllowlistedNativeAction, isAllowlistedNativeJoystickAction } from "./native-allowlist.js";
import { extractThreadId, parseNativeSnapshot } from "./snapshot.js";
import {
  MICRO_SLOT_KEYS,
  NATIVE_ACTION_SLOTS,
  type AdapterState,
  type CodexDesktopAdapterOptions,
  type ControlBindings,
  type DesktopProcessIdentity,
  type HealthReason,
  type MicroSnapshot,
  type NativeActionSlot,
  type NativeComposerImageAttachment,
  type NativeControlIdentifier,
  type NativeControlTarget,
  type NativeDispatch,
  type NativeDispatchAuthorityGuard,
  type NativeMicroRuntime,
  type NativeRuntimeFactory,
  type SemanticCommand,
  type SemanticControl
} from "./types.js";

const ACTION_EVENT_KEYS: Readonly<Record<NativeActionSlot, NativeControlIdentifier>> = {
  ACT06: "ACT06",
  ACT07: "ACT07",
  ACT08: "ACT08",
  ACT09: "ACT09",
  ACT10_ACT11: "ACT10",
  ACT12: "ACT12"
};

const SEMANTIC_KEYCAP_IDS: Readonly<Partial<Record<SemanticControl, string>>> = {
  fast: "FAST",
  approve: "APPR",
  reject: "REJ",
  fork: "SPLIT",
  dictate: "MIC",
  send: "CODEX",
  "new-task": "NEW",
  "reasoning-increase": "MIND+",
  "reasoning-decrease": "MIND-"
};

const SEMANTIC_JOYSTICK_COMMAND_IDS: Readonly<Partial<Record<SemanticControl, string>>> = {
  "skill-1": "skill.one",
};

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_TARGET_TRANSITION_TIMEOUT_MS = 1_000;
const DEFAULT_TARGET_TRANSITION_POLL_MS = 25;
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

function isGenericApprovalAssignment(keycapId: string, commandId: string | null): boolean {
  const normalize = (value: string): string => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
    return normalized.startsWith("native") ? normalized.slice("native".length) : normalized;
  };
  return GENERIC_APPROVAL_IDENTITIES.has(normalize(keycapId))
    || (commandId !== null && GENERIC_APPROVAL_IDENTITIES.has(normalize(commandId)));
}

function retryDelay(
  consecutiveFailures: number,
  initialDelayMs: number,
  maxDelayMs: number,
  random: () => number
): number {
  const exponential = Math.min(
    maxDelayMs,
    initialDelayMs * (2 ** Math.min(Math.max(0, consecutiveFailures - 1), 30))
  );
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.max(1, Math.round(exponential * (0.5 + (normalized * 0.5))));
}

interface PendingTargetTransition {
  readonly mode: "exact" | "changed";
  readonly previousThreadId: string | null;
  readonly expectedThreadId: string | null;
  readonly desktopIdentity: DesktopProcessIdentity | undefined;
  candidate: string | null;
  consecutiveObservations: number;
}

export class CodexDesktopAdapter {
  private runtime: NativeMicroRuntime | undefined;
  private readonly runtimeFactory: NativeRuntimeFactory;
  private readonly controlBindings: ControlBindings;
  private readonly now: () => number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly random: () => number;
  private readonly logger: (message: string) => void;
  private readonly targetTransitionTimeoutMs: number;
  private readonly targetTransitionPollMs: number;
  private lastValidated: MicroSnapshot | null = null;
  private stateValue: AdapterState;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  private refreshQueue: Promise<void> = Promise.resolve();
  private expectedDesktopIdentity: DesktopProcessIdentity | undefined;
  private pendingTargetTransition: PendingTargetTransition | undefined;

  constructor(options: CodexDesktopAdapterOptions = {}) {
    this.expectedDesktopIdentity = options.discovery?.expectedDesktopIdentity;
    this.runtimeFactory = options.runtimeFactory ?? ((expectedDesktopIdentity) => connectCodexNativeRuntime({
      ...options.discovery,
      ...(expectedDesktopIdentity === undefined ? {} : { expectedDesktopIdentity }),
    }));
    this.controlBindings = validateControlBindings(options.controlBindings ?? {});
    this.now = options.now ?? Date.now;
    this.retryInitialDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    this.retryMaxDelayMs = Math.max(
      this.retryInitialDelayMs,
      Math.floor(options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS)
    );
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? (() => undefined);
    this.targetTransitionTimeoutMs = Math.max(
      1,
      Math.floor(options.targetTransitionTimeoutMs ?? DEFAULT_TARGET_TRANSITION_TIMEOUT_MS),
    );
    this.targetTransitionPollMs = Math.max(
      1,
      Math.floor(options.targetTransitionPollMs ?? DEFAULT_TARGET_TRANSITION_POLL_MS),
    );
    const changedAt = this.now();
    this.stateValue = {
      snapshot: null,
      stale: false,
      health: {
        status: "offline",
        reasons: [{ code: "awaiting-snapshot", message: "Codex Desktop native state has not been read yet." }],
        changedAt
      }
    };
  }

  snapshot(): AdapterState {
    return this.stateValue;
  }

  /**
   * Prepares a separately authorized external selection. An unresolved gesture
   * in the same renderer generation cannot be cancelled and therefore blocks
   * the newer sink; rebinding to a different exact process generation is safe.
   */
  supersedePendingTargetTransition(desktopIdentity: DesktopProcessIdentity): void {
    if (
      this.pendingTargetTransition !== undefined
      && (
        this.pendingTargetTransition.desktopIdentity === undefined
        || sameDesktopIdentity(this.pendingTargetTransition.desktopIdentity, desktopIdentity)
      )
    ) {
      throw new CodexDesktopAdapterError(
        "delivery-unknown",
        "An earlier native target-changing gesture may still fire in this Desktop generation.",
      );
    }
    this.pendingTargetTransition = undefined;
  }

  refresh(expectedDesktopIdentity?: DesktopProcessIdentity): Promise<AdapterState> {
    const refresh = this.refreshQueue.then(() => {
      this.bindDesktopIdentity(expectedDesktopIdentity);
      return this.performRefresh();
    });
    this.refreshQueue = refresh.then(() => undefined, () => undefined);
    return refresh;
  }

  private async performRefresh(): Promise<AdapterState> {
    if (!this.runtime && this.now() < this.nextAttemptAt) return this.stateValue;
    try {
      const runtime = await this.ensureRuntime();
      const parsed = parseNativeSnapshot(await runtime.readSnapshot(), this.now());
      if (!this.observePendingTargetTransition(parsed.snapshot)) {
        return this.markTargetTransitionPending();
      }
      this.consecutiveFailures = 0;
      this.nextAttemptAt = 0;
      this.lastValidated = parsed.snapshot;
      this.stateValue = {
        snapshot: parsed.snapshot,
        stale: false,
        health: {
          status: parsed.warnings.length === 0 ? "ready" : "degraded",
          reasons: parsed.warnings,
          changedAt: this.now()
        }
      };
      return this.stateValue;
    } catch (error) {
      return this.degrade(error, this.pendingTargetTransition === undefined);
    }
  }

  async execute(
    command: SemanticCommand,
    assertDispatchAuthority?: NativeDispatchAuthorityGuard,
    expectedDesktopIdentity?: DesktopProcessIdentity,
  ): Promise<AdapterState> {
    const live = await this.refresh(expectedDesktopIdentity);
    if (!live.snapshot || live.stale) {
      throw new CodexDesktopAdapterError("snapshot-stale", "Refusing native input without a fresh validated Codex Desktop snapshot.");
    }

    let targetTransitionMode: PendingTargetTransition["mode"] | null = null;
    try {
      const runtime = await this.ensureRuntime();
      if (
        expectedDesktopIdentity !== undefined
        && !sameDesktopIdentity(runtime.desktopIdentity, expectedDesktopIdentity)
      ) {
        throw new CodexDesktopAdapterError(
          "cdp-unavailable",
          "The write-adjacent renderer no longer matches the attested Desktop process.",
        );
      }
      if (command.action === "select-slot") {
        const slot = live.snapshot.slots[command.slotIndex];
        if (!slot.threadId) {
          throw new CodexDesktopAdapterError("invalid-thread-key", `${slot.key} is not assigned to a validated Codex thread.`);
        }
        const expected = extractExactCanonicalThreadId(command.expectedThreadId);
        if (expected !== slot.threadId) {
          throw new CodexDesktopAdapterError("thread-changed", `${slot.key} changed before native selection.`);
        }
        const dispatch: NativeDispatch = { kind: "agent", key: slot.key, index: slot.index, threadKey: slot.threadId };
        consumeDispatchAuthority(assertDispatchAuthority);
        targetTransitionMode = this.beginTargetTransition(dispatch, live.snapshot, expectedDesktopIdentity);
        await runtime.dispatch(dispatch);
      } else {
        const expected = extractExactCanonicalThreadId(command.expectedThreadId);
        if (!live.snapshot.capabilities.activeThread || live.snapshot.activeThreadId !== expected) {
          throw new CodexDesktopAdapterError("thread-changed", "The active Codex thread changed before native control dispatch.");
        }
        const selectedSlot = live.snapshot.slots.find((slot) => slot.selected && slot.threadId === expected);
        if (!selectedSlot) {
          throw new CodexDesktopAdapterError(
            "thread-changed",
            "The exact active thread has no authoritative selected native agent slot.",
          );
        }
        if (selectedSlot.status === "awaiting-approval") {
          throw new CodexDesktopAdapterError(
            "control-not-configured",
            "Generic native controls are locked while the exact task has a pending approval.",
          );
        }
        const dispatch = command.action === "invoke-control"
          ? resolveControlDispatch(command.control, expected, live.snapshot, this.controlBindings)
          : command.action === "invoke-action-slot"
            ? (() => {
                const slot = live.snapshot.slots[command.expectedAgentSlot];
                if (slot.threadId !== expected || !slot.selected) {
                  throw new CodexDesktopAdapterError(
                    "thread-changed",
                    "The exact thread moved from the expected native agent slot before action dispatch.",
                  );
                }
                return dispatchForTarget(
                  { kind: "action", slot: command.slot, keycapId: command.expectedKeycapId },
                  expected,
                  live.snapshot,
                  command.expectedNativeCommandId,
                  command.gesture,
                );
              })()
            : dispatchForTarget(
                { kind: "joystick", direction: command.direction, assignment: command.expectedAssignment },
                expected,
                live.snapshot,
              );
        consumeDispatchAuthority(assertDispatchAuthority);
        targetTransitionMode = this.beginTargetTransition(dispatch, live.snapshot, expectedDesktopIdentity);
        await runtime.dispatch(dispatch);
      }
    } catch (error) {
      // Semantic/target validation failures must be immediately revalidated on
      // the next command; only failed refresh/discovery polls are backed off.
      const adapterError = asAdapterError(error);
      if (targetTransitionMode !== null && adapterError.code !== "delivery-unknown") {
        // The typed runtime contract distinguishes a definitive pre-fire
        // rejection from an evaluation whose delivery may have happened.
        this.pendingTargetTransition = undefined;
      }
      this.degrade(adapterError, false);
      throw adapterError;
    }

    return targetTransitionMode !== null
      ? this.awaitTargetTransition(targetTransitionMode)
      : this.refresh();
  }

  async attachImageToComposer(
    attachment: NativeComposerImageAttachment,
    assertDispatchAuthority?: NativeDispatchAuthorityGuard,
    expectedDesktopIdentity?: DesktopProcessIdentity,
  ): Promise<AdapterState> {
    const live = await this.refresh(expectedDesktopIdentity);
    const expected = extractExactCanonicalThreadId(attachment.expectedThreadId);
    if (
      expected === null
      || live.snapshot === null
      || live.stale
      || !live.snapshot.capabilities.activeThread
      || !live.snapshot.capabilities.composerAttachment
      || live.snapshot.activeThreadId !== expected
      || !live.snapshot.slots.some((slot) => slot.selected && slot.threadId === expected)
    ) {
      throw new CodexDesktopAdapterError(
        "thread-changed",
        "The exact selected Codex composer is unavailable for image attachment.",
      );
    }

    try {
      const runtime = await this.ensureRuntime();
      if (
        expectedDesktopIdentity !== undefined
        && !sameDesktopIdentity(runtime.desktopIdentity, expectedDesktopIdentity)
      ) {
        throw new CodexDesktopAdapterError(
          "cdp-unavailable",
          "The composer renderer no longer matches the attested Desktop process.",
        );
      }
      if (runtime.attachImageToComposer === undefined) {
        throw new CodexDesktopAdapterError(
          "control-not-configured",
          "The connected Codex renderer does not expose the bounded composer attachment primitive.",
        );
      }
      consumeDispatchAuthority(assertDispatchAuthority);
      await runtime.attachImageToComposer(attachment);
      return await this.refresh(expectedDesktopIdentity);
    } catch (error) {
      const adapterError = asAdapterError(error);
      this.degrade(adapterError, false);
      throw adapterError;
    }
  }

  close(): void {
    this.runtime?.close();
    this.runtime = undefined;
  }

  private async ensureRuntime(): Promise<NativeMicroRuntime> {
    if (this.runtime) {
      if (
        this.expectedDesktopIdentity !== undefined
        && !sameDesktopIdentity(this.runtime.desktopIdentity, this.expectedDesktopIdentity)
      ) {
        this.runtime.close();
        this.runtime = undefined;
        throw new CodexDesktopAdapterError(
          "cdp-unavailable",
          "The connected renderer no longer matches the attested Desktop process.",
        );
      }
      return this.runtime;
    }
    const runtime = await this.runtimeFactory(this.expectedDesktopIdentity);
    if (
      this.expectedDesktopIdentity !== undefined
      && !sameDesktopIdentity(runtime.desktopIdentity, this.expectedDesktopIdentity)
    ) {
      runtime.close();
      throw new CodexDesktopAdapterError(
        "cdp-unavailable",
        "The discovered renderer is not bound to the attested Desktop process.",
      );
    }
    this.runtime = runtime;
    return runtime;
  }

  private bindDesktopIdentity(identity: DesktopProcessIdentity | undefined): void {
    if (identity === undefined) return;
    if (!validDesktopIdentity(identity)) {
      throw new CodexDesktopAdapterError("cdp-unavailable", "The expected Desktop process identity is invalid.");
    }
    if (sameDesktopIdentity(this.expectedDesktopIdentity, identity)) return;
    if (
      this.pendingTargetTransition !== undefined
      && !sameDesktopIdentity(this.pendingTargetTransition.desktopIdentity, identity)
    ) {
      this.pendingTargetTransition = undefined;
    }
    this.runtime?.close();
    this.runtime = undefined;
    this.expectedDesktopIdentity = { ...identity };
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
  }

  private beginTargetTransition(
    dispatch: NativeDispatch,
    snapshot: MicroSnapshot,
    desktopIdentity: DesktopProcessIdentity | undefined,
  ): PendingTargetTransition["mode"] | null {
    const previousThreadId = authoritativeSelectedThread(snapshot)?.threadId ?? snapshot.activeThreadId;
    if (dispatch.kind === "agent") {
      this.pendingTargetTransition = {
        mode: "exact",
        previousThreadId,
        expectedThreadId: dispatch.threadKey,
        desktopIdentity: desktopIdentity === undefined ? undefined : { ...desktopIdentity },
        candidate: null,
        consecutiveObservations: 0,
      };
      return "exact";
    }
    const changesUnknownTarget = (
      dispatch.kind === "action"
      && dispatch.expectedNativeCommandId === "thread.fork"
    ) || (
      dispatch.kind === "joystick"
      && (dispatch.expectedAssignment.commandId === "nav.forward" || dispatch.expectedAssignment.commandId === "nav.back")
    );
    if (!changesUnknownTarget) return null;
    this.pendingTargetTransition = {
      mode: "changed",
      previousThreadId,
      expectedThreadId: null,
      desktopIdentity: desktopIdentity === undefined ? undefined : { ...desktopIdentity },
      candidate: null,
      consecutiveObservations: 0,
    };
    return "changed";
  }

  private observePendingTargetTransition(snapshot: MicroSnapshot): boolean {
    const pending = this.pendingTargetTransition;
    if (pending === undefined) return true;
    const selected = authoritativeSelectedThread(snapshot);
    const qualifies = selected !== null && (
      pending.mode === "exact"
        ? selected.threadId === pending.expectedThreadId
        : pending.previousThreadId !== null && selected.threadId !== pending.previousThreadId
    );
    if (!qualifies) {
      pending.candidate = null;
      pending.consecutiveObservations = 0;
      return false;
    }
    const candidate = `${selected.threadId}:${selected.slotIndex}`;
    if (pending.candidate === candidate) {
      pending.consecutiveObservations += 1;
    } else {
      pending.candidate = candidate;
      pending.consecutiveObservations = 1;
    }
    if (pending.consecutiveObservations < 2) return false;
    this.pendingTargetTransition = undefined;
    return true;
  }

  private markTargetTransitionPending(): AdapterState {
    const snapshot = this.lastValidated;
    const reasons: HealthReason[] = [{
      code: "delivery-unknown",
      message: "The native target-changing control was delivered, but the new selected task has not settled yet.",
    }];
    if (snapshot !== null) {
      reasons.push({ code: "snapshot-stale", message: "Showing the last structurally validated native snapshot." });
    }
    this.stateValue = {
      snapshot,
      stale: snapshot !== null,
      health: {
        status: snapshot === null ? "offline" : "degraded",
        reasons,
        changedAt: this.now(),
      },
    };
    return this.stateValue;
  }

  private async awaitTargetTransition(
    transitionMode: PendingTargetTransition["mode"],
  ): Promise<AdapterState> {
    const attempts = Math.max(2, Math.ceil(this.targetTransitionTimeoutMs / this.targetTransitionPollMs));
    let state = await this.refresh();
    for (let attempt = 1; this.pendingTargetTransition !== undefined && attempt < attempts; attempt += 1) {
      await delay(this.targetTransitionPollMs);
      state = await this.refresh();
    }
    if (this.pendingTargetTransition === undefined) {
      if (transitionMode === "exact") return state;
      const error = new CodexDesktopAdapterError(
        "delivery-unknown",
        "The native target settled after the gesture, but fork/navigation causality cannot be proven.",
      );
      this.stateValue = {
        snapshot: state.snapshot,
        stale: state.stale,
        health: {
          status: "degraded",
          reasons: [{ code: error.code, message: error.message }],
          changedAt: this.now(),
        },
      };
      throw error;
    }
    this.markTargetTransitionPending();
    throw new CodexDesktopAdapterError(
      "delivery-unknown",
      "Codex Desktop accepted a target-changing native control, but its selected-task postcondition did not settle.",
    );
  }

  private degrade(error: unknown, scheduleRetry: boolean): AdapterState {
    const adapterError = asAdapterError(error);
    this.logger(`Codex Desktop adapter degraded: ${adapterError.code}: ${adapterError.message}`);
    this.runtime?.close();
    this.runtime = undefined;
    if (scheduleRetry) {
      this.consecutiveFailures += 1;
      this.nextAttemptAt = this.now() + retryDelay(
        this.consecutiveFailures,
        this.retryInitialDelayMs,
        this.retryMaxDelayMs,
        this.random
      );
    }
    const reasons: HealthReason[] = [{ code: adapterError.code, message: adapterError.message }];
    if (this.lastValidated) reasons.push({ code: "snapshot-stale", message: "Showing the last structurally validated native snapshot." });
    this.stateValue = {
      snapshot: this.lastValidated,
      stale: this.lastValidated !== null,
      health: {
        status: this.lastValidated ? "degraded" : "offline",
        reasons,
        changedAt: this.now()
      }
    };
    return this.stateValue;
  }
}

function consumeDispatchAuthority(assertDispatchAuthority: NativeDispatchAuthorityGuard | undefined): void {
  if (assertDispatchAuthority === undefined) return;
  try {
    assertDispatchAuthority();
  } catch (error) {
    throw new CodexDesktopAdapterError(
      "mutation-authority-stale",
      "Desktop mutation authority changed at the native dispatch boundary.",
      { cause: error },
    );
  }
}

function validDesktopIdentity(identity: DesktopProcessIdentity): boolean {
  return Number.isSafeInteger(identity.pid)
    && identity.pid > 0
    && /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(identity.startedAt)
    && identity.appPath.startsWith("/")
    && identity.executablePath.startsWith(`${identity.appPath}/Contents/MacOS/`)
    && (identity.bundleId === "com.openai.codex" || identity.bundleId === "com.openai.chatgpt");
}

function sameDesktopIdentity(
  left: DesktopProcessIdentity | undefined,
  right: DesktopProcessIdentity | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.appPath === right.appPath
    && left.executablePath === right.executablePath
    && left.bundleId === right.bundleId;
}

function authoritativeSelectedThread(
  snapshot: MicroSnapshot,
): { readonly threadId: string; readonly slotIndex: number } | null {
  if (!snapshot.capabilities.activeThread || snapshot.activeThreadId === null) return null;
  const selected = snapshot.slots.filter((slot) => slot.selected);
  if (
    selected.length !== 1
    || selected[0]?.threadId === null
    || selected[0]?.threadId !== snapshot.activeThreadId
  ) {
    return null;
  }
  return { threadId: selected[0].threadId, slotIndex: selected[0].index };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveControlDispatch(control: SemanticControl, expectedThreadId: string, snapshot: MicroSnapshot, bindings: ControlBindings): import("./types.js").NativeDispatch {
  if (control === "approve" || control === "reject") {
    throw new CodexDesktopAdapterError(
      "control-not-configured",
      "Approval decisions require an exact pending app-server request and cannot use generic native HID controls.",
    );
  }
  const configured = bindings[control];
  if (configured) {
    return dispatchForTarget(configured, expectedThreadId, snapshot);
  }

  if (control === "reasoning-increase" || control === "reasoning-decrease") {
    if (!snapshot.reasoning?.adjustable) {
      throw new CodexDesktopAdapterError("reasoning-unavailable", "Live reasoning adjustment capability is unavailable.");
    }
    // Native rotation orientation follows the observed Codex Micro event contract.
    return control === "reasoning-increase"
      ? { kind: "reasoning", direction: "increase", key: "ENC_CC", expectedThreadId }
      : { kind: "reasoning", direction: "decrease", key: "ENC_CW", expectedThreadId };
  }

  const keycapId = SEMANTIC_KEYCAP_IDS[control];
  const action = keycapId && snapshot.actionLayout?.find((candidate) => candidate.keycapId === keycapId);
  if (action) return dispatchForTarget({ kind: "action", slot: action.slot, keycapId }, expectedThreadId, snapshot);
  const joystickCommandId = SEMANTIC_JOYSTICK_COMMAND_IDS[control];
  if (joystickCommandId && snapshot.joystickLayout) {
    const joystick = Object.values(snapshot.joystickLayout).find((candidate) => (
      candidate.commandId === joystickCommandId
    ));
    if (joystick) {
      return dispatchForTarget({
        kind: "joystick",
        direction: joystick.direction,
        assignment: { type: joystick.type, commandId: joystick.commandId },
      }, expectedThreadId, snapshot);
    }
  }
  throw new CodexDesktopAdapterError("control-not-configured", `${control} is not assigned in the live Codex Micro layout.`);
}

function dispatchForTarget(
  target: NativeControlTarget,
  expectedThreadId: string,
  snapshot: MicroSnapshot,
  expectedNativeCommandId?: string | null,
  gesture?: "tap" | "begin" | "end",
): import("./types.js").NativeDispatch {
  if (target.kind === "reasoning") {
    if (!snapshot.reasoning?.adjustable) {
      throw new CodexDesktopAdapterError("reasoning-unavailable", "Configured reasoning control is not live in Codex Desktop.");
    }
    return target.direction === "increase"
      ? { kind: "reasoning", direction: "increase", key: "ENC_CC", expectedThreadId }
      : { kind: "reasoning", direction: "decrease", key: "ENC_CW", expectedThreadId };
  }
  if (target.kind === "joystick") {
    if (!snapshot.capabilities.joystickControl || !snapshot.joystickLayout) {
      throw new CodexDesktopAdapterError("joystick-handler-unavailable", "Configured joystick control is not proven live in Codex Desktop.");
    }
    const assignment = snapshot.joystickLayout[target.direction];
    if (
      assignment.type !== target.assignment.type
      || assignment.commandId !== target.assignment.commandId
    ) {
      throw new CodexDesktopAdapterError("control-not-configured", "Configured joystick assignment changed in the live layout.");
    }
    if (isGenericApprovalAssignment(assignment.commandId, null)) {
      throw new CodexDesktopAdapterError("control-not-configured", "Approval decisions cannot use generic native joystick controls.");
    }
    if (!isAllowlistedNativeJoystickAction(target.direction, assignment.type, assignment.commandId)) {
      throw new CodexDesktopAdapterError("control-not-configured", "The native joystick assignment is not on the explicit safe allowlist.");
    }
    return {
      kind: "joystick",
      direction: target.direction,
      expectedAssignment: { type: assignment.type, commandId: assignment.commandId },
      expectedThreadId,
    };
  }
  if (!snapshot.capabilities.actionControl || !snapshot.actionLayout) {
    throw new CodexDesktopAdapterError("action-handler-unavailable", "Configured action control is not proven live in Codex Desktop.");
  }
  const assignment = snapshot.actionLayout.find((candidate) => candidate.slot === target.slot);
  if (
    !assignment
    || assignment.keycapId !== target.keycapId
    || (expectedNativeCommandId !== undefined && assignment.commandId !== expectedNativeCommandId)
  ) {
    throw new CodexDesktopAdapterError("control-not-configured", "Configured action assignment changed in the live layout.");
  }
  if (isGenericApprovalAssignment(assignment.keycapId, assignment.commandId)) {
    throw new CodexDesktopAdapterError("control-not-configured", "Approval decisions cannot use generic native HID controls.");
  }
  if (!isAllowlistedNativeAction(target.slot, assignment.keycapId, assignment.commandId)) {
    throw new CodexDesktopAdapterError("control-not-configured", "The native action assignment is not on the explicit safe allowlist.");
  }
  const selectedSlot = snapshot.slots.find((slot) => slot.selected && slot.threadId === expectedThreadId);
  if (selectedSlot === undefined) {
    throw new CodexDesktopAdapterError("thread-changed", "The exact active thread has no authoritative native agent slot.");
  }
  return {
    kind: "action",
    expectedAgentSlot: selectedSlot.index,
    slot: target.slot,
    key: ACTION_EVENT_KEYS[target.slot] as Exclude<NativeControlIdentifier, "ENC_CC" | "ENC_CW">,
    expectedKeycapId: assignment.keycapId,
    expectedNativeCommandId: assignment.commandId,
    expectedThreadId,
    ...(gesture === undefined ? {} : { gesture }),
  };
}

function validateControlBindings(bindings: ControlBindings): ControlBindings {
  for (const [control, target] of Object.entries(bindings)) {
    if (!target || !isValidControlTarget(target)) throw new CodexDesktopAdapterError("control-not-configured", `Invalid native target configured for ${control}.`);
  }
  return { ...bindings };
}

function isValidControlTarget(target: NativeControlTarget): boolean {
  if (target.kind === "reasoning") return target.direction === "increase" || target.direction === "decrease";
  if (target.kind === "action") {
    return /^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,127}$/.test(target.keycapId)
      && NATIVE_ACTION_SLOTS.includes(target.slot);
  }
  return ["up", "right", "down", "left"].includes(target.direction)
    && target.assignment.type === "command"
    && /^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,127}$/.test(target.assignment.commandId);
}

function extractExactCanonicalThreadId(value: string): string {
  const extracted = extractThreadId(value);
  if (!extracted || value !== extracted) {
    throw new CodexDesktopAdapterError("invalid-thread-key", "Expected thread identity must be a canonical lowercase UUID.");
  }
  return extracted;
}

export interface CodexDesktopProbeOptions {
  readonly cdpPort?: number;
}

export async function probeCodexDesktop(options: CodexDesktopProbeOptions = {}): Promise<AdapterState> {
  const adapter = new CodexDesktopAdapter(options.cdpPort === undefined
    ? {}
    : { discovery: { explicitPort: options.cdpPort, processArgs: [] } });
  try {
    return await adapter.refresh();
  } finally {
    adapter.close();
  }
}

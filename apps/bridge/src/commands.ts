import type { Command, CommandResult } from "@codex-pad/protocol";
import type { DesktopProcessIdentity } from "@codex-pad/codex-desktop";
import type { ThreadTransport } from "./thread-transport.js";
import { BridgeStateService } from "./state.js";
import type { BridgeDataPaths } from "./paths.js";
import { validateAndNormalizeSketch } from "./sketch.js";
import { validateAndNormalizeReview, type ReviewInstructionHook } from "./review.js";
import type { SessionsService } from "./sessions.js";

const SECRET_LIKE_PROMPT = /(?:\bsk-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;

export interface LibraryCommandDefinition {
  libraryId: string;
  label: string;
  prompt: string;
}

export interface ProtocolCommandExecutorOptions {
  state: BridgeStateService;
  transport: ThreadTransport;
  sessions: SessionsService;
  paths: BridgeDataPaths;
  libraryCommands?: readonly LibraryCommandDefinition[];
  reviewInstructionHook?: ReviewInstructionHook;
  logger?: Pick<Console, "warn">;
  normalizeSketch?: typeof validateAndNormalizeSketch;
  normalizeReview?: typeof validateAndNormalizeReview;
}

export class ProtocolCommandError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, statusCode = 400, retryable = false) {
    super(message);
    this.name = "ProtocolCommandError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class ProtocolCommandExecutor {
  readonly state: BridgeStateService;
  readonly transport: ThreadTransport;
  readonly sessions: SessionsService;
  readonly paths: BridgeDataPaths;
  readonly libraryCommands: readonly LibraryCommandDefinition[];
  readonly reviewInstructionHook?: ReviewInstructionHook;
  readonly logger: Pick<Console, "warn">;
  readonly normalizeSketch: typeof validateAndNormalizeSketch;
  readonly normalizeReview: typeof validateAndNormalizeReview;
  readonly #heldMicroActions = new Map<string, {
    readonly threadId: string;
    readonly agentSlot: number;
    readonly actionSlot: string;
    readonly keycapId: string;
    readonly nativeCommandId: string | null;
  }>();

  constructor(options: ProtocolCommandExecutorOptions) {
    this.state = options.state;
    this.transport = options.transport;
    this.sessions = options.sessions;
    this.paths = options.paths;
    this.libraryCommands = options.libraryCommands ?? [];
    if (options.reviewInstructionHook !== undefined) this.reviewInstructionHook = options.reviewInstructionHook;
    this.logger = options.logger ?? console;
    this.normalizeSketch = options.normalizeSketch ?? validateAndNormalizeSketch;
    this.normalizeReview = options.normalizeReview ?? validateAndNormalizeReview;
  }

  async cleanupUpload(kind: "sketch" | "review", cleanup: () => Promise<void>): Promise<void> {
    try {
      await cleanup();
    } catch {
      this.logger.warn(`Codex Pad could not remove a normalized ${kind} upload; startup scavenging will retry without changing the command outcome.`);
    }
  }

  async execute(command: Command): Promise<CommandResult> {
    this.state.assertSnapshotIdentity(
      command.expectedBridgeInstanceId,
      command.expectedSequence,
    );
    switch (command.type) {
      case "selectAgent": {
        const snapshot = await this.state.selectSlot(
          command.expectedSequence,
          command.slot,
          command.expectedThreadId,
        );
        return result(snapshot.sequence, command.expectedThreadId, "Native Codex agent selected");
      }
      case "runMicroAction": {
        const gesture = command.gesture ?? "tap";
        if (gesture === "begin") {
          if (this.#heldMicroActions.size > 0 || command.gestureId !== command.commandId) {
            throw new ProtocolCommandError("GESTURE_ACTIVE", "Stop the active Dictation gesture before starting another one.", 409);
          }
          const snapshot = await this.state.invokeActionSlot(
            command.expectedSequence,
            command.expectedThreadId,
            command.slot,
            command.actionSlot,
            command.expectedKeycapId,
            command.expectedNativeCommandId,
            "begin",
          );
          this.#heldMicroActions.set(command.commandId, {
            threadId: command.expectedThreadId,
            agentSlot: command.slot,
            actionSlot: "ACT10_ACT11",
            keycapId: "MIC",
            nativeCommandId: command.expectedNativeCommandId,
          });
          return result(snapshot.sequence, command.expectedThreadId, "Mac Dictation started");
        }
        if (gesture === "end") {
          const held = command.gestureId === undefined || command.gestureId === null
            ? undefined
            : this.#heldMicroActions.get(command.gestureId);
          if (
            held === undefined
            || held.threadId !== command.expectedThreadId
            || held.agentSlot !== command.slot
            || held.actionSlot !== command.actionSlot
            || held.keycapId !== command.expectedKeycapId
            || held.nativeCommandId !== command.expectedNativeCommandId
          ) {
            throw new ProtocolCommandError("GESTURE_NOT_FOUND", "This Dictation gesture is no longer active on the Mac.", 409);
          }
          const snapshot = await this.state.invokeActionSlot(
            command.expectedSequence,
            command.expectedThreadId,
            command.slot,
            command.actionSlot,
            command.expectedKeycapId,
            command.expectedNativeCommandId,
            "end",
          );
          this.#heldMicroActions.delete(command.gestureId!);
          return result(snapshot.sequence, command.expectedThreadId, "Mac Dictation stopped");
        }
        const snapshot = await this.state.invokeActionSlot(
          command.expectedSequence,
          command.expectedThreadId,
          command.slot,
          command.actionSlot,
          command.expectedKeycapId,
          command.expectedNativeCommandId,
          "tap",
        );
        return result(snapshot.sequence, command.expectedThreadId, "Verified native Micro action dispatched");
      }
      case "runJoystickAction": {
        const snapshot = await this.state.invokeJoystick(
          command.expectedSequence,
          command.expectedThreadId,
          command.direction,
          command.expectedAssignment,
        );
        return result(snapshot.sequence, command.expectedThreadId, "Verified native joystick action dispatched");
      }
      case "adjustReasoning": {
        const target = this.state.assertExactTarget(
          command.expectedSequence,
          command.expectedThreadId,
          true,
        );
        const modes = this.state.capabilities().reasoningModes;
        const current = this.state.capabilities().currentReasoningMode;
        const currentIndex = current === null ? -1 : modes.indexOf(current);
        const direction = command.adjustment === "increase" ? 1 : -1;
        const nextIndex = Math.max(0, Math.min(modes.length - 1, currentIndex + direction));
        const effort = modes[nextIndex];
        if (effort === undefined || effort === current) {
          throw new ProtocolCommandError(
            "CAPABILITY_UNAVAILABLE",
            "No different reasoning effort is available in that direction.",
            409,
          );
        }
        const assertTargetAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
          this.state.revalidateExactTarget(command.expectedThreadId, target.slot, true, desktopIdentity)
        );
        await this.transport.selectThread(command.expectedThreadId, assertTargetAuthority);
        await this.transport.setReasoning({
          commandId: command.commandId,
          threadId: command.expectedThreadId,
          effort,
          assertTargetAuthority,
        });
        const snapshot = await this.state.refresh();
        return result(snapshot.sequence, command.expectedThreadId, `Reasoning set to ${effort}`);
      }
      case "setModelReasoning": {
        const target = this.state.assertExactTarget(
          command.expectedSequence,
          command.expectedThreadId,
          true,
        );
        const model = this.state.capabilities().models.find((candidate) => (
          candidate.model === command.model
          && candidate.supportedReasoningEfforts.includes(command.effort)
        ));
        if (model === undefined) {
          throw new ProtocolCommandError(
            "CAPABILITY_UNAVAILABLE",
            "That exact model and reasoning preset is not exposed by this Codex installation.",
            409,
          );
        }
        const assertTargetAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
          this.state.revalidateExactTarget(command.expectedThreadId, target.slot, true, desktopIdentity)
        );
        const selectedThread = await this.transport.selectThread(
          command.expectedThreadId,
          assertTargetAuthority,
        );
        this.state.observeThreadSettings(selectedThread);
        await this.transport.setModelReasoning({
          commandId: command.commandId,
          threadId: command.expectedThreadId,
          model: command.model,
          effort: command.effort,
          assertTargetAuthority,
        });
        this.state.rememberModelReasoning(command.model, command.effort);
        const snapshot = await this.state.refresh();
        return result(
          snapshot.sequence,
          command.expectedThreadId,
          `Model set to ${model.displayName} with ${command.effort} reasoning`,
        );
      }
      case "respondToApproval": {
        const target = this.state.assertExactTarget(
          command.expectedSequence,
          command.expectedThreadId,
          true,
        );
        const approval = this.state.current().pendingApprovals.find((candidate) =>
          candidate.requestId === command.requestId
          && candidate.threadId === command.expectedThreadId
          && candidate.turnId === command.turnId
          && candidate.itemId === command.itemId
          && candidate.kind === command.approvalKind
          && candidate.actionable
        );
        if (approval === undefined) {
          throw new ProtocolCommandError(
            "APPROVAL_NOT_FOUND",
            "The exact actionable pending approval is no longer present in this snapshot",
            409,
          );
        }
        const assertTargetAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
          this.state.revalidateExactTarget(command.expectedThreadId, target.slot, true, desktopIdentity)
        );
        await this.transport.selectThread(command.expectedThreadId, assertTargetAuthority);
        const input = {
          commandId: command.commandId,
          requestId: command.requestId,
          threadId: command.expectedThreadId,
          turnId: command.turnId,
          itemId: command.itemId,
          kind: command.approvalKind,
          assertTargetAuthority,
        };
        if (command.decision === "accept") await this.transport.approve(input);
        else await this.transport.reject(input);
        try {
          await this.state.refresh();
        } catch {
          this.logger.warn("Codex Pad answered an exact pending approval but could not refresh the native snapshot; the typed decision remains successful.");
        }
        return result(
          this.state.current().sequence,
          command.expectedThreadId,
          command.decision === "accept" ? "Exact pending approval accepted" : "Exact pending approval declined",
        );
      }
      case "createTask": {
        this.state.assertSequence(command.expectedSequence);
        if (command.expectedThreadId !== null) {
          throw new ProtocolCommandError("TARGET_MISMATCH", "New-task commands must not carry a fallback thread target", 409);
        }
        const thread = await this.transport.newThread({ commandId: command.commandId });
        try {
          await this.sessions.openCreatedThread(thread.threadId);
        } catch {
          this.logger.warn("Codex Pad created a task but could not open it in Desktop; task creation remains successful.");
        }
        let initialInstructionConfirmed = true;
        if (command.instruction !== null) {
          try {
            // A turn is an existing-thread mutation even when its thread was
            // just created. Open and observe it natively before binding the
            // initial instruction to an exact one-shot target proof.
            const openedSnapshot = await this.state.refresh();
            const target = this.state.assertExactTarget(
              openedSnapshot.sequence,
              thread.threadId,
              true,
            );
            const assertSelectionAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
              this.state.revalidateExactTarget(thread.threadId, target.slot, true, desktopIdentity)
            );
            // thread/start selects the new app-server thread before Desktop has
            // followed its deep link. A periodic native refresh in that window
            // must be allowed to clear that premature transport selection. Once
            // Desktop authoritatively confirms the new thread, explicitly bind
            // the transport to it again before dispatching the first turn.
            await this.transport.selectThread(thread.threadId, assertSelectionAuthority);
            const assertTurnAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
              this.state.revalidateExactTarget(thread.threadId, target.slot, true, desktopIdentity)
            );
            await this.transport.startTurn({
              commandId: `${command.commandId}:initial`,
              threadId: thread.threadId,
              input: [{ type: "text", text: command.instruction, text_elements: [] }],
              assertTargetAuthority: assertTurnAuthority,
            });
          } catch {
            initialInstructionConfirmed = false;
            this.logger.warn("Codex Pad created a task but could not confirm its initial instruction delivery; the created task ID remains authoritative.");
          }
        }
        try {
          await this.state.refresh();
        } catch {
          this.logger.warn("Codex Pad created a task but could not refresh the native snapshot; task creation remains successful.");
        }
        return result(
          this.state.current().sequence,
          thread.threadId,
          initialInstructionConfirmed
            ? "New Codex task created"
            : "New Codex task created; initial instruction delivery was not confirmed",
        );
      }
      case "sendSketch": {
        const target = this.state.assertExactTarget(command.expectedSequence, command.targetThreadId, true);
        if ("images" in command) {
          const normalized: Awaited<ReturnType<typeof this.normalizeSketch>>[] = [];
          try {
            for (const image of command.images) {
              normalized.push(await this.normalizeSketch({
                commandId: command.commandId,
                snapshotSeq: command.expectedSequence,
                targetThreadId: command.targetThreadId,
                instruction: "",
                pngBase64: image.png,
              }, this.paths));
            }
            // Exact target is checked again by the state mutation immediately
            // before the one native paste event.
            if (normalized.length === 1) {
              await this.state.attachImageToComposer(
                command.targetThreadId,
                target.slot,
                normalized[0]!.pngBase64,
                command.images[0]!.fileName as `Nerva Board ${string}.png`,
              );
            } else {
              await this.state.attachImagesToComposer(
                command.targetThreadId,
                target.slot,
                normalized.map((image, index) => ({
                  fileName: command.images[index]!.fileName as `Nerva Board ${string}.png`,
                  pngBase64: image.pngBase64,
                })),
              );
            }
          } finally {
            for (const image of normalized) await this.cleanupUpload("sketch", image.cleanup);
          }
          return result(this.state.current().sequence, command.targetThreadId, `${normalized.length} board image${normalized.length === 1 ? "" : "s"} attached to the exact Codex composer`);
        }
        const image = await this.normalizeSketch({
          commandId: command.commandId,
          snapshotSeq: command.expectedSequence,
          targetThreadId: command.targetThreadId,
          instruction: command.instruction,
          pngBase64: command.png,
        }, this.paths);
        try {
          await this.state.attachImageToComposer(
            command.targetThreadId,
            target.slot,
            image.pngBase64,
          );
        } finally {
          await this.cleanupUpload("sketch", image.cleanup);
        }
        return result(
          this.state.current().sequence,
          command.targetThreadId,
          "Sketch attached to the exact Codex composer",
        );
      }
      case "sendReview": {
        if (command.snapshotSeq !== command.expectedSequence) {
          throw new ProtocolCommandError("STALE_SNAPSHOT", "Review snapshot sequence does not match command authority", 409);
        }
        const target = this.state.assertExactTarget(command.expectedSequence, command.targetThreadId, true);
        const assertTargetAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
          this.state.revalidateExactTarget(command.targetThreadId, target.slot, true, desktopIdentity)
        );
        await this.transport.selectThread(command.targetThreadId, assertTargetAuthority);
        const review = await this.normalizeReview(command, this.paths, this.reviewInstructionHook);
        try {
          await this.transport.sendReview({
            commandId: command.commandId,
            threadId: command.targetThreadId,
            instruction: review.instruction,
            imagePaths: review.images.map((image) => image.path),
            assertTargetAuthority,
          });
        } finally {
          await this.cleanupUpload("review", review.cleanup);
        }
        return result(this.state.current().sequence, command.targetThreadId, "Ordered visual review delivered atomically");
      }
      case "runLibraryCommand": {
        if (command.snapshotSeq !== command.expectedSequence) {
          throw new ProtocolCommandError("STALE_SNAPSHOT", "Library snapshot sequence does not match command authority", 409);
        }
        if (SECRET_LIKE_PROMPT.test(command.prompt)) {
          throw new ProtocolCommandError(
            "SECRET_LIKE_INPUT",
            "The editable command appears to contain a credential or private key and was not sent",
            400,
          );
        }
        const target = this.state.assertExactTarget(command.expectedSequence, command.targetThreadId, true);
        const assertTargetAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
          this.state.revalidateExactTarget(command.targetThreadId, target.slot, true, desktopIdentity)
        );
        await this.transport.selectThread(command.targetThreadId, assertTargetAuthority);
        await this.transport.runLibraryCommand({
          commandId: command.commandId,
          threadId: command.targetThreadId,
          text: command.prompt,
          assertTargetAuthority,
        });
        return result(this.state.current().sequence, command.targetThreadId, "Configured command delivered to the exact Codex task");
      }
      case "runSkill": {
        const target = this.state.assertExactTarget(command.expectedSequence, command.targetThreadId, true);
        const assertTargetAuthority = (desktopIdentity?: DesktopProcessIdentity) => (
          this.state.revalidateExactTarget(command.targetThreadId, target.slot, true, desktopIdentity)
        );
        await this.transport.selectThread(command.targetThreadId, assertTargetAuthority);
        await this.transport.invokeSkill({
          commandId: command.commandId,
          threadId: command.targetThreadId,
          skillName: command.skillName,
          assertTargetAuthority,
        });
        return result(this.state.current().sequence, command.targetThreadId, "Skill delivered to the exact Codex task");
      }
      case "openSession": {
        this.state.assertSequence(command.expectedSequence);
        await this.sessions.openSession(command.targetThreadId);
        return result(this.state.current().sequence, command.targetThreadId, "Exact Codex session opened on the Mac");
      }
      case "refreshSnapshot": {
        const snapshot = await this.state.refresh();
        return result(snapshot.sequence, command.expectedThreadId, "Snapshot refreshed");
      }
      case "acknowledgeCompletion":
        throw new ProtocolCommandError(
          "CAPABILITY_UNAVAILABLE",
          "Completion acknowledgement is unavailable without a verified native revision contract",
          409,
        );
    }
  }
}

function result(sequence: number, targetThreadId: string | null, message: string): CommandResult {
  return { sequence, targetThreadId, message };
}

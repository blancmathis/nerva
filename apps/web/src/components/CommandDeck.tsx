import type { ReactNode } from "react";
import type { AgentSlot, NativeActionBinding, NativeJoystickBinding, PendingApproval, SkillCapability } from "../lib/model";
import {
  isCodexDictationBinding,
  isGenericApprovalBinding,
  isGenericApprovalJoystickBinding,
  isVerifiedNonApprovalBinding,
  isVerifiedJoystickBinding,
  microActionReference,
} from "../lib/control-commands";
import { BoltIcon, CheckIcon, ChevronIcon, ForkIcon, PencilIcon, PlusIcon, SparkIcon, XIcon } from "./Icons";

interface CommandDeckProps {
  readonly selected: AgentSlot | null;
  readonly targetReady: boolean;
  readonly resolveAction: (canonical: string) => string | null;
  readonly reasoningModes: readonly string[];
  readonly currentReasoningMode: string | null;
  readonly skills: readonly SkillCapability[];
  readonly microActions: readonly NativeActionBinding[];
  readonly joystickActions: readonly NativeJoystickBinding[];
  readonly drawingEnabled: boolean;
  readonly siteAvailable: boolean;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly approvalCommandEnabled: boolean;
  readonly busyAction: string | null;
  readonly onAction: (action: string, value?: string) => void;
  readonly onJoystick: (direction: NativeJoystickBinding["direction"]) => void;
  readonly onOpenDrawing: () => void;
  readonly onOpenReview: () => void;
  readonly onApprovalDecision: (approval: PendingApproval, decision: "accept" | "decline") => void;
}

interface CommandButtonProps {
  readonly label: string;
  readonly note: string;
  readonly action: string | null;
  readonly disabled: boolean;
  readonly active: boolean;
  readonly commandBusy: boolean;
  readonly tone?: "neutral" | "approve" | "decline" | "cobalt";
  readonly icon: ReactNode;
  readonly onPress: (action: string) => void;
}

function CommandButton({ label, note, action, disabled, active, commandBusy, tone = "neutral", icon, onPress }: CommandButtonProps) {
  return (
    <button
      type="button"
      className={`command-key tone-${tone}`}
      disabled={disabled || !action || commandBusy}
      onClick={() => action && onPress(action)}
      aria-busy={commandBusy}
    >
      <span className="command-icon" aria-hidden="true">{icon}</span>
      <span><strong>{active ? "Sending…" : label}</strong><small>{note}</small></span>
    </button>
  );
}

function bindingToken(binding: NativeActionBinding): string {
  return [binding.label, binding.nativeCommandId, binding.keycapId]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function bindingKind(binding: NativeActionBinding): "fast" | "fork" | "dictate" | "new" | "custom" {
  if (isCodexDictationBinding(binding)) return "dictate";
  const value = bindingToken(binding);
  if (["fork", "branch", "split"].some((alias) => value.includes(alias))) return "fork";
  if (["new", "createtask", "newthread"].some((alias) => value.includes(alias))) return "new";
  if (["fast", "quick"].some((alias) => value.includes(alias))) return "fast";
  return "custom";
}

function bindingIcon(kind: ReturnType<typeof bindingKind>): ReactNode {
  switch (kind) {
    case "fast": return <BoltIcon />;
    case "fork": return <ForkIcon />;
    case "dictate": return <SparkIcon />;
    case "new": return <PlusIcon />;
    case "custom": return <SparkIcon />;
  }
}

function bindingTone(kind: ReturnType<typeof bindingKind>): "neutral" | "approve" | "decline" | "cobalt" {
  if (kind === "fast") return "cobalt";
  return "neutral";
}

function bindingAction(binding: NativeActionBinding): string | null {
  return microActionReference(binding);
}

function approvalKindLabel(kind: PendingApproval["kind"]): string {
  if (kind === "commandExecution") return "Command execution";
  if (kind === "fileChange") return "File change";
  return "Permission request";
}

function approvalReference(approval: PendingApproval): string {
  const request = String(approval.requestId);
  return `request ${request.slice(-12)} · turn ${approval.turnId.slice(-8)} · item ${approval.itemId.slice(-12)}`;
}

export function CommandDeck({
  selected,
  targetReady,
  resolveAction,
  reasoningModes,
  currentReasoningMode,
  skills,
  microActions,
  joystickActions,
  drawingEnabled,
  siteAvailable,
  pendingApprovals = [],
  approvalCommandEnabled,
  busyAction,
  onAction,
  onJoystick,
  onOpenDrawing,
  onOpenReview,
  onApprovalDecision,
}: CommandDeckProps) {
  const approvalReady = targetReady && approvalCommandEnabled;
  const genericDispatchLocked = pendingApprovals.length > 0 || selected?.status === "awaiting-approval";
  const canAdjustReasoning = reasoningModes.length > 0 || Boolean(resolveAction("reasoning"));
  const skillSlots = Array.from({ length: 4 }, (_, index) => skills[index] ?? null);
  const hasNativeNew = microActions.some((binding) => (
    bindingKind(binding) === "new"
    && bindingAction(binding) !== null
    && resolveAction(bindingAction(binding) ?? "") !== null
  ));
  const commandBusy = busyAction !== null;

  return (
    <aside className="command-deck" aria-label="Task controls" aria-busy={commandBusy}>
      <div className="target-readout">
        <p className="eyebrow">Target channel</p>
        <div className="target-row">
          <div>
            <strong>{selected?.title ?? "No agent selected"}</strong>
            <span>{selected?.suffix ? `thread ${selected.suffix}` : "Choose one of the six native slots"}</span>
          </div>
          <span className={`target-state${targetReady ? " is-ready" : ""}`} aria-label={targetReady ? "Target locked" : "Target unavailable"}>
            {targetReady ? "LOCK" : "SAFE"}
          </span>
        </div>
        {siteAvailable && (
          <button type="button" className="open-site-review" onClick={onOpenReview} disabled={!selected}>
            Open associated site in Review
          </button>
        )}
      </div>

      {(pendingApprovals.length > 0 || selected?.status === "awaiting-approval") && (
        <section className="command-section approval-section" aria-labelledby="approval-heading">
          <div className="section-heading">
            <h2 id="approval-heading">Pending approval</h2><span>Exact app-server request</span>
          </div>
          {pendingApprovals.length === 0 ? (
            <p className="approval-locked" role="status">
              Approval controls are locked because no exact request identity is available.
            </p>
          ) : pendingApprovals.map((approval) => (
            <article className="approval-card" key={`${typeof approval.requestId}:${String(approval.requestId)}`}>
              <div className="approval-copy">
                <strong>{approvalKindLabel(approval.kind)}</strong>
                <p>{approval.summary ?? "Codex requested a decision for this exact item."}</p>
                <small>{approvalReference(approval)}</small>
              </div>
              <div className="approval-actions">
                <button
                  type="button"
                  className="approval-decision is-accept"
                  disabled={!approvalReady || !approval.actionable || commandBusy}
                  aria-busy={commandBusy}
                  onClick={() => onApprovalDecision(approval, "accept")}
                ><CheckIcon /><span>Approve exact request</span></button>
                <button
                  type="button"
                  className="approval-decision is-decline"
                  disabled={!approvalReady || !approval.actionable || commandBusy}
                  aria-busy={commandBusy}
                  onClick={() => onApprovalDecision(approval, "decline")}
                ><XIcon /><span>Decline exact request</span></button>
              </div>
              {!approval.actionable && <p className="approval-readonly">Read only — this grant type is not modeled safely.</p>}
            </article>
          ))}
        </section>
      )}

      <section className="command-section" aria-labelledby="commands-heading">
        <div className="section-heading">
          <h2 id="commands-heading">Commands</h2><span>Native mappings</span>
        </div>
        <div className="command-grid">
          {microActions.map((binding) => {
            const kind = bindingKind(binding);
            const codexDictation = isCodexDictationBinding(binding);
            const genericApproval = isGenericApprovalBinding(binding);
            const verifiedNonApproval = isVerifiedNonApprovalBinding(binding);
            const bindingReference = bindingAction(binding);
            const action = genericApproval || genericDispatchLocked
              ? null
              : codexDictation
                ? targetReady ? resolveAction("dictate") : null
                : targetReady && bindingReference ? resolveAction(bindingReference) : null;
            return (
              <CommandButton
                key={binding.actionSlot}
                label={codexDictation ? "Dictée Codex" : binding.label ?? "Unassigned"}
                note={codexDictation
                  ? "micro du Mac"
                  : genericApproval
                  ? `${binding.actionSlot} · exact request only`
                  : genericDispatchLocked
                    ? `${binding.actionSlot} · approval pending`
                  : binding.enabled && !verifiedNonApproval
                    ? `${binding.actionSlot} · unverified mapping`
                    : binding.enabled
                      ? binding.actionSlot
                      : "No native mapping"}
                action={action}
                disabled={!targetReady || genericApproval}
                active={action !== null && (busyAction === kind || busyAction === action)}
                commandBusy={commandBusy}
                tone={bindingTone(kind)}
                icon={bindingIcon(kind)}
                onPress={onAction}
              />
            );
          })}
          {!hasNativeNew && (
            <CommandButton
              label="New"
              note="App-server task"
              action={resolveAction("new")}
              disabled={false}
              active={busyAction === "new"}
              commandBusy={commandBusy}
              icon={<PlusIcon />}
              onPress={onAction}
            />
          )}
          <button
            type="button"
            className="command-key tone-neutral"
            disabled={!selected?.threadKey || !drawingEnabled}
            onClick={onOpenDrawing}
          >
            <span className="command-icon" aria-hidden="true"><PencilIcon /></span>
            <span><strong>Sketch</strong><small>Pencil input</small></span>
          </button>
        </div>
      </section>

      <section className="command-section reasoning-section" aria-labelledby="reasoning-heading">
        <div className="section-heading">
          <h2 id="reasoning-heading">Reasoning</h2><span>Effort</span>
        </div>
        <div className="reasoning-dial" aria-label={`Reasoning effort: ${currentReasoningMode ?? "unavailable"}`}>
          <button
            type="button"
            aria-label="Previous reasoning effort"
            aria-busy={commandBusy}
            disabled={commandBusy || genericDispatchLocked || !targetReady || !canAdjustReasoning || !resolveAction("reasoning")}
            onClick={() => onAction(resolveAction("reasoning") ?? "reasoning", "decrease")}
          ><ChevronIcon direction="left" /></button>
          <div className="dial-face">
            <span className="dial-tick" aria-hidden="true" />
            <small>Effort</small>
            <strong>{currentReasoningMode ?? "—"}</strong>
          </div>
          <button
            type="button"
            aria-label="Next reasoning effort"
            aria-busy={commandBusy}
            disabled={commandBusy || genericDispatchLocked || !targetReady || !canAdjustReasoning || !resolveAction("reasoning")}
            onClick={() => onAction(resolveAction("reasoning") ?? "reasoning", "increase")}
          ><ChevronIcon /></button>
        </div>
      </section>

      <section className="command-section joystick-section" aria-labelledby="joystick-heading">
        <div className="section-heading">
          <h2 id="joystick-heading">Direction pad</h2><span>Native assignments</span>
        </div>
        <div className="joystick-pad">
          {(["up", "left", "right", "down"] as const).map((direction) => {
            const assignment = joystickActions.find((candidate) => candidate.direction === direction);
            return (
              <button
                key={direction}
                type="button"
                className={`joystick-${direction}`}
                disabled={
                  commandBusy
                  || genericDispatchLocked
                  || !targetReady
                  || !resolveAction("joystick")
                  || !assignment?.enabled
                  || !isVerifiedJoystickBinding(assignment)
                  || isGenericApprovalJoystickBinding(assignment)
                }
                onClick={() => onJoystick(direction)}
                aria-label={`${direction} joystick action: ${assignment?.label ?? "unassigned"}`}
                aria-busy={commandBusy}
              >
                <strong aria-hidden="true">{direction === "up" ? "↑" : direction === "down" ? "↓" : direction === "left" ? "←" : "→"}</strong>
                <small>{assignment?.label ?? "Unassigned"}</small>
              </button>
            );
          })}
        </div>
      </section>

      <section className="command-section skill-section" aria-labelledby="skills-heading">
        <div className="section-heading">
          <h2 id="skills-heading">Skill launchers</h2><span>Configured on Mac</span>
        </div>
        <div className="skill-grid">
          {skillSlots.map((skill, index) => (
            <button
              key={skill?.id ?? `empty-${index}`}
              type="button"
              disabled={commandBusy || !targetReady || !skill?.enabled || !resolveAction("skill")}
              onClick={() => skill && onAction(resolveAction("skill") ?? "skill", skill.id)}
              title={skill?.description}
              aria-busy={commandBusy}
            >
              <span aria-hidden="true"><SparkIcon /></span>
              <strong>{skill?.label ?? "Unassigned"}</strong>
              <small>0{index + 1}</small>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

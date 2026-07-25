import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandDeck } from "./CommandDeck";
import type { AgentSlot, NativeActionBinding, NativeJoystickBinding } from "../lib/model";

const selected: AgentSlot = {
  slotId: "AG00",
  index: 0,
  title: "Exact task",
  threadKey: "local:019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
  suffix: "312a8ba1",
  status: "idle",
  selected: true,
  activityLabel: null,
  activityAt: null,
};

function binding(actionSlot: NativeActionBinding["actionSlot"], label: string): NativeActionBinding {
  const commandIds: Readonly<Record<string, string>> = {
    FAST: "mode.fast",
    APPROVE: "approval.accept",
    DECLINE: "approval.reject",
    FORK: "thread.fork",
    NEW: "thread.new",
  };
  const keycapId = label.toUpperCase();
  return {
    actionSlot,
    keycapId,
    nativeCommandId: commandIds[keycapId] ?? `native-${label.toLowerCase()}`,
    label,
    enabled: true,
  };
}

const joystick: NativeJoystickBinding = {
  direction: "up",
  type: "command",
  commandId: "native-up",
  label: "Move up",
  enabled: true,
};

describe("CommandDeck", () => {
  it("renders every configured native Micro assignment instead of a canonical subset", () => {
    const { container } = render(
      <CommandDeck
        selected={selected}
        targetReady
        resolveAction={() => null}
        reasoningModes={[]}
        currentReasoningMode={null}
        skills={[]}
        microActions={[
          binding("ACT06", "Fast"),
          binding("ACT07", "Approve"),
          binding("ACT08", "Decline"),
          binding("ACT09", "Fork"),
          binding("ACT10_ACT11", "New"),
          binding("ACT12", "Deploy preview"),
        ]}
        joystickActions={[]}
        drawingEnabled
        siteAvailable={false}
        pendingApprovals={[]}
        approvalCommandEnabled={false}
        busyAction={null}
        onAction={vi.fn()}
        onJoystick={vi.fn()}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    const deck = within(container);
    expect(deck.getByRole("button", { name: /Deploy previewACT12 · unverified mapping/ })).toBeDisabled();
    expect(deck.getByRole("button", { name: /ApproveACT07 · exact request only/ })).toBeDisabled();
    expect(deck.getByRole("button", { name: /DeclineACT08 · exact request only/ })).toBeDisabled();
    expect(deck.getByRole("button", { name: "SketchPencil input" })).toBeEnabled();
  });

  it("locks every dispatching control while any command is in flight", () => {
    const { container } = render(
      <CommandDeck
        selected={selected}
        targetReady
        resolveAction={(canonical) => canonical === "reasoning"
          ? "semantic:adjustReasoning"
          : canonical === "skill"
            ? "semantic:runSkill"
            : canonical === "joystick"
              ? "semantic:runJoystickAction"
              : canonical === "micro:ACT06:FAST:mode.fast"
                ? canonical
                : null}
        reasoningModes={["medium", "high"]}
        currentReasoningMode="medium"
        skills={[{ id: "review", label: "Review", enabled: true }]}
        microActions={[binding("ACT06", "Fast")]}
        joystickActions={[joystick]}
        drawingEnabled
        siteAvailable={false}
        pendingApprovals={[]}
        approvalCommandEnabled={false}
        busyAction="fast"
        onAction={vi.fn()}
        onJoystick={vi.fn()}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    const deck = within(container);
    expect(deck.getByRole("complementary", { name: "Task controls" })).toHaveAttribute("aria-busy", "true");
    for (const button of [
      deck.getByRole("button", { name: "Sending…ACT06" }),
      deck.getByRole("button", { name: "Previous reasoning effort" }),
      deck.getByRole("button", { name: "Next reasoning effort" }),
      deck.getByRole("button", { name: "up joystick action: Move up" }),
      deck.getByRole("button", { name: "Review01" }),
    ]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
    }

    // Opening a local canvas is not a bridge mutation and remains available.
    expect(deck.getByRole("button", { name: "SketchPencil input" })).toBeEnabled();
  });

  it("keeps the local sketch workspace available while bridge mutations are offline", () => {
    const openDrawing = vi.fn();
    const { container } = render(
      <CommandDeck
        selected={selected}
        targetReady={false}
        resolveAction={() => null}
        reasoningModes={[]}
        currentReasoningMode={null}
        skills={[]}
        microActions={[binding("ACT06", "Fast")]}
        joystickActions={[]}
        drawingEnabled
        siteAvailable={false}
        pendingApprovals={[]}
        approvalCommandEnabled={false}
        busyAction={null}
        onAction={vi.fn()}
        onJoystick={vi.fn()}
        onOpenDrawing={openDrawing}
        onOpenReview={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    const deck = within(container);
    expect(deck.getByRole("button", { name: "FastACT06" })).toBeDisabled();
    const sketch = deck.getByRole("button", { name: "SketchPencil input" });
    expect(sketch).toBeEnabled();
    sketch.click();
    expect(openDrawing).toHaveBeenCalledTimes(1);
  });

  it("disables an unknown future joystick identity even when a stale capability marks it enabled", () => {
    const onJoystick = vi.fn();
    const { container } = render(
      <CommandDeck
        selected={selected}
        targetReady
        resolveAction={() => null}
        reasoningModes={[]}
        currentReasoningMode={null}
        skills={[]}
        microActions={[]}
        joystickActions={[joystick]}
        drawingEnabled={false}
        siteAvailable={false}
        pendingApprovals={[]}
        approvalCommandEnabled={false}
        busyAction={null}
        onAction={vi.fn()}
        onJoystick={onJoystick}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    const button = within(container).getByRole("button", { name: "up joystick action: Move up" });
    expect(button).toBeDisabled();
    button.click();
    expect(onJoystick).not.toHaveBeenCalled();
  });

  it("responds only through an exact pending app-server request", () => {
    const onApprovalDecision = vi.fn();
    const approval = {
      requestId: 991,
      threadId: selected.threadId!,
      turnId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      itemId: "approval-item-a",
      kind: "commandExecution" as const,
      actionable: true,
      summary: "npm test",
    };
    const { container } = render(
      <CommandDeck
        selected={{ ...selected, status: "awaiting-approval" }}
        targetReady
        resolveAction={(canonical) => canonical === "reasoning" ? "semantic:adjustReasoning" : null}
        reasoningModes={["medium", "high"]}
        currentReasoningMode="medium"
        skills={[]}
        microActions={[binding("ACT06", "Fast"), binding("ACT07", "Approve")]}
        joystickActions={[{
          direction: "up",
          type: "command",
          commandId: "mode.plan",
          label: "Plan",
          enabled: true,
        }]}
        drawingEnabled
        siteAvailable={false}
        pendingApprovals={[approval]}
        approvalCommandEnabled
        busyAction={null}
        onAction={vi.fn()}
        onJoystick={vi.fn()}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={onApprovalDecision}
      />,
    );

    const deck = within(container);
    expect(deck.getByText("npm test")).toBeInTheDocument();
    expect(deck.getByRole("button", { name: /ApproveACT07 · exact request only/ })).toBeDisabled();
    expect(deck.getByRole("button", { name: /FastACT06 · approval pending/ })).toBeDisabled();
    expect(deck.getByRole("button", { name: "up joystick action: Plan" })).toBeDisabled();
    expect(deck.getByRole("button", { name: "Previous reasoning effort" })).toBeDisabled();
    expect(deck.getByRole("button", { name: "Next reasoning effort" })).toBeDisabled();
    deck.getByRole("button", { name: "Approve exact request" }).click();
    expect(onApprovalDecision).toHaveBeenCalledWith(approval, "accept");
  });

  it("surfaces permission requests read-only and never emits a decision", () => {
    const onApprovalDecision = vi.fn();
    const permission = {
      requestId: "permission-17",
      threadId: selected.threadId!,
      turnId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      itemId: "permission-item",
      kind: "permissions" as const,
      actionable: false,
      summary: "Allow filesystem access",
    };
    const { container } = render(
      <CommandDeck
        selected={{ ...selected, status: "awaiting-approval" }}
        targetReady
        resolveAction={() => null}
        reasoningModes={[]}
        currentReasoningMode={null}
        skills={[]}
        microActions={[binding("ACT06", "Fast")]}
        joystickActions={[]}
        drawingEnabled={false}
        siteAvailable={false}
        pendingApprovals={[permission]}
        approvalCommandEnabled
        busyAction={null}
        onAction={vi.fn()}
        onJoystick={vi.fn()}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={onApprovalDecision}
      />,
    );

    const deck = within(container);
    expect(deck.getByText("Allow filesystem access")).toBeInTheDocument();
    expect(deck.getByText(/Read only/)).toBeInTheDocument();
    const accept = deck.getByRole("button", { name: "Approve exact request" });
    const decline = deck.getByRole("button", { name: "Decline exact request" });
    expect(accept).toBeDisabled();
    expect(decline).toBeDisabled();
    accept.click();
    decline.click();
    expect(onApprovalDecision).not.toHaveBeenCalled();
  });

  it("labels and dispatches the exact native Mac microphone gesture without claiming recording state", () => {
    const action = "micro:ACT10_ACT11:MIC:dictation.toggle";
    const onAction = vi.fn();
    const { container } = render(
      <CommandDeck
        selected={selected}
        targetReady
        resolveAction={(canonical) => canonical === "dictate" ? action : null}
        reasoningModes={[]}
        currentReasoningMode={null}
        skills={[]}
        microActions={[{
          actionSlot: "ACT10_ACT11",
          keycapId: "MIC",
          nativeCommandId: "dictation.toggle",
          label: "MIC",
          enabled: true,
        }]}
        joystickActions={[]}
        drawingEnabled={false}
        siteAvailable={false}
        pendingApprovals={[]}
        approvalCommandEnabled={false}
        busyAction={null}
        onAction={onAction}
        onJoystick={vi.fn()}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    const deck = within(container);
    const dictate = deck.getByRole("button", { name: "Dictée Codexmicro du Mac" });
    expect(dictate).toBeEnabled();
    expect(deck.queryByText(/recording|listening/i)).not.toBeInTheDocument();
    dictate.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(action);
  });

  it("keeps exact Codex dictation disabled until native mutation authority is advertised", () => {
    const { container } = render(
      <CommandDeck
        selected={selected}
        targetReady
        resolveAction={() => null}
        reasoningModes={[]}
        currentReasoningMode={null}
        skills={[]}
        microActions={[{
          actionSlot: "ACT10_ACT11",
          keycapId: "MIC",
          nativeCommandId: "dictation.toggle",
          label: "MIC",
          enabled: true,
        }]}
        joystickActions={[]}
        drawingEnabled={false}
        siteAvailable={false}
        pendingApprovals={[]}
        approvalCommandEnabled={false}
        busyAction={null}
        onAction={vi.fn()}
        onJoystick={vi.fn()}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    expect(within(container).getByRole("button", { name: "Dictée Codexmicro du Mac" })).toBeDisabled();
  });

  it("does not brand or enable a lookalike microphone assignment as Codex dictation", () => {
    const { container } = render(
      <CommandDeck
        selected={selected}
        targetReady
        resolveAction={() => "micro:ACT10_ACT11:MIC:composer.dictate"}
        reasoningModes={[]}
        currentReasoningMode={null}
        skills={[]}
        microActions={[{
          actionSlot: "ACT10_ACT11",
          keycapId: "MIC",
          nativeCommandId: "composer.dictate",
          label: "Dictate",
          enabled: true,
        }]}
        joystickActions={[]}
        drawingEnabled={false}
        siteAvailable={false}
        pendingApprovals={[]}
        approvalCommandEnabled={false}
        busyAction={null}
        onAction={vi.fn()}
        onJoystick={vi.fn()}
        onOpenDrawing={vi.fn()}
        onOpenReview={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    const deck = within(container);
    expect(deck.queryByRole("button", { name: /Dictée Codex/ })).not.toBeInTheDocument();
    expect(deck.getByRole("button", { name: /DictateACT10_ACT11 · unverified mapping/ })).toBeDisabled();
  });
});

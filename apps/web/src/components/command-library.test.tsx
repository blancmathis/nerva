import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandLibrary, type CommandLibraryProps } from "./CommandLibrary";
import { parseCommandLibrary, type CommandLibraryConfig } from "../lib/command-library";

const THREAD_A = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const THREAD_B = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";

afterEach(cleanup);

const TEST_LIBRARY: CommandLibraryConfig = parseCommandLibrary({
  version: 1,
  libraryId: "library_component_test",
  commands: [{
    id: "command.review.test",
    label: "Open my review",
    glyph: "⌗",
    category: "review",
    scope: { kind: "global" },
    prompt: "Open the exact review surface for this task and wait for annotations.",
  }],
});

function props(overrides: Partial<CommandLibraryProps> = {}): CommandLibraryProps {
  return {
    selectedTarget: { threadId: THREAD_A, title: "Landing page review" },
    online: true,
    onRunCommand: vi.fn(),
    initialLibrary: TEST_LIBRARY,
    ...overrides,
  };
}

describe("CommandLibrary target guard", () => {
  it("creates and filters project-scoped commands from the opaque current project", () => {
    const projectId = "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I";
    const view = render(<CommandLibrary {...props({ currentProject: { id: projectId, label: "Codex Pad" } })} />);

    expect(screen.getByText("Project: Codex Pad")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Command" }));
    expect(screen.getByLabelText("Scope")).toHaveValue("project");
    fireEvent.change(screen.getByLabelText("Short label"), { target: { value: "Verify this project" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Detailed prompt/ }), { target: { value: "Verify the current project task." } });
    fireEvent.click(screen.getByRole("button", { name: "Save command" }));
    expect(screen.getByText("Verify this project")).toBeInTheDocument();

    view.rerender(<CommandLibrary {...props({ currentProject: {
      id: "project:CTW3aFtA0PLAfVg9FMSzjZ6jsVRSm9_1ABm0ZZJxPdE",
      label: "Codex Pad",
    } })} />);
    expect(screen.queryByText("Verify this project")).not.toBeInTheDocument();
  });

  it("emits exactly once only after the user confirms the full selected thread", async () => {
    const onRunCommand = vi.fn();
    render(<CommandLibrary {...props({ onRunCommand })} />);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(THREAD_A);

    fireEvent.click(screen.getByRole("button", { name: "Confirm exact thread" }));
    await waitFor(() => expect(onRunCommand).toHaveBeenCalledTimes(1));
    expect(onRunCommand).toHaveBeenCalledWith(expect.objectContaining({
      targetThreadId: THREAD_A,
      libraryId: "library_component_test",
      libraryCommandId: "command.review.test",
      prompt: "Open the exact review surface for this task and wait for annotations.",
    }));
  });

  it("invalidates confirmation when selection changes", () => {
    const onRunCommand = vi.fn();
    const view = render(<CommandLibrary {...props({ onRunCommand })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    view.rerender(<CommandLibrary {...props({
      onRunCommand,
      selectedTarget: { threadId: THREAD_B, title: "Different task" },
    })} />);

    expect(screen.getByRole("button", { name: "Confirm exact thread" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/selected thread or connection changed/i);
    expect(onRunCommand).not.toHaveBeenCalled();
  });

  it("never queues or replays a command while offline", () => {
    const onRunCommand = vi.fn();
    const view = render(<CommandLibrary {...props({ online: false, onRunCommand })} />);
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

    view.rerender(<CommandLibrary {...props({ online: true, onRunCommand })} />);
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("permanently invalidates a pending confirmation after a connection loss", () => {
    const onRunCommand = vi.fn();
    const view = render(<CommandLibrary {...props({ onRunCommand })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    view.rerender(<CommandLibrary {...props({ online: false, onRunCommand })} />);
    view.rerender(<CommandLibrary {...props({ online: true, onRunCommand })} />);

    expect(screen.getByRole("button", { name: "Confirm exact thread" })).toBeDisabled();
    expect(onRunCommand).not.toHaveBeenCalled();
  });

  it("contains focus in confirmations, closes with Escape, and restores the trigger", () => {
    render(<CommandLibrary {...props()} />);
    const trigger = screen.getByRole("button", { name: "Run" });
    trigger.focus();
    fireEvent.click(trigger);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm exact thread" });
    expect(cancel).toHaveFocus();

    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

import { useRef, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./use-modal-focus";

function Modal({ name, children, onClose, active = true }: {
  name: string; children?: ReactNode; onClose: () => void; active?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useModalFocus(ref, onClose, { active });
  return <section ref={ref} role="dialog" aria-label={name} hidden={!active} tabIndex={-1}>
    <button>{name} first</button>{children}<button>{name} last</button>
  </section>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("modal focus ownership", () => {
  it("skips controls hidden by an ancestor, disabled fieldsets and negative tab stops", () => {
    render(<Modal name="Editor" onClose={vi.fn()}>
      <div style={{ display: "none" }}><button>Hidden control</button></div>
      <fieldset disabled><button>Disabled fieldset control</button></fieldset>
      <button tabIndex={-1}>Programmatic only</button>
      <div aria-hidden="true"><button>Hidden from assistive technology</button></div>
    </Modal>);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Editor last" })).toHaveFocus();
  });

  it("gives simultaneous nested dialogs to the innermost modal", () => {
    render(<Modal name="Parent" onClose={vi.fn()}><Modal name="Child" onClose={vi.fn()} /></Modal>);
    expect(screen.getByRole("button", { name: "Child first" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Child last" })).toHaveFocus();
  });

  it("closes only the top dialog for a single Escape", () => {
    const parentClose = vi.fn();
    const childClose = vi.fn();
    render(<Modal name="Parent" onClose={parentClose}><Modal name="Child" onClose={childClose} /></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(childClose).toHaveBeenCalledOnce();
    expect(parentClose).not.toHaveBeenCalled();
  });

  it("respects a key event already handled by a control", () => {
    const close = vi.fn();
    render(<Modal name="Editor" onClose={close}><input aria-label="Editor text" onKeyDown={(event) => {
      if (event.key === "Escape") event.preventDefault();
    }} /></Modal>);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });

  it("brings programmatic focus back into the active modal", () => {
    render(<><button>Background action</button><Modal name="Editor" onClose={vi.fn()} /></>);
    screen.getByRole("button", { name: "Background action" }).focus();
    expect(screen.getByRole("button", { name: "Editor first" })).toHaveFocus();
  });

  it("restores the trigger even when an inactive dialog stays mounted", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open editor</button>
        <Modal name="Editor" active={open} onClose={() => setOpen(false)} /></>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open editor" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not steal focus from a replacement dialog", async () => {
    function Harness() {
      const [view, setView] = useState("first");
      return <><button>Background action</button>{view === "first"
        ? <Modal key="first" name="First" onClose={() => setView("second")} />
        : <Modal key="second" name="Second" onClose={vi.fn()} />}</>;
    }
    render(<Harness />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Second first" })).toHaveFocus());
  });
});

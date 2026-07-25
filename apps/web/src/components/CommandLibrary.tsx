import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  COMMAND_CATEGORIES,
  COMMAND_CATEGORY_LABELS,
  COMMAND_GLYPHS,
  COMMAND_LIMITS,
  createCommandId,
  createCommandRunRequest,
  createDefaultCommandLibrary,
  deleteCommand,
  isValidThreadTarget,
  parseCommandLibrary,
  reorderCommand,
  serializeCommandLibrary,
  upsertCommand,
  visibleCommands,
  type CommandCategory,
  type CommandGlyph,
  type CommandLibraryConfig,
  type CommandRunRequest,
  type CommandTarget,
  type LibraryCommand,
  type ProjectScopeContext,
} from "../lib/command-library";
import { loadCommandLibrary, saveCommandLibrary } from "../lib/command-library-store";
import { COMMAND_LIBRARY_STYLES } from "./command-library-styles";

export type {
  CommandLibraryConfig,
  CommandRunRequest,
  CommandTarget,
  LibraryCommand,
  ProjectScopeContext,
} from "../lib/command-library";

export interface CommandLibraryProps {
  readonly selectedTarget: CommandTarget | null;
  readonly online: boolean;
  readonly readOnly?: boolean;
  readonly currentProject?: ProjectScopeContext | null;
  readonly onRunCommand: (request: CommandRunRequest) => void | Promise<void>;
  readonly initialLibrary?: CommandLibraryConfig;
  readonly onLibraryChange?: (library: CommandLibraryConfig) => void;
}

interface CommandDraft {
  readonly id: string;
  readonly label: string;
  readonly glyph: CommandGlyph;
  readonly category: CommandCategory;
  readonly scopeKind: "global" | "project";
  readonly prompt: string;
}

interface PendingRun {
  readonly command: LibraryCommand;
  readonly targetThreadId: string;
  readonly targetTitle: string;
}

type Overlay = "editor" | "import" | "export" | "delete" | "run" | null;

const DIALOG_FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function useContainedDialog(
  activeKey: Overlay,
  dialogRef: RefObject<HTMLElement | null>,
  escapeAllowed: boolean,
  onEscape: () => void,
) {
  const escapeAllowedRef = useRef(escapeAllowed);
  const onEscapeRef = useRef(onEscape);
  escapeAllowedRef.current = escapeAllowed;
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!activeKey) return;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      ?? dialog?.querySelector<HTMLElement>(DIALOG_FOCUSABLE)
      ?? dialog;
    initial?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const currentDialog = dialogRef.current;
      if (!currentDialog) return;
      if (event.key === "Escape") {
        if (!escapeAllowedRef.current) return;
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(currentDialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        currentDialog.focus();
        return;
      }
      const active = document.activeElement;
      if (!currentDialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === currentDialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === currentDialog)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [activeKey, dialogRef]);
}

function draftFor(
  command: LibraryCommand | null,
  library: CommandLibraryConfig,
  currentProject: ProjectScopeContext | null,
): CommandDraft {
  if (command) {
    return {
      id: command.id,
      label: command.label,
      glyph: command.glyph,
      category: command.category,
      scopeKind: command.scope.kind,
      prompt: command.prompt,
    };
  }
  return {
    id: createCommandId(new Set(library.commands.map((candidate) => candidate.id))),
    label: "",
    glyph: "◇",
    category: "review",
    scopeKind: currentProject ? "project" : "global",
    prompt: "",
  };
}

function commandFromDraft(draft: CommandDraft, currentProject: ProjectScopeContext | null): LibraryCommand {
  return {
    id: draft.id,
    label: draft.label,
    glyph: draft.glyph,
    category: draft.category,
    scope: draft.scopeKind === "project" && currentProject
      ? { kind: "project", projectId: currentProject.id, projectLabel: currentProject.label }
      : { kind: "global" },
    prompt: draft.prompt,
  };
}

function shortThreadId(threadId: string | null | undefined): string {
  if (!threadId) return "No exact thread selected";
  return `${threadId.slice(0, 8)}…${threadId.slice(-8)}`;
}

export function CommandLibrary({
  selectedTarget,
  online,
  readOnly = false,
  currentProject = null,
  onRunCommand,
  initialLibrary,
  onLibraryChange,
}: CommandLibraryProps) {
  const titleId = useId();
  const editorTitleId = useId();
  const [library, setLibrary] = useState<CommandLibraryConfig>(() => (
    initialLibrary ? parseCommandLibrary(initialLibrary) : createDefaultCommandLibrary()
  ));
  const [ready, setReady] = useState(Boolean(initialLibrary));
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CommandCategory | "all">("all");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [draft, setDraft] = useState<CommandDraft>(() => draftFor(null, library, currentProject));
  const [deleteCandidate, setDeleteCandidate] = useState<LibraryCommand | null>(null);
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const [importText, setImportText] = useState("");
  const [exportText, setExportText] = useState("");
  const [message, setMessage] = useState<{ readonly tone: "error" | "success"; readonly text: string } | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [runInvalidated, setRunInvalidated] = useState(false);
  const dispatchGuard = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);

  useContainedDialog(overlay, dialogRef, !dispatching, () => setOverlay(null));

  useEffect(() => {
    if (initialLibrary) return;
    let active = true;
    void loadCommandLibrary().then((stored) => {
      if (!active) return;
      setLibrary(stored);
      setReady(true);
    }).catch(() => {
      if (!active) return;
      setReady(true);
      setMessage({ tone: "error", text: "Stored commands could not be read. The editable templates are still available." });
    });
    return () => { active = false; };
  }, [initialLibrary]);

  const shownCommands = useMemo(
    () => visibleCommands(library, currentProject?.id, query, category),
    [category, currentProject?.id, library, query],
  );
  const targetReady = online && !readOnly && isValidThreadTarget(selectedTarget?.threadId);
  const libraryFull = library.commands.length >= COMMAND_LIMITS.commands;

  useEffect(() => {
    if (!pendingRun || overlay !== "run") return;
    if (!targetReady || selectedTarget?.threadId !== pendingRun.targetThreadId) setRunInvalidated(true);
  }, [overlay, pendingRun, selectedTarget?.threadId, targetReady]);

  const commitLibrary = (next: CommandLibraryConfig, successText: string) => {
    setLibrary(next);
    onLibraryChange?.(next);
    setMessage({ tone: "success", text: successText });
    void saveCommandLibrary(next).catch((error: unknown) => {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Command library could not be saved on this device.",
      });
    });
  };

  const openEditor = (command: LibraryCommand | null) => {
    setDraft(draftFor(command, library, currentProject));
    setMessage(null);
    setOverlay("editor");
  };

  const saveDraft = () => {
    try {
      const next = upsertCommand(library, commandFromDraft(draft, currentProject));
      commitLibrary(next, "Command saved locally.");
      setOverlay(null);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Command is invalid." });
    }
  };

  const requestDelete = (command: LibraryCommand) => {
    setDeleteCandidate(command);
    setOverlay("delete");
  };

  const confirmDelete = () => {
    if (!deleteCandidate) return;
    commitLibrary(deleteCommand(library, deleteCandidate.id), "Command deleted.");
    setDeleteCandidate(null);
    setOverlay(null);
  };

  const move = (command: LibraryCommand, direction: -1 | 1) => {
    const next = reorderCommand(library, command.id, direction);
    if (next !== library) commitLibrary(next, "Command order saved.");
  };

  const requestRun = (command: LibraryCommand) => {
    setMessage(null);
    if (!targetReady || !selectedTarget) {
      setMessage({ tone: "error", text: "Select an online Codex thread before running a command." });
      return;
    }
    setPendingRun({ command, targetThreadId: selectedTarget.threadId, targetTitle: selectedTarget.title });
    setRunInvalidated(false);
    setOverlay("run");
  };

  const targetStillExact = Boolean(
    pendingRun
    && !runInvalidated
    && targetReady
    && selectedTarget?.threadId === pendingRun.targetThreadId,
  );

  const confirmRun = async () => {
    if (!pendingRun || !targetStillExact || dispatchGuard.current) {
      setMessage({ tone: "error", text: "The selected thread changed. Close this confirmation and choose the command again." });
      return;
    }
    try {
      const request = createCommandRunRequest(library, pendingRun.command, pendingRun.targetThreadId);
      dispatchGuard.current = true;
      setDispatching(true);
      setOverlay(null);
      setPendingRun(null);
      await onRunCommand(request);
      setMessage({ tone: "success", text: `“${pendingRun.command.label}” sent once to ${shortThreadId(request.targetThreadId)}.` });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The command was not accepted. It will not be replayed automatically.",
      });
    } finally {
      dispatchGuard.current = false;
      setDispatching(false);
    }
  };

  const applyImport = () => {
    try {
      const imported = parseCommandLibrary(importText);
      commitLibrary(imported, `Imported ${imported.commands.length} commands.`);
      setOverlay(null);
      setImportText("");
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Import is invalid." });
    }
  };

  const readImportFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > COMMAND_LIMITS.serializedBytes) {
      setMessage({ tone: "error", text: `Import is limited to ${COMMAND_LIMITS.serializedBytes} bytes.` });
      return;
    }
    setImportText(await file.text());
  };

  const openExport = () => {
    setExportText(serializeCommandLibrary(library));
    setOverlay("export");
  };

  return (
    <section className="cpl-shell" aria-labelledby={titleId} aria-busy={!ready || dispatching}>
      <style>{COMMAND_LIBRARY_STYLES}</style>
      <header className="cpl-head">
        <div>
          <p className="cpl-kicker">Local command plates</p>
          <h2 id={titleId}>Command library</h2>
        </div>
        <div className={`cpl-target${targetReady ? " is-ready" : ""}`} aria-label={targetReady ? "Exact command target selected" : "Command target unavailable"}>
          <strong>{selectedTarget?.title ?? "No task selected"}</strong>
          <code>{shortThreadId(selectedTarget?.threadId)}</code>
        </div>
      </header>

      <div className="cpl-toolbar">
        <label>
          <span className="sr-only">Search commands</span>
          <input
            className="cpl-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search labels or categories"
          />
        </label>
        <label>
          <span className="sr-only">Filter by category</span>
          <select className="cpl-select" value={category} onChange={(event) => setCategory(event.currentTarget.value as CommandCategory | "all")}>
            <option value="all">All categories</option>
            {COMMAND_CATEGORIES.map((value) => <option key={value} value={value}>{COMMAND_CATEGORY_LABELS[value]}</option>)}
          </select>
        </label>
        <div className="cpl-actions">
          <button type="button" className="cpl-button" onClick={() => { setMessage(null); setOverlay("import"); }}>Import</button>
          <button type="button" className="cpl-button" onClick={openExport}>Export</button>
          <button type="button" className="cpl-button is-primary" disabled={libraryFull} onClick={() => openEditor(null)}>+ Command</button>
        </div>
      </div>

      <div className="cpl-actions">
        <span className="cpl-count">{shownCommands.length} visible · {library.commands.length}/{COMMAND_LIMITS.commands} stored</span>
        {currentProject ? <span className="cpl-count">Project: {currentProject.label}</span> : <span className="cpl-count">Global commands only</span>}
      </div>
      {!online && <p className="cpl-note">Offline: commands stay editable, but Run is disabled. Nothing will be replayed when the connection returns.</p>}
      {readOnly && <p className="cpl-note">Read-only bridge: commands remain editable locally, but dispatching is disabled.</p>}
      {message && <p className={message.tone === "error" ? "cpl-error" : "cpl-success"} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}

      {shownCommands.length > 0 ? (
        <ul className="cpl-grid">
          {shownCommands.map((command) => {
            const absoluteIndex = library.commands.findIndex((candidate) => candidate.id === command.id);
            return (
              <li className="cpl-card" key={command.id}>
                <span className="cpl-glyph" aria-hidden="true">{command.glyph}</span>
                <div className="cpl-card-copy">
                  <strong>{command.label}</strong>
                  <span>{COMMAND_CATEGORY_LABELS[command.category]} · {command.scope.kind === "global" ? "Global" : command.scope.projectLabel}</span>
                </div>
                <div className="cpl-card-actions">
                  <button type="button" aria-label={`Move ${command.label} earlier`} disabled={absoluteIndex <= 0} onClick={() => move(command, -1)}>↑</button>
                  <button type="button" aria-label={`Move ${command.label} later`} disabled={absoluteIndex >= library.commands.length - 1} onClick={() => move(command, 1)}>↓</button>
                  <button type="button" aria-label={`Edit ${command.label}`} onClick={() => openEditor(command)}>Edit</button>
                  <button type="button" aria-label={`Delete ${command.label}`} onClick={() => requestDelete(command)}>Delete</button>
                  <button type="button" className="cpl-run" disabled={!targetReady || dispatching} onClick={() => requestRun(command)}>Run</button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="cpl-empty">
          <strong>No command matches this view.</strong>
          <span>Clear the search, change category, or add a command for this project.</span>
        </div>
      )}

      {overlay === "editor" && (
        <div className="cpl-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOverlay(null); }}>
          <section ref={dialogRef} className="cpl-dialog" role="dialog" aria-modal="true" aria-labelledby={editorTitleId} tabIndex={-1}>
            <div className="cpl-dialog-head">
              <div><h3 id={editorTitleId}>{library.commands.some((command) => command.id === draft.id) ? "Edit command" : "Create command"}</h3><p>The detailed prompt remains behind this short label until you edit it.</p></div>
              <button type="button" className="cpl-button" aria-label="Close command editor" onClick={() => setOverlay(null)}>×</button>
            </div>
            <div className="cpl-form-grid">
              <label className="cpl-field"><span>Short label</span><input data-dialog-initial-focus maxLength={COMMAND_LIMITS.label} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.currentTarget.value })} /></label>
              <label className="cpl-field"><span>Category</span><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.currentTarget.value as CommandCategory })}>{COMMAND_CATEGORIES.map((value) => <option key={value} value={value}>{COMMAND_CATEGORY_LABELS[value]}</option>)}</select></label>
            </div>
            <div className="cpl-glyph-field"><span>Glyph</span><div className="cpl-glyphs" role="radiogroup" aria-label="Command glyph">{COMMAND_GLYPHS.map((glyph) => <button key={glyph} type="button" role="radio" aria-checked={draft.glyph === glyph} className={`cpl-icon-choice${draft.glyph === glyph ? " is-selected" : ""}`} onClick={() => setDraft({ ...draft, glyph })}>{glyph}</button>)}</div></div>
            <label className="cpl-field"><span>Scope</span><select value={draft.scopeKind} onChange={(event) => setDraft({ ...draft, scopeKind: event.currentTarget.value as "global" | "project" })}><option value="global">All projects</option><option value="project" disabled={!currentProject}>{currentProject ? `Only ${currentProject.label}` : "Open a project first"}</option></select></label>
            <label className="cpl-field"><span>Detailed prompt</span><textarea maxLength={COMMAND_LIMITS.prompt} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })} /><small>{draft.prompt.length}/{COMMAND_LIMITS.prompt}. Store instructions, never credentials.</small></label>
            <div className="cpl-dialog-actions"><button type="button" className="cpl-button" onClick={() => setOverlay(null)}>Cancel</button><button type="button" className="cpl-button is-primary" onClick={saveDraft}>Save command</button></div>
          </section>
        </div>
      )}

      {overlay === "delete" && deleteCandidate && (
        <div className="cpl-overlay" role="presentation">
          <section ref={dialogRef} className="cpl-dialog" role="dialog" aria-modal="true" aria-labelledby={`${editorTitleId}-delete`} tabIndex={-1}>
            <div><h3 id={`${editorTitleId}-delete`}>Delete “{deleteCandidate.label}”?</h3><p className="cpl-confirm-copy">This removes the local template. It does not send anything to Codex.</p></div>
            <div className="cpl-dialog-actions"><button type="button" className="cpl-button" data-dialog-initial-focus onClick={() => setOverlay(null)}>Keep command</button><button type="button" className="cpl-button is-danger" onClick={confirmDelete}>Delete command</button></div>
          </section>
        </div>
      )}

      {overlay === "run" && pendingRun && (
        <div className="cpl-overlay" role="presentation">
          <section ref={dialogRef} className="cpl-dialog" role="dialog" aria-modal="true" aria-labelledby={`${editorTitleId}-run`} tabIndex={-1}>
            <div><h3 id={`${editorTitleId}-run`}>Send “{pendingRun.command.label}”?</h3><p className="cpl-confirm-copy">Confirm the exact Codex thread. The prompt is sent once and is never queued for offline replay.</p></div>
            <div className="cpl-confirm-target"><strong>{pendingRun.targetTitle}</strong><code>{pendingRun.targetThreadId}</code></div>
            {!targetStillExact && <p className="cpl-error" role="alert">The selected thread or connection changed. Close and choose the command again.</p>}
            <div className="cpl-dialog-actions"><button type="button" className="cpl-button" data-dialog-initial-focus onClick={() => setOverlay(null)}>Cancel</button><button type="button" className="cpl-button is-run" disabled={!targetStillExact || dispatching} onClick={() => { void confirmRun(); }}>Confirm exact thread</button></div>
          </section>
        </div>
      )}

      {overlay === "import" && (
        <div className="cpl-overlay" role="presentation">
          <section ref={dialogRef} className="cpl-dialog" role="dialog" aria-modal="true" aria-labelledby={`${editorTitleId}-import`} tabIndex={-1}>
            <div><h3 id={`${editorTitleId}-import`}>Import command library</h3><p className="cpl-confirm-copy">Only version 1 JSON with known fields, bounded prompts, unique ids, and no credential-like values is accepted.</p></div>
            <label className="cpl-button cpl-file">Choose JSON file<input type="file" accept="application/json,.json" onChange={(event) => { void readImportFile(event.currentTarget.files?.[0]); }} /></label>
            <label className="cpl-field"><span>JSON</span><textarea className="cpl-import-text" data-dialog-initial-focus value={importText} onChange={(event) => setImportText(event.currentTarget.value)} /></label>
            <div className="cpl-dialog-actions"><button type="button" className="cpl-button" onClick={() => setOverlay(null)}>Cancel</button><button type="button" className="cpl-button is-primary" disabled={!importText.trim()} onClick={applyImport}>Validate and replace</button></div>
          </section>
        </div>
      )}

      {overlay === "export" && (
        <div className="cpl-overlay" role="presentation">
          <section ref={dialogRef} className="cpl-dialog" role="dialog" aria-modal="true" aria-labelledby={`${editorTitleId}-export`} tabIndex={-1}>
            <div><h3 id={`${editorTitleId}-export`}>Export command library</h3><p className="cpl-confirm-copy">Copy this validated, versioned JSON. No connection credentials are included.</p></div>
            <label className="cpl-field"><span>JSON</span><textarea className="cpl-export-text" data-dialog-initial-focus readOnly value={exportText} onFocus={(event) => event.currentTarget.select()} /></label>
            <div className="cpl-dialog-actions"><button type="button" className="cpl-button is-primary" onClick={() => setOverlay(null)}>Done</button></div>
          </section>
        </div>
      )}
    </section>
  );
}

import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { STATUS_LABELS, type AgentSlot } from "../lib/model";
import {
  SPATIAL_BOX_COLORS,
  SPATIAL_BOX_SIZES,
  boxIdForThread,
  buildGroupingSuggestions,
  emptySpatialLayout,
  reconcileSpatialLayout,
  sessionMatchesSearch,
  spatialLayoutReducer,
  spatialSessionsFromSources,
  type SessionSummary,
  type SpatialBox,
  type SpatialBoxColor,
  type SpatialBoxSize,
  type SpatialLayout,
  type SpatialSession,
} from "../lib/spatial-model";
import {
  browserSpatialLayoutStorage,
  type SpatialLayoutStorage,
} from "../lib/spatial-storage";
import { createUuidV4 } from "../lib/uuid";

export type { SessionSummary, SpatialSession } from "../lib/spatial-model";
export type { SpatialLayoutStorage } from "../lib/spatial-storage";

export interface SpatialBoardProps {
  readonly slots: readonly AgentSlot[];
  readonly sessions?: readonly SessionSummary[];
  readonly allSessionsEnabled?: boolean;
  readonly allSessionsAvailable?: boolean;
  readonly selectedThreadId?: string | null;
  readonly onOpenSession: (session: SpatialSession) => void;
  readonly onAllSessionsEnabledChange?: (enabled: boolean) => void;
  readonly storage?: SpatialLayoutStorage;
  readonly initialLayout?: SpatialLayout;
  readonly onLayoutChange?: (layout: SpatialLayout) => void;
}

interface PointerDrag {
  readonly pointerId: number;
  readonly threadId: string;
  readonly startX: number;
  readonly startY: number;
  readonly moved: boolean;
  readonly overBoxId: string | null | undefined;
}

interface DropDestination {
  readonly boxId: string | null;
  readonly beforeThreadId: string | undefined;
}

interface SessionCardProps {
  readonly session: SpatialSession;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly boxId: string | null;
  readonly boxes: readonly SpatialBox[];
  readonly onOpen: (session: SpatialSession) => void;
  readonly onStartPointerMove: (
    session: SpatialSession,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  readonly onMove: (session: SpatialSession, targetBoxId: string | null) => void;
  readonly onKeyboardMove: (session: SpatialSession, direction: -1 | 1) => void;
  readonly onKeyboardReorder: (session: SpatialSession, direction: -1 | 1) => void;
}

const UNASSIGNED_DROP_ID = "__unassigned__";
const POINTER_MOVE_THRESHOLD = 5;
const DIALOG_FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function useContainedDialog(
  activeKey: string | null,
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  restoreFallbackRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!activeKey) return;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    (initialFocusRef.current
      ?? dialog?.querySelector<HTMLElement>(DIALOG_FOCUSABLE)
      ?? dialog)?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const currentDialog = dialogRef.current;
      if (!currentDialog) return;
      if (event.key === "Escape") {
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
      const focused = document.activeElement;
      if (!currentDialog.contains(focused)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (focused === first || focused === currentDialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focused === last || focused === currentDialog)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previous?.isConnected && !previous.matches(":disabled")) previous.focus();
      else restoreFallbackRef.current?.focus();
    };
  }, [activeKey, dialogRef, initialFocusRef, restoreFallbackRef]);
}

const COLOR_LABELS: Record<SpatialBoxColor, string> = {
  cobalt: "Cobalt",
  amber: "Amber",
  coral: "Coral",
  sage: "Sage",
  violet: "Violet",
  slate: "Slate",
};

const SIZE_LABELS: Record<SpatialBoxSize, string> = {
  compact: "Compact",
  standard: "Standard",
  wide: "Wide",
};

function uniqueBoxId(layout: SpatialLayout, prefix = "box"): string {
  const token = createUuidV4().slice(0, 8);
  const base = `${prefix}-${token}`;
  if (!layout.boxes.some((box) => box.id === base)) return base;
  let suffix = 2;
  while (layout.boxes.some((box) => box.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function boxName(layout: SpatialLayout, boxId: string | null): string {
  if (boxId === null) return "Unassigned";
  return layout.boxes.find((box) => box.id === boxId)?.name ?? "Unassigned";
}

function targetFromPointer(
  event: ReactPointerEvent<HTMLElement>,
  draggedThreadId: string,
): DropDestination | null {
  const eventElement = event.target instanceof Element ? event.target : null;
  let pointedElement: Element | null = null;
  try {
    pointedElement = document.elementFromPoint(event.clientX, event.clientY);
  } catch {
    // jsdom and older embedded webviews may not expose elementFromPoint.
  }
  const dropElement =
    pointedElement?.closest<HTMLElement>("[data-spatial-drop-target]") ??
    eventElement?.closest<HTMLElement>("[data-spatial-drop-target]");
  if (!dropElement) return null;
  const rawBoxId = dropElement.dataset.spatialDropTarget;
  if (!rawBoxId) return null;
  const cardElement =
    pointedElement?.closest<HTMLElement>("[data-spatial-thread-id]") ??
    eventElement?.closest<HTMLElement>("[data-spatial-thread-id]");
  const beforeThreadId = cardElement?.dataset.spatialThreadId;
  return {
    boxId: rawBoxId === UNASSIGNED_DROP_ID ? null : rawBoxId,
    beforeThreadId:
      beforeThreadId && beforeThreadId !== draggedThreadId ? beforeThreadId : undefined,
  };
}

function BoxNameInput({ box, onRename }: { box: SpatialBox; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(box.name);

  useEffect(() => setDraft(box.name), [box.name]);

  function commit() {
    const next = draft.trim();
    if (next) onRename(next);
    else setDraft(box.name);
  }

  return (
    <input
      className="spatial-box-name"
      aria-label={`Rename ${box.name}`}
      value={draft}
      maxLength={80}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(box.name);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SessionCard({
  session,
  selected,
  dragging,
  boxId,
  boxes,
  onOpen,
  onStartPointerMove,
  onMove,
  onKeyboardMove,
  onKeyboardReorder,
}: SessionCardProps) {
  const projectLabel = session.project ?? (session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).at(-1) : null);
  const slotLabel =
    session.nativeSlotIndex === null
      ? null
      : `Native slot ${String(session.nativeSlotIndex + 1).padStart(2, "0")}`;

  function handleOpenKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!event.altKey) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onKeyboardMove(session, -1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onKeyboardMove(session, 1);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onKeyboardReorder(session, -1);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onKeyboardReorder(session, 1);
    }
  }

  return (
    <article
      className={`spatial-session-card status-${session.status}${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      data-spatial-thread-id={session.threadId}
      data-status={session.status}
      aria-label={`${session.title}, ${STATUS_LABELS[session.status]}`}
    >
      <span className="spatial-session-signal" aria-hidden="true" />
      <div className="spatial-session-copy">
        <div className="spatial-session-register">
          {slotLabel && <span className="native-slot-badge">{slotLabel}</span>}
          <span className="session-status-badge">{STATUS_LABELS[session.status]}</span>
          {session.attention && <span className="session-attention-badge">Needs attention</span>}
        </div>
        <button
          type="button"
          className="spatial-session-open"
          aria-current={selected ? "true" : undefined}
          aria-describedby="spatial-keyboard-help"
          onClick={() => onOpen(session)}
          onKeyDown={handleOpenKeyDown}
        >
          <span className="spatial-session-title">{session.title}</span>
          <span className="spatial-session-meta">
            {projectLabel ? `${projectLabel} · ` : ""}thread {session.threadId.slice(-8)}
          </span>
        </button>
      </div>
      <div className="spatial-session-move-controls">
        <button
          type="button"
          className="spatial-drag-handle"
          style={{ touchAction: "none" }}
          aria-label={`Touch and move ${session.title}`}
          onPointerDown={(event) => onStartPointerMove(session, event)}
        >
          <span aria-hidden="true">⠿</span>
        </button>
        <label className="spatial-move-select-label">
          <span className="sr-only">Move {session.title} to</span>
          <select
            className="spatial-move-select"
            aria-label={`Move ${session.title} to a box`}
            value={boxId ?? ""}
            onChange={(event) => onMove(session, event.currentTarget.value || null)}
          >
            <option value="">Unassigned</option>
            {boxes.map((box) => (
              <option key={box.id} value={box.id}>{box.name}</option>
            ))}
          </select>
        </label>
      </div>
    </article>
  );
}

function DropZone({
  id,
  label,
  className,
  children,
  missingCount,
  isOver,
}: {
  id: string | null;
  label: string;
  className: string;
  children: ReactNode;
  missingCount: number;
  isOver: boolean;
}) {
  return (
    <div
      className={`${className}${isOver ? " is-drop-target" : ""}`}
      data-spatial-drop-target={id ?? UNASSIGNED_DROP_ID}
      role="group"
      aria-label={`${label} session drop zone`}
    >
      {children}
      {missingCount > 0 && (
        <p className="spatial-missing-note">
          {missingCount} saved {missingCount === 1 ? "session is" : "sessions are"} currently unavailable. Its place is kept.
        </p>
      )}
    </div>
  );
}

export function SpatialBoard({
  slots,
  sessions = [],
  allSessionsEnabled = false,
  allSessionsAvailable = false,
  selectedThreadId = null,
  onOpenSession,
  onAllSessionsEnabledChange,
  storage = browserSpatialLayoutStorage,
  initialLayout,
  onLayoutChange,
}: SpatialBoardProps) {
  const spatialSessions = useMemo(
    () => spatialSessionsFromSources(slots, sessions),
    [slots, sessions],
  );
  const sessionIds = useMemo(
    () => spatialSessions.map((session) => session.threadId),
    [spatialSessions],
  );
  const sessionIdsKey = sessionIds.join("\u001f");
  const [layout, dispatch] = useReducer(
    spatialLayoutReducer,
    initialLayout ?? emptySpatialLayout(),
    (value) => reconcileSpatialLayout(value, initialLayout ? sessionIds : []),
  );
  const [hydrated, setHydrated] = useState(initialLayout !== undefined);
  const [query, setQuery] = useState("");
  const [creatingBox, setCreatingBox] = useState(false);
  const [newBoxName, setNewBoxName] = useState("");
  const [drag, setDrag] = useState<PointerDrag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const catalogPrivacyDescriptionId = useId();
  const deleteDialogTitleId = useId();
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const dragCaptureRef = useRef<{ pointerId: number; target: HTMLButtonElement } | null>(null);
  const deleteDialogRef = useRef<HTMLElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const createBoxButtonRef = useRef<HTMLButtonElement | null>(null);

  useContainedDialog(
    deleteCandidateId,
    deleteDialogRef,
    deleteCancelRef,
    createBoxButtonRef,
    () => setDeleteCandidateId(null),
  );

  useEffect(() => () => {
    const captured = dragCaptureRef.current;
    dragCaptureRef.current = null;
    if (!captured) return;
    try {
      captured.target.releasePointerCapture(captured.pointerId);
    } catch {
      // Capture may already have been cancelled by the browser.
    }
  }, []);

  useEffect(() => {
    if (initialLayout) return;
    let active = true;
    void storage
      .load()
      .then((saved) => {
        if (!active) return;
        dispatch({ type: "load-layout", layout: saved ?? emptySpatialLayout() });
        setHydrated(true);
      })
      .catch(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, [initialLayout, storage]);

  useEffect(() => {
    if (!hydrated) return;
    dispatch({ type: "reconcile", currentThreadIds: sessionIds });
  }, [hydrated, sessionIdsKey]);

  useEffect(() => {
    if (!hydrated) return;
    saveChain.current = saveChain.current
      .catch(() => undefined)
      .then(() => storage.save(layout));
    onLayoutChange?.(layout);
  }, [hydrated, layout, onLayoutChange, storage]);

  const sessionsById = useMemo(
    () => new Map(spatialSessions.map((session) => [session.threadId, session])),
    [spatialSessions],
  );
  const visibleSessionsById = useMemo(
    () =>
      new Map(
        spatialSessions
          .filter((session) => sessionMatchesSearch(session, query))
          .map((session) => [session.threadId, session]),
      ),
    [query, spatialSessions],
  );
  const suggestions = useMemo(
    () => buildGroupingSuggestions(spatialSessions, layout),
    [layout, spatialSessions],
  );

  function moveSession(
    session: SpatialSession,
    targetBoxId: string | null,
    beforeThreadId?: string,
  ) {
    dispatch(
      beforeThreadId
        ? {
            type: "move-session",
            threadId: session.threadId,
            targetBoxId,
            beforeThreadId,
          }
        : { type: "move-session", threadId: session.threadId, targetBoxId },
    );
    setAnnouncement(`${session.title} moved to ${boxName(layout, targetBoxId)}.`);
  }

  function keyboardMove(session: SpatialSession, direction: -1 | 1) {
    const locations: readonly (string | null)[] = [null, ...layout.boxes.map((box) => box.id)];
    const current = boxIdForThread(layout, session.threadId);
    const currentIndex = Math.max(0, locations.indexOf(current));
    const nextIndex = Math.max(0, Math.min(locations.length - 1, currentIndex + direction));
    const target = locations[nextIndex] ?? null;
    if (target !== current) moveSession(session, target);
  }

  function keyboardReorder(session: SpatialSession, direction: -1 | 1) {
    const currentBoxId = boxIdForThread(layout, session.threadId);
    const threadIds = currentBoxId === null
      ? layout.unassignedThreadIds
      : layout.boxes.find((box) => box.id === currentBoxId)?.threadIds ?? [];
    const currentIndex = threadIds.indexOf(session.threadId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= threadIds.length) return;

    const beforeThreadId = direction < 0
      ? threadIds[nextIndex]
      : threadIds[currentIndex + 2];
    dispatch({
      type: "move-session",
      threadId: session.threadId,
      targetBoxId: currentBoxId,
      ...(beforeThreadId ? { beforeThreadId } : {}),
    });
    setAnnouncement(
      `${session.title} moved ${direction < 0 ? "up" : "down"} in ${boxName(layout, currentBoxId)}.`,
    );
  }

  function createBox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newBoxName.trim() || `Box ${layout.boxes.length + 1}`;
    dispatch({
      type: "create-box",
      box: {
        id: uniqueBoxId(layout),
        name,
        color: SPATIAL_BOX_COLORS[layout.boxes.length % SPATIAL_BOX_COLORS.length]!,
        size: "standard",
      },
    });
    setNewBoxName("");
    setCreatingBox(false);
    setAnnouncement(`${name} created.`);
  }

  function deleteBox(box: SpatialBox) {
    dispatch({ type: "delete-box", boxId: box.id });
    setDeleteCandidateId(null);
    setAnnouncement(`${box.name} deleted. Its sessions moved to Unassigned.`);
  }

  function beginPointerMove(
    session: SpatialSession,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (event.isPrimary === false || event.button > 0) return;
    event.preventDefault();
    const previousCapture = dragCaptureRef.current;
    if (previousCapture) {
      try {
        previousCapture.target.releasePointerCapture(previousCapture.pointerId);
      } catch {
        // A previous pointer may already have left the surface.
      }
      dragCaptureRef.current = null;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragCaptureRef.current = { pointerId: event.pointerId, target: event.currentTarget };
    } catch {
      // Synthetic events and older embedded webviews may not support capture.
    }
    setDrag({
      pointerId: event.pointerId,
      threadId: session.threadId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      overBoxId: undefined,
    });
  }

  function finishPointerMove(pointerId: number) {
    const captured = dragCaptureRef.current;
    if (captured?.pointerId === pointerId) {
      dragCaptureRef.current = null;
      try {
        captured.target.releasePointerCapture(pointerId);
      } catch {
        // lostpointercapture may race this explicit release.
      }
    }
    setDrag((current) => current?.pointerId === pointerId ? null : current);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    const destination = targetFromPointer(event, drag.threadId);
    setDrag((current) =>
      current
        ? {
            ...current,
            moved: current.moved || distance >= POINTER_MOVE_THRESHOLD,
            overBoxId: destination?.boxId,
          }
        : null,
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const destination = targetFromPointer(event, drag.threadId);
    const session = sessionsById.get(drag.threadId);
    const moved =
      drag.moved ||
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >=
        POINTER_MOVE_THRESHOLD;
    if (moved && destination && session) {
      moveSession(session, destination.boxId, destination.beforeThreadId);
    }
    finishPointerMove(event.pointerId);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (drag?.pointerId !== event.pointerId) return;
    finishPointerMove(event.pointerId);
  }

  function handleLostPointerCapture(event: ReactPointerEvent<HTMLElement>) {
    if (dragCaptureRef.current?.pointerId === event.pointerId) dragCaptureRef.current = null;
    setDrag((current) => current?.pointerId === event.pointerId ? null : current);
  }

  function handlePointerLeave(event: ReactPointerEvent<HTMLElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const captured = dragCaptureRef.current;
    if (captured?.pointerId === event.pointerId) {
      try {
        if (captured.target.hasPointerCapture?.(event.pointerId)) return;
      } catch {
        // If capture state cannot be read, cancel rather than leave a stuck drag.
      }
    }
    finishPointerMove(event.pointerId);
  }

  function renderSession(threadId: string) {
    const session = visibleSessionsById.get(threadId);
    if (!session) return null;
    return (
      <SessionCard
        key={threadId}
        session={session}
        selected={selectedThreadId === threadId}
        dragging={drag?.threadId === threadId}
        boxId={boxIdForThread(layout, threadId)}
        boxes={layout.boxes}
        onOpen={onOpenSession}
        onStartPointerMove={beginPointerMove}
        onMove={moveSession}
        onKeyboardMove={keyboardMove}
        onKeyboardReorder={keyboardReorder}
      />
    );
  }

  const visibleCount = [...visibleSessionsById.keys()].filter((threadId) =>
    layout.unassignedThreadIds.includes(threadId) ||
    layout.boxes.some((box) => box.threadIds.includes(threadId)),
  ).length;

  return (
    <section
      className="spatial-board"
      aria-label="Spatial session organizer"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
      onLostPointerCapture={handleLostPointerCapture}
    >
      <header className="spatial-board-header">
        <div className="spatial-board-heading">
          <span className="section-register">Session map</span>
          <h2>Arrange the work, not the agents.</h2>
          <p>
            Boxes are a private view on this iPad. Moving a card never changes, forks, or reroutes its Codex session.
          </p>
        </div>
        <div className="spatial-board-tools">
          <label className="spatial-search">
            <span>Find a session</span>
            <input
              type="search"
              value={query}
              placeholder="Title, project, folder, thread…"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button
            ref={createBoxButtonRef}
            type="button"
            className="spatial-create-box-trigger"
            aria-expanded={creatingBox}
            onClick={() => setCreatingBox((current) => !current)}
          >
            Create box
          </button>
        </div>
      </header>

      <section className={`spatial-catalog-consent${allSessionsEnabled ? " is-enabled" : ""}`} aria-label="All-session privacy">
        <div className="spatial-catalog-consent__copy">
          <span>Private expansion</span>
          <strong>Choose whether this iPad asks for sessions beyond the native six.</strong>
          <p id={catalogPrivacyDescriptionId}>
            Off by default. Turning this on requests the authenticated session catalog from your Mac. Turning it off hides catalog titles immediately while keeping your local box placements.
          </p>
        </div>
        <div className="spatial-catalog-consent__control">
          <label>
            <input
              type="checkbox"
              checked={allSessionsEnabled}
              disabled={!onAllSessionsEnabledChange}
              aria-describedby={catalogPrivacyDescriptionId}
              onChange={(event) => onAllSessionsEnabledChange?.(event.currentTarget.checked)}
            />
            <span>Include all Codex sessions</span>
          </label>
          <small>
            {!allSessionsEnabled
              ? "Off · no all-session request is sent."
              : allSessionsAvailable
                ? "On · catalog summaries are loaded in memory only."
                : "On · catalog unavailable; the native six still work."}
          </small>
        </div>
      </section>

      {creatingBox && (
        <form className="spatial-create-box" aria-label="Create a box" onSubmit={createBox}>
          <label>
            <span>Box name</span>
            <input
              autoFocus
              value={newBoxName}
              maxLength={80}
              placeholder="Release checks"
              onChange={(event) => setNewBoxName(event.currentTarget.value)}
            />
          </label>
          <button type="submit">Add box</button>
          <button type="button" onClick={() => setCreatingBox(false)}>Cancel</button>
        </form>
      )}

      {suggestions.length > 0 && (
        <aside className="spatial-suggestions" aria-label="Grouping suggestions">
          <span>Suggested from your projects</span>
          <div>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => {
                  const id = uniqueBoxId(layout, suggestion.kind);
                  dispatch({
                    type: "create-box",
                    box: {
                      id,
                      name: suggestion.boxName,
                      color: SPATIAL_BOX_COLORS[layout.boxes.length % SPATIAL_BOX_COLORS.length]!,
                      size: suggestion.threadIds.length > 4 ? "wide" : "standard",
                    },
                    threadIds: suggestion.threadIds,
                  });
                  setAnnouncement(`${suggestion.boxName} created from ${suggestion.threadIds.length} sessions.`);
                }}
              >
                {suggestion.label} <span>{suggestion.threadIds.length}</span>
              </button>
            ))}
          </div>
        </aside>
      )}

      {!hydrated ? (
        <div className="spatial-board-loading" role="status">Loading this iPad’s session map…</div>
      ) : (
        <div className="spatial-box-grid">
          {layout.boxes.map((box, boxIndex) => {
            const missingCount = box.threadIds.filter((threadId) => !sessionsById.has(threadId)).length;
            return (
              <section
                key={box.id}
                className={`spatial-box spatial-box--${box.color} spatial-box--${box.size}`}
                data-spatial-box-id={box.id}
              >
                <header className="spatial-box-header">
                  <div className="spatial-box-identity">
                    <span className="spatial-box-index" aria-hidden="true">
                      {String(boxIndex + 1).padStart(2, "0")}
                    </span>
                    <BoxNameInput
                      box={box}
                      onRename={(name) => dispatch({ type: "rename-box", boxId: box.id, name })}
                    />
                  </div>
                  <div className="spatial-box-controls">
                    <label>
                      <span className="sr-only">Color for {box.name}</span>
                      <select
                        aria-label={`Color for ${box.name}`}
                        value={box.color}
                        onChange={(event) =>
                          dispatch({
                            type: "recolor-box",
                            boxId: box.id,
                            color: event.currentTarget.value as SpatialBoxColor,
                          })
                        }
                      >
                        {SPATIAL_BOX_COLORS.map((color) => (
                          <option key={color} value={color}>{COLOR_LABELS[color]}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span className="sr-only">Size for {box.name}</span>
                      <select
                        aria-label={`Size for ${box.name}`}
                        value={box.size}
                        onChange={(event) =>
                          dispatch({
                            type: "resize-box",
                            boxId: box.id,
                            size: event.currentTarget.value as SpatialBoxSize,
                          })
                        }
                      >
                        {SPATIAL_BOX_SIZES.map((size) => (
                          <option key={size} value={size}>{SIZE_LABELS[size]}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      aria-label={`Move ${box.name} left`}
                      disabled={boxIndex === 0}
                      onClick={() =>
                        dispatch({ type: "reorder-box", boxId: box.id, toIndex: boxIndex - 1 })
                      }
                    >
                      <span aria-hidden="true">←</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${box.name} right`}
                      disabled={boxIndex === layout.boxes.length - 1}
                      onClick={() =>
                        dispatch({ type: "reorder-box", boxId: box.id, toIndex: boxIndex + 1 })
                      }
                    >
                      <span aria-hidden="true">→</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${box.name}`}
                      onClick={() => {
                        if (box.threadIds.length > 0) setDeleteCandidateId(box.id);
                        else deleteBox(box);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </header>
                <DropZone
                  id={box.id}
                  label={box.name}
                  className="spatial-box-dropzone"
                  missingCount={missingCount}
                  isOver={drag?.overBoxId === box.id}
                >
                  <div className="spatial-session-stack">
                    {box.threadIds.map(renderSession)}
                  </div>
                  {box.threadIds.length === 0 && (
                    <p className="spatial-empty-box">Move sessions here with touch, Pencil, or the move menu.</p>
                  )}
                </DropZone>
              </section>
            );
          })}

          <section className="spatial-box spatial-box--unassigned spatial-box--wide">
            <header className="spatial-box-header">
              <div className="spatial-box-identity">
                <span className="spatial-box-index" aria-hidden="true">∞</span>
                <div>
                  <h3>Unassigned</h3>
                  <p>New sessions land here until you place them.</p>
                </div>
              </div>
            </header>
            <DropZone
              id={null}
              label="Unassigned"
              className="spatial-box-dropzone"
              missingCount={layout.unassignedThreadIds.filter((threadId) => !sessionsById.has(threadId)).length}
              isOver={drag?.overBoxId === null}
            >
              <div className="spatial-session-stack">
                {layout.unassignedThreadIds.map(renderSession)}
              </div>
              {layout.unassignedThreadIds.length === 0 && (
                <p className="spatial-empty-box">Every known session has a box.</p>
              )}
            </DropZone>
          </section>
        </div>
      )}

      {hydrated && query && visibleCount === 0 && (
        <p className="spatial-no-results" role="status">No session matches “{query}”.</p>
      )}
      <p id="spatial-keyboard-help" className="sr-only">
        Press Alt and Left or Right Arrow to move this session between adjacent boxes.
        Press Alt and Up or Down Arrow to reorder it inside its current box.
      </p>
      <div className="sr-only" aria-live="polite">{announcement}</div>
      {deleteCandidateId !== null && (() => {
        const candidate = layout.boxes.find((box) => box.id === deleteCandidateId);
        if (!candidate) return null;
        return (
          <div className="drawing-overlay" role="presentation">
            <section
              ref={deleteDialogRef}
              className="drawing-confirm"
              role="dialog"
              aria-modal="true"
              aria-labelledby={deleteDialogTitleId}
              tabIndex={-1}
            >
              <span className="drawing-confirm__mark" aria-hidden="true">×</span>
              <h3 id={deleteDialogTitleId}>Delete {candidate.name}?</h3>
              <p>
                {candidate.threadIds.length} {candidate.threadIds.length === 1 ? "session returns" : "sessions return"} to Unassigned. No Codex task is changed or deleted.
              </p>
              <div>
                <button ref={deleteCancelRef} type="button" onClick={() => setDeleteCandidateId(null)}>Cancel</button>
                <button type="button" className="is-destructive" onClick={() => deleteBox(candidate)}>Delete box</button>
              </div>
            </section>
          </div>
        );
      })()}
    </section>
  );
}

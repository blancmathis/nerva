import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { HomeCase } from "../lib/home-layout";
import type { ProductSession } from "../lib/session-presentation";
import { relativeSessionActivity, sessionStatusLabel } from "../lib/session-presentation";
import { FolderIcon, MacIcon, MoreIcon, PinIcon } from "./Icons";

interface SessionCardProps {
  readonly session: ProductSession;
  readonly compact?: boolean;
  readonly homeCases?: readonly Pick<HomeCase, "id" | "name">[];
  readonly currentCaseId?: string | null;
  readonly dragEnabled?: boolean;
  readonly onOpen: (session: ProductSession) => void;
  readonly onUnpin?: (threadId: string) => void;
  readonly onMove?: (threadId: string, caseId: string | null, beforeThreadId?: string) => void;
}

interface DragDestination {
  readonly caseId: string | null;
  readonly beforeThreadId: string | undefined;
  readonly dropElement: HTMLElement;
  readonly beforeElement: HTMLElement | null;
}

interface CardPointerDrag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
  destination: DragDestination | null;
}

export const DIRECT_HOME_DROP_TARGET = "__codex_pad_direct_home__";
const DRAG_THRESHOLD = 6;

function dragDestination(
  clientX: number,
  clientY: number,
  fallbackTarget: EventTarget | null,
  draggedThreadId: string,
): DragDestination | null {
  const fallbackElement = fallbackTarget instanceof Element ? fallbackTarget : null;
  let pointedElement: Element | null = null;
  try {
    pointedElement = document.elementFromPoint(clientX, clientY);
  } catch {
    // jsdom and older embedded webviews may not expose elementFromPoint.
  }
  const dropElement = (
    pointedElement?.closest<HTMLElement>("[data-home-drop-target]")
    ?? fallbackElement?.closest<HTMLElement>("[data-home-drop-target]")
  );
  const rawTarget = dropElement?.dataset.homeDropTarget;
  if (!dropElement || !rawTarget) return null;
  const beforeElement = (
    pointedElement?.closest<HTMLElement>("[data-thread-id]")
    ?? fallbackElement?.closest<HTMLElement>("[data-thread-id]")
  );
  const beforeThreadId = beforeElement?.dataset.threadId;
  return {
    caseId: rawTarget === DIRECT_HOME_DROP_TARGET ? null : rawTarget,
    beforeThreadId: beforeThreadId && beforeThreadId !== draggedThreadId ? beforeThreadId : undefined,
    dropElement,
    beforeElement: beforeThreadId && beforeThreadId !== draggedThreadId ? beforeElement : null,
  };
}

export function SessionCard({
  session,
  compact = false,
  homeCases = [],
  currentCaseId = null,
  dragEnabled = false,
  onOpen,
  onUnpin,
  onMove,
}: SessionCardProps) {
  const [clock, setClock] = useState(() => Date.now());
  const [dragOffset, setDragOffset] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const suppressOpen = useRef(false);
  const longPressStart = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly target: HTMLButtonElement;
  } | null>(null);
  const pointerDrag = useRef<CardPointerDrag | null>(null);
  const highlightedDrop = useRef<DragDestination | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    highlightedDrop.current?.dropElement.classList.remove("is-drop-target");
    highlightedDrop.current?.beforeElement?.classList.remove("is-drop-before");
  }, []);

  function cancelLongPress() {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressStart.current = null;
  }

  function clearDropHighlight() {
    highlightedDrop.current?.dropElement.classList.remove("is-drop-target");
    highlightedDrop.current?.beforeElement?.classList.remove("is-drop-before");
    highlightedDrop.current = null;
  }

  function showDropHighlight(destination: DragDestination | null) {
    clearDropHighlight();
    if (!destination) return;
    destination.dropElement.classList.add("is-drop-target");
    destination.beforeElement?.classList.add("is-drop-before");
    highlightedDrop.current = destination;
  }

  function beginPointer(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelLongPress();
    suppressOpen.current = false;
    if (!dragEnabled || !onMove) return;
    longPressStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target: event.currentTarget,
    };
    longPressTimer.current = window.setTimeout(() => {
      const start = longPressStart.current;
      if (!start) return;
      longPressTimer.current = null;
      suppressOpen.current = true;
      pointerDrag.current = {
        pointerId: start.pointerId,
        startX: start.x,
        startY: start.y,
        moved: false,
        destination: null,
      };
      setDragOffset({ x: 0, y: 0 });
      try {
        start.target.setPointerCapture(start.pointerId);
      } catch {
        // The drag still works while the pointer remains inside the card.
      }
      longPressStart.current = null;
    }, 420);
  }

  function movePointer(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = pointerDrag.current;
    if (drag && drag.pointerId === event.pointerId) {
      const x = event.clientX - drag.startX;
      const y = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(x, y) < DRAG_THRESHOLD) return;
      event.preventDefault();
      drag.moved = true;
      setDragOffset({ x, y });
      drag.destination = dragDestination(event.clientX, event.clientY, event.target, session.threadId);
      showDropHighlight(drag.destination);
      return;
    }
    const start = longPressStart.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelLongPress();
  }

  function finishPointer(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    const drag = pointerDrag.current;
    if (drag && drag.pointerId === event.pointerId) {
      const destination = commit && drag.moved ? drag.destination : null;
      suppressOpen.current = true;
      event.preventDefault();
      event.stopPropagation();
      pointerDrag.current = null;
      setDragOffset(null);
      clearDropHighlight();
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // The browser may already have released capture.
      }
      cancelLongPress();
      if (destination && onMove) {
        onMove(session.threadId, destination.caseId, destination.beforeThreadId);
      }
      return;
    }
    cancelLongPress();
  }

  const label = sessionStatusLabel(session.status);
  return (
    <article
      className={`cp-session-card status-${session.status}${compact ? " is-compact" : ""}${session.activeOnMac ? " is-on-mac" : ""}${dragEnabled ? " is-drag-enabled" : ""}${dragOffset ? " is-dragging" : ""}`}
      data-thread-id={session.threadId}
      style={dragOffset ? {
        "--cp-card-drag-x": `${dragOffset.x}px`,
        "--cp-card-drag-y": `${dragOffset.y}px`,
      } as CSSProperties : undefined}
    >
      <button
        type="button"
        className="cp-session-card__open"
        aria-label={`Open ${session.title}, ${label}${session.activeOnMac ? ", active on Mac" : ""}`}
        aria-grabbed={dragEnabled ? dragOffset !== null : undefined}
        onPointerDown={beginPointer}
        onPointerMove={movePointer}
        onPointerUp={(event) => finishPointer(event, true)}
        onPointerCancel={(event) => finishPointer(event, false)}
        onLostPointerCapture={(event) => {
          if (pointerDrag.current?.pointerId === event.pointerId) finishPointer(event, false);
        }}
        onPointerLeave={() => {
          if (!pointerDrag.current) cancelLongPress();
        }}
        onClick={() => {
          if (suppressOpen.current) {
            suppressOpen.current = false;
            return;
          }
          onOpen(session);
        }}
      >
        <span className="cp-session-card__light" aria-hidden="true" />
        <span className="cp-session-card__topline">
          <span className="cp-session-card__state"><i aria-hidden="true" />{label}</span>
          {session.activeOnMac && <span className="cp-session-card__mac"><MacIcon />On Mac</span>}
        </span>
        <span className="cp-session-card__title">{session.title}</span>
        {!compact && (
          <span className="cp-session-card__meta">
            {session.project ? <span><FolderIcon />{session.project}</span> : <span>Codex session</span>}
            <span className="cp-session-card__thread">{session.threadId.slice(-8)}</span>
          </span>
        )}
        <span className="cp-session-card__activity">{relativeSessionActivity(session, clock)}</span>
        <span className="cp-session-card__edge" aria-hidden="true" />
      </button>
      {(onMove || onUnpin) && (
        <div className={`cp-session-card__tools${toolsOpen ? " is-open" : ""}`}>
          {toolsOpen && onMove && (
            <label>
              <span className="sr-only">Move {session.title}</span>
              <select
                aria-label={`Move ${session.title}`}
                value={currentCaseId ?? ""}
                onChange={(event) => onMove(session.threadId, event.target.value || null)}
              >
                <option value="">Directly on Home</option>
                {homeCases.map((homeCase) => <option value={homeCase.id} key={homeCase.id}>{homeCase.name}</option>)}
              </select>
            </label>
          )}
          {toolsOpen && onUnpin && (
            <button type="button" aria-label={`Unpin ${session.title} from Home`} onClick={() => onUnpin(session.threadId)}>
              <PinIcon /><span>Unpin</span>
            </button>
          )}
          <button type="button" aria-label={`${toolsOpen ? "Close actions for" : "More actions for"} ${session.title}`} aria-expanded={toolsOpen} onClick={() => setToolsOpen((current) => !current)}>{toolsOpen ? "Done" : <MoreIcon />}</button>
        </div>
      )}
    </article>
  );
}

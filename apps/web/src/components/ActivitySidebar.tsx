/**
 * THESIS: Activity is a complete cross-project history with priority lifted to the top.
 * OWN-WORLD: Nerva glass frames one dense, separator-led index with two priority signals.
 * STORY: Handle what is running or ready, then scan every recent task by day.
 * FIRST VIEWPORT: Priority leads; chronological day groups follow without duplication.
 * FORM: A precisely specified left sidebar extension; no concept seed was needed.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  groupActivitySessions,
  type ActivityState,
} from "../lib/activity-groups";
import type { ProductSession } from "../lib/session-presentation";
import { relativeSessionActivity } from "../lib/session-presentation";
import { useModalFocus } from "../lib/use-modal-focus";
import { ChevronIcon, CloseIcon, FolderIcon, MoreIcon, PinIcon } from "./Icons";

interface ActivitySidebarProps {
  readonly open: boolean;
  readonly sessions: readonly ProductSession[];
  readonly currentThreadId: string | null;
  readonly pinnedThreadIds: readonly string[];
  readonly onClose: () => void;
  readonly onOpenConversations: () => void;
  readonly onOpenSession: (session: ProductSession) => void;
  readonly onPinSession: (threadId: string) => void;
  readonly onUnpinSession: (threadId: string) => void;
}

const ACTIVITY_LABELS: Readonly<Record<ActivityState, string>> = {
  "in-progress": "In progress",
  "ready-for-review": "Ready for review",
};

const ACTIVITY_LONG_PRESS_MS = 460;

interface ActivityRowProps {
  readonly session: ProductSession;
  readonly state: ActivityState | null;
  readonly current: boolean;
  readonly pinned: boolean;
  readonly onOpen: (session: ProductSession) => void;
  readonly onPin: (threadId: string) => void;
  readonly onUnpin: (threadId: string) => void;
}

function ActivityRow({
  session,
  state,
  current,
  pinned,
  onOpen,
  onPin,
  onUnpin,
}: ActivityRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLButtonElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const suppressOpen = useRef(false);
  const pointerStart = useRef<{ readonly id: number; readonly x: number; readonly y: number } | null>(null);

  function cancelLongPress() {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    pointerStart.current = null;
  }

  function openMenu(trigger: HTMLButtonElement | null = rowRef.current) {
    menuTrigger.current = trigger;
    cancelLongPress();
    suppressOpen.current = trigger === rowRef.current;
    setMenuOpen(true);
  }

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    const closeFromOutside = (event: PointerEvent) => {
      if (!shellRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeFromOutside, true);
    return () => window.removeEventListener("pointerdown", closeFromOutside, true);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) suppressOpen.current = false;
  }, [menuOpen]);

  useEffect(() => () => cancelLongPress(), []);

  function beginLongPress(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelLongPress();
    suppressOpen.current = false;
    pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    longPressTimer.current = window.setTimeout(() => openMenu(), ACTIVITY_LONG_PRESS_MS);
  }

  function moveLongPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = pointerStart.current;
    if (!start || start.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelLongPress();
  }

  function closeMenuAndRestoreFocus() {
    setMenuOpen(false);
    (menuTrigger.current ?? rowRef.current)?.focus({ preventScroll: true });
  }

  return (
    <article ref={shellRef} className={`cp-activity-row-shell${menuOpen ? " has-actions" : ""}`}>
      <button
        ref={rowRef}
        type="button"
        className={`cp-activity-row ${state ? `activity-${state}` : "activity-history"}`}
        aria-current={current ? "page" : undefined}
        aria-describedby="activity-actions-hint"
        aria-label={`${state ? `${ACTIVITY_LABELS[state]}. ` : ""}Open ${session.title} from Activity`}
        onPointerDown={beginLongPress}
        onPointerMove={moveLongPress}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            openMenu();
          }
        }}
        onClick={() => {
          if (suppressOpen.current) {
            suppressOpen.current = false;
            return;
          }
          setMenuOpen(false);
          onOpen(session);
        }}
      >
        {state && <span className={`cp-activity-row__signal is-${state}`} aria-hidden="true" />}
        <span className="cp-activity-row__copy">
          <strong>{session.title}</strong>
          <small><FolderIcon />{session.project ?? "No project"}<span aria-hidden="true">·</span>{relativeSessionActivity(session)}</small>
        </span>
        <span className={`cp-activity-row__state${state ? "" : " is-history"}`}><ChevronIcon /></span>
      </button>
      <button
        ref={actionsRef}
        type="button"
        className="cp-activity-row__more"
        aria-label={`Actions for ${session.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          if (menuOpen) closeMenuAndRestoreFocus();
          else openMenu(actionsRef.current);
        }}
      ><MoreIcon /></button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="cp-activity-row-actions"
          role="menu"
          aria-label={`Actions for ${session.title}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeMenuAndRestoreFocus();
              return;
            }
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
              : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
            if (direction || event.key === "Home" || event.key === "End") {
              event.preventDefault();
              event.stopPropagation();
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                : (current + direction + items.length) % items.length;
              items[next]?.focus();
            } else if (event.key === "Tab") {
              // Restore the anchor synchronously, then let the owning modal
              // move to the previous/next control outside this menu.
              closeMenuAndRestoreFocus();
            }
          }}
        >
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setMenuOpen(false); onOpen(session); }}>
            Open conversation <ChevronIcon />
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => {
            closeMenuAndRestoreFocus();
            if (pinned) onUnpin(session.threadId);
            else onPin(session.threadId);
          }}>
            <PinIcon />{pinned ? "Unpin from Home" : "Pin to Home"}
          </button>
        </div>
      )}
    </article>
  );
}

export function ActivitySidebar({
  open,
  sessions,
  currentThreadId,
  pinnedThreadIds,
  onClose,
  onOpenConversations,
  onOpenSession,
  onPinSession,
  onUnpinSession,
}: ActivitySidebarProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const groups = useMemo(() => groupActivitySessions(sessions), [open, sessions]);
  const pinned = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const workingCount = groups.inProgress.length;
  const reviewCount = groups.readyForReview.length;
  const visibleCount = workingCount + reviewCount;
  useModalFocus(dialogRef, onClose, { active: open, initialFocus: ".cp-activity-row" });

  if (!open) return null;

  const row = (session: ProductSession, state: ActivityState | null) => (
    <ActivityRow
      key={session.threadId}
      session={session}
      state={state}
      current={currentThreadId === session.threadId}
      pinned={pinned.has(session.threadId)}
      onOpen={onOpenSession}
      onPin={onPinSession}
      onUnpin={onUnpinSession}
    />
  );

  return (
    <div className="cp-drawer-layer cp-activity-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside
        id="activity-sidebar"
        ref={dialogRef}
        className="cp-activity-sidebar"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-title"
        tabIndex={-1}
      >
        <header className="cp-activity-sidebar__header">
          <div>
            <p className="cp-overline">Across every project</p>
            <h2 id="activity-title">Activity</h2>
            <p>Open a conversation, or use its menu to pin or unpin.</p>
          </div>
          <button type="button" className="cp-icon-button" aria-label="Close Activity" onClick={onClose}><CloseIcon /></button>
        </header>
        <nav className="cp-conversation-tabs" aria-label="Conversation views">
          <div className="cp-segmented cp-segmented--small">
            <button type="button" aria-pressed="false" onClick={onOpenConversations}>Conversations</button>
            <button type="button" aria-pressed="true">Activity{visibleCount > 0 && <span>{visibleCount > 99 ? "99+" : visibleCount}</span>}</button>
          </div>
        </nav>
        <p id="activity-actions-hint" className="sr-only">Use the actions button or press and hold for conversation actions.</p>

        <div className="cp-activity-summary" aria-label="Activity summary">
          <span className="status-in-progress"><i aria-hidden="true" />{workingCount} in progress</span>
          <span className="status-ready-for-review"><i aria-hidden="true" />{reviewCount} ready for review</span>
        </div>

        <div className="cp-activity-sidebar__body">
          {sessions.length === 0 ? (
            <div className="cp-activity-empty">
              <strong>Nothing needs you right now.</strong>
              <p>Working tasks and new results will appear here.</p>
            </div>
          ) : (
            <>
              <section className="cp-activity-section" aria-labelledby="activity-priority-title">
                <header><h3 id="activity-priority-title">Priority</h3><span>{visibleCount}</span></header>
                {visibleCount > 0
                  ? <div className="cp-activity-section__list">
                    {groups.inProgress.map((session) => row(session, "in-progress"))}
                    {groups.readyForReview.map((session) => row(session, "ready-for-review"))}
                  </div>
                  : <p className="cp-activity-caught-up">Nothing needs you right now.</p>}
              </section>

              {groups.recent.map((group) => (
                <section className="cp-activity-section is-history" key={group.id} aria-labelledby={`activity-${group.id}-title`}>
                  <header><h3 id={`activity-${group.id}-title`}>{group.label}</h3><span>{group.sessions.length}</span></header>
                  <div className="cp-activity-section__list">{group.sessions.map((session) => row(session, null))}</div>
                </section>
              ))}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

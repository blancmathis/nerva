import { useMemo, useRef, useState } from "react";
import { MAX_PINNED_SESSIONS } from "../lib/home-layout";
import type { ProductSession } from "../lib/session-presentation";
import { relativeSessionActivity, searchProductSession, sessionStatusLabel } from "../lib/session-presentation";
import { CloseIcon, FolderIcon, PinIcon, SearchIcon } from "./Icons";
import { useModalFocus } from "../lib/use-modal-focus";

interface UnpinnedSessionsDrawerProps {
  readonly open: boolean;
  readonly sessions: readonly ProductSession[];
  readonly pinnedThreadIds: readonly string[];
  readonly onClose: () => void;
  readonly activityCount: number;
  readonly onOpenActivity: () => void;
  readonly onOpenSession: (session: ProductSession) => void;
  readonly onPin: (threadId: string) => void;
  readonly onUnpin?: (threadId: string) => void;
}

export function UnpinnedSessionsDrawer({
  open,
  sessions,
  pinnedThreadIds,
  onClose,
  activityCount,
  onOpenActivity,
  onOpenSession,
  onPin,
  onUnpin,
}: UnpinnedSessionsDrawerProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [organization, setOrganization] = useState<"recent" | "project">("recent");
  const visibleSessions = useMemo(() => sessions
    .filter((session) => searchProductSession(session, query))
    .sort((left, right) => organization === "project"
      ? (left.project ?? "No project").localeCompare(right.project ?? "No project") || left.title.localeCompare(right.title)
      : (right.activityAt ?? 0) - (left.activityAt ?? 0)), [organization, query, sessions]);

  const groups = useMemo(() => {
    if (organization === "recent") return [["Recent", visibleSessions] as const];
    const byProject = new Map<string, ProductSession[]>();
    for (const session of visibleSessions) {
      const project = session.project ?? "No project";
      byProject.set(project, [...(byProject.get(project) ?? []), session]);
    }
    return [...byProject.entries()];
  }, [organization, visibleSessions]);
  useModalFocus(dialogRef, onClose, { active: open, initialFocus: "input" });

  if (!open) return null;
  return (
    <div className="cp-drawer-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={dialogRef} className="cp-session-drawer" role="dialog" aria-modal="true" aria-labelledby="unpinned-title" tabIndex={-1}>
        <header>
          <div>
            <h2 id="unpinned-title">Conversations</h2>
            <p>{sessions.length} sessions across your projects · {pinnedThreadIds.length}/{MAX_PINNED_SESSIONS} on Home</p>
          </div>
          <button type="button" className="cp-icon-button" aria-label="Close Conversations" onClick={onClose}><CloseIcon /></button>
        </header>
        <nav className="cp-conversation-tabs" aria-label="Conversation views">
          <div className="cp-segmented cp-segmented--small">
            <button type="button" aria-pressed="true">Conversations</button>
            <button type="button" aria-pressed="false" onClick={onOpenActivity}>Activity{activityCount > 0 && <span>{activityCount > 99 ? "99+" : activityCount}</span>}</button>
          </div>
        </nav>
        <div className="cp-drawer-controls">
          <label className="cp-search-field">
            <SearchIcon />
            <span className="sr-only">Search sessions</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions or projects" />
          </label>
          <div className="cp-segmented cp-segmented--small" aria-label="Organize sessions">
            <button type="button" aria-pressed={organization === "recent"} onClick={() => setOrganization("recent")}>Last used</button>
            <button type="button" aria-pressed={organization === "project"} onClick={() => setOrganization("project")}>By project</button>
          </div>
        </div>
        <div className="cp-unpinned-list">
          {groups.map(([group, items]) => items.length > 0 && (
            <section key={group} aria-labelledby={`group-${group.replace(/\W+/g, "-")}`}>
              <h3 id={`group-${group.replace(/\W+/g, "-")}`}>{group}</h3>
              {items.map((session) => (
                <article key={session.threadId} className={`cp-unpinned-row status-${session.status}`}>
                  <button type="button" className="cp-unpinned-row__open" onClick={() => onOpenSession(session)}>
                    <span className="cp-unpinned-row__signal" aria-hidden="true" />
                    <span>
                      <strong>{session.title}</strong>
                      <small>{sessionStatusLabel(session.status)} · {relativeSessionActivity(session)}</small>
                    </span>
                    <span className="cp-unpinned-row__project"><FolderIcon />{session.project ?? "No project"}</span>
                  </button>
                  <button type="button" className="cp-pin-button" aria-pressed={pinnedThreadIds.includes(session.threadId)}
                    aria-label={pinnedThreadIds.includes(session.threadId) ? `Unpin ${session.title} from Home` : `Pin ${session.title} to Home`}
                    disabled={pinnedThreadIds.includes(session.threadId) && !onUnpin}
                    onClick={() => pinnedThreadIds.includes(session.threadId) ? onUnpin?.(session.threadId) : onPin(session.threadId)}>
                    <PinIcon /><span>{pinnedThreadIds.includes(session.threadId) ? "Pinned" : "Pin"}</span>
                  </button>
                </article>
              ))}
            </section>
          ))}
          {visibleSessions.length === 0 && (
            <div className="cp-empty-list">
              <strong>{query ? "No matching sessions" : "No conversations yet"}</strong>
              <p>{query ? "Try a session name, project, or status." : "Start a conversation in Codex on your Mac. It will appear here when connected."}</p>
              {query && <button type="button" className="cp-secondary-button" onClick={() => setQuery("")}>Clear search</button>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

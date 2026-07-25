import { useMemo, useState } from "react";
import { MAX_PINNED_SESSIONS } from "../lib/home-layout";
import type { ProductSession } from "../lib/session-presentation";
import { relativeSessionActivity, searchProductSession, sessionStatusLabel } from "../lib/session-presentation";
import { CloseIcon, FolderIcon, PinIcon, SearchIcon } from "./Icons";

interface UnpinnedSessionsDrawerProps {
  readonly open: boolean;
  readonly sessions: readonly ProductSession[];
  readonly pinnedThreadIds: readonly string[];
  readonly onClose: () => void;
  readonly onOpenSession: (session: ProductSession) => void;
  readonly onPin: (threadId: string) => void;
}

export function UnpinnedSessionsDrawer({
  open,
  sessions,
  pinnedThreadIds,
  onClose,
  onOpenSession,
  onPin,
}: UnpinnedSessionsDrawerProps) {
  const [query, setQuery] = useState("");
  const [organization, setOrganization] = useState<"recent" | "project">("recent");
  const unpinned = useMemo(() => sessions
    .filter((session) => !pinnedThreadIds.includes(session.threadId))
    .filter((session) => searchProductSession(session, query))
    .sort((left, right) => organization === "project"
      ? (left.project ?? "No project").localeCompare(right.project ?? "No project") || left.title.localeCompare(right.title)
      : (right.activityAt ?? 0) - (left.activityAt ?? 0)), [organization, pinnedThreadIds, query, sessions]);

  const groups = useMemo(() => {
    if (organization === "recent") return [["Recent", unpinned] as const];
    const byProject = new Map<string, ProductSession[]>();
    for (const session of unpinned) {
      const project = session.project ?? "No project";
      byProject.set(project, [...(byProject.get(project) ?? []), session]);
    }
    return [...byProject.entries()];
  }, [organization, unpinned]);

  if (!open) return null;
  return (
    <div className="cp-drawer-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="cp-session-drawer" role="dialog" aria-modal="true" aria-labelledby="unpinned-title">
        <header>
          <div>
            <p className="cp-overline">Session archive</p>
            <h2 id="unpinned-title">Unpinned Sessions</h2>
            <p>{unpinned.length} available · {pinnedThreadIds.length}/{MAX_PINNED_SESSIONS} pinned</p>
          </div>
          <button type="button" className="cp-icon-button" aria-label="Close Unpinned Sessions" onClick={onClose}><CloseIcon /></button>
        </header>
        <div className="cp-drawer-controls">
          <label className="cp-search-field">
            <SearchIcon />
            <span className="sr-only">Search sessions</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions or projects" autoFocus />
          </label>
          <div className="cp-segmented cp-segmented--small" aria-label="Organize unpinned sessions">
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
                  <button type="button" className="cp-pin-button" aria-label={`Pin ${session.title} to Home`} onClick={() => onPin(session.threadId)}>
                    <PinIcon /><span>Pin</span>
                  </button>
                </article>
              ))}
            </section>
          ))}
          {unpinned.length === 0 && (
            <div className="cp-empty-list">
              <strong>{query ? "No matching sessions" : "Everything is pinned"}</strong>
              <p>{query ? "Try a session name, project, or status." : "Unpin a session from Home to find it here."}</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

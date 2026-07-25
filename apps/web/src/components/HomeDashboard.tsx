import { useEffect, useMemo, useRef, useState } from "react";
import {
  HOME_COLORS,
  MAX_PINNED_SESSIONS,
  automaticStatusForSession,
  type AutomaticStatus,
  type HomeColor,
  type HomeLayout,
  type HomeLayoutAction,
} from "../lib/home-layout";
import type { ProductSession } from "../lib/session-presentation";
import type { CodexUsageSnapshot } from "@codex-pad/protocol";
import { ArrowDownIcon, ArrowUpIcon, InboxIcon, MacIcon, MissionControlIcon, MoreIcon, PlusIcon, SlidersIcon } from "./Icons";
import { CodexUsageCard } from "./CodexUsageCard";
import { DIRECT_HOME_DROP_TARGET, SessionCard } from "./SessionCard";
import { UnpinnedSessionsDrawer } from "./UnpinnedSessionsDrawer";

interface HomeDashboardProps {
  readonly layout: HomeLayout;
  readonly sessions: readonly ProductSession[];
  readonly compactCards: boolean;
  readonly macUnavailable: boolean;
  readonly codexUsage: CodexUsageSnapshot | null;
  readonly codexUsageLoaded: boolean;
  readonly onLayoutAction: (action: HomeLayoutAction) => void;
  readonly onOpenSession: (session: ProductSession) => void;
  readonly onOpenCurrentMacSession: () => void;
  readonly attentionRequestKey: number;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onOpenCaptureInbox: () => void;
  readonly captureInboxCount: number;
  readonly onOpenSettings: () => void;
  readonly onRefreshCodexUsage: () => void;
}

type HomeStatusFilter = Exclude<AutomaticStatus, "idle">;
type HomeFocus = "manual" | "priority" | HomeStatusFilter;

const HOME_STATUS_FILTERS: readonly Readonly<{
  status: HomeStatusFilter;
  label: string;
}>[] = [
  { status: "needs-approval", label: "Approval" },
  { status: "error", label: "Error" },
  { status: "working", label: "Working" },
  { status: "waiting", label: "Waiting" },
  { status: "completed", label: "Completed" },
];

const STATUS_PRIORITY: Readonly<Record<AutomaticStatus, number>> = {
  "needs-approval": 0,
  error: 1,
  waiting: 2,
  working: 3,
  completed: 4,
  idle: 5,
};

function compareFocusedSessions(
  left: ProductSession,
  right: ProductSession,
  pinnedThreadIds: ReadonlySet<string>,
  priorityView: boolean,
): number {
  const leftPinned = pinnedThreadIds.has(left.threadId);
  const rightPinned = pinnedThreadIds.has(right.threadId);
  const leftStatus = automaticStatusForSession(left);
  const rightStatus = automaticStatusForSession(right);
  if (priorityView) {
    const group = (pinned: boolean, status: AutomaticStatus) => pinned
      ? status === "idle" ? 1 : 0
      : 2;
    const groupDifference = group(leftPinned, leftStatus) - group(rightPinned, rightStatus);
    if (groupDifference !== 0) return groupDifference;
  } else if (leftPinned !== rightPinned) {
    return leftPinned ? -1 : 1;
  }
  const statusDifference = STATUS_PRIORITY[leftStatus] - STATUS_PRIORITY[rightStatus];
  if (statusDifference !== 0) return statusDifference;
  const activityDifference = (right.activityAt ?? 0) - (left.activityAt ?? 0);
  return activityDifference !== 0 ? activityDifference : left.title.localeCompare(right.title);
}

function colorForIndex(index: number): HomeColor {
  return HOME_COLORS[index % HOME_COLORS.length]!;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function HomeDashboard({
  layout,
  sessions,
  compactCards,
  macUnavailable,
  codexUsage,
  codexUsageLoaded,
  onLayoutAction,
  onOpenSession,
  onOpenCurrentMacSession,
  attentionRequestKey,
  onFocusChange,
  onOpenCaptureInbox,
  captureInboxCount,
  onOpenSettings,
  onRefreshCodexUsage,
}: HomeDashboardProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newSectionOpen, setNewSectionOpen] = useState(false);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [newSectionName, setNewSectionName] = useState("");
  const [newCaseSectionId, setNewCaseSectionId] = useState<string | null>(null);
  const [newCaseName, setNewCaseName] = useState("");
  const [replacementThreadId, setReplacementThreadId] = useState<string | null>(null);
  const [focus, setFocus] = useState<HomeFocus>("manual");
  const suppressSessionOpenUntil = useRef(0);

  useEffect(() => {
    if (attentionRequestKey > 0) setFocus("priority");
  }, [attentionRequestKey]);

  useEffect(() => {
    onFocusChange(focus !== "manual");
  }, [focus, onFocusChange]);

  useEffect(() => () => onFocusChange(false), [onFocusChange]);

  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.threadId, session])), [sessions]);
  const pinned = layout.pinnedThreadIds.flatMap((threadId) => {
    const session = sessionsById.get(threadId);
    return session ? [session] : [];
  });
  const pinnedById = new Map(pinned.map((session) => [session.threadId, session]));
  const pinnedThreadIds = useMemo(() => new Set(layout.pinnedThreadIds), [layout.pinnedThreadIds]);
  const statusCounts = useMemo(() => new Map(HOME_STATUS_FILTERS.map(({ status }) => [
    status,
    sessions.filter((session) => automaticStatusForSession(session) === status).length,
  ])), [sessions]);
  const attentionCount = useMemo(() => sessions.filter((session) => (
    automaticStatusForSession(session) !== "idle"
  )).length, [sessions]);
  const homeCases = layout.manual.sections.flatMap((section) => section.cases.map((homeCase) => ({
    id: homeCase.id,
    name: `${section.name} / ${homeCase.name}`,
  })));
  const caseForThread = new Map(layout.manual.sections.flatMap((section) => section.cases.flatMap((homeCase) => (
    homeCase.threadIds.map((threadId) => [threadId, homeCase.id] as const)
  ))));

  function requestPin(threadId: string) {
    if (pinned.length < MAX_PINNED_SESSIONS) {
      onLayoutAction({ type: "pin", threadId });
      return;
    }
    setReplacementThreadId(threadId);
  }

  function card(session: ProductSession, filtered = false) {
    const isPinned = pinnedById.has(session.threadId);
    return (
      <SessionCard
        key={session.threadId}
        session={session}
        compact={compactCards}
        homeCases={homeCases}
        currentCaseId={caseForThread.get(session.threadId) ?? null}
        dragEnabled={!filtered && isPinned}
        onOpen={(candidate) => {
          if (Date.now() < suppressSessionOpenUntil.current) return;
          onOpenSession(candidate);
        }}
        {...(isPinned ? { onUnpin: (threadId: string) => onLayoutAction({ type: "unpin", threadId }) } : {})}
        {...(!filtered && isPinned ? {
          onMove: (threadId: string, targetCaseId: string | null, beforeThreadId?: string) => {
            suppressSessionOpenUntil.current = Date.now() + 750;
            onLayoutAction({
              type: "move-session",
              threadId,
              targetCaseId,
              ...(beforeThreadId ? { beforeThreadId } : {}),
            });
          },
        } : {})}
      />
    );
  }

  const loose = layout.manual.looseThreadIds.flatMap((threadId) => {
    const session = pinnedById.get(threadId);
    return session ? [session] : [];
  });
  const focusedSessions = useMemo(() => {
    if (focus === "manual") return [];
    const visible = focus === "priority"
      ? sessions.filter((session) => (
          pinnedThreadIds.has(session.threadId)
          || automaticStatusForSession(session) !== "idle"
        ))
      : sessions.filter((session) => automaticStatusForSession(session) === focus);
    return [...visible].sort((left, right) => compareFocusedSessions(
      left,
      right,
      pinnedThreadIds,
      focus === "priority",
    ));
  }, [focus, pinnedThreadIds, sessions]);
  const newSectionForm = newSectionOpen ? (
    <section className="cp-add-section">
      <form onSubmit={(event) => {
        event.preventDefault();
        onLayoutAction({ type: "create-section", section: { id: uniqueId("section"), name: newSectionName, color: colorForIndex(layout.manual.sections.length) } });
        setNewSectionName("");
        setNewSectionOpen(false);
      }}>
        <div><PlusIcon /><span><strong>New section</strong><small>Sections hold visible cases—nothing is hidden inside a folder.</small></span></div>
        <input aria-label="New section name" value={newSectionName} onChange={(event) => setNewSectionName(event.target.value)} placeholder="Section name" />
        <button type="submit" disabled={!newSectionName.trim()}>Create section</button>
      </form>
    </section>
  ) : null;

  return (
    <main className="cp-home">
      <header className="cp-home__header cp-enter">
        <div className="cp-home__title">
          <p className="cp-overline">Codex at a glance</p>
          <h1>Your working set.</h1>
          <p>Live sessions from the Mac, arranged for touch.</p>
        </div>
        <div className="cp-home__actions">
          <CodexUsageCard usage={codexUsage} loaded={codexUsageLoaded} onRefresh={onRefreshCodexUsage} />
          <button type="button" className="cp-current-mac" disabled={macUnavailable || !sessions.some((session) => session.activeOnMac)} onClick={onOpenCurrentMacSession}>
            <MacIcon /><span><strong>Open current Mac session</strong><small>{macUnavailable ? "Mac unavailable" : "Follow the exact active task"}</small></span>
          </button>
          <button type="button" className="cp-icon-button cp-icon-button--large" aria-label="Open Settings" onClick={onOpenSettings}><SlidersIcon /></button>
        </div>
      </header>

      <section className="cp-home__commandbar cp-enter cp-enter--2" aria-label="Home controls">
        <div className="cp-home-focus" aria-label="Session status filters">
          <button
            type="button"
            className="cp-priority-trigger"
            aria-label="Show priority sessions"
            aria-pressed={focus === "priority"}
            onClick={() => setFocus((current) => current === "priority" ? "manual" : "priority")}
          >
            <MissionControlIcon /><span>{attentionCount}</span>
          </button>
          <div className="cp-status-filters">
            {HOME_STATUS_FILTERS.map(({ status, label }) => (
              <button
                type="button"
                key={status}
                data-status={status}
                aria-pressed={focus === status}
                onClick={() => setFocus((current) => current === status ? "manual" : status)}
              >
                <i aria-hidden="true" /><span>{label}</span><strong>{statusCounts.get(status) ?? 0}</strong>
              </button>
            ))}
          </div>
        </div>
        <div className="cp-commandbar__right">
          <button type="button" className="cp-new-section-trigger cp-inbox-trigger" onClick={onOpenCaptureInbox}>
            <InboxIcon />Capture Inbox{captureInboxCount > 0 && <span>{captureInboxCount}</span>}
          </button>
          <button type="button" className="cp-new-section-trigger" aria-expanded={newSectionOpen} onClick={() => {
            setFocus("manual");
            setNewSectionOpen((value) => !value);
          }}><PlusIcon />New section</button>
          <button type="button" className="cp-unpinned-trigger" onClick={() => setDrawerOpen(true)}>
            Unpinned Sessions <span>{sessions.filter((session) => !layout.pinnedThreadIds.includes(session.threadId)).length}</span>
          </button>
        </div>
      </section>

      {focus !== "manual" ? (
        <section
          className="cp-focused-sessions cp-enter cp-enter--3"
          aria-label={focus === "priority" ? "Priority sessions" : `${HOME_STATUS_FILTERS.find((item) => item.status === focus)?.label ?? "Filtered"} sessions`}
        >
          {focusedSessions.length > 0
            ? <div className={`cp-focused-sessions__grid count-${Math.min(focusedSessions.length, 12)}`}>{focusedSessions.map((session) => card(session, true))}</div>
            : <div className="cp-focused-sessions__empty"><strong>Nothing here right now.</strong><span>Tap the active filter to return to your layout.</span></div>}
        </section>
      ) : pinned.length === 0 ? (
        <div className="cp-manual-layout cp-enter cp-enter--3">
          <section className="cp-home-empty">
            <span className="cp-home-empty__orb" aria-hidden="true"><PlusIcon /></span>
            <p className="cp-overline">Home is ready</p>
            <h2>Pin only what matters now.</h2>
            <p>Sessions stay on the Mac. Home is your personal view of the ones you want within reach.</p>
            <button type="button" onClick={() => setDrawerOpen(true)}>Choose sessions</button>
          </section>
          {newSectionForm}
        </div>
      ) : (
        <div className="cp-manual-layout cp-enter cp-enter--3" data-home-drop-target={DIRECT_HOME_DROP_TARGET}>
          {loose.length > 0 && (
            <section
              className={`cp-direct-sessions count-${Math.min(loose.length, 12)}`}
              aria-label="Pinned sessions directly on Home"
              data-home-drop-target={DIRECT_HOME_DROP_TARGET}
            >
              {loose.map((session) => card(session))}
            </section>
          )}
          {layout.manual.sections.map((section, sectionIndex) => (
            <section className={`cp-home-section color-${section.color}`} key={section.id} aria-labelledby={`section-${section.id}`}>
              <header>
                <span className="cp-home-section__mark" aria-hidden="true" />
                {editingSectionId === section.id ? (
                  <input aria-label={`Rename section ${section.name}`} value={section.name} onChange={(event) => onLayoutAction({ type: "rename-section", sectionId: section.id, name: event.target.value })} />
                ) : <h2 id={`section-${section.id}`}>{section.name}</h2>}
                <span>{section.cases.length} {section.cases.length === 1 ? "case" : "cases"}</span>
                <div className="cp-home-section__tools">
                  {editingSectionId === section.id ? (
                    <>
                      <button type="button" aria-label={`Move ${section.name} up`} disabled={sectionIndex === 0} onClick={() => onLayoutAction({ type: "reorder-section", sectionId: section.id, toIndex: sectionIndex - 1 })}><ArrowUpIcon /></button>
                      <button type="button" aria-label={`Move ${section.name} down`} disabled={sectionIndex === layout.manual.sections.length - 1} onClick={() => onLayoutAction({ type: "reorder-section", sectionId: section.id, toIndex: sectionIndex + 1 })}><ArrowDownIcon /></button>
                      <select aria-label={`Color for section ${section.name}`} value={section.color} onChange={(event) => onLayoutAction({ type: "recolor-section", sectionId: section.id, color: event.target.value as HomeColor })}>
                        {HOME_COLORS.map((color) => <option key={color}>{color}</option>)}
                      </select>
                      <button type="button" className="is-danger" onClick={() => onLayoutAction({ type: "delete-section", sectionId: section.id })}>Delete</button>
                      <button type="button" onClick={() => setEditingSectionId(null)}>Done</button>
                    </>
                  ) : <button type="button" aria-label={`Manage section ${section.name}`} onClick={() => setEditingSectionId(section.id)}><MoreIcon /></button>}
                </div>
              </header>
              <div className="cp-case-grid">
                {section.cases.map((homeCase) => {
                  const caseSessions = homeCase.threadIds.flatMap((threadId) => {
                    const session = pinnedById.get(threadId);
                    return session ? [session] : [];
                  });
                  return (
                    <section
                      className={`cp-home-case color-${homeCase.color}`}
                      key={homeCase.id}
                      aria-labelledby={`case-${homeCase.id}`}
                      data-home-drop-target={homeCase.id}
                    >
                      <header>
                        {editingCaseId === homeCase.id ? (
                          <input aria-label={`Rename case ${homeCase.name}`} value={homeCase.name} onChange={(event) => onLayoutAction({ type: "rename-case", caseId: homeCase.id, name: event.target.value })} />
                        ) : <h3 id={`case-${homeCase.id}`}>{homeCase.name}</h3>}
                        <span>{caseSessions.length}</span>
                        <div>
                          {editingCaseId === homeCase.id ? (
                            <>
                              <select aria-label={`Move case ${homeCase.name} to section`} value={section.id} onChange={(event) => onLayoutAction({ type: "move-case", caseId: homeCase.id, sectionId: event.target.value })}>
                                {layout.manual.sections.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
                              </select>
                              <button type="button" onClick={() => onLayoutAction({ type: "delete-case", caseId: homeCase.id })}>Remove</button>
                              <button type="button" onClick={() => setEditingCaseId(null)}>Done</button>
                            </>
                          ) : <button type="button" aria-label={`Manage case ${homeCase.name}`} onClick={() => setEditingCaseId(homeCase.id)}><MoreIcon /></button>}
                        </div>
                      </header>
                      <div className={`cp-case-sessions count-${Math.min(caseSessions.length, 12)}`}>{caseSessions.map((session) => card(session))}</div>
                      {caseSessions.length === 0 && <p className="cp-home-case__empty">Move pinned sessions here.</p>}
                    </section>
                  );
                })}
                <div className={`cp-add-case${newCaseSectionId === section.id ? " is-open" : ""}`}>
                  {newCaseSectionId === section.id ? (
                    <form onSubmit={(event) => {
                      event.preventDefault();
                      onLayoutAction({ type: "create-case", sectionId: section.id, homeCase: { id: uniqueId("case"), name: newCaseName, color: colorForIndex(section.cases.length) } });
                      setNewCaseName("");
                      setNewCaseSectionId(null);
                    }}>
                      <input aria-label={`New case name in ${section.name}`} value={newCaseName} onChange={(event) => setNewCaseName(event.target.value)} placeholder="Case name" autoFocus />
                      <button type="submit" disabled={!newCaseName.trim()}>Add case</button>
                      <button type="button" onClick={() => setNewCaseSectionId(null)}>Cancel</button>
                    </form>
                  ) : <button type="button" onClick={() => setNewCaseSectionId(section.id)}><PlusIcon />Add case</button>}
                </div>
              </div>
            </section>
          ))}
          {newSectionForm}
        </div>
      )}

      <UnpinnedSessionsDrawer
        open={drawerOpen}
        sessions={sessions}
        pinnedThreadIds={pinned.map((session) => session.threadId)}
        onClose={() => setDrawerOpen(false)}
        onOpenSession={(session) => { setDrawerOpen(false); onOpenSession(session); }}
        onPin={requestPin}
      />

      {replacementThreadId && (
        <div className="cp-modal-layer" role="presentation">
          <section className="cp-replace-modal" role="dialog" aria-modal="true" aria-labelledby="replace-title">
            <p className="cp-overline">Home limit reached</p>
            <h2 id="replace-title">Choose a session to unpin.</h2>
            <p>Home holds up to 12 sessions. Nothing is deleted from Codex.</p>
            <div>
              {pinned.map((session) => (
                <button type="button" key={session.threadId} onClick={() => {
                  onLayoutAction({ type: "replace-pin", unpinThreadId: session.threadId, pinThreadId: replacementThreadId });
                  setReplacementThreadId(null);
                }}><span>{session.title}</span><small>{session.project ?? session.threadId.slice(-8)}</small></button>
              ))}
            </div>
            <button type="button" className="cp-secondary-button" onClick={() => setReplacementThreadId(null)}>Cancel</button>
          </section>
        </div>
      )}
    </main>
  );
}

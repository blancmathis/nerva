import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ModelCapability, PendingApproval, SkillCapability } from "../lib/model";
import type { ModelReasoningPreset } from "../lib/storage";
import { resolveModelReasoningPresets } from "../lib/model-presets";
import { groupSkills } from "../lib/skill-groups";
import type { ProductSession } from "../lib/session-presentation";
import type { SessionActivityEvent } from "../lib/activity-timeline";
import { relativeSessionActivity, sessionStatusLabel } from "../lib/session-presentation";
import {
  BoltIcon,
  CameraIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  GlobeIcon,
  InboxIcon,
  LayersIcon,
  MacIcon,
  MicIcon,
  PencilIcon,
  PinIcon,
  SparkIcon,
  ArrowUpIcon,
  XIcon,
} from "./Icons";

interface SessionWorkspaceProps {
  readonly session: ProductSession;
  readonly pinned: boolean;
  readonly followMac: boolean;
  readonly targetReady: boolean;
  readonly macUnavailable: boolean;
  readonly skills: readonly SkillCapability[];
  readonly selectedSkillIds: readonly string[];
  readonly reasoningModes: readonly string[];
  readonly currentReasoningMode: string | null;
  readonly currentModel: string | null;
  readonly models: readonly ModelCapability[];
  readonly modelReasoningPresets: readonly ModelReasoningPreset[];
  readonly modelReasoningEnabled: boolean;
  readonly dictationAction: string | null;
  readonly dictationActive: boolean;
  readonly fastAction: string | null;
  readonly sendAction: string | null;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly approvalEnabled: boolean;
  readonly busyAction: string | null;
  readonly activityEvents: readonly SessionActivityEvent[];
  readonly captureInboxCount: number;
  readonly onTogglePin: () => void;
  readonly onToggleFollow: () => void;
  readonly onToggleSkill: (skillId: string) => void;
  readonly onRunAction: (action: string, value?: string) => void;
  readonly onSendPrompt: () => void;
  readonly onToggleDictation: () => void;
  readonly onSetModelReasoning: (preset: Pick<ModelReasoningPreset, "model" | "reasoning">) => Promise<boolean>;
  readonly onApprovalDecision: (approval: PendingApproval, decision: "accept" | "decline") => void;
  readonly onOpenDrawing: (importPhoto: boolean) => void;
  readonly onOpenReview: () => void;
  readonly onOpenImageReview: () => void;
  readonly onOpenCaptureInbox: () => void;
  readonly onOpenSavedDrawings: () => void;
  readonly onOpenOnMac: () => void;
}

function approvalKind(kind: PendingApproval["kind"]): string {
  if (kind === "commandExecution") return "Command execution";
  if (kind === "fileChange") return "File change";
  return "Permission request";
}

export function SessionWorkspace({
  session,
  pinned,
  followMac,
  targetReady,
  macUnavailable,
  skills,
  selectedSkillIds,
  reasoningModes,
  currentReasoningMode,
  currentModel,
  models,
  modelReasoningPresets,
  modelReasoningEnabled,
  dictationAction,
  dictationActive,
  fastAction,
  sendAction,
  pendingApprovals,
  approvalEnabled,
  busyAction,
  activityEvents,
  captureInboxCount,
  onTogglePin,
  onToggleFollow,
  onToggleSkill,
  onRunAction,
  onSendPrompt,
  onToggleDictation,
  onSetModelReasoning,
  onApprovalDecision,
  onOpenDrawing,
  onOpenReview,
  onOpenImageReview,
  onOpenCaptureInbox,
  onOpenSavedDrawings,
  onOpenOnMac,
}: SessionWorkspaceProps) {
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [expandedSkillGroupIds, setExpandedSkillGroupIds] = useState<readonly string[]>([]);
  const [approvalDetail, setApprovalDetail] = useState<PendingApproval | null>(null);
  const modelPresets = useMemo(
    () => resolveModelReasoningPresets(modelReasoningPresets, models),
    [modelReasoningPresets, models],
  );
  const skillGroups = useMemo(
    () => groupSkills(skills, selectedSkillIds),
    [selectedSkillIds, skills],
  );
  const standaloneSkills = useMemo(
    () => skillGroups.flatMap((group) => group.skills.length === 1 ? group.skills : []),
    [skillGroups],
  );
  const groupedSkillSections = useMemo(
    () => skillGroups.filter((group) => group.skills.length > 1),
    [skillGroups],
  );
  useEffect(() => {
    setExpandedSkillGroupIds((current) => {
      const validIds = new Set(groupedSkillSections.map((group) => group.id));
      const next = current.filter((groupId) => validIds.has(groupId));
      for (const group of groupedSkillSections) {
        if (group.selectedCount > 0 && !next.includes(group.id)) next.push(group.id);
      }
      if (next.length === 0 && groupedSkillSections.length === 1 && standaloneSkills.length === 0) next.push(groupedSkillSections[0]!.id);
      return next.length === current.length && next.every((groupId, index) => groupId === current[index])
        ? current
        : next;
    });
  }, [groupedSkillSections, standaloneSkills.length]);
  const observedPresetIndex = useMemo(() => {
    const exact = modelPresets.findIndex((preset) => (
      preset.model === currentModel && preset.reasoning === currentReasoningMode
    ));
    if (exact >= 0) return exact;
    const defaultModel = models.find((model) => model.isDefault);
    const catalogDefault = defaultModel === undefined ? -1 : modelPresets.findIndex((preset) => (
      preset.model === defaultModel.model && preset.reasoning === defaultModel.defaultReasoningEffort
    ));
    return Math.max(0, catalogDefault);
  }, [currentModel, currentReasoningMode, modelPresets, models]);
  const [presetIndex, setPresetIndex] = useState(observedPresetIndex);
  const presetIndexRef = useRef(observedPresetIndex);
  const presetCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (presetCommitTimerRef.current !== null) clearTimeout(presetCommitTimerRef.current);
    presetCommitTimerRef.current = null;
    presetIndexRef.current = observedPresetIndex;
    setPresetIndex(observedPresetIndex);
  }, [observedPresetIndex]);
  useEffect(() => () => {
    if (presetCommitTimerRef.current !== null) clearTimeout(presetCommitTimerRef.current);
  }, []);
  const selectedPreset = modelPresets[presetIndex] ?? null;
  const selectedModel = selectedPreset === null
    ? null
    : models.find((model) => model.model === selectedPreset.model) ?? null;
  const commitPresetIndex = useCallback((index: number) => {
    const preset = modelPresets[index];
    if (!preset || index === observedPresetIndex) return;
    void onSetModelReasoning(preset).then((accepted) => {
      if (accepted) return;
      presetIndexRef.current = observedPresetIndex;
      setPresetIndex(observedPresetIndex);
    });
  }, [modelPresets, observedPresetIndex, onSetModelReasoning]);
  const clearPresetCommit = () => {
    if (presetCommitTimerRef.current !== null) clearTimeout(presetCommitTimerRef.current);
    presetCommitTimerRef.current = null;
  };
  const commitPreset = () => {
    clearPresetCommit();
    commitPresetIndex(presetIndexRef.current);
  };
  const previewPreset = (index: number) => {
    presetIndexRef.current = index;
    setPresetIndex(index);
    clearPresetCommit();
    // iPadOS can deliver the range input after pointerup. This short fallback
    // commits the final value without requiring a second touch.
    presetCommitTimerRef.current = setTimeout(() => {
      presetCommitTimerRef.current = null;
      commitPresetIndex(index);
    }, 180);
  };
  const controlsDisabled = macUnavailable || !targetReady || busyAction !== null;
  const status = sessionStatusLabel(session.status);

  return (
    <main className={`cp-session-workspace status-${session.status}`}>
      <header className="cp-session-nav cp-enter">
        <div className="cp-session-nav__identity">
          <span className="cp-session-nav__signal" aria-hidden="true" />
          <span><strong>{session.title}</strong><small>{session.threadId.slice(-8)}</small></span>
        </div>
        <div className="cp-session-nav__controls">
          <button type="button" aria-pressed={pinned} onClick={onTogglePin}><PinIcon />{pinned ? "Unpin from Home" : "Pin to Home"}</button>
          <button
            type="button"
            aria-pressed={followMac}
            title={followMac ? "Tap to stay on this iPad session" : "Tap to follow the current Mac task"}
            onClick={onToggleFollow}
          ><MacIcon />{followMac ? "Following Mac" : "Staying here"}</button>
        </div>
      </header>

      <section className="cp-session-hero cp-enter cp-enter--2">
        <span className="cp-session-hero__light" aria-hidden="true" />
        <div className="cp-session-hero__copy">
          <p className="cp-overline">Exact Codex session</p>
          <h1>{session.title}</h1>
          <div className="cp-session-hero__meta">
            {session.project && <span><FolderIcon />{session.project}</span>}
            <span className="cp-session-hero__status"><i aria-hidden="true" />{status}</span>
            {session.activeOnMac && <span><MacIcon />Open on Mac</span>}
          </div>
          <p className="cp-session-hero__activity">{relativeSessionActivity(session)}</p>
        </div>
        <div className="cp-session-hero__authority">
          <span>{targetReady ? "Exact target verified" : macUnavailable ? "Mac unavailable" : "Display only"}</span>
          <small>{targetReady ? "Native actions are bound to this thread." : "No action will be queued or replayed."}</small>
        </div>
      </section>

      <section className="cp-activity-timeline cp-enter cp-enter--3" aria-labelledby="activity-timeline-title">
        <div>
          <p className="cp-overline">Structured events</p>
          <h2 id="activity-timeline-title">Recent activity</h2>
        </div>
        {activityEvents.length > 0 ? (
          <ol>
            {activityEvents.slice(0, 4).map((event) => (
              <li key={event.id} data-status={event.status}>
                <span aria-hidden="true" />
                <div><strong>{event.title}</strong><small>{event.detail}</small></div>
                <time dateTime={new Date(event.at).toISOString()}>{new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(event.at)}</time>
              </li>
            ))}
          </ol>
        ) : <p>Nerva is waiting for the first verified state transition.</p>}
      </section>

      <section className="cp-primary-actions cp-enter cp-enter--3" aria-labelledby="primary-actions-title">
        <div className="cp-section-heading">
          <div><p className="cp-overline">Touch surface</p><h2 id="primary-actions-title">Choose an input.</h2></div>
          <div className="cp-primary-actions__utilities">
            <button
              type="button"
              className="cp-send-prompt"
              disabled={controlsDisabled || sendAction === null}
              title={dictationActive ? "Finish Dictation and submit the Mac composer" : "Submit the current Mac composer"}
              onClick={onSendPrompt}
            ><ArrowUpIcon />Send prompt</button>
            <button type="button" className="cp-saved-drawings-trigger cp-session-inbox-trigger" onClick={onOpenCaptureInbox}><InboxIcon />Capture Inbox{captureInboxCount > 0 && <span>{captureInboxCount}</span>}</button>
            <button type="button" className="cp-saved-drawings-trigger" onClick={onOpenSavedDrawings}><LayersIcon />Saved Drawings</button>
          </div>
        </div>
        <div className="cp-primary-actions__grid has-site">
          <button
            type="button"
            className="tone-coral"
            aria-pressed={dictationActive}
            disabled={controlsDisabled || dictationAction === null}
            onClick={onToggleDictation}
          >
            <span className="cp-action-icon"><MicIcon /></span>
            <span><strong>{dictationActive ? "Stop Dictation" : "Dictation"}</strong><small>{dictationActive ? "Tap to finish on the Mac" : "Tap to start on the Mac"}</small></span>
            <i aria-hidden="true" />
          </button>
          <button type="button" className="tone-cobalt" disabled={!session.nativeSlot || controlsDisabled} onClick={() => onOpenDrawing(false)}>
            <span className="cp-action-icon"><PencilIcon /></span>
            <span><strong>Draw</strong><small>Start a local canvas</small></span>
            <i aria-hidden="true" />
          </button>
          <button type="button" className="tone-sage" disabled={!session.nativeSlot || controlsDisabled} onClick={() => onOpenDrawing(true)}>
            <span className="cp-action-icon"><CameraIcon /></span>
            <span><strong>Photo</strong><small>Camera, Library, or Files</small></span>
            <i aria-hidden="true" />
          </button>
          <button type="button" className="tone-amber" onClick={onOpenReview}>
            <span className="cp-action-icon"><GlobeIcon /></span>
            <span>
              <strong>Sites</strong>
              <small>Browse open Mac pages</small>
            </span>
            <i aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="cp-session-controls cp-enter cp-enter--4" aria-labelledby="session-controls-title">
        <div className="cp-section-heading"><div><p className="cp-overline">Next message</p><h2 id="session-controls-title">Agent controls.</h2></div></div>
        <div className="cp-session-controls__grid">
          <div className="cp-skill-control">
            <button type="button" className="cp-control-header" aria-expanded={skillsOpen} onClick={() => setSkillsOpen((value) => !value)}>
              <span><SparkIcon /></span><span><strong>Skills</strong><small>{selectedSkillIds.length > 0 ? `${selectedSkillIds.length} armed for the next send` : `${skills.length} available`}</small></span><ChevronIcon />
            </button>
            {selectedSkillIds.length > 0 && (
              <div className="cp-skill-chips" aria-label="Selected skills for Nerva visual sends">
                {selectedSkillIds.map((skillId) => <button type="button" key={skillId} onClick={() => onToggleSkill(skillId)}>{skillId}<CloseIcon /></button>)}
              </div>
            )}
            {skillsOpen && typeof document !== "undefined" && createPortal(
              <div className="cp-skill-picker" aria-label="Available skill groups">
                {skillGroups.length > 0 ? (
                  <>
                    <header className="cp-skill-picker__header">
                      <span><strong>Skill library</strong><small>Grouped automatically by provider · {skills.length} available</small></span>
                      <button type="button" aria-label="Close Skills" onClick={() => setSkillsOpen(false)}><CloseIcon /></button>
                    </header>
                    <div className="cp-skill-groups">
                      {standaloneSkills.map((skill) => (
                        <button
                          type="button"
                          className="cp-skill-option cp-skill-option--standalone"
                          key={skill.id}
                          disabled={!skill.enabled}
                          aria-pressed={selectedSkillIds.includes(skill.id)}
                          onClick={() => onToggleSkill(skill.id)}
                        >
                          <span><strong>{skill.label}</strong><small>{skill.description ?? "Available to this Codex session"}</small></span>
                          <span className="cp-checkmark">{selectedSkillIds.includes(skill.id) ? <CheckIcon /> : null}</span>
                        </button>
                      ))}
                      {groupedSkillSections.map((group) => {
                        const expanded = expandedSkillGroupIds.includes(group.id);
                        const groupPanelId = `skill-group-${group.id}`;
                        return (
                          <section className={`cp-skill-group${expanded ? " is-expanded" : ""}${group.selectedCount > 0 ? " has-selected" : ""}`} key={group.id}>
                            <button
                              type="button"
                              className="cp-skill-group__header"
                              aria-expanded={expanded}
                              aria-controls={groupPanelId}
                              onClick={() => setExpandedSkillGroupIds((current) => (
                                current.includes(group.id)
                                  ? current.filter((groupId) => groupId !== group.id)
                                  : [...current, group.id]
                              ))}
                            >
                              <span className="cp-skill-group__icon"><FolderIcon /></span>
                              <span className="cp-skill-group__identity">
                                <strong>{group.label}</strong>
                                <small>{group.skills.length} {group.skills.length === 1 ? "skill" : "skills"}{group.selectedCount > 0 ? ` · ${group.selectedCount} selected` : ""}</small>
                              </span>
                              <span className="cp-skill-group__count">{group.skills.length}</span>
                              <ChevronIcon />
                            </button>
                            {expanded && (
                              <div className="cp-skill-group__items" id={groupPanelId}>
                                {group.skills.map((skill) => (
                                  <button
                                    type="button"
                                    className="cp-skill-option"
                                    key={skill.id}
                                    disabled={!skill.enabled}
                                    aria-pressed={selectedSkillIds.includes(skill.id)}
                                    onClick={() => onToggleSkill(skill.id)}
                                  >
                                    <span><strong>{skill.label}</strong><small>{skill.description ?? "Available to this Codex session"}</small></span>
                                    <span className="cp-checkmark">{selectedSkillIds.includes(skill.id) ? <CheckIcon /> : null}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </section>
                        );
                      })}
                    </div>
                  </>
                ) : <p>No session skills are currently exposed by Codex.</p>}
                <p className="cp-skill-note">Skills stay armed for the next text instruction. Drawings are always sent image-only; use Dictation afterward to add a message in Codex.</p>
              </div>,
              document.body,
            )}
          </div>

          <div className="cp-model-control">
            <div className="cp-control-header cp-control-header--static">
              <span><SlidersGlyph /></span><span><strong>Model + Reasoning</strong><small>{selectedModel?.displayName ?? currentModel ?? "Codex model"} · {selectedPreset?.reasoning ?? currentReasoningMode ?? "loading"}</small></span>
            </div>
            <div className="cp-reasoning-slider">
              <input
                type="range"
                min={0}
                max={Math.max(0, modelPresets.length - 1)}
                value={presetIndex}
                disabled={controlsDisabled || !modelReasoningEnabled || modelPresets.length < 2}
                aria-label="Model and reasoning preset"
                onChange={(event) => {
                  previewPreset(Number(event.target.value));
                }}
                onPointerUp={commitPreset}
                onBlur={commitPreset}
                onKeyUp={(event) => {
                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) commitPreset();
                }}
              />
              <div>
                <span>{modelPresets[0]?.reasoning ?? reasoningModes[0] ?? "Low"}</span>
                <strong>{selectedPreset ? `${selectedModel?.displayName ?? selectedPreset.model} · ${selectedPreset.reasoning}` : currentReasoningMode ?? "Unavailable"}</strong>
                <span>{modelPresets.at(-1)?.reasoning ?? reasoningModes.at(-1) ?? "High"}</span>
              </div>
            </div>
            <p>{modelPresets.length > 0
              ? "Only the presets selected in Settings appear here."
              : modelReasoningPresets.length > 0
                ? "Your selected presets are not currently available from Codex."
                : "Waiting for the live Codex model catalog."}</p>
          </div>

          <button type="button" className={`cp-fast-control${fastAction ? "" : " is-disabled"}`} disabled={controlsDisabled || fastAction === null} onClick={() => fastAction && onRunAction(fastAction)}>
            <span><BoltIcon /></span><span><strong>Fast</strong><small>{fastAction ? "Toggle the native Codex mode" : "Unavailable for this session"}</small></span>
          </button>
        </div>
      </section>

      {(pendingApprovals.length > 0 || session.status === "awaiting-approval") && (
        <section className="cp-context-panel cp-context-panel--approval cp-enter" aria-labelledby="approval-title">
          <div><p className="cp-overline">Action required</p><h2 id="approval-title">Codex needs your approval.</h2></div>
          {pendingApprovals.length === 0 ? (
            <p>The status is visible, but the exact request identity is unavailable. Approval remains locked.</p>
          ) : pendingApprovals.map((approval) => (
            <article key={`${typeof approval.requestId}:${String(approval.requestId)}`}>
              <div><strong>{approvalKind(approval.kind)}</strong><p>{approval.summary ?? "Codex requested a decision for this exact item."}</p></div>
              <div className="cp-context-panel__actions">
                <button type="button" onClick={() => setApprovalDetail(approval)}>View command</button>
                <button type="button" className="is-approve" disabled={!approvalEnabled || !approval.actionable || busyAction !== null} onClick={() => onApprovalDecision(approval, "accept")}><CheckIcon />Approve</button>
                <button type="button" className="is-reject" disabled={!approvalEnabled || !approval.actionable || busyAction !== null} onClick={() => onApprovalDecision(approval, "decline")}><XIcon />Reject</button>
                <button type="button" disabled={controlsDisabled || dictationAction === null} onClick={onToggleDictation}><MicIcon />{dictationActive ? "Stop Dictation" : "Add instruction"}</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {session.status === "error" && (
        <section className="cp-context-panel cp-context-panel--error cp-enter">
          <div><p className="cp-overline">Agent error</p><h2>The session needs attention on the Mac.</h2></div>
          <div className="cp-context-panel__actions">
            <button type="button" disabled={macUnavailable} onClick={onOpenOnMac}><MacIcon />Open on Mac</button>
            <button type="button" disabled={controlsDisabled || dictationAction === null} onClick={onToggleDictation}><MicIcon />{dictationActive ? "Stop Dictation" : "Add instruction"}</button>
          </div>
        </section>
      )}

      {session.status === "unread" && (
        <section className="cp-context-panel cp-context-panel--completed cp-enter">
          <div><p className="cp-overline">Result ready</p><h2>Review the latest interface.</h2></div>
          <div className="cp-context-panel__actions"><button type="button" onClick={onOpenImageReview}><GlobeIcon />Review result</button></div>
        </section>
      )}

      {approvalDetail && (
        <div className="cp-modal-layer" role="presentation">
          <section className="cp-command-detail" role="dialog" aria-modal="true" aria-labelledby="command-detail-title">
            <button type="button" className="cp-icon-button" aria-label="Close command details" onClick={() => setApprovalDetail(null)}><CloseIcon /></button>
            <p className="cp-overline">{approvalKind(approvalDetail.kind)}</p>
            <h2 id="command-detail-title">Review the exact request.</h2>
            <pre>{approvalDetail.summary ?? "The bridge did not expose a safe command summary."}</pre>
            <dl>
              <div><dt>Thread</dt><dd>{approvalDetail.threadId}</dd></div>
              <div><dt>Turn</dt><dd>{approvalDetail.turnId}</dd></div>
              <div><dt>Item</dt><dd>{approvalDetail.itemId}</dd></div>
            </dl>
            <p>The working directory is shown only when Codex exposes it through the exact approval contract.</p>
          </section>
        </div>
      )}
    </main>
  );
}

function SlidersGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>;
}

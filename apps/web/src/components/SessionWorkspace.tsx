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
import { relativeSessionActivity, sessionStatusLabel } from "../lib/session-presentation";
import { useModalFocus } from "../lib/use-modal-focus";
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
  PhoneIcon,
  PinIcon,
  SearchIcon,
  SlidersIcon,
  SparkIcon,
  ArrowUpIcon,
  XIcon,
} from "./Icons";

interface SessionWorkspaceProps {
  readonly session: ProductSession;
  readonly pinned: boolean;
  readonly followMac: boolean;
  readonly targetReady: boolean;
  readonly voiceChatStatus: "available" | "active" | "unavailable";
  readonly voiceChatEnabled: boolean;
  readonly voiceChatDetail: string;
  readonly drawingAvailable: boolean;
  readonly macUnavailable: boolean;
  readonly skills: readonly SkillCapability[];
  readonly selectedSkillIds: readonly string[];
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
  readonly captureInboxCount: number;
  readonly onTogglePin: () => void;
  readonly onSwitchSession: () => void;
  readonly onToggleFollow: () => void;
  readonly onToggleSkill: (skillId: string) => void;
  readonly onRunAction: (action: string, value?: string) => void;
  readonly onSendPrompt: () => void;
  readonly onToggleDictation: () => void;
  readonly onStartVoiceChat: () => void;
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
  voiceChatStatus,
  voiceChatEnabled,
  voiceChatDetail,
  drawingAvailable,
  macUnavailable,
  skills,
  selectedSkillIds,
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
  captureInboxCount,
  onTogglePin,
  onSwitchSession,
  onToggleFollow,
  onToggleSkill,
  onRunAction,
  onSendPrompt,
  onToggleDictation,
  onStartVoiceChat,
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
  const [skillQuery, setSkillQuery] = useState("");
  const [expandedSkillGroupIds, setExpandedSkillGroupIds] = useState<readonly string[]>([]);
  const [approvalDetail, setApprovalDetail] = useState<PendingApproval | null>(null);
  const skillsDialogRef = useRef<HTMLDivElement | null>(null);
  const approvalDialogRef = useRef<HTMLElement | null>(null);
  useModalFocus(skillsDialogRef, () => setSkillsOpen(false), {
    active: skillsOpen,
    initialFocus: "[aria-label='Close Skills']",
  });
  useModalFocus(approvalDialogRef, () => setApprovalDetail(null), {
    active: approvalDetail !== null,
    initialFocus: "[aria-label='Close command details']",
  });
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
  const skillMatches = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    return skillGroups.flatMap((group) => group.skills.filter((skill) =>
      `${group.label} ${skill.label} ${skill.description ?? ""} ${skill.id}`.toLocaleLowerCase().includes(query),
    ));
  }, [skillGroups, skillQuery]);
  const observedPresetIndex = useMemo(() => modelPresets.findIndex((preset) => (
    preset.model === currentModel && preset.reasoning === currentReasoningMode
  )), [currentModel, currentReasoningMode, modelPresets]);
  const [presetIndex, setPresetIndex] = useState(observedPresetIndex);
  const [presetPending, setPresetPending] = useState(false);
  const presetRequestRef = useRef(0);
  useEffect(() => {
    presetRequestRef.current += 1;
    setPresetIndex(observedPresetIndex);
    setPresetPending(false);
    return () => { presetRequestRef.current += 1; };
  }, [observedPresetIndex, session.threadId]);
  const currentModelLabel = models.find((model) => model.model === currentModel)?.displayName ?? currentModel ?? "Codex model";
  const commitPresetIndex = useCallback((index: number) => {
    const preset = modelPresets[index];
    if (!preset || index === observedPresetIndex) return;
    const request = ++presetRequestRef.current;
    setPresetIndex(index);
    setPresetPending(true);
    void onSetModelReasoning(preset).then((accepted) => {
      if (!accepted && presetRequestRef.current === request) setPresetIndex(observedPresetIndex);
    }).catch(() => {
      if (presetRequestRef.current === request) setPresetIndex(observedPresetIndex);
    }).finally(() => {
      if (presetRequestRef.current === request) setPresetPending(false);
    });
  }, [modelPresets, observedPresetIndex, onSetModelReasoning]);
  const nativeControlsDisabled = macUnavailable || !targetReady || busyAction !== null;
  const status = sessionStatusLabel(session.status);

  return (
    <main className={`cp-session-workspace status-${session.status}`}>
      <header className="cp-session-nav cp-enter">
        <button type="button" className="cp-back-button" onClick={onSwitchSession}><ChevronIcon direction="left" />All sessions</button>
        <div className="cp-session-nav__controls">
          <button type="button" aria-label={pinned ? "Unpin from Home" : "Pin to Home"} aria-pressed={pinned} onClick={onTogglePin}><PinIcon /><span className="cp-pin-label">{pinned ? "Unpin from Home" : "Pin to Home"}</span><span className="cp-pin-label-short" aria-hidden="true">{pinned ? "Pinned" : "Pin"}</span></button>
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
          <h1>{session.title}</h1>
          <div className="cp-session-hero__meta">
            {session.project && <span><FolderIcon />{session.project}</span>}
            <span className="cp-session-hero__status"><i aria-hidden="true" />{status}</span>
            {session.activeOnMac && <span><MacIcon />Open on Mac</span>}
          </div>
          {relativeSessionActivity(session) !== status && <p className="cp-session-hero__activity">{relativeSessionActivity(session)}</p>}
        </div>
        <div className="cp-session-hero__authority">
          <span>{targetReady ? "Connected to this task" : macUnavailable ? "Mac unavailable" : "Display only"}</span>
          <small>{targetReady
            ? "Actions below apply to this task on your Mac."
            : macUnavailable
              ? "Local drawing remains available. Nothing will send until the Mac reconnects."
              : "Native Mac controls are not verified for this task. Local drawing remains available."}</small>
          <button
            type="button"
            className="cp-voice-chat"
            data-state={voiceChatStatus}
            aria-pressed={voiceChatStatus === "active"}
            disabled={!voiceChatEnabled || busyAction !== null}
            title={voiceChatDetail}
            onClick={onStartVoiceChat}
          >
            <span className="cp-voice-chat__icon"><PhoneIcon /></span>
            <span>
              <strong>{voiceChatStatus === "active" ? "Voice active" : "Start voice call"}</strong>
              <small>{voiceChatDetail}</small>
            </span>
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
                <button type="button" disabled={nativeControlsDisabled || dictationAction === null} onClick={onToggleDictation}><MicIcon />{dictationActive ? "Stop Dictation" : "Add instruction"}</button>
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
            <button type="button" disabled={nativeControlsDisabled || dictationAction === null} onClick={onToggleDictation}><MicIcon />{dictationActive ? "Stop Dictation" : "Add instruction"}</button>
          </div>
        </section>
      )}

      {session.status === "unread" && (
        <section className="cp-context-panel cp-context-panel--completed cp-enter">
          <div><p className="cp-overline">Result ready</p><h2>Review the latest interface.</h2></div>
          <div className="cp-context-panel__actions"><button type="button" onClick={onOpenImageReview}><GlobeIcon />Review result</button></div>
        </section>
      )}

      <section className="cp-primary-actions cp-enter cp-enter--3" aria-labelledby="primary-actions-title">
        <div className="cp-section-heading">
          <div><h2 id="primary-actions-title">Add to this task</h2></div>
          <div className="cp-primary-actions__utilities">
            <button
              type="button"
              className="cp-send-prompt"
              disabled={nativeControlsDisabled || sendAction === null}
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
            disabled={nativeControlsDisabled || dictationAction === null}
            onClick={onToggleDictation}
          >
            <span className="cp-action-icon"><MicIcon /></span>
            <span><strong>{dictationActive ? "Stop Dictation" : "Dictation"}</strong><small>{dictationActive ? "Tap to finish on the Mac" : "Tap to start on the Mac"}</small></span>
            <i aria-hidden="true" />
          </button>
          <button type="button" className="tone-cobalt" disabled={!drawingAvailable} onClick={() => onOpenDrawing(false)}>
            <span className="cp-action-icon"><PencilIcon /></span>
            <span><strong>Draw</strong><small>Start a local canvas</small></span>
            <i aria-hidden="true" />
          </button>
          <button type="button" className="tone-sage" disabled={!drawingAvailable} onClick={() => onOpenDrawing(true)}>
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
        <div className="cp-section-heading"><h2 id="session-controls-title">Task options</h2></div>
        <div className="cp-session-controls__grid">
          <div className="cp-skill-control">
            <button type="button" className="cp-control-header" aria-expanded={skillsOpen} aria-controls="skill-library-dialog" onClick={() => setSkillsOpen((value) => !value)}>
              <span><SparkIcon /></span><span><strong>Skills</strong><small>{selectedSkillIds.length > 0 ? `${selectedSkillIds.length} selected for your next message` : `${skills.length} available`}</small></span><ChevronIcon />
            </button>
            {selectedSkillIds.length > 0 && (
              <div className="cp-skill-chips" aria-label="Selected skills for Nerva visual sends">
                {selectedSkillIds.map((skillId) => <button type="button" key={skillId} onClick={() => onToggleSkill(skillId)}>{skillId}<CloseIcon /></button>)}
              </div>
            )}
            {skillsOpen && typeof document !== "undefined" && createPortal(
              <div ref={skillsDialogRef} id="skill-library-dialog" className="cp-skill-picker" role="dialog" aria-modal="true" aria-labelledby="skill-library-title" tabIndex={-1}>
                <header className="cp-skill-picker__header">
                  <span><strong id="skill-library-title">Skill library</strong><small>{selectedSkillIds.length} selected · {skills.length} available</small></span>
                  <button type="button" aria-label="Close Skills" onClick={() => setSkillsOpen(false)}><CloseIcon /></button>
                </header>
                <label className="cp-skill-search"><SearchIcon /><input type="search" aria-label="Search skills" placeholder="Find a skill" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} /></label>
                {skillQuery.trim() ? (
                  <div className="cp-skill-groups">
                    <p className="cp-skill-results" role="status">{skillMatches.length} {skillMatches.length === 1 ? "skill" : "skills"} found</p>
                    {skillMatches.map((skill) => <button type="button" className="cp-skill-option" key={skill.id} disabled={!skill.enabled} aria-pressed={selectedSkillIds.includes(skill.id)} onClick={() => onToggleSkill(skill.id)}>
                      <span><strong>{skill.label}</strong><small>{skill.description ?? "Available to this Codex session"}</small></span>
                      <span className="cp-checkmark">{selectedSkillIds.includes(skill.id) ? <CheckIcon /> : null}</span>
                    </button>)}
                    {skillMatches.length === 0 && <button type="button" className="cp-secondary-button" onClick={() => setSkillQuery("")}>Clear search</button>}
                  </div>
                ) : skillGroups.length > 0 ? (
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
                ) : <p className="cp-skill-note">No skills are available for this task yet.</p>}
                <p className="cp-skill-note">Selected skills apply when you send your next text instruction.</p>
                <button type="button" className="cp-skill-done" onClick={() => setSkillsOpen(false)}>Done{selectedSkillIds.length > 0 ? ` · ${selectedSkillIds.length} selected` : ""}</button>
              </div>,
              document.body,
            )}
          </div>

          <div className="cp-model-control">
            <label className="cp-control-header cp-control-header--static" htmlFor="session-model-preset">
              <span><SlidersIcon /></span><span><strong>Model &amp; reasoning</strong><small>{presetPending ? "Applying your choice…" : "Choose how Codex works on this task"}</small></span>
            </label>
            <select
              id="session-model-preset"
              className="cp-model-preset-select"
              value={presetIndex}
              disabled={nativeControlsDisabled || !modelReasoningEnabled || presetPending || modelPresets.length === 0}
              aria-label="Model and reasoning preset"
              aria-busy={presetPending}
              onChange={(event) => commitPresetIndex(Number(event.target.value))}
            >
              {observedPresetIndex < 0 && <option value={-1} disabled>{currentModelLabel}{currentReasoningMode ? ` · ${currentReasoningMode}` : " · Unavailable"}</option>}
              {modelPresets.map((preset, index) => <option key={preset.id} value={index}>{models.find((model) => model.model === preset.model)?.displayName ?? preset.model} · {preset.reasoning}</option>)}
            </select>
            <p>{!modelReasoningEnabled
              ? "Model changes are unavailable for this task right now."
              : modelReasoningPresets.length > 0
                ? modelPresets.length > 0 ? "Your shortcuts from Settings." : "Your saved shortcuts are unavailable in Codex."
                : "Models and reasoning levels available in Codex."}</p>
          </div>

          <button type="button" className={`cp-fast-control${fastAction ? "" : " is-disabled"}`} disabled={nativeControlsDisabled || fastAction === null} onClick={() => fastAction && onRunAction(fastAction)}>
            <span><BoltIcon /></span><span><strong>Fast</strong><small>{fastAction ? "Switch Fast mode on the Mac" : "Unavailable for this session"}</small></span>
          </button>
        </div>
      </section>

      {approvalDetail && (
        <div className="cp-modal-layer" role="presentation">
          <section ref={approvalDialogRef} className="cp-command-detail" role="dialog" aria-modal="true" aria-labelledby="command-detail-title" tabIndex={-1}>
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

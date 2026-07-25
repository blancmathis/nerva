export const THREADS = [
  { id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1", title: "Release checklist", nativeStatus: "idle", visualStatus: "idle", project: "codex-pad", projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I" },
  { id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2", title: "Bridge hardening", nativeStatus: "working", visualStatus: "working", project: "codex-pad", projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I" },
  { id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba3", title: "Research queue", nativeStatus: "completed", visualStatus: "completed", project: "research", projectId: "project:CTW3aFtA0PLAfVg9FMSzjZ6jsVRSm9_1ABm0ZZJxPdE" },
  { id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba4", title: "Approval audit", nativeStatus: "awaiting-approval", visualStatus: "needsInput", project: "codex-pad", projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I" },
  { id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba5", title: "Visual polish", nativeStatus: "error", visualStatus: "error", project: "web", projectId: "project:PRJ-vk9HAFbo9yq4Yx_XxoTAqzbPVLs_tB59_o2e_qw" },
  { id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba6", title: "iPad field notes", nativeStatus: "idle", visualStatus: "idle", project: "research", projectId: "project:CTW3aFtA0PLAfVg9FMSzjZ6jsVRSm9_1ABm0ZZJxPdE" },
] as const;

export const CATALOG_SESSION = {
  id: "019f7ec2-68eb-7183-bb3a-0e67312a8ba7",
  title: "Catalog reference",
  nativeStatus: "idle",
  visualStatus: "idle",
  project: "archive",
  projectId: "project:T1iBhMlybx93UTk0x-R12z_XvJTKtecmEEjDoFThbv4",
} as const;

export const INITIAL_BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
export const RESTARTED_BRIDGE_INSTANCE_ID = "0bb7bb32-f477-4792-ad7b-06fef8287138";

export function fixtureRuntimeDiagnostics(sequence = 73) {
  const capturedAt = Date.now();
  const labels = {
    sessions: "Sessions",
    nativeControls: "Native controls",
    composerAttachment: "Composer attachment",
    skillsAndModels: "Skills and models",
    approvals: "Approvals",
    sites: "Sites",
  } as const;
  return {
    ok: true,
    data: {
      protocolVersion: 1,
      bridgeVersion: "0.1.0-test-fixture",
      codexVersion: "0.145.0-test-fixture",
      snapshotSequence: sequence,
      capturedAt,
      bridgeHealth: {
        state: "live",
        reason: null,
        changedAt: capturedAt - 5_000,
        lastSuccessfulRefreshAt: capturedAt,
      },
      schemaCompatibility: {
        state: "current",
        summary: "Installed-version schema matches the test fixture.",
        remediation: null,
      },
      checks: Object.entries(labels).map(([id, label]) => ({
        id,
        label,
        state: "available",
        reason: null,
        lastProvenAt: capturedAt,
      })),
    },
  } as const;
}

export function fixtureContextRoomStatus() {
  return {
    ok: true,
    data: {
      configured: true,
      available: true,
      checkedAt: Date.now(),
      roomName: "Nerva design QA",
      version: "0.1.8-test-fixture",
      reason: null,
    },
  } as const;
}

export interface FixtureState {
  readonly bridgeInstanceId: string;
  readonly sequence: number;
  readonly selectedIndex: number;
  readonly activeThreadId?: string;
  readonly approvalPending?: boolean;
}

function assignment(label: string, keycapId: string, nativeCommandId: string) {
  return {
    keycapId,
    nativeCommandId,
    label,
    enabled: true,
  };
}

function joystickAssignment(label: string, commandId: string) {
  return {
    type: "command" as const,
    commandId,
    label,
    enabled: true,
  };
}

export function fixtureSnapshot(state: FixtureState) {
  const timestamp = Date.now();
  const activeThreadId = state.activeThreadId ?? THREADS[state.selectedIndex]!.id;
  const selectedThread = THREADS.find((thread) => thread.id === activeThreadId) ?? null;
  return {
    bridgeInstanceId: state.bridgeInstanceId,
    sequence: state.sequence,
    timestamp,
    codexVersion: "0.145.0-test-fixture",
    bridgeHealth: {
      state: "live",
      reason: null,
      changedAt: timestamp - 5_000,
      lastSuccessfulRefreshAt: timestamp,
    },
    agentSource: "pinned",
    slots: THREADS.map((thread, slot) => ({
      slot,
      threadId: thread.id,
      title: thread.title,
      activityLabel: null,
      nativeStatus: slot === 3 && state.approvalPending === false ? "idle" : thread.nativeStatus,
      visualStatus: slot === 3 && state.approvalPending === false ? "idle" : thread.visualStatus,
      selected: thread.id === selectedThread?.id,
      activityAt: timestamp - (slot + 1) * 60_000,
      ownedByHost: true,
    })),
    actionAssignments: {
      micro: {
        ACT06: assignment("Fast", "FAST", "mode.fast"),
        ACT07: assignment("Approve", "APPR", "approval.accept"),
        ACT08: assignment("Decline", "REJ", "approval.reject"),
        ACT09: assignment("Fork", "SPLIT", "thread.fork"),
        ACT10_ACT11: assignment("Dictate", "MIC", "dictation.toggle"),
        ACT12: assignment("Send", "CODEX", "composer.submit"),
      },
      joystick: {
        up: joystickAssignment("Plan", "mode.plan"),
        right: joystickAssignment("Forward", "nav.forward"),
        down: joystickAssignment("Skill one", "skill.one"),
        left: joystickAssignment("Back", "nav.back"),
      },
    },
    activeThreadId,
    selectedThreadId: selectedThread?.id ?? null,
    pendingApprovals: state.selectedIndex === 3 && state.approvalPending !== false ? [{
      requestId: 991,
      threadId: THREADS[3].id,
      turnId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb1",
      itemId: "approval-item-a",
      kind: "commandExecution",
      actionable: true,
      summary: "npm test",
    }] : [],
    reasoning: { effort: "high", adjustable: true },
    theme: "dark",
  } as const;
}

export function fixtureCapabilities() {
  return {
    ok: true,
    data: {
      commands: [
        "selectAgent",
        "runMicroAction",
        "createTask",
        "adjustReasoning",
        "setModelReasoning",
        "respondToApproval",
        "runSkill",
        "runLibraryCommand",
        "sendSketch",
        "sendReview",
        "openSession",
      ],
      reasoningModes: ["low", "medium", "high"],
      currentReasoningMode: "high",
      currentModel: "gpt-test",
      models: [{
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      }, {
        model: "gpt-test-pro",
        displayName: "GPT Test Pro",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
        defaultReasoningEffort: "high",
        isDefault: false,
      }],
      skills: [
        { id: "visual-review", label: "Visual review", description: "Fixture skill", enabled: true, group: "personal" },
        { id: "computer-use", label: "Computer use", description: "Control local Mac applications", enabled: true, group: "computer-use" },
        { id: "gh-fix-ci", label: "Fix GitHub CI", description: "Inspect and repair CI failures", enabled: true, group: "github" },
        { id: "artifact-template-design-report", label: "Design report", description: "Create a structured design report", enabled: true, group: "openai-templates" },
        { id: "artifact-template-project-kickoff", label: "Project kickoff", description: "Create a project kickoff artifact", enabled: true, group: "openai-templates" },
        { id: "openai-docs", label: "OpenAI docs", description: "Use current OpenAI documentation", enabled: true, group: "system" },
      ],
      drawing: true,
      review: true,
      reviewMaxImages: 12,
      siteCapture: { available: false, reason: "Mac capture is intentionally disabled in E2E." },
      libraries: [],
    },
  } as const;
}

export function fixtureSessions(
  state: Pick<FixtureState, "sequence" | "selectedIndex">
    & Partial<Pick<FixtureState, "bridgeInstanceId">>,
) {
  const timestamp = Date.now();
  return {
    ok: true,
    data: {
      sequence: state.sequence,
      timestamp,
      sessions: [...THREADS.map((thread, microSlot) => ({
        threadId: thread.id,
        title: thread.title,
        nativeStatus: thread.nativeStatus,
        visualStatus: thread.visualStatus,
        activityLabel: null,
        activityAt: timestamp - (microSlot + 1) * 60_000,
        projectId: thread.projectId,
        projectLabel: thread.project,
        selected: microSlot === state.selectedIndex,
        microSlot,
        ownedByHost: true,
        siteAssociations: [],
        siteAssociation: null,
      })), {
        threadId: CATALOG_SESSION.id,
        title: CATALOG_SESSION.title,
        nativeStatus: CATALOG_SESSION.nativeStatus,
        visualStatus: CATALOG_SESSION.visualStatus,
        activityLabel: null,
        activityAt: timestamp - 7 * 60_000,
        projectId: CATALOG_SESSION.projectId,
        projectLabel: CATALOG_SESSION.project,
        selected: false,
        microSlot: null,
        ownedByHost: true,
        siteAssociations: [],
        siteAssociation: null,
      }],
    },
  } as const;
}

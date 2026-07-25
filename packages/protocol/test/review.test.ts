import { describe, expect, it } from "vitest";

import {
  AllSessionsResponseSchema,
  DisplayOnlyHttpUrlSchema,
  LocalSessionSiteSelectionSchema,
  NativeSessionsResponseSchema,
  SendReviewCommandSchema,
  SiteAssociationSchema,
  type SendReviewCommand,
} from "../src/index.js";

const COMMAND_ID = "73cc8a00-9160-48be-b1df-4efccd58ac22";
const BRIDGE_INSTANCE_ID = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
const THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e626";
const FRAME_ID = "83cc8a00-9160-48be-b1df-4efccd58ac33";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function reviewCommand(): SendReviewCommand {
  return {
    type: "sendReview",
    commandId: COMMAND_ID,
    expectedBridgeInstanceId: BRIDGE_INSTANCE_ID,
    expectedSequence: 12,
    expectedThreadId: THREAD_ID,
    targetThreadId: THREAD_ID,
    snapshotSeq: 12,
    instruction: "Review these two states",
    frames: [
      {
        frameId: FRAME_ID,
        index: 0,
        kind: "siteSnapshot",
        image: { kind: "inlinePng", png: PNG_1X1 },
        url: "https://preview.example.test/dashboard?state=empty",
        title: "Dashboard empty state",
        viewport: { width: 1_024, height: 768, devicePixelRatio: 2 },
        scroll: { x: 0, y: 320, documentWidth: 1_024, documentHeight: 2_400 },
      },
    ],
  };
}

describe("sendReview", () => {
  it("accepts an ordered, bounded atomic review", () => {
    expect(SendReviewCommandSchema.parse(reviewCommand())).toEqual(reviewCommand());
  });

  it("accepts exactly 8,000 instruction characters and rejects 8,001", () => {
    expect(SendReviewCommandSchema.safeParse({ ...reviewCommand(), instruction: "x".repeat(8_000) }).success).toBe(true);
    expect(SendReviewCommandSchema.safeParse({ ...reviewCommand(), instruction: "x".repeat(8_001) }).success).toBe(false);
  });

  it("supports opaque image references without accepting paths", () => {
    const command = reviewCommand();
    const frame = command.frames[0]!;
    command.frames[0] = {
      ...frame,
      image: { kind: "uploadRef", uploadId: FRAME_ID, byteLength: 1_024 },
    };
    expect(SendReviewCommandSchema.safeParse(command).success).toBe(true);

    command.frames[0] = {
      ...frame,
      image: { kind: "uploadRef", uploadId: "../../secret.png", byteLength: 1_024 } as never,
    };
    expect(SendReviewCommandSchema.safeParse(command).success).toBe(false);
  });

  it("allows photo and blank frames without a URL", () => {
    for (const kind of ["photo", "blank"] as const) {
      const frame = reviewCommand().frames[0]!;
      expect(
        SendReviewCommandSchema.safeParse({
          ...reviewCommand(),
          frames: [{ ...frame, kind, url: null }],
        }).success,
      ).toBe(true);
    }
  });

  it("requires URL metadata only for site snapshots", () => {
    const frame = reviewCommand().frames[0]!;
    expect(SendReviewCommandSchema.safeParse({ ...reviewCommand(), frames: [{ ...frame, url: null }] }).success).toBe(false);
    expect(
      SendReviewCommandSchema.safeParse({
        ...reviewCommand(),
        frames: [{ ...frame, kind: "photo", url: "https://example.test/photo" }],
      }).success,
    ).toBe(false);
  });

  it("requires a matching snapshot sequence", () => {
    expect(SendReviewCommandSchema.safeParse({ ...reviewCommand(), snapshotSeq: 11 }).success).toBe(false);
  });

  it("rejects missing, excess, duplicate, or misordered frames", () => {
    expect(SendReviewCommandSchema.safeParse({ ...reviewCommand(), frames: [] }).success).toBe(false);

    const tooMany = Array.from({ length: 13 }, (_, index) => ({
      ...reviewCommand().frames[0],
      frameId: `83cc8a00-9160-48be-b1df-4efccd58a${String(index).padStart(3, "0")}`,
      index,
    }));
    expect(SendReviewCommandSchema.safeParse({ ...reviewCommand(), frames: tooMany }).success).toBe(false);

    const duplicate = reviewCommand().frames[0];
    expect(
      SendReviewCommandSchema.safeParse({
        ...reviewCommand(),
        frames: [duplicate, { ...duplicate, index: 1 }],
      }).success,
    ).toBe(false);

    expect(
      SendReviewCommandSchema.safeParse({
        ...reviewCommand(),
        frames: [{ ...reviewCommand().frames[0], index: 1 }],
      }).success,
    ).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,unsafe",
    "https://user:secret@example.test/",
    "/relative/path",
  ])("rejects executable or non-HTTP frame URL %s", (url) => {
    expect(DisplayOnlyHttpUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe("read-only session and site schemas", () => {
  const capabilities = {
    state: "available" as const,
    canCaptureFrames: true,
    canSendReview: true,
    supportsInlinePng: true,
    supportsUploadRefs: true,
    maxFrames: 12,
    maxFrameBytes: 8 * 1024 * 1024,
    maxTotalBytes: 24 * 1024 * 1024,
    reason: null,
  };

  const association = {
    associationId: FRAME_ID,
    threadId: THREAD_ID,
    projectId: null,
    name: "Local preview",
    origin: "https://preview.example.test",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_001,
    capabilities,
    interactionModes: {
      selected: "none" as const,
      direct: {
        status: "unavailable" as const,
        reason: "same-host-storage-boundary" as const,
        detail: "Live preview requires a separately verified browser storage boundary.",
      },
      remoteBrowser: {
        status: "unavailable" as const,
        reason: "thread-tab-mapping-unproven" as const,
        detail: "Remote browser control is disabled until the exact task is mapped to one browser tab.",
        association: {
          status: "unavailable" as const,
          reason: "thread-tab-mapping-unproven" as const,
          detail: "Remote browser control is disabled until the exact task is mapped to one browser tab.",
        },
      },
    },
  };

  it("validates an explicit per-device site choice without treating it as authority", () => {
    expect(LocalSessionSiteSelectionSchema.safeParse({
      threadId: THREAD_ID,
      selectedSiteId: "dashboard-preview",
    }).success).toBe(true);
    expect(LocalSessionSiteSelectionSchema.safeParse({
      threadId: `local:${THREAD_ID}`,
      selectedSiteId: "dashboard-preview",
    }).success).toBe(false);
    expect(LocalSessionSiteSelectionSchema.safeParse({
      threadId: THREAD_ID,
      selectedSiteId: "Dashboard Preview",
    }).success).toBe(false);
  });

  it("validates a site association and rejects non-origin values", () => {
    expect(SiteAssociationSchema.safeParse(association).success).toBe(true);
    expect(SiteAssociationSchema.safeParse({ ...association, associationId: "dashboard_preview" }).success).toBe(true);
    expect(SiteAssociationSchema.safeParse({ ...association, associationId: "Dashboard Preview" }).success).toBe(false);
    expect(SiteAssociationSchema.safeParse({ ...association, origin: "https://preview.example.test/path" }).success).toBe(false);
  });

  it("keeps experimental browser proof metadata disabled without a typed transport", () => {
    const experimental = {
      ...association,
      interactionModes: {
        ...association.interactionModes,
        remoteBrowser: {
          status: "unavailable" as const,
          reason: "typed-remote-browser-transport-unavailable" as const,
          detail: "Remote Mac browser control is disabled because no safe typed transport is available.",
          association: {
            status: "experimental" as const,
            reason: "thread-tab-mapping-proven-for-session" as const,
            detail: "This session has an operator-approved exact task-to-tab proof.",
            proofId: "proof-session-17",
          },
        },
      },
    };
    expect(SiteAssociationSchema.safeParse(experimental).success).toBe(true);
    expect(SiteAssociationSchema.safeParse({
      ...experimental,
      interactionModes: {
        ...experimental.interactionModes,
        remoteBrowser: {
          ...experimental.interactionModes.remoteBrowser,
          reason: "thread-tab-mapping-unproven",
        },
      },
    }).success).toBe(false);
    expect(SiteAssociationSchema.safeParse({
      ...experimental,
      interactionModes: {
        ...experimental.interactionModes,
        remoteBrowser: {
          ...experimental.interactionModes.remoteBrowser,
          unexpectedTransport: true,
        },
      },
    }).success).toBe(false);
  });

  it("validates a unique all-session response", () => {
    const session = {
      threadId: THREAD_ID,
      title: "Review dashboard",
      nativeStatus: "idle",
      visualStatus: "idle" as const,
      activityLabel: null,
      activityAt: 1_750_000_000_000,
      projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I",
      projectLabel: "codex-pad",
      selected: false,
      microSlot: null,
      ownedByHost: true,
      siteAssociations: [association],
      siteAssociation: association,
    };
    expect(
      AllSessionsResponseSchema.safeParse({ sequence: 12, timestamp: 1_750_000_000_000, sessions: [session] }).success,
    ).toBe(true);
    expect(
      AllSessionsResponseSchema.safeParse({ sequence: 12, timestamp: 1_750_000_000_000, sessions: [session, session] }).success,
    ).toBe(false);
    const projectAssociation = { ...association, projectId: session.projectId };
    expect(AllSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      sessions: [{
        ...session,
        siteAssociations: [projectAssociation],
        siteAssociation: projectAssociation,
      }],
    }).success).toBe(true);
    expect(AllSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      sessions: [{
        ...session,
        siteAssociations: [{
          ...projectAssociation,
          projectId: "project:CTW3aFtA0PLAfVg9FMSzjZ6jsVRSm9_1ABm0ZZJxPdE",
        }],
        siteAssociation: {
          ...projectAssociation,
          projectId: "project:CTW3aFtA0PLAfVg9FMSzjZ6jsVRSm9_1ABm0ZZJxPdE",
        },
      }],
    }).success).toBe(false);

    const nativeSession = { ...session, microSlot: 0 };
    expect(NativeSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      registryGeneration: 3,
      sessions: [nativeSession],
    }).success).toBe(true);
    expect(NativeSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      registryGeneration: 3,
      sessions: [session],
    }).success).toBe(false);
    expect(NativeSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      registryGeneration: 3,
      sessions: [nativeSession, { ...nativeSession, threadId: "019f6de7-44c2-7fe2-9d17-9322c952e627" }],
    }).success).toBe(false);
  });

  it("requires a bounded deterministic multi-site list and an exact scalar projection", () => {
    const projectId = "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I";
    const exactSite = {
      ...association,
      associationId: "thread-site",
      name: "Zulu",
    };
    const projectSite = {
      ...association,
      associationId: "project-site",
      projectId,
      name: "Alpha",
    };
    const session = {
      threadId: THREAD_ID,
      title: "Two previews",
      nativeStatus: "idle",
      visualStatus: "idle" as const,
      activityLabel: null,
      activityAt: null,
      projectId,
      projectLabel: "codex-pad",
      selected: false,
      microSlot: null,
      ownedByHost: true,
      siteAssociations: [exactSite, projectSite],
      siteAssociation: exactSite,
    };
    const response = { sequence: 12, timestamp: 1_750_000_000_000, sessions: [session] };
    expect(AllSessionsResponseSchema.safeParse(response).success).toBe(true);
    expect(AllSessionsResponseSchema.safeParse({
      ...response,
      sessions: [{ ...session, siteAssociations: [projectSite, exactSite], siteAssociation: projectSite }],
    }).success).toBe(false);
    expect(AllSessionsResponseSchema.safeParse({
      ...response,
      sessions: [{ ...session, siteAssociation: projectSite }],
    }).success).toBe(false);
    expect(AllSessionsResponseSchema.safeParse({
      ...response,
      sessions: [{
        ...session,
        siteAssociations: [exactSite, { ...projectSite, associationId: exactSite.associationId }],
      }],
    }).success).toBe(false);
  });

  it("rejects absolute project paths", () => {
    const session = {
      threadId: THREAD_ID,
      title: "Review dashboard",
      nativeStatus: "idle",
      visualStatus: "idle" as const,
      activityLabel: null,
      activityAt: null,
      projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I",
      projectLabel: "/workspace/private-project",
      selected: false,
      microSlot: null,
      ownedByHost: true,
      siteAssociations: [],
      siteAssociation: null,
    };
    expect(
      AllSessionsResponseSchema.safeParse({ sequence: 12, timestamp: 1_750_000_000_000, sessions: [session] }).success,
    ).toBe(false);
  });

  it("requires a canonical opaque project id paired with its display label", () => {
    const session = {
      threadId: THREAD_ID,
      title: "Review dashboard",
      nativeStatus: "idle",
      visualStatus: "idle" as const,
      activityLabel: null,
      activityAt: null,
      projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I",
      projectLabel: "codex-pad",
      selected: false,
      microSlot: null,
      ownedByHost: true,
      siteAssociations: [],
      siteAssociation: null,
    };
    expect(AllSessionsResponseSchema.safeParse({ sequence: 12, timestamp: 1_750_000_000_000, sessions: [session] }).success).toBe(true);
    expect(AllSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      sessions: [{ ...session, projectId: "/workspace/private-project" }],
    }).success).toBe(false);
    expect(AllSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      sessions: [{ ...session, projectId: null }],
    }).success).toBe(false);
    expect(AllSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      sessions: [{ ...session, projectLabel: null }],
    }).success).toBe(false);
    expect(AllSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      sessions: [{ ...session, projectId: null, projectLabel: null }],
    }).success).toBe(true);
    const missingProjectId: Record<string, unknown> = { ...session };
    delete missingProjectId.projectId;
    expect(AllSessionsResponseSchema.safeParse({
      sequence: 12,
      timestamp: 1_750_000_000_000,
      sessions: [missingProjectId],
    }).success).toBe(false);
  });
});

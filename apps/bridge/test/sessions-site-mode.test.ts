import { describe, expect, it, vi } from "vitest";

import {
  TYPED_REMOTE_BROWSER_TRANSPORT_UNAVAILABLE_DETAIL,
  SessionsService,
  safeProjectId,
  safeProjectLabel,
  siteAssociationFromRecord,
  siteAssociationsForSession,
} from "../src/sessions.js";
import { projectCwdIdentifier } from "@codex-pad/site-review";
import type { SiteRecord } from "../src/site-registry.js";
import type { ThreadTransport } from "../src/thread-transport.js";
import type { BridgeStateService } from "../src/state.js";
import { defaultDataPaths } from "../src/paths.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

function record(remoteBrowser: SiteRecord["remoteBrowser"]): SiteRecord {
  return {
    associationId: "019f7ec2-68eb-7183-bb3a-0e67312a8bb1",
    targetKind: "thread",
    targetId: THREAD_ID,
    name: "Registered preview",
    loopbackUrl: "http://127.0.0.1:5173",
    publicOrigin: "https://mac.example.ts.net:5173",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_001,
    remoteBrowser,
  };
}

describe("site interaction mode projection", () => {
  it("keeps capture available but review degraded until delivery authority is verified", () => {
    const site = record({
      status: "unavailable",
      reason: "thread-tab-mapping-unproven",
      detail: "Exact task-to-tab mapping has not been proven for this session.",
    });

    expect(siteAssociationFromRecord(site, true, null)?.capabilities).toMatchObject({
      state: "degraded",
      canCaptureFrames: true,
      canSendReview: false,
      reason: expect.stringContaining("has not been verified"),
    });
    expect(siteAssociationFromRecord(site, true, null, true)?.capabilities).toMatchObject({
      state: "available",
      canCaptureFrames: true,
      canSendReview: true,
      reason: null,
    });
  });

  it("auto-selects Direct and preserves the exact unavailable association reason", () => {
    const detail = "Exact task-to-tab mapping has not been proven for this session.";
    const association = siteAssociationFromRecord(record({
      status: "unavailable",
      reason: "thread-tab-mapping-unproven",
      detail,
    }), true, null);

    expect(association?.interactionModes).toEqual({
      selected: "none",
      direct: {
        status: "unavailable",
        reason: "same-host-storage-boundary",
        detail: expect.stringContaining("storage boundary"),
      },
      remoteBrowser: {
        status: "unavailable",
        reason: "thread-tab-mapping-unproven",
        detail,
        association: {
          status: "unavailable",
          reason: "thread-tab-mapping-unproven",
          detail,
        },
      },
    });
  });

  it("exposes experimental proof metadata but keeps remote control disabled without a typed transport", () => {
    const association = siteAssociationFromRecord(record({
      status: "experimental",
      reason: "thread-tab-mapping-proven-for-session",
      detail: "Operator-approved mapping proof is current for this session.",
      proofId: "proof-session-17",
    }), true, null);

    expect(association?.interactionModes.remoteBrowser).toEqual({
      status: "unavailable",
      reason: "typed-remote-browser-transport-unavailable",
      detail: TYPED_REMOTE_BROWSER_TRANSPORT_UNAVAILABLE_DETAIL,
      association: {
        status: "experimental",
        reason: "thread-tab-mapping-proven-for-session",
        detail: "Operator-approved mapping proof is current for this session.",
        proofId: "proof-session-17",
      },
    });
  });
});

describe("session project projection", () => {
  it("pairs a display-only label with the existing stable opaque cwd identifier", () => {
    const cwd = "/workspace/work/../codex-pad";
    expect(safeProjectLabel(cwd)).toBe("codex-pad");
    expect(safeProjectId(cwd)).toBe(projectCwdIdentifier("/workspace/codex-pad"));
    expect(safeProjectId(cwd)).toMatch(/^project:[A-Za-z0-9_-]{43}$/u);
  });

  it("fails closed for absent or non-absolute cwd values", () => {
    expect(safeProjectId(null)).toBeNull();
    expect(safeProjectId("relative/private-project")).toBeNull();
    expect(safeProjectLabel("/workspace/private/project")).toBe("project");
  });

  it("projects a project registration only with an explicit session context and opaque project id", () => {
    const projectId = projectCwdIdentifier("/workspace/codex-pad");
    const projectRecord: SiteRecord = {
      ...record({
        status: "unavailable",
        reason: "thread-tab-mapping-unproven",
        detail: "Exact task-to-tab mapping has not been proven for this session.",
      }),
      targetKind: "project",
      targetId: projectId,
      name: "Registered project site",
    };

    expect(siteAssociationFromRecord(projectRecord, false, "Capture unavailable")).toBeNull();
    expect(
      siteAssociationFromRecord(projectRecord, false, "Capture unavailable", false, THREAD_ID),
    ).toMatchObject({
      threadId: THREAD_ID,
      projectId,
      name: "Registered project site",
    });
    expect(JSON.stringify(
      siteAssociationFromRecord(projectRecord, false, "Capture unavailable", false, THREAD_ID),
    )).not.toContain("/workspace/");
  });

  it("projects every matching site in deterministic thread-first order", () => {
    const projectId = projectCwdIdentifier("/workspace/codex-pad");
    const remoteBrowser = {
      status: "unavailable" as const,
      reason: "thread-tab-mapping-unproven" as const,
      detail: "Exact task-to-tab mapping has not been proven for this session.",
    };
    const base = record(remoteBrowser);
    const records: SiteRecord[] = [
      {
        ...base,
        associationId: "project-alpha",
        targetKind: "project",
        targetId: projectId,
        name: "Alpha",
      },
      {
        ...base,
        associationId: "thread-zulu",
        name: "Same label",
      },
      {
        ...base,
        associationId: "thread-alpha",
        name: "Same label",
      },
      {
        ...base,
        associationId: "other-thread",
        targetId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
        name: "Unrelated",
      },
    ];

    const associations = siteAssociationsForSession(
      records,
      THREAD_ID,
      projectId,
      false,
      "Capture unavailable",
    );
    expect(associations.map((association) => association.associationId)).toEqual([
      "thread-alpha",
      "thread-zulu",
      "project-alpha",
    ]);
    expect(associations.map((association) => association.threadId)).toEqual([
      THREAD_ID,
      THREAD_ID,
      THREAD_ID,
    ]);
  });
});

describe("capture context resolution", () => {
  function service(cwd: string | null): SessionsService {
    const transport = {
      listSessions: vi.fn(async () => [{
        threadId: THREAD_ID,
        title: "Preview",
        cwd,
        updatedAt: 1,
        status: "idle" as const,
      }]),
    } as unknown as ThreadTransport;
    return new SessionsService({
      transport,
      state: {
        current: () => ({ slots: [] }),
      } as unknown as BridgeStateService,
      paths: defaultDataPaths("/tmp/codex-pad-context-test"),
    });
  }

  it("derives only an opaque project id from the authoritative current session", async () => {
    await expect(service("/workspace/private/acme").resolveSiteLookupContext(THREAD_ID)).resolves.toEqual({
      threadId: THREAD_ID,
      projectId: projectCwdIdentifier("/workspace/private/acme"),
    });
  });

  it("fails closed for an unknown thread and omits unsafe project context", async () => {
    await expect(
      service("/workspace/private/acme").resolveSiteLookupContext(
        "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(service("relative/project").resolveSiteLookupContext(THREAD_ID)).resolves.toEqual({
      threadId: THREAD_ID,
    });
    await expect(service("/workspace/private/\u0001").resolveSiteLookupContext(THREAD_ID)).resolves.toEqual({
      threadId: THREAD_ID,
    });
  });
});

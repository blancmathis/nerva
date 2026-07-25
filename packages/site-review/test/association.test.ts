import { describe, expect, it } from "vitest";

import {
  normalizeExactThreadUuid,
  normalizeSiteAssociation,
  projectCwdIdentifier,
} from "../src/index.js";

const THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e626";

describe("site associations", () => {
  it("accepts one exact UUID and rejects prefixed identities", () => {
    expect(normalizeExactThreadUuid(THREAD_ID.toUpperCase())).toBe(THREAD_ID);
    expect(() => normalizeExactThreadUuid(`local:${THREAD_ID}`)).toThrow(/exact canonical UUID/u);
    expect(() => normalizeExactThreadUuid(`https://example.test/${THREAD_ID}`)).toThrow(
      /exact canonical UUID/u,
    );
  });

  it("derives a stable, opaque identifier from a normalized absolute cwd", () => {
    expect(projectCwdIdentifier("/workspace/work/../project")).toBe(
      projectCwdIdentifier("/workspace/project"),
    );
    expect(projectCwdIdentifier("/workspace/project")).toMatch(/^project:[A-Za-z0-9_-]{43}$/u);
    expect(() => projectCwdIdentifier("relative/project")).toThrow(/absolute/u);
  });

  it("normalizes either a thread or project association", () => {
    expect(normalizeSiteAssociation({ threadId: THREAD_ID })).toEqual({
      kind: "thread",
      threadId: THREAD_ID,
    });
    expect(normalizeSiteAssociation({ projectCwd: "/workspace/project" })).toMatchObject({
      kind: "project",
    });
  });
});

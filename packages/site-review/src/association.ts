import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";

import { SiteReviewError } from "./errors.js";

const EXACT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECT_ID = /^project:[A-Za-z0-9_-]{43}$/u;

export interface ThreadSiteAssociation {
  kind: "thread";
  threadId: string;
}

export interface ProjectSiteAssociation {
  kind: "project";
  projectCwdId: string;
}

export type SiteAssociation = ThreadSiteAssociation | ProjectSiteAssociation;

export type SiteAssociationInput =
  | { threadId: string; projectCwd?: never }
  | { projectCwd: string; threadId?: never };

export function normalizeExactThreadUuid(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || !EXACT_UUID.test(value)) {
    throw new SiteReviewError(
      "INVALID_ASSOCIATION",
      "Thread association must be one exact canonical UUID, without a prefix or URL",
    );
  }
  return value.toLowerCase();
}

export function normalizeProjectCwd(cwd: string): string {
  if (
    typeof cwd !== "string" ||
    cwd !== cwd.trim() ||
    cwd.includes("\0") ||
    !isAbsolute(cwd)
  ) {
    throw new SiteReviewError("INVALID_ASSOCIATION", "Project cwd must be an absolute local path");
  }
  return normalize(resolve(cwd)).normalize("NFC");
}

export function projectCwdIdentifier(cwd: string): string {
  const normalized = normalizeProjectCwd(cwd);
  return `project:${createHash("sha256").update(normalized, "utf8").digest("base64url")}`;
}

export function normalizeProjectCwdIdentifier(value: string): string {
  if (!PROJECT_ID.test(value)) {
    throw new SiteReviewError("INVALID_ASSOCIATION", "Invalid project cwd identifier");
  }
  return value;
}

export function normalizeSiteAssociation(input: SiteAssociationInput): SiteAssociation {
  if ("threadId" in input && typeof input.threadId === "string") {
    return { kind: "thread", threadId: normalizeExactThreadUuid(input.threadId) };
  }
  if ("projectCwd" in input && typeof input.projectCwd === "string") {
    return { kind: "project", projectCwdId: projectCwdIdentifier(input.projectCwd) };
  }
  throw new SiteReviewError("INVALID_ASSOCIATION", "Choose exactly one thread or project association");
}

export function associationKey(association: SiteAssociation): string {
  return association.kind === "thread"
    ? `thread:${normalizeExactThreadUuid(association.threadId)}`
    : normalizeProjectCwdIdentifier(association.projectCwdId);
}

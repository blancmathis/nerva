import type { SiteAssociation } from "./association.js";

export const SITE_RECORD_VERSION = 1 as const;
/**
 * Bound one exact thread/project association so a corrupt or adversarial
 * registry cannot turn a session response into an unbounded payload.
 * A session can see one thread scope and one project scope, hence the
 * corresponding context limit is twice this value.
 */
export const MAX_SITE_RECORDS_PER_ASSOCIATION = 32 as const;
export const MAX_SITE_RECORDS_PER_CONTEXT = 64 as const;

export interface RemoteBrowserUnavailable {
  status: "unavailable";
  reason: "thread-tab-mapping-unproven";
  detail: string;
}

export interface RemoteBrowserExperimental {
  status: "experimental";
  reason: "thread-tab-mapping-proven-for-session";
  detail: string;
  proofId: string;
}

export type RemoteBrowserAssociation = RemoteBrowserUnavailable | RemoteBrowserExperimental;

export function unavailableRemoteBrowserAssociation(): RemoteBrowserUnavailable {
  return {
    status: "unavailable",
    reason: "thread-tab-mapping-unproven",
    detail:
      "Remote browser control is disabled until this Codex thread is reliably mapped to one browser tab.",
  };
}

export interface ApprovedSiteRecord {
  version: typeof SITE_RECORD_VERSION;
  siteId: string;
  label: string;
  association: SiteAssociation;
  /** Bridge-internal source origin used for local capture. Never expose it to the iPad. */
  origin: string;
  /** HTTPS MagicDNS site origin. Null means direct iPad access is not configured. */
  publicOrigin: string | null;
  approvedAt: string;
  updatedAt: string;
  remoteBrowser: RemoteBrowserAssociation;
}

export interface ApproveSiteInput {
  siteId?: string;
  label: string;
  origin: string;
  publicOrigin?: string;
  association:
    | { threadId: string; projectCwd?: never }
    | { projectCwd: string; threadId?: never };
}

export interface SiteLookupContext {
  threadId?: string;
  /** Opaque project identity derived by trusted bridge code, never accepted from the browser. */
  projectId?: string;
  projectCwd?: string;
}

export type DirectModeMetadata =
  | {
      mode: "direct";
      access: "tailscale-serve-required";
      publicOrigin: string | null;
      localPort: number;
      tailscaleServe: {
        targetOrigin: string;
        argv: readonly ["tailscale", "serve", "--bg", `--https=${number}`, string];
        command: string;
      };
    }
  | {
      mode: "direct";
      access: "private-https-origin";
      publicOrigin: string;
      localPort: null;
      tailscaleServe: null;
    };

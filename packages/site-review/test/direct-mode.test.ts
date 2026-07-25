import { describe, expect, it } from "vitest";

import {
  SITE_RECORD_VERSION,
  directModeMetadata,
  unavailableRemoteBrowserAssociation,
  type ApprovedSiteRecord,
} from "../src/index.js";

function record(origin: string, publicOrigin: string | null): ApprovedSiteRecord {
  return {
    version: SITE_RECORD_VERSION,
    siteId: "dashboard",
    label: "Dashboard",
    association: { kind: "project", projectCwdId: `project:${"A".repeat(43)}` },
    origin,
    publicOrigin,
    approvedAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    remoteBrowser: unavailableRemoteBrowserAssociation(),
  };
}

describe("direct-mode metadata", () => {
  it("suggests one exact non-Funnel, non-reset Serve command without executing it", () => {
    expect(
      directModeMetadata(
        record(
          "http://127.0.0.1:5173",
          "https://codex-mac.example-tail.ts.net:5173",
        ),
      ),
    ).toEqual({
      mode: "direct",
      access: "tailscale-serve-required",
      publicOrigin: "https://codex-mac.example-tail.ts.net:5173",
      localPort: 5173,
      tailscaleServe: {
        targetOrigin: "http://127.0.0.1:5173",
        argv: [
          "tailscale",
          "serve",
          "--bg",
          "--https=5173",
          "http://127.0.0.1:5173",
        ],
        command:
          "tailscale serve --bg --https=5173 http://127.0.0.1:5173",
      },
    });
  });

  it("marks an approved private MagicDNS site as directly reachable", () => {
    expect(
      directModeMetadata(
        record(
          "https://codex-mac.example-tail.ts.net:5173",
          "https://codex-mac.example-tail.ts.net:5173",
        ),
      ),
    ).toMatchObject({
      access: "private-https-origin",
      publicOrigin: "https://codex-mac.example-tail.ts.net:5173",
      localPort: null,
      tailscaleServe: null,
    });
  });

  it("never prints an unsupported IPv6 Serve proxy command", () => {
    expect(() =>
      directModeMetadata(
        record("http://[::1]:3000", "https://codex-mac.example-tail.ts.net:3000"),
      ),
    ).toThrow(/IPv6 loopback.*127\.0\.0\.1/u);
  });
});

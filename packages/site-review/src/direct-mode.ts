import { SiteReviewError } from "./errors.js";
import { assertUsableSitePort, isLoopbackSiteOrigin } from "./origin.js";
import type { ApprovedSiteRecord, DirectModeMetadata } from "./types.js";

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:=?~-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function directModeMetadata(record: ApprovedSiteRecord): DirectModeMetadata {
  return directModeMetadataFromOrigins(record.origin, record.publicOrigin);
}

export function directModeMetadataFromOrigins(
  sourceOrigin: string,
  publicOrigin: string | null,
): DirectModeMetadata {
  const url = new URL(sourceOrigin);
  if (!isLoopbackSiteOrigin(sourceOrigin)) {
    return {
      mode: "direct",
      access: "private-https-origin",
      publicOrigin: publicOrigin ?? sourceOrigin,
      localPort: null,
      tailscaleServe: null,
    };
  }

  if (url.hostname.toLowerCase() === "[::1]" || url.hostname.toLowerCase() === "::1") {
    throw new SiteReviewError(
      "INVALID_ORIGIN",
      "IPv6 loopback cannot be proxied by Tailscale Serve; register http://127.0.0.1 instead",
    );
  }

  const localPort = assertUsableSitePort(Number(url.port || "80"));
  const targetOrigin = `http://127.0.0.1:${localPort}`;
  const httpsFlag = `--https=${localPort}` as const;
  const argv = ["tailscale", "serve", "--bg", httpsFlag, targetOrigin] as const;
  return {
    mode: "direct",
    access: "tailscale-serve-required",
    publicOrigin,
    localPort,
    tailscaleServe: {
      targetOrigin,
      argv,
      command: argv.map(shellWord).join(" "),
    },
  };
}

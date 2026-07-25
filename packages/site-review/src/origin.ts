import { SiteReviewError } from "./errors.js";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const RESERVED_SITE_PORTS = new Set([443, 8787]);

export interface SiteOriginPolicyInput {
  allowedLoopbackPorts: readonly number[];
  allowedMagicDnsOrigins?: readonly string[];
}

export interface SiteOriginPolicy {
  readonly allowedLoopbackPorts: ReadonlySet<number>;
  readonly allowedMagicDnsOrigins: ReadonlySet<string>;
}

function invalidOrigin(message: string): never {
  throw new SiteReviewError("INVALID_ORIGIN", message);
}

function parseStrictUrl(input: string): URL {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim() ||
    /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    invalidOrigin("Site origin must be a non-empty URL without surrounding whitespace or controls");
  }
  try {
    return new URL(input);
  } catch {
    return invalidOrigin("Site origin is not a valid absolute URL");
  }
}

function rawHostname(input: string): string {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(input)?.[1];
  if (authority === undefined) return "";
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) {
    const closingBracket = hostAndPort.indexOf("]");
    return closingBracket === -1 ? "" : hostAndPort.slice(0, closingBracket + 1).toLowerCase();
  }
  return (hostAndPort.split(":", 1)[0] ?? "").toLowerCase();
}

function assertOriginOnly(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    invalidOrigin("Credentials are forbidden in approved site origins");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    invalidOrigin("Register an origin only; capture paths are selected separately");
  }
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function assertMagicDnsHttps(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !hostname.endsWith(".ts.net") || hostname === "ts.net") {
    invalidOrigin("Expected an explicit private HTTPS MagicDNS .ts.net origin");
  }
}

export function assertUsableSitePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalidOrigin(`Invalid site listener port: ${String(port)}`);
  }
  if (RESERVED_SITE_PORTS.has(port)) {
    invalidOrigin(
      `Port ${port} is reserved for the Codex Pad bridge and cannot be used as a site listener`,
    );
  }
  return port;
}

export function siteOriginPort(input: string): number {
  const url = parseStrictUrl(input);
  assertOriginOnly(url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalidOrigin("Site origins must use HTTP or HTTPS");
  }
  return assertUsableSitePort(effectivePort(url));
}

export function canonicalizeBridgeMagicDnsOrigin(input: string): string {
  const url = parseStrictUrl(input);
  assertOriginOnly(url);
  assertMagicDnsHttps(url);
  if (effectivePort(url) !== 443) {
    invalidOrigin("The Codex Pad bridge MagicDNS origin must use HTTPS port 443");
  }
  return url.origin.toLowerCase();
}

export function canonicalizeSitePublicOrigin(input: string, expectedPort?: number): string {
  const url = parseStrictUrl(input);
  assertOriginOnly(url);
  assertMagicDnsHttps(url);
  const port = assertUsableSitePort(effectivePort(url));
  if (url.port === "") {
    invalidOrigin("A site public origin must include its explicit non-bridge HTTPS port");
  }
  if (expectedPort !== undefined && port !== assertUsableSitePort(expectedPort)) {
    invalidOrigin(`Site public origin must use the matching local port ${expectedPort}`);
  }
  return url.origin.toLowerCase();
}

export function deriveSitePublicOrigin(bridgeMagicDnsOrigin: string, sitePort: number): string {
  const bridgeOrigin = new URL(canonicalizeBridgeMagicDnsOrigin(bridgeMagicDnsOrigin));
  const port = assertUsableSitePort(sitePort);
  return canonicalizeSitePublicOrigin(`https://${bridgeOrigin.hostname}:${port}`, port);
}

export function createSiteOriginPolicy(input: SiteOriginPolicyInput): SiteOriginPolicy {
  const ports = new Set<number>();
  for (const port of input.allowedLoopbackPorts) {
    ports.add(assertUsableSitePort(port));
  }
  const magicDnsOrigins = new Set<string>();
  for (const origin of input.allowedMagicDnsOrigins ?? []) {
    magicDnsOrigins.add(canonicalizeSitePublicOrigin(origin));
  }
  return {
    allowedLoopbackPorts: ports,
    allowedMagicDnsOrigins: magicDnsOrigins,
  };
}

export function isLoopbackSiteOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function canonicalizeApprovedSiteOrigin(input: string, policy: SiteOriginPolicy): string {
  const url = parseStrictUrl(input);
  assertOriginOnly(url);
  const hostname = url.hostname.toLowerCase();
  const sourceHostname = rawHostname(input);
  const port = effectivePort(url);

  if (url.protocol === "http:" && (hostname === "[::1]" || hostname === "::1")) {
    invalidOrigin(
      "IPv6 loopback is not supported by Tailscale Serve proxies; register an HTTP 127.0.0.1 origin",
    );
  }

  if (
    url.protocol === "http:" &&
    LOOPBACK_HOSTNAMES.has(hostname) &&
    LOOPBACK_HOSTNAMES.has(sourceHostname)
  ) {
    if (!policy.allowedLoopbackPorts.has(port)) {
      invalidOrigin(`Loopback port ${port} is not in the explicit site-review allowlist`);
    }
    return url.origin.toLowerCase();
  }

  const candidate = url.origin.toLowerCase();
  if (policy.allowedMagicDnsOrigins.has(candidate)) {
    // Re-validate even though the allowlist is normalized at construction time.
    return canonicalizeSitePublicOrigin(candidate);
  }

  return invalidOrigin(
    "Only allowlisted loopback HTTP origins or explicitly allowlisted private HTTPS MagicDNS origins are supported",
  );
}

export function assertUrlWithinOrigin(input: string, approvedOrigin: string): URL {
  const url = parseStrictUrl(input);
  if (url.username !== "" || url.password !== "") {
    invalidOrigin("Credentials are forbidden in capture URLs");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalidOrigin(`Blocked capture URL protocol: ${url.protocol}`);
  }
  if (url.origin.toLowerCase() !== approvedOrigin.toLowerCase()) {
    invalidOrigin("Capture navigation crossed the approved site origin");
  }
  return url;
}

export function resolveApprovedCapturePath(approvedOrigin: string, path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path !== path.trim() ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new SiteReviewError(
      "INVALID_CAPTURE_PATH",
      "Capture path must be one root-relative path on the approved origin",
    );
  }
  let resolved: URL;
  try {
    resolved = new URL(path, approvedOrigin);
  } catch {
    throw new SiteReviewError("INVALID_CAPTURE_PATH", "Capture path is not a valid relative URL");
  }
  try {
    assertUrlWithinOrigin(resolved.href, approvedOrigin);
  } catch (error) {
    if (error instanceof SiteReviewError) {
      throw new SiteReviewError("INVALID_CAPTURE_PATH", error.message);
    }
    throw error;
  }
  return resolved.href;
}

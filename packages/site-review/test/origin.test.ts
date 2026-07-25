import { describe, expect, it } from "vitest";

import {
  SiteReviewError,
  assertUrlWithinOrigin,
  canonicalizeApprovedSiteOrigin,
  canonicalizeBridgeMagicDnsOrigin,
  canonicalizeSitePublicOrigin,
  createSiteOriginPolicy,
  deriveSitePublicOrigin,
  resolveApprovedCapturePath,
} from "../src/index.js";

const policy = createSiteOriginPolicy({
  allowedLoopbackPorts: [3000, 5173],
  allowedMagicDnsOrigins: ["https://codex-mac.example-tail.ts.net:5173"],
});

describe("approved site origins", () => {
  it.each([
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://LOCALHOST:5173", "http://localhost:5173"],
    [
      "https://codex-mac.example-tail.ts.net:5173",
      "https://codex-mac.example-tail.ts.net:5173",
    ],
  ])("accepts the explicit origin %s", (input, expected) => {
    expect(canonicalizeApprovedSiteOrigin(input, policy)).toBe(expected);
  });

  it.each([
    "http://127.0.0.1:8080",
    "http://127.0.0.2:3000",
    "http://127.1:3000",
    "http://2130706433:3000",
    "http://0.0.0.0:3000",
    "http://192.168.1.20:3000",
    "http://169.254.169.254:3000",
    "http://[::1]:3000",
    "https://localhost:3000",
    "https://public.example.com",
    "https://other.example-tail.ts.net:5173",
    "file:///etc/passwd",
    "data:text/plain,hello",
    "javascript:alert(1)",
  ])("rejects an unapproved or SSRF-capable origin: %s", (input) => {
    expect(() => canonicalizeApprovedSiteOrigin(input, policy)).toThrowError(
      expect.objectContaining({ code: "INVALID_ORIGIN" }),
    );
  });

  it.each([
    "http://user@localhost:3000",
    "http://user:secret@127.0.0.1:3000",
    "https://user@codex-mac.example-tail.ts.net:5173",
  ])("rejects URL credentials: %s", (input) => {
    expect(() => canonicalizeApprovedSiteOrigin(input, policy)).toThrow(/Credentials/u);
  });

  it("requires a pure origin at approval time", () => {
    expect(() => canonicalizeApprovedSiteOrigin("http://localhost:3000/admin", policy)).toThrow(
      /origin only/u,
    );
    expect(() => canonicalizeApprovedSiteOrigin("http://localhost:3000/?token=x", policy)).toThrow(
      /origin only/u,
    );
  });

  it("reserves bridge ports and requires a distinct explicit site listener", () => {
    expect(() => createSiteOriginPolicy({ allowedLoopbackPorts: [443] })).toThrow(/reserved/u);
    expect(() => createSiteOriginPolicy({ allowedLoopbackPorts: [8787] })).toThrow(/reserved/u);
    expect(() => canonicalizeSitePublicOrigin("https://codex-mac.example-tail.ts.net")).toThrow(
      /reserved|explicit/u,
    );
    expect(() =>
      canonicalizeSitePublicOrigin("https://codex-mac.example-tail.ts.net:8787"),
    ).toThrow(/reserved/u);
  });

  it("rejects IPv6 loopback because current Serve proxy targets require 127.0.0.1", () => {
    expect(() => canonicalizeApprovedSiteOrigin("http://[::1]:3000", policy)).toThrow(
      /IPv6 loopback.*127\.0\.0\.1/u,
    );
  });

  it("derives a matching per-site MagicDNS origin from the bridge hostname", () => {
    expect(canonicalizeBridgeMagicDnsOrigin("https://codex-mac.example-tail.ts.net")).toBe(
      "https://codex-mac.example-tail.ts.net",
    );
    expect(deriveSitePublicOrigin("https://codex-mac.example-tail.ts.net", 5173)).toBe(
      "https://codex-mac.example-tail.ts.net:5173",
    );
    expect(
      canonicalizeSitePublicOrigin("https://codex-mac.example-tail.ts.net:3000", 3000),
    ).toBe("https://codex-mac.example-tail.ts.net:3000");
    expect(() =>
      canonicalizeSitePublicOrigin("https://codex-mac.example-tail.ts.net:3001", 3000),
    ).toThrow(/matching/u);
  });
});

describe("capture paths", () => {
  const origin = "http://localhost:3000";

  it("resolves a root-relative page without changing origin", () => {
    expect(resolveApprovedCapturePath(origin, "/settings/profile?tab=photo#crop")).toBe(
      "http://localhost:3000/settings/profile?tab=photo#crop",
    );
  });

  it.each([
    "//evil.example/path",
    "https://evil.example/path",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "/\\evil.example/path",
    "relative/path",
  ])("blocks an unsafe capture path: %s", (path) => {
    expect(() => resolveApprovedCapturePath(origin, path)).toThrowError(SiteReviewError);
  });

  it("rejects a cross-origin final redirect", () => {
    expect(() => assertUrlWithinOrigin("http://127.0.0.1:3000/", origin)).toThrow(
      /crossed/u,
    );
    expect(assertUrlWithinOrigin("http://localhost:3000/next", origin).href).toBe(
      "http://localhost:3000/next",
    );
  });
});

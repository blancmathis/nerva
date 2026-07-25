import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialCapacityError,
  CredentialStore,
  legacyCookieClearHeaders,
  readBearerToken,
  readWebSocketTicketProtocol,
  WebSocketTicketStore,
  WEB_SOCKET_PROTOCOL,
  webSocketTicketProtocol,
} from "../src/auth.js";
import { PairingStore, pairingNonceFromUrl, renderPairingQr } from "../src/pairing.js";
import { defaultDataPaths } from "../src/paths.js";

const temporaryRoots: string[] = [];

async function temporaryPaths() {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-auth-test-"));
  temporaryRoots.push(root);
  return defaultDataPaths(root);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CredentialStore", () => {
  it("stores only hashes in a mode-0600 file and verifies opaque bearers", async () => {
    const paths = await temporaryPaths();
    const store = new CredentialStore({ paths });
    const issued = await store.issue("Mathis’s iPad");

    expect(await store.verify(issued.bearerToken)).toEqual({
      id: issued.device.id,
      name: "Mathis’s iPad",
    });
    const persisted = await readFile(paths.credentials, "utf8");
    expect(persisted).not.toContain(issued.bearerToken);
    expect((await stat(paths.credentials)).mode & 0o777).toBe(0o600);
  });

  it("serializes mutations from independent store instances without losing devices", async () => {
    const paths = await temporaryPaths();
    const first = new CredentialStore({ paths });
    const second = new CredentialStore({ paths });
    const [one, two] = await Promise.all([first.issue("One"), second.issue("Two")]);
    expect((await first.list()).map((device) => device.id).sort()).toEqual([one.device.id, two.device.id].sort());

    await second.revoke(one.device.id);
    expect(await first.verify(one.bearerToken)).toBeNull();
    expect(await first.verify(two.bearerToken)).not.toBeNull();
  });

  it("parses only bounded bearer headers and emits deletion-only legacy cookie migration headers", () => {
    const token = "a".repeat(43);
    expect(readBearerToken(`Bearer ${token}`)).toBe(token);
    expect(readBearerToken(`Basic ${token}`)).toBeUndefined();
    expect(readBearerToken(`Bearer ${token}.extra`)).toBeUndefined();
    const headers = legacyCookieClearHeaders(true);
    expect(headers).toEqual(expect.arrayContaining([
      expect.stringContaining("__Host-codex_pad_device=;"),
      expect.stringContaining("codex_pad_unsafe_device=;"),
    ]));
    expect(headers.join("\n")).toContain("Max-Age=0");
    expect(headers.join("\n")).not.toContain(token);
  });

  it("invalidates legacy cookie-era hashes instead of accepting them as version 2 bearers", async () => {
    const paths = await temporaryPaths();
    const store = new CredentialStore({ paths });
    const legacy = await store.issue("Legacy iPad");
    const file = JSON.parse(await readFile(paths.credentials, "utf8")) as { version: number };
    file.version = 1;
    await writeFile(paths.credentials, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    expect(await store.verify(legacy.bearerToken)).toBeNull();
    const current = await store.issue("Current iPad");
    expect(await store.verify(current.bearerToken)).toMatchObject({ name: "Current iPad" });
    expect(JSON.parse(await readFile(paths.credentials, "utf8"))).toMatchObject({ version: 2 });
  });

  it("reclaims only revoked records at the lifetime cap", async () => {
    const paths = await temporaryPaths();
    const createdAt = "2026-07-20T10:00:00.000Z";
    const devices = Array.from({ length: 128 }, (_, index) => ({
      id: randomUUID(),
      name: `iPad ${index}`,
      tokenHash: createHash("sha256").update(`unexposed-${index}`, "utf8").digest("hex"),
      createdAt,
      revokedAt: null,
    }));
    await mkdir(paths.security, { recursive: true, mode: 0o700 });
    await writeFile(paths.credentials, `${JSON.stringify({ version: 2, devices })}\n`, { mode: 0o600 });
    const store = new CredentialStore({ paths });
    await expect(store.issue("Overflow")).rejects.toBeInstanceOf(CredentialCapacityError);
    await store.revoke(devices[0]!.id);
    await expect(store.issue("Replacement")).resolves.toMatchObject({ device: { name: "Replacement" } });
    expect(await store.list()).toHaveLength(128);
  });
});

describe("WebSocketTicketStore", () => {
  it("binds a short-lived ticket to one origin and consumes it exactly once", () => {
    const store = new WebSocketTicketStore();
    const device = { id: "019f7ec2-68eb-7183-bb3a-0e67312a8bc0", name: "iPad" };
    const { ticket } = store.issue(device, "https://pad.example.test", 1_000);
    const header = `${WEB_SOCKET_PROTOCOL}, ${webSocketTicketProtocol(ticket)}`;
    expect(readWebSocketTicketProtocol(header)).toBe(ticket);
    expect(store.consume(ticket, "https://other.example.test", 1_001)).toBeNull();
    expect(store.consume(ticket, "https://pad.example.test", 1_002)).toBeNull();

    const fresh = store.issue(device, "https://pad.example.test", 2_000).ticket;
    expect(store.consume(fresh, "https://pad.example.test", 2_001)).toEqual(device);
    expect(store.consume(fresh, "https://pad.example.test", 2_002)).toBeNull();

    const expired = store.issue(device, "https://pad.example.test", 3_000).ticket;
    expect(store.consume(expired, "https://pad.example.test", 33_000)).toBeNull();
  });
});

describe("PairingStore", () => {
  it("renders an actual QR and consumes a five-minute fragment invitation exactly once", async () => {
    const paths = await temporaryPaths();
    const store = new PairingStore({ paths });
    const now = new Date("2026-07-20T10:00:00.000Z");
    const info = await store.rotate({ publicOrigin: "https://pad.example.test", now });
    const url = new URL(info.qrPayload);
    expect(url.origin).toBe("https://pad.example.test");
    expect(url.search).toBe("");
    expect([...new URLSearchParams(url.hash.slice(1)).keys()]).toEqual(["pair"]);
    expect(pairingNonceFromUrl(info.qrPayload)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await renderPairingQr(info, { type: "svg" })).toContain("<svg");

    const nonce = pairingNonceFromUrl(info.qrPayload) ?? "";
    expect((await store.consume(nonce, url.origin, new Date(now.getTime() + 299_999))).ok).toBe(true);
    expect(await store.consume(nonce, url.origin, new Date(now.getTime() + 300_000))).toEqual({ ok: false, reason: "consumed" });
  });

  it("rejects expired and non-HTTPS pairing payloads", async () => {
    const paths = await temporaryPaths();
    const store = new PairingStore({ paths });
    await expect(store.rotate({ publicOrigin: "http://pad.example.test" })).rejects.toThrow(/HTTPS/u);
    const now = new Date("2026-07-20T10:00:00.000Z");
    const info = await store.rotate({ publicOrigin: "https://pad.example.test", now });
    const nonce = pairingNonceFromUrl(info.qrPayload) ?? "";
    expect(await store.consume(nonce, "https://pad.example.test", new Date(now.getTime() + 300_000))).toEqual({ ok: false, reason: "expired" });
  });

  it("does not consume a nonce from another allowed origin or when credential issuance fails", async () => {
    const paths = await temporaryPaths();
    const store = new PairingStore({ paths });
    const info = await store.rotate({ publicOrigin: "https://pad-a.example.test" });
    const nonce = pairingNonceFromUrl(info.qrPayload) ?? "";
    await expect(store.consume(nonce, "https://pad-b.example.test")).resolves.toEqual({ ok: false, reason: "origin" });
    await expect(store.redeem(
      nonce,
      "https://pad-a.example.test",
      async () => { throw new Error("credential write failed"); },
      async () => undefined,
    )).rejects.toThrow(/credential write failed/u);
    await expect(store.consume(nonce, "https://pad-a.example.test")).resolves.toMatchObject({ ok: true });
  });

  it("allows an HTTP QR only behind the explicit unsafe-development flag and a concrete non-loopback IP", async () => {
    const paths = await temporaryPaths();
    const store = new PairingStore({ paths });
    const info = await store.rotate({
      publicOrigin: "http://192.0.2.10:8787",
      allowInsecureHttp: true,
    });
    expect(info.insecureDevelopment).toBe(true);
    expect(info.qrPayload).toMatch(/^http:\/\/192\.0\.2\.10:8787\/pair#pair=/u);
    expect(await renderPairingQr(info, { type: "svg" })).toContain("<svg");
    await expect(store.rotate({
      publicOrigin: "http://devbox.example:8787",
      allowInsecureHttp: true,
    })).rejects.toThrow(/concrete non-loopback IP/u);
  });
});

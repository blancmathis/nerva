import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { probeRuntimeCompatibility } from "./runtime-compatibility.js";

const METHODS = [
  "thread/list",
  "model/list",
  "skills/list",
  "account/rateLimits/read",
  "thread/settings/update",
  "turn/start",
  "turn/steer",
  "thread/start",
  "thread/fork",
];

async function fixture(methods = METHODS, sameVersion = false) {
  const root = await mkdtemp(join(tmpdir(), "nerva-compatibility-"));
  const desktop = join(root, "desktop-codex");
  const daemon = join(root, "daemon-codex");
  await writeFile(desktop, "desktop");
  await writeFile(daemon, "daemon");
  await chmod(desktop, 0o700);
  await chmod(daemon, 0o700);
  const cacheRoot = join(root, "cache");
  for (const [index, binary] of [desktop, daemon].entries()) {
    const version = sameVersion ? "codex-cli-2" : index === 0 ? "codex-cli-2" : "codex-cli-1";
    const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
    const directory = join(cacheRoot, "app-server-schemas", `${version}--${binarySha256.slice(0, 16)}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const schema = {
      oneOf: methods.map((method) => ({
        type: "object",
        required: ["id", "method", "params"],
        properties: {
          id: { type: ["number", "string"] },
          method: { const: method },
          params: {},
        },
      })),
    };
    const schemaContents = Buffer.from(JSON.stringify(schema));
    await writeFile(join(directory, "ClientRequest.json"), schemaContents);
    const digest = createHash("sha256")
      .update("ClientRequest.json")
      .update("\0")
      .update(schemaContents)
      .update("\0")
      .digest("hex");
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      formatVersion: 1,
      codexBinary: binary,
      codexBinarySha256: binarySha256,
      codexVersion: version.replaceAll("-", " "),
      schemaSha256: digest,
      files: ["ClientRequest.json"],
    }));
  }
  return {
    root,
    desktop,
    daemon,
    cacheRoot,
    attestationPath: join(root, "security", "protocol-compatibility-attestation.json"),
  };
}

function connection(call: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => ({
  data: method === "thread/list" || method === "model/list" ? [] : undefined,
}))) {
  return {
    client: {
      serverInfo: { userAgent: "Codex Desktop/1 (codex-pad; 0.1.0)" },
      call,
      close: vi.fn(async () => undefined),
    },
    writeAuthority: {},
  };
}

describe("runtime compatibility probe", () => {
  it("attests different versions when schemas and structural live reads are compatible", async () => {
    const test = await fixture();
    const live = connection();
    const connect = vi.fn(async () => live as never);
    const result = await probeRuntimeCompatibility({
      desktopBinaryPath: test.desktop,
      desktopVersion: "codex cli 2",
      daemonBinaryPath: test.daemon,
      daemonVersion: "codex cli 1",
      socketPath: join(test.root, "managed.sock"),
      cacheRoot: test.cacheRoot,
      attestationPath: test.attestationPath,
      connect,
    });

    expect(result.state).toBe("compatible");
    expect(result.source).toBe("live");
    expect(result.capabilities.every((capability) => capability.state === "available")).toBe(true);
    expect(live.client.call).toHaveBeenCalledTimes(2);

    const cachedLive = connection();
    const cached = await probeRuntimeCompatibility({
      desktopBinaryPath: test.desktop,
      desktopVersion: "codex cli 2",
      daemonBinaryPath: test.daemon,
      daemonVersion: "codex cli 1",
      socketPath: join(test.root, "managed.sock"),
      cacheRoot: test.cacheRoot,
      attestationPath: test.attestationPath,
      connect: vi.fn(async () => cachedLive as never),
    });
    expect(cached.source).toBe("cache");
    expect(cachedLive.client.call).not.toHaveBeenCalled();
  });

  it("keeps distinct schema caches for equal-version Desktop and daemon binaries", async () => {
    const test = await fixture(METHODS, true);
    const result = await probeRuntimeCompatibility({
      desktopBinaryPath: test.desktop,
      desktopVersion: "codex cli 2",
      daemonBinaryPath: test.daemon,
      daemonVersion: "codex cli 2",
      socketPath: join(test.root, "managed.sock"),
      cacheRoot: test.cacheRoot,
      attestationPath: test.attestationPath,
      connect: vi.fn(async () => connection() as never),
    });
    expect(result.state).toBe("compatible");
    expect(result.desktopSchemaSha256).toBeDefined();
    expect(result.daemonSchemaSha256).toBeDefined();
  });

  it("fails only the affected capability when a schema method disappears", async () => {
    const test = await fixture(METHODS.filter((method) => method !== "skills/list"));
    const result = await probeRuntimeCompatibility({
      desktopBinaryPath: test.desktop,
      desktopVersion: "codex cli 2",
      daemonBinaryPath: test.daemon,
      daemonVersion: "codex cli 1",
      socketPath: join(test.root, "managed.sock"),
      cacheRoot: test.cacheRoot,
      attestationPath: test.attestationPath,
      connect: vi.fn(async () => connection() as never),
    });
    expect(result.state).toBe("limited");
    expect(result.capabilities.find((capability) => capability.id === "skills")?.state).toBe("unavailable");
    expect(result.capabilities.find((capability) => capability.id === "sessions")?.state).toBe("available");
  });

  it("fails closed when a structural live response is malformed", async () => {
    const test = await fixture();
    const malformed = connection(vi.fn(async () => ({ unexpected: true })));
    const result = await probeRuntimeCompatibility({
      desktopBinaryPath: test.desktop,
      desktopVersion: "codex cli 2",
      daemonBinaryPath: test.daemon,
      daemonVersion: "codex cli 1",
      socketPath: join(test.root, "managed.sock"),
      cacheRoot: test.cacheRoot,
      attestationPath: test.attestationPath,
      connect: vi.fn(async () => malformed as never),
    });
    expect(result.state).toBe("unavailable");
    expect(result.capabilities.find((capability) => capability.id === "sessions")?.state).toBe("unavailable");
  });
});

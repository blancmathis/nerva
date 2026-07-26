import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupCodexPad } from "../src/setup.js";

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-setup-test-"));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  return home;
}

describe("setupCodexPad", () => {
  it("creates only private Codex Pad state and is idempotent", async () => {
    const homeDirectory = await temporaryHome();
    const first = await setupCodexPad({ homeDirectory, platform: "darwin" });
    const second = await setupCodexPad({ homeDirectory, platform: "darwin" });

    expect(first.ok).toBe(true);
    expect(first.created).toContain(first.paths.config);
    expect(second.created).toEqual([]);
    expect(second.existing).toContain(second.paths.config);
    expect(JSON.parse(await readFile(first.paths.config, "utf8"))).toMatchObject({
      bridge: { host: "127.0.0.1", port: 8787 },
    });
    expect((await stat(first.paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(first.paths.config)).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing valid config instead of overwriting it", async () => {
    const homeDirectory = await temporaryHome();
    const first = await setupCodexPad({ homeDirectory, platform: "darwin" });
    const custom = {
      version: 1,
      bridge: { host: "127.0.0.1", port: 9898 },
      tailscale: { serveHttpsPort: 443 },
    };
    await writeFile(first.paths.config, `${JSON.stringify(custom)}\n`, { mode: 0o644 });

    const result = await setupCodexPad({ homeDirectory, platform: "darwin" });

    expect(result.config.bridge.port).toBe(9898);
    expect(JSON.parse(await readFile(first.paths.config, "utf8"))).toEqual(custom);
    expect((await stat(first.paths.config)).mode & 0o777).toBe(0o600);
  });

  it("creates an ownership attestation only from positive injected co-presence evidence", async () => {
    const homeDirectory = await temporaryHome();
    const installation = {
      appPath: "/Applications/ChatGPT.app",
      bundleId: "com.openai.codex",
      appVersion: "26.test",
      buildVersion: "5591",
      binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      binaryVersion: "codex-cli test",
    } as const;
    const socketPath = join(homeDirectory, ".codex", "app-server-control", "app-server-control.sock");
    const evidence = {
      socket: {
        path: socketPath,
        device: "1",
        inode: "2",
        uid: process.getuid?.() ?? 501,
        listenerAddress: "a0",
        listenerKernelInode: "b0",
        listenerGeneration: "10",
      },
      daemon: { pid: 201, startedAt: "Mon Jul 20 10:00:00 2026" },
      desktop: {
        pid: 101,
        startedAt: "Mon Jul 20 09:59:00 2026",
        appPath: installation.appPath,
        executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        bundleId: installation.bundleId,
        appVersion: installation.appVersion,
        buildVersion: installation.buildVersion,
      },
      desktopClient: {
        kind: "managed-proxy" as const,
        pid: 301,
        startedAt: "Mon Jul 20 10:01:00 2026",
        serverEndpointAddress: "a1",
        serverEndpointGeneration: "12",
        clientEndpointAddress: "a2",
        clientEndpointGeneration: "11",
      },
      codex: {
        binaryPath: installation.binaryPath,
        binaryVersion: installation.binaryVersion,
      },
    };
    const runCommand = async () => ({ exitCode: 1, stdout: "", stderr: "unused" });
    const result = await setupCodexPad({
      homeDirectory,
      platform: "darwin",
      desktopOwnership: {
        installation,
        socketPath,
        runCommand,
        collectEvidence: async () => evidence,
        now: () => new Date("2026-07-20T12:00:00.000Z"),
      },
    });

    expect(result.ownershipAttestation).toMatchObject({
      createdAt: "2026-07-20T12:00:00.000Z",
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await stat(result.paths.desktopOwnershipAttestation)).mode & 0o777).toBe(0o600);

    const secondHome = await temporaryHome();
    await expect(
      setupCodexPad({
        homeDirectory: secondHome,
        platform: "darwin",
        desktopOwnership: {
          installation,
          socketPath,
          runCommand,
          collectEvidence: async () => {
            throw new Error("co-presence unavailable");
          },
        },
      }),
    ).rejects.toThrow("co-presence unavailable");
    await expect(
      stat(join(secondHome, "Library", "Application Support", "CodexPad", "security", "desktop-ownership-attestation.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("generates and records schemas from the selected installed binary once", async () => {
    const homeDirectory = await temporaryHome();
    const binaryPath = join(homeDirectory, "codex-test");
    await writeFile(binaryPath, "codex-test-binary");
    let calls = 0;
    const generate = async (_executable: string, arguments_: readonly string[]) => {
      calls += 1;
      const output = arguments_.at(-1);
      if (!output) throw new Error("missing output");
      await writeFile(join(output, "codex_app_server_protocol.schemas.json"), "{\"type\":\"object\"}\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const options = {
      enabled: true,
      binaryPath,
      binaryVersion: "codex-cli 0.test",
      run: generate,
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    } as const;

    const first = await setupCodexPad({ homeDirectory, platform: "darwin", protocolSchema: options });
    const second = await setupCodexPad({ homeDirectory, platform: "darwin", protocolSchema: options });

    expect(first.schema).toMatchObject({
      codexVersion: "codex-cli 0.test",
      generatedAt: "2026-07-20T10:00:00.000Z",
      files: ["codex_app_server_protocol.schemas.json"],
    });
    expect(second.schema?.schemaSha256).toBe(first.schema?.schemaSha256);
    expect(calls).toBe(1);
  });

  it("keeps separate schema caches for different binaries with the same version", async () => {
    const homeDirectory = await temporaryHome();
    const desktopBinary = join(homeDirectory, "desktop-codex");
    const daemonBinary = join(homeDirectory, "daemon-codex");
    await writeFile(desktopBinary, "desktop-binary");
    await writeFile(daemonBinary, "daemon-binary");
    const generate = async (_executable: string, arguments_: readonly string[]) => {
      const output = arguments_.at(-1);
      if (!output) throw new Error("missing output");
      await writeFile(join(output, "ClientRequest.json"), "{\"type\":\"object\"}\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const first = await setupCodexPad({
      homeDirectory,
      platform: "darwin",
      protocolSchema: {
        enabled: true,
        binaryPath: desktopBinary,
        binaryVersion: "codex-cli same",
        run: generate,
      },
    });
    const second = await setupCodexPad({
      homeDirectory,
      platform: "darwin",
      protocolSchema: {
        enabled: true,
        binaryPath: daemonBinary,
        binaryVersion: "codex-cli same",
        run: generate,
      },
    });

    expect(first.schema?.codexBinarySha256).not.toBe(second.schema?.codexBinarySha256);
    const schemaDirectories = await readdir(join(first.paths.cache, "app-server-schemas"));
    expect(schemaDirectories.filter((entry) => entry.startsWith("codex-cli-same--"))).toHaveLength(2);
  });

  it("does not touch the filesystem on unsupported platforms", async () => {
    const homeDirectory = await temporaryHome();
    const result = await setupCodexPad({ homeDirectory, platform: "linux" });
    expect(result.ok).toBe(false);
    await expect(stat(result.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to follow a symlinked config", async () => {
    const homeDirectory = await temporaryHome();
    const first = await setupCodexPad({ homeDirectory, platform: "darwin" });
    const outside = join(homeDirectory, "outside.json");
    await writeFile(outside, "{}\n");
    await unlink(first.paths.config);
    await symlink(outside, first.paths.config);

    await expect(setupCodexPad({ homeDirectory, platform: "darwin" })).rejects.toThrow(
      "Refusing non-regular or symlinked config path",
    );
    expect(await readFile(outside, "utf8")).toBe("{}\n");
  });
});

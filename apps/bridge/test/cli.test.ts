import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import type { SetupDependencies } from "../src/setup.js";

const cliRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cliRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeOut: (message: string) => stdout.push(message),
    writeError: (message: string) => stderr.push(message),
  };
}

describe("runCli", () => {
  it("publishes one structured diagram to the exact ambient Codex task", async () => {
    const output = io();
    const root = await mkdtemp(join(tmpdir(), "nerva-cli-diagram-"));
    cliRoots.push(root);
    const file = join(root, "diagram.json");
    await writeFile(file, JSON.stringify({
      title: "Collaborative architecture",
      nodes: [
        {
          id: "codex",
          label: "Codex",
          x: 100,
          y: 100,
          width: 220,
          height: 96,
          shape: "rectangle",
          tone: "blue",
        },
      ],
      edges: [],
    }));
    const publish = vi.fn(async (input) => ({
      ...input,
      version: 1 as const,
      diagramId: "219f7ec2-68eb-4183-ab3a-0e67312a8ba1",
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      createdBy: "codex" as const,
      lastEditedBy: "codex" as const,
      sourceLabel: null,
    }));
    const previousThreadId = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
    try {
      const code = await runCli(["diagram", "publish", "--file", file], {
        stdout: output.writeOut,
        stderr: output.writeError,
        loadDiagrams: async () => ({
          publish,
          list: async () => [],
          get: async () => { throw new Error("unused"); },
        }),
      });
      expect(code).toBe(0);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: process.env.CODEX_THREAD_ID,
          title: "Collaborative architecture",
        }),
        "codex",
      );
      expect(output.stdout.join("\n")).toContain("Open Draw in Nerva");
    } finally {
      if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThreadId;
    }
  });

  it("prints a precise degraded setup check and keeps installation available", async () => {
    const output = io();
    const code = await runCli(["setup-check"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      preflightMacSetup: async () => ({
        installationState: "degraded",
        nativeIntegration: {
          state: "degraded",
          desktopCodexVersion: "0.146.0-alpha.3.1",
          standaloneCodexVersion: "0.145.0",
          reasons: [{
            code: "codex-version-mismatch",
            detail: "Codex Desktop and standalone versions differ.",
            remediation: ["Run the official Codex installer."],
          }],
        },
        blockers: [],
      }),
    });

    expect(code).toBe(0);
    expect(output.stdout.join("\n")).toContain("READY WITH LIMITED CODEX CONTROLS");
    expect(output.stdout.join("\n")).toContain("0.146.0-alpha.3.1");
    expect(output.stdout.join("\n")).toContain("app-server-backed controls will remain unavailable");
  });

  it("emits setup-check JSON and exits nonzero only when installation is blocked", async () => {
    const output = io();
    const code = await runCli(["setup-check", "--json"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      preflightMacSetup: async () => ({
        installationState: "blocked",
        nativeIntegration: { state: "degraded", reasons: [] },
        blockers: [{
          code: "funnel-not-disabled",
          detail: "Funnel is active.",
          remediation: ["Disable Funnel."],
        }],
      }),
    });

    expect(code).toBe(1);
    expect(JSON.parse(output.stdout.join("\n"))).toMatchObject({
      installationState: "blocked",
      blockers: [{ code: "funnel-not-disabled" }],
    });
  });

  it("installs the background Mac bridge and prints one QR without a second terminal", async () => {
    const output = io();
    const pairing = {
      qrPayload: "https://mac.example.ts.net/pair#pair=test",
      expiresAt: "2026-07-20T00:05:00.000Z",
      consumed: false,
      expired: false,
    };
    const setupMac = vi.fn(async () => ({
      setup: {
        ok: true,
        created: [],
        existing: [],
        paths: {
          root: "/tmp/CodexPad",
          config: "/tmp/CodexPad/config.json",
          security: "/tmp/CodexPad/security",
          runtime: "/tmp/CodexPad/runtime",
          cache: "/tmp/CodexPad/cache",
          desktopOwnershipAttestation: "/tmp/attestation.json",
        },
        config: {
          version: 1 as const,
          bridge: { host: "127.0.0.1" as const, port: 8787 },
          tailscale: { serveHttpsPort: 443 as const },
        },
        notes: [],
      },
      publicOrigin: "https://mac.example.ts.net",
      pairing,
      tailscaleBinary: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      launchAgentPath: "/tmp/codex-pad-test-home/Library/LaunchAgents/com.codex-pad.bridge.plist",
      bridgeHealthy: true,
      installationState: "ready" as const,
      serveChanged: true,
      launchAgentChanged: true,
      managedDaemonConfigured: true as const,
      legacyAppServerLaunchAgentRemoved: false,
      nativeIntegration: {
        state: "ready" as const,
        desktopCodexVersion: "0.146.0-alpha.3.1",
        standaloneCodexVersion: "0.146.0-alpha.3.1",
        reasons: [],
      },
    }));

    const code = await runCli(["setup-mac", "--no-wait"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      setupMac,
      loadPairing: async () => ({
        rotatePairingCode: async () => pairing,
        showPairingInfo: async () => pairing,
        renderPairingQr: async () => "TERMINAL QR",
      }),
    });

    expect(code).toBe(0);
    expect(setupMac).toHaveBeenCalledOnce();
    expect(output.stdout.join("\n")).toContain("background Mac user service");
    expect(output.stdout.join("\n")).toContain("TERMINAL QR");
    expect(output.stdout.join("\n")).toContain("Created the private Codex Pad Tailscale Serve route");
    expect(output.stdout.join("\n")).toContain("Configured the Desktop-bundled managed app-server");
  });

  it("waits for one durable iPad pairing when requested", async () => {
    const output = io();
    const pairing = {
      qrPayload: "https://mac.example.ts.net/pair#pair=test",
      expiresAt: "2026-07-20T00:05:00.000Z",
      consumed: false,
      expired: false,
    };
    const waitForPairingConsumption = vi.fn(async () => "consumed" as const);
    const code = await runCli(["pair"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      createMacPairing: async () => ({
        publicOrigin: "https://mac.example.ts.net",
        pairing,
        tailscaleBinary: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        launchAgentPath: "/tmp/codex-pad-test-home/Library/LaunchAgents/com.codex-pad.bridge.plist",
        bridgeHealthy: true,
      }),
      waitForPairingConsumption,
      loadPairing: async () => ({
        rotatePairingCode: async () => pairing,
        showPairingInfo: async () => pairing,
        renderPairingQr: async () => "TERMINAL QR",
      }),
    });

    expect(code).toBe(0);
    expect(waitForPairingConsumption).toHaveBeenCalledOnce();
    expect(output.stdout.join("\n")).toContain("Pairing is complete and will survive Terminal and Mac restarts");
  });

  it("emits machine-readable doctor JSON and a nonzero red exit", async () => {
    const output = io();
    const code = await runCli(["doctor", "--json"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      doctor: async () => ({
        generatedAt: "2026-07-20T00:00:00.000Z",
        overall: "red",
        checks: [],
        safeCommands: [],
        proofBoundaries: [],
      }),
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.stdout.join("\n"))).toMatchObject({ overall: "red" });
  });

  it("serves on default loopback and accepts start as an alias", async () => {
    const output = io();
    const close = vi.fn(async () => undefined);
    const startBridge = vi.fn(async () => ({ url: "http://127.0.0.1:8787", close }));
    const inspectMultiImageInputCapability = vi.fn(async () => ({
      attestationStatus: "absent" as const,
    }));
    const code = await runCli(["start"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      locateDesktop: async () => ({
        appPath: "/Applications/ChatGPT.app",
        binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        binaryVersion: "codex-cli 0.145.0-test",
      }),
      inspectMultiImageInputCapability,
      loadServer: async () => ({ startBridge }),
      waitForShutdown: async (handle) => handle.close(),
    });
    expect(code).toBe(0);
    expect(inspectMultiImageInputCapability).toHaveBeenCalledWith({
      codexBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      codexVersion: "codex-cli 0.145.0-test",
    });
    expect(startBridge).toHaveBeenCalledWith({
      codexVersion: "codex-cli 0.145.0-test",
      schemaCompatibility: expect.objectContaining({ state: "missing" }),
    });
    expect(close).toHaveBeenCalledOnce();
    expect(output.stdout.join("\n")).toContain("Loopback-only");
  });

  it("passes an exact verified multi-image capability into normal startup", async () => {
    const output = io();
    const capability = {
      verified: true as const,
      serverUserAgent: "codex-app-server/0.145.0-test",
      verifiedAt: "2026-07-20T10:00:00.000Z",
      probe: "runtime-disposable-thread-bounded-multi-local-image" as const,
      maxImages: 12,
    };
    const inspectMultiImageInputCapability = vi.fn(async () => ({
      attestationStatus: "valid" as const,
      capability,
    }));
    const startBridge = vi.fn(async () => ({
      url: "http://127.0.0.1:8787",
      close: async () => undefined,
    }));
    const code = await runCli(["serve"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      locateDesktop: async () => ({
        appPath: "/Applications/ChatGPT.app",
        binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        binaryVersion: "codex-cli 0.145.0-test",
      }),
      inspectMultiImageInputCapability,
      loadServer: async () => ({ startBridge }),
      waitForShutdown: async () => undefined,
    });

    expect(code).toBe(0);
    expect(inspectMultiImageInputCapability).toHaveBeenCalledWith({
      codexBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      codexVersion: "codex-cli 0.145.0-test",
    });
    expect(startBridge).toHaveBeenCalledWith({
      codexVersion: "codex-cli 0.145.0-test",
      multiImageInputCapability: capability,
      schemaCompatibility: expect.objectContaining({ state: "missing" }),
    });
  });

  it("warns locally and omits an invalid or stale attestation without blocking startup", async () => {
    const output = io();
    const startBridge = vi.fn(async () => ({
      url: "http://127.0.0.1:8787",
      close: async () => undefined,
    }));
    const code = await runCli(["start"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      locateDesktop: async () => ({
        appPath: "/Applications/ChatGPT.app",
        binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        binaryVersion: "codex-cli 0.145.0-test",
      }),
      inspectMultiImageInputCapability: async () => ({ attestationStatus: "invalid-or-stale" }),
      loadServer: async () => ({ startBridge }),
      waitForShutdown: async () => undefined,
    });

    expect(code).toBe(0);
    expect(startBridge).toHaveBeenCalledWith({
      codexVersion: "codex-cli 0.145.0-test",
      schemaCompatibility: expect.objectContaining({ state: "missing" }),
    });
    expect(output.stderr.join("\n")).toContain("invalid or stale");
    expect(output.stderr.join("\n")).not.toContain("/Applications/");
  });

  it("rejects wildcard unsafe LAN binds before loading the server", async () => {
    const output = io();
    const loadServer = vi.fn();
    const code = await runCli(["serve", "--unsafe-lan", "0.0.0.0"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      loadServer,
    });
    expect(code).toBe(1);
    expect(loadServer).not.toHaveBeenCalled();
    expect(output.stderr.join("\n")).toContain("wildcard");
    expect(output.stderr.join("\n")).toContain("npm run codex-pad -- help");
  });

  it("allows only an explicit concrete LAN address and keeps security warnings visible", async () => {
    const output = io();
    const startBridge = vi.fn(async () => ({
      url: "http://192.168.1.25:9000",
      close: async () => undefined,
    }));
    const code = await runCli(
      [
        "serve",
        "--unsafe-lan",
        "192.168.1.25",
        "--origin",
        "http://192.168.1.25:9000",
        "--port",
        "9000",
      ],
      {
        stdout: output.writeOut,
        stderr: output.writeError,
        locateDesktop: async () => undefined,
        loadServer: async () => ({ startBridge }),
        waitForShutdown: async () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(startBridge).toHaveBeenCalledWith({
      host: "192.168.1.25",
      port: 9000,
      unsafeLan: true,
      allowedOrigins: ["http://192.168.1.25:9000"],
      publicOrigin: "http://192.168.1.25:9000",
      schemaCompatibility: expect.objectContaining({ state: "unknown" }),
    });
    expect(output.stderr.join("\n")).toContain("development-only unsafe LAN");
  });

  it("rotates pairing only for an HTTPS origin", async () => {
    const output = io();
    const rotatePairingCode = vi.fn(async () => ({
      qrPayload: "https://mac.tail.test/pair#pair=x",
      expiresAt: "2026-07-20T00:03:00.000Z",
      consumed: false,
      expired: false,
    }));
    const invalid = await runCli(["pairing", "rotate", "--origin", "http://mac.tail.test"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      loadPairing: async () => ({
        rotatePairingCode,
        showPairingInfo: async () => null,
        renderPairingQr: async () => "QR",
      }),
    });
    expect(invalid).toBe(1);
    expect(rotatePairingCode).not.toHaveBeenCalled();

    const valid = await runCli(
      ["pairing", "rotate", "--origin", "https://mac.tail.test", "--name", "Mathis iPad"],
      {
        stdout: output.writeOut,
        stderr: output.writeError,
        loadPairing: async () => ({
          rotatePairingCode,
          showPairingInfo: async () => null,
          renderPairingQr: async () => "QR",
        }),
      },
    );
    expect(valid).toBe(0);
    expect(rotatePairingCode).toHaveBeenCalledWith({
      publicOrigin: "https://mac.tail.test",
      deviceNameHint: "Mathis iPad",
    });
  });

  it("requires an exact concrete address for explicitly unsafe HTTP pairing", async () => {
    const output = io();
    const rotatePairingCode = vi.fn(async () => ({
      qrPayload: "http://192.168.1.25:9000/pair#pair=x",
      expiresAt: "2026-07-20T00:03:00.000Z",
      consumed: false,
      expired: false,
      insecureDevelopment: true as const,
    }));
    const loadPairing = async () => ({
      rotatePairingCode,
      showPairingInfo: async () => null,
      renderPairingQr: async () => "QR",
    });
    const code = await runCli([
      "pairing",
      "rotate",
      "--unsafe-lan",
      "192.168.1.25",
      "--origin",
      "http://192.168.1.25:9000",
      "--port",
      "9000",
    ], { stdout: output.writeOut, stderr: output.writeError, loadPairing });
    expect(code).toBe(0);
    expect(rotatePairingCode).toHaveBeenCalledWith({
      publicOrigin: "http://192.168.1.25:9000",
      allowInsecureHttp: true,
    });
    expect(output.stderr.join("\n")).toContain("development-only HTTP pairing QR");

    const mismatch = await runCli([
      "pairing",
      "rotate",
      "--unsafe-lan",
      "192.168.1.25",
      "--origin",
      "http://192.168.1.26:9000",
      "--port",
      "9000",
    ], { stdout: output.writeOut, stderr: output.writeError, loadPairing });
    expect(mismatch).toBe(1);
    expect(rotatePairingCode).toHaveBeenCalledTimes(1);
  });

  it("lists only unresolved ledger metadata and gates exact-record deletion behind an explicit warning", async () => {
    const output = io();
    const listUnresolvedCommands = vi.fn(async () => [{
      deviceId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      createdAt: Date.parse("2026-07-20T10:00:00.000Z"),
      updatedAt: Date.parse("2026-07-20T10:01:00.000Z"),
    }]);
    const forgetUnresolvedCommand = vi.fn(async () => true);
    const loadCommandLedger = async () => ({ listUnresolvedCommands, forgetUnresolvedCommand });

    await expect(runCli(
      ["command-ledger", "list-unresolved", "--json"],
      { stdout: output.writeOut, stderr: output.writeError, loadCommandLedger },
    )).resolves.toBe(0);
    expect(JSON.parse(output.stdout.join("\n"))).toEqual([expect.objectContaining({
      deviceId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
    })]);

    const denied = await runCli([
      "command-ledger",
      "forget",
      "--device",
      "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      "--command",
      "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
    ], { stdout: output.writeOut, stderr: output.writeError, loadCommandLedger });
    expect(denied).toBe(1);
    expect(forgetUnresolvedCommand).not.toHaveBeenCalled();

    const confirmed = await runCli([
      "command-ledger",
      "forget",
      "--device",
      "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      "--command",
      "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      "--acknowledge-delivery-unknown",
    ], { stdout: output.writeOut, stderr: output.writeError, loadCommandLedger });
    expect(confirmed).toBe(0);
    expect(forgetUnresolvedCommand).toHaveBeenCalledWith(
      "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
    );
    expect(output.stderr.join("\n")).toContain("can duplicate an operation");
  });

  it("passes installed binary provenance into opt-in schema setup", async () => {
    const output = io();
    const setup = vi.fn(async (options) => ({
      ok: true,
      created: [],
      existing: [],
      paths: {
        root: "",
        config: "",
        security: "",
        runtime: "",
        cache: "",
        desktopOwnershipAttestation: "",
      },
      config: { version: 1 as const, bridge: { host: "127.0.0.1" as const, port: 8787 }, tailscale: { serveHttpsPort: 443 as const } },
      notes: [],
      schema: {
        formatVersion: 1 as const,
        codexBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
        codexVersion: "codex-cli test",
        generatedAt: "2026-07-20T00:00:00.000Z",
        schemaSha256: "a".repeat(64),
        files: ["schema.json"],
      },
    }));
    const code = await runCli(["setup", "--generate-schemas"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      locateDesktop: async () => ({
        appPath: "/Applications/ChatGPT.app",
        binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        binaryVersion: "codex-cli test",
      }),
      setup,
      doctor: async () => ({
        generatedAt: "2026-07-20T00:00:00.000Z",
        overall: "warn",
        checks: [],
        safeCommands: [],
        proofBoundaries: [],
      }),
    });
    expect(code).toBe(0);
    expect(setup.mock.calls[0]?.[0]?.protocolSchema).toMatchObject({
      enabled: true,
      binaryVersion: "codex-cli test",
    });
  });

  it("passes complete Desktop identity only for explicit ownership attestation", async () => {
    const output = io();
    const setup = vi.fn(async (_options?: SetupDependencies) => ({
      ok: true,
      created: [],
      existing: [],
      paths: {
        root: "",
        config: "",
        security: "",
        runtime: "",
        cache: "",
        desktopOwnershipAttestation: "",
      },
      config: {
        version: 1 as const,
        bridge: { host: "127.0.0.1" as const, port: 8787 },
        tailscale: { serveHttpsPort: 443 as const },
      },
      notes: [],
      ownershipAttestation: {
        createdAt: "2026-07-20T12:00:00.000Z",
        evidenceSha256: "a".repeat(64),
      },
    }));
    const code = await runCli(["setup", "--attest-desktop-ownership"], {
      stdout: output.writeOut,
      stderr: output.writeError,
      locateDesktop: async () => ({
        appPath: "/Applications/ChatGPT.app",
        bundleId: "com.openai.codex",
        appVersion: "26.test",
        buildVersion: "5591",
        binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        binaryVersion: "codex-cli test",
      }),
      setup,
      doctor: async () => ({
        generatedAt: "2026-07-20T12:00:00.000Z",
        overall: "warn",
        checks: [],
        safeCommands: [],
        proofBoundaries: [],
      }),
    });

    expect(code).toBe(0);
    expect(setup.mock.calls[0]?.[0]?.desktopOwnership?.installation).toMatchObject({
      bundleId: "com.openai.codex",
      appVersion: "26.test",
      buildVersion: "5591",
      binaryVersion: "codex-cli test",
    });
    expect(output.stdout.join("\n")).toContain("Desktop ownership attested at");
  });

  it("registers only context metadata and never recommends exposing the site", async () => {
    const output = io();
    const addSite = vi.fn(async (input) => ({ associationId: "site-1", ...input }));
    const loadSites = async () => ({
      addSite,
      listSites: async () => [],
      removeSite: async () => true,
    });
    const bad = await runCli(
      ["site", "add", "--project", "demo", "--url", "https://example.com"],
      { stdout: output.writeOut, stderr: output.writeError, loadSites },
    );
    expect(bad).toBe(1);
    expect(addSite).not.toHaveBeenCalled();

    const good = await runCli(
      [
        "site",
        "add",
        "--thread",
        "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
        "--url",
        "http://127.0.0.1:3000",
        "--public-origin",
        "https://codex-mac.example-tail.ts.net:3000",
      ],
      { stdout: output.writeOut, stderr: output.writeError, loadSites },
    );
    expect(good).toBe(0);
    expect(addSite).toHaveBeenCalledWith({
      targetKind: "thread",
      targetId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      loopbackUrl: "http://127.0.0.1:3000",
      publicOrigin: "https://codex-mac.example-tail.ts.net:3000",
    });
    expect(output.stdout.join("\n").toLowerCase()).not.toContain("tailscale serve");
    expect(output.stdout.join("\n")).not.toContain("http://127.0.0.1:3000");
    expect(output.stdout.join("\n")).not.toContain("https://codex-mac.example-tail.ts.net:3000");
    expect(output.stdout.join("\n")).toContain("Live preview, browser opening, and automatic capture are unavailable");
    expect(output.stdout.join("\n")).toContain("No Tailscale configuration was changed or recommended");
  });

  it("rejects bridge-reserved site ports and a mismatched public port", async () => {
    const output = io();
    const addSite = vi.fn();
    const loadSites = async () => ({
      addSite,
      listSites: async () => [],
      removeSite: async () => true,
    });

    for (const port of [443, 8787]) {
      const code = await runCli(
        [
          "site",
          "add",
          "--project",
          "/workspace/demo",
          "--url",
          `http://127.0.0.1:${port}`,
          "--public-origin",
          `https://codex-mac.example-tail.ts.net:${port}`,
        ],
        { stdout: output.writeOut, stderr: output.writeError, loadSites },
      );
      expect(code).toBe(1);
    }

    const mismatch = await runCli(
      [
        "site",
        "add",
        "--project",
        "/workspace/demo",
        "--url",
        "http://127.0.0.1:3000",
        "--public-origin",
        "https://codex-mac.example-tail.ts.net:3001",
      ],
      { stdout: output.writeOut, stderr: output.writeError, loadSites },
    );
    expect(mismatch).toBe(1);
    expect(addSite).not.toHaveBeenCalled();
  });

  it("keeps the JSON public origin distinct from the local site target", async () => {
    const output = io();
    const code = await runCli(
      [
        "site",
        "add",
        "--project",
        "/workspace/demo-website",
        "--url",
        "http://localhost:5173",
        "--public-origin",
        "https://codex-mac.example-tail.ts.net:5173",
        "--json",
      ],
      {
        stdout: output.writeOut,
        stderr: output.writeError,
        loadSites: async () => ({
          addSite: async (input) => ({
            associationId: "site-2",
            name: "Demo",
            ...input,
            targetId: `project:${"a".repeat(43)}`,
          }),
          listSites: async () => [],
          removeSite: async () => true,
        }),
      },
    );

    expect(code).toBe(0);
    const response = JSON.parse(output.stdout.join("\n")) as {
      site: { targetId: string; publicOrigin: string; loopbackUrl?: string };
      liveSitePreview: { status: string; reason: string };
    };
    expect(response.site).toMatchObject({
      targetId: `project:${"a".repeat(43)}`,
      publicOrigin: "https://codex-mac.example-tail.ts.net:5173",
    });
    expect(response.site.loopbackUrl).toBeUndefined();
    expect(response.liveSitePreview).toEqual({
      status: "unavailable",
      reason: "same-host-storage-boundary",
    });
  });

  it("rejects friendly project labels that cannot prove a project cwd", async () => {
    const output = io();
    const addSite = vi.fn();
    const code = await runCli(
      [
        "site",
        "add",
        "--project",
        "demo",
        "--url",
        "http://127.0.0.1:3000",
        "--public-origin",
        "https://codex-mac.example-tail.ts.net:3000",
      ],
      {
        stdout: output.writeOut,
        stderr: output.writeError,
        loadSites: async () => ({
          addSite,
          listSites: async () => [],
          removeSite: async () => true,
        }),
      },
    );

    expect(code).toBe(1);
    expect(addSite).not.toHaveBeenCalled();
    expect(output.stderr.join("\n")).toContain("absolute project cwd");
  });

  it("rejects IPv6 loopback sites before registry mutation", async () => {
    const output = io();
    const addSite = vi.fn();
    const code = await runCli(
      [
        "site",
        "add",
        "--project",
        "/workspace/demo",
        "--url",
        "http://[::1]:3000",
        "--public-origin",
        "https://codex-mac.example-tail.ts.net:3000",
      ],
      {
        stdout: output.writeOut,
        stderr: output.writeError,
        loadSites: async () => ({
          addSite,
          listSites: async () => [],
          removeSite: async () => true,
        }),
      },
    );

    expect(code).toBe(1);
    expect(addSite).not.toHaveBeenCalled();
    expect(output.stderr.join("\n")).toContain("loopback HTTP URL");
  });
});

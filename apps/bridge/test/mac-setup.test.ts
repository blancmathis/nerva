import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LAUNCH_AGENT_LABEL,
  MANAGED_LOG_ROTATION_BYTES,
  createMacPairing,
  inspectMacUninstall,
  preflightMacSetup,
  setupMac,
  uninstallMac,
  type MacSetupPreflight,
} from "../src/mac-setup.js";
import { defaultDataPaths } from "../src/paths.js";
import { pairingNonceFromUrl } from "../src/pairing.js";
import { codexPadPaths } from "../src/setup.js";
import type { CommandResult, DoctorCheck, DoctorReport } from "../src/doctor.js";

function commandResult(stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { stdout, exitCode, stderr };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-mac-setup-test-"));
  const home = join(root, "home");
  const repository = join(root, "repo with spaces");
  const cli = join(repository, "apps", "bridge", "dist", "cli.js");
  const bin = join(root, "bin");
  const tailscale = join(bin, "tailscale");
  const codex = join(bin, "codex");
  await mkdir(home);
  await mkdir(join(repository, "apps", "bridge", "dist"), { recursive: true });
  await mkdir(bin);
  await writeFile(cli, "// built fixture\n");
  await writeFile(tailscale, "#!/bin/sh\nexit 0\n");
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(tailscale, 0o700);
  await chmod(codex, 0o700);
  return { root, home, repository, cli, bin, tailscale, codex };
}

function readyServeStatus() {
  return JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: {
      "mac.example.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } },
      },
    },
  });
}

const readyPreflight: MacSetupPreflight = {
  installationState: "ready",
  nativeIntegration: {
    state: "ready",
    desktopCodexVersion: "0.146.0-alpha.3.1",
    standaloneCodexVersion: "0.146.0-alpha.3.1",
    reasons: [],
  },
  blockers: [],
};

const limitedPreflight: MacSetupPreflight = {
  installationState: "limited",
  nativeIntegration: {
    state: "limited",
    reasons: [{
      code: "managed-app-server-unavailable",
      detail: "Native controls are intentionally unavailable in this fixture.",
      remediation: [],
    }],
  },
  blockers: [],
};

function managedBridgeHarness(
  test: Awaited<ReturnType<typeof fixture>>,
  options: { readonly exactServeReady?: boolean } = {},
) {
  let exactServeReady = options.exactServeReady ?? false;
  const unrelatedHandler = { Handlers: { "/docs": { Proxy: "http://127.0.0.1:9000" } } };
  const serveStatus = (): string => JSON.stringify(exactServeReady
    ? {
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "mac.example.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } },
        },
        "mac.example.ts.net:8443": unrelatedHandler,
      },
    }
    : {
      TCP: { "8443": { HTTPS: true } },
      Web: { "mac.example.ts.net:8443": unrelatedHandler },
    });
  const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
    if (executable === test.tailscale && arguments_[0] === "status") {
      return commandResult(JSON.stringify({
        BackendState: "Running",
        Self: { Online: true, DNSName: "mac.example.ts.net." },
      }));
    }
    if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
    if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
      return commandResult(serveStatus());
    }
    if (executable === test.tailscale && arguments_[0] === "serve") {
      exactServeReady = arguments_.at(-1) !== "off";
      return commandResult();
    }
    if (executable === "/bin/launchctl" && arguments_[0] === "bootout") {
      return commandResult("", 1, "not loaded");
    }
    if (executable === "/usr/sbin/lsof") return commandResult("", 1);
    if (executable === "/bin/launchctl") return commandResult();
    return commandResult("", 1, "unexpected command");
  });
  return {
    runCommand,
    exactServeReady: () => exactServeReady,
    common: {
      platform: "darwin" as const,
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      nodeExecutable: "/usr/local/bin/node",
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      filesystemUid: process.getuid?.() ?? 0,
      runCommand,
      inspectPreflight: async () => limitedPreflight,
      waitForBridgeHealth: async () => true,
    },
  };
}

const inspectReadyPreflight = async () => readyPreflight;

function doctorReport(checks: readonly DoctorCheck[]): DoctorReport {
  return {
    generatedAt: "2026-07-26T10:00:00.000Z",
    overall: checks.some((check) => check.status === "red") ? "red" : "green",
    checks,
    safeCommands: [],
    proofBoundaries: [],
  };
}

function doctorCheck(id: string, status: DoctorCheck["status"], summary: string): DoctorCheck {
  return {
    id,
    category: "transport",
    status,
    summary,
    remediation: status === "green" ? [] : ["Repair the observed native integration state."],
    proofBoundary: "Fixture evidence only.",
  };
}

describe("macOS one-command setup", () => {
  it("classifies the current version-skewed, multi-writer runtime as limited", async () => {
    const test = await fixture();
    const standalone = join(test.home, ".codex", "packages", "standalone", "current", "codex");
    await mkdir(join(standalone, ".."), { recursive: true });
    await writeFile(standalone, "#!/bin/sh\nexit 0\n");
    await chmod(standalone, 0o700);
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: "mac.example.ts.net." } }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve") return commandResult("null");
      if (executable === test.codex && arguments_[0] === "--version") return commandResult("codex-cli 0.146.0-alpha.3.1\n");
      if (executable === standalone && arguments_[0] === "--version") return commandResult("codex-cli 0.145.0\n");
      return commandResult("", 1, "unexpected command");
    });

    const result = await preflightMacSetup({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      runCommand,
      inspectDoctor: async () => doctorReport([
        doctorCheck("app-server-writers", "red", "3 independent writers observed."),
        doctorCheck("managed-app-server", "red", "Managed socket absent."),
        doctorCheck("desktop-shared-ownership", "red", "Ownership is not attested."),
        doctorCheck("cdp-loopback", "green", "CDP is ready."),
        doctorCheck("micro-six-slots", "green", "Six slots are ready."),
      ]),
    });

    expect(result.installationState).toBe("limited");
    expect(result.blockers).toEqual([]);
    expect(result.nativeIntegration.desktopCodexVersion).toBe("0.146.0-alpha.3.1");
    expect(result.nativeIntegration.standaloneCodexVersion).toBe("0.145.0");
    expect(result.nativeIntegration.reasons.map((reason) => reason.code)).toEqual([
      "codex-version-mismatch",
      "managed-app-server-unavailable",
      "desktop-ownership-unverified",
    ]);
  });

  it("keeps independent Codex version probes truthful when Tailscale is offline", async () => {
    const test = await fixture();
    const standalone = join(test.home, ".codex", "packages", "standalone", "current", "codex");
    await mkdir(join(standalone, ".."), { recursive: true });
    await writeFile(standalone, "#!/bin/sh\nexit 0\n");
    await chmod(standalone, 0o700);
    const inspectDoctor = vi.fn(async () => doctorReport([
      doctorCheck("managed-app-server", "green", "Managed socket is available."),
      doctorCheck("desktop-shared-ownership", "green", "Ownership is attested."),
      doctorCheck("cdp-loopback", "green", "CDP is ready."),
      doctorCheck("micro-six-slots", "green", "Six slots are ready."),
      doctorCheck("protocol-schema", "green", "Protocol schemas are compatible."),
    ]));
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({ BackendState: "Stopped", Self: { Online: false } }));
      }
      if (executable === test.codex && arguments_[0] === "--version") {
        return commandResult("codex-cli 0.146.0-alpha.9.2\n");
      }
      if (executable === standalone && arguments_[0] === "--version") {
        return commandResult("codex-cli 0.146.0\n");
      }
      return commandResult("", 1, "unexpected command");
    });

    const result = await preflightMacSetup({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      runCommand,
      inspectDoctor,
    });

    expect(result.installationState).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["tailscale-unavailable"]);
    expect(result.nativeIntegration.desktopCodexVersion).toBe("0.146.0-alpha.9.2");
    expect(result.nativeIntegration.standaloneCodexVersion).toBe("0.146.0");
    expect(result.nativeIntegration.reasons.map((reason) => reason.code)).toEqual([
      "codex-version-mismatch",
    ]);
    expect(inspectDoctor).toHaveBeenCalledOnce();
  });

  it("blocks unsupported Node before touching Tailscale", async () => {
    const test = await fixture();
    const runCommand = vi.fn(async () => commandResult());
    const result = await preflightMacSetup({
      platform: "darwin",
      nodeVersion: "20.19.0",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      runCommand,
    });
    expect(result.installationState).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toContain("unsupported-node");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("configures the durable managed daemon, exact private route, and bridge LaunchAgent idempotently", async () => {
    const test = await fixture();
    let serveReady = false;
    const commands: Array<{ executable: string; arguments_: readonly string[] }> = [];
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      commands.push({ executable, arguments_ });
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "mac.example.ts.net." },
        }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
        return commandResult(serveReady ? readyServeStatus() : "null");
      }
      if (executable === test.tailscale && arguments_[0] === "serve") {
        serveReady = true;
        return commandResult("Serve started");
      }
      if (executable === test.codex && arguments_[2] === "version") {
        return commandResult(JSON.stringify({ status: "running", cliVersion: "test", managedCodexVersion: "test", appServerVersion: "test" }));
      }
      if (executable === test.codex) return commandResult();
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") {
        return commandResult("", 1, "not loaded");
      }
      if (executable === "/bin/launchctl") return commandResult();
      return commandResult("", 1, "unexpected command");
    });
    const fetch = vi.fn(async () => Response.json({ ok: true, data: { version: "0.1.0" } }));

    const first = await setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      nodeExecutable: "/usr/local/bin/node",
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch,
      inspectPreflight: inspectReadyPreflight,
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    expect(first.serveChanged).toBe(true);
    expect(first.launchAgentChanged).toBe(true);
    expect(first.managedDaemonConfigured).toBe(true);
    expect(first.installationState).toBe("ready");
    expect(first.legacyAppServerLaunchAgentRemoved).toBe(false);
    expect(first.publicOrigin).toBe("https://mac.example.ts.net");
    expect(new URL(first.pairing.qrPayload).origin).toBe(first.publicOrigin);
    expect(commands).toContainEqual({
      executable: test.tailscale,
      arguments_: ["serve", "--bg", "--https=443", "http://127.0.0.1:8787"],
    });
    expect(commands.some(({ arguments_ }) => arguments_.includes("reset"))).toBe(false);
    expect(commands).toContainEqual({
      executable: "/bin/launchctl",
      arguments_: ["bootstrap", "gui/501", first.launchAgentPath],
    });
    expect(commands).not.toContainEqual({
      executable: test.codex,
      arguments_: ["app-server", "daemon", "bootstrap", "--remote-control"],
    });
    expect(commands).toContainEqual({
      executable: test.codex,
      arguments_: ["app-server", "daemon", "version"],
    });
    expect(commands.some(({ arguments_ }) => arguments_[0] === "kickstart")).toBe(false);
    const plist = await readFile(first.launchAgentPath, "utf8");
    expect(plist).toContain("/usr/local/bin/node");
    expect(plist).toContain(test.cli.replaceAll("&", "&amp;"));
    expect(plist).not.toContain(pairingNonceFromUrl(first.pairing.qrPayload) ?? "missing");
    expect((await stat(first.launchAgentPath)).mode & 0o777).toBe(0o600);
    commands.length = 0;
    const second = await setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      nodeExecutable: "/usr/local/bin/node",
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch,
      inspectPreflight: inspectReadyPreflight,
      now: () => new Date("2026-07-20T10:01:00.000Z"),
    });
    expect(second.serveChanged).toBe(false);
    expect(second.launchAgentChanged).toBe(false);
    expect(second.managedDaemonConfigured).toBe(true);
    expect(second.legacyAppServerLaunchAgentRemoved).toBe(false);
    expect(commands.some(({ executable, arguments_ }) => executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "--bg")).toBe(false);
  });

  it("retries the transient launchd bootout/bootstrap race", async () => {
    const test = await fixture();
    let serveReady = false;
    let bridgeBootstrapAttempts = 0;
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "mac.example.ts.net." },
        }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
        return commandResult(serveReady ? readyServeStatus() : "null");
      }
      if (executable === test.tailscale && arguments_[0] === "serve") {
        serveReady = true;
        return commandResult();
      }
      if (executable === test.codex && arguments_[2] === "version") {
        return commandResult(JSON.stringify({ status: "running", cliVersion: "test", managedCodexVersion: "test", appServerVersion: "test" }));
      }
      if (executable === test.codex) return commandResult();
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") {
        return commandResult("", 1, "not loaded");
      }
      if (
        executable === "/bin/launchctl"
        && arguments_[0] === "bootstrap"
        && arguments_[2]?.endsWith("com.codex-pad.bridge.plist")
      ) {
        bridgeBootstrapAttempts += 1;
        if (bridgeBootstrapAttempts === 1) {
          return commandResult("", 5, "Bootstrap failed: 5: Input/output error");
        }
      }
      if (executable === "/bin/launchctl") return commandResult();
      return commandResult("", 1, "unexpected command");
    });

    await expect(setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      nodeExecutable: "/usr/local/bin/node",
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
      inspectPreflight: inspectReadyPreflight,
    })).resolves.toMatchObject({ bridgeHealthy: true });
    expect(bridgeBootstrapAttempts).toBe(2);
  });

  it("removes only the recognized obsolete raw app-server LaunchAgent", async () => {
    const test = await fixture();
    const launchAgents = join(test.home, "Library", "LaunchAgents");
    await mkdir(launchAgents, { recursive: true });
    const legacyPath = join(launchAgents, "com.codex-pad.app-server.plist");
    const socketPath = join(test.home, ".codex", "app-server-control", "app-server-control.sock");
    await writeFile(legacyPath, [
      "<plist><dict>",
      "<key>Label</key><string>com.codex-pad.app-server</string>",
      `<array><string>${test.codex}</string><string>app-server</string><string>--listen</string>`,
      `<string>unix://${socketPath}</string></array>`,
      "</dict></plist>",
    ].join(""));
    let serveReady = false;
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: "mac.example.ts.net." } }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
        return commandResult(serveReady ? readyServeStatus() : "null");
      }
      if (executable === test.tailscale && arguments_[0] === "serve") {
        serveReady = true;
        return commandResult();
      }
      if (executable === test.codex && arguments_[2] === "version") {
        return commandResult(JSON.stringify({ status: "running", cliVersion: "test", managedCodexVersion: "test", appServerVersion: "test" }));
      }
      if (executable === test.codex) return commandResult();
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") return commandResult();
      if (executable === "/bin/launchctl") return commandResult();
      return commandResult("", 1, "unexpected command");
    });

    const result = await setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      nodeExecutable: "/usr/local/bin/node",
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
      inspectPreflight: inspectReadyPreflight,
    });

    expect(result.legacyAppServerLaunchAgentRemoved).toBe(true);
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs the bridge in limited mode without touching Codex when versions differ", async () => {
    const test = await fixture();
    const launchAgents = join(test.home, "Library", "LaunchAgents");
    await mkdir(launchAgents, { recursive: true });
    const legacyPath = join(launchAgents, "com.codex-pad.app-server.plist");
    const socketPath = join(test.home, ".codex", "app-server-control", "app-server-control.sock");
    await writeFile(legacyPath, [
      "<plist><dict>",
      "<key>Label</key><string>com.codex-pad.app-server</string>",
      `<array><string>${test.codex}</string><string>app-server</string><string>--listen</string>`,
      `<string>unix://${socketPath}</string></array>`,
      "</dict></plist>",
    ].join(""));
    let serveReady = false;
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: "mac.example.ts.net." } }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
        return commandResult(serveReady ? readyServeStatus() : "null");
      }
      if (executable === test.tailscale && arguments_[0] === "serve") {
        serveReady = true;
        return commandResult();
      }
      if (executable === test.codex && arguments_[2] === "version") {
        return commandResult(JSON.stringify({
          status: "running",
          cliVersion: "0.146.0-alpha.3.1",
          managedCodexVersion: "0.145.0",
          appServerVersion: "0.145.0",
        }));
      }
      if (executable === test.codex) return commandResult();
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") return commandResult("", 1, "not loaded");
      if (executable === "/bin/launchctl") return commandResult();
      return commandResult("", 1, "unexpected command");
    });

    const result = await setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      nodeExecutable: "/usr/local/bin/node",
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
      inspectPreflight: async () => ({
        ...readyPreflight,
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
      }),
    });

    expect(result.installationState).toBe("limited");
    expect(result.managedDaemonConfigured).toBe(false);
    expect(result.bridgeHealthy).toBe(true);
    expect(result.pairing.qrPayload).toContain("https://mac.example.ts.net/pair#pair=");
    expect(await readFile(legacyPath, "utf8")).toContain("com.codex-pad.app-server");
    expect(runCommand.mock.calls.some(([executable, arguments_]) => (
      executable === "/bin/launchctl" && arguments_[0] === "setenv"
    ))).toBe(false);
    expect(runCommand.mock.calls.some(([executable, arguments_]) => (
      executable === test.codex && arguments_[0] === "app-server" && arguments_[1] === "daemon"
    ))).toBe(false);
  });

  it("does not create a pairing code before the installed bridge is healthy", async () => {
    const test = await fixture();
    let serveReady = false;
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: "mac.example.ts.net." } }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
        return commandResult(serveReady ? readyServeStatus() : "null");
      }
      if (executable === test.tailscale && arguments_[0] === "serve") {
        serveReady = true;
        return commandResult();
      }
      if (executable === "/bin/launchctl") return commandResult();
      return commandResult("", 1, "unexpected command");
    });

    await expect(setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      inspectPreflight: async () => ({
        ...readyPreflight,
        installationState: "degraded",
        nativeIntegration: {
          state: "degraded",
          reasons: [{
            code: "standalone-unavailable",
            detail: "Standalone Codex is unavailable.",
            remediation: ["Run the official Codex installer."],
          }],
        },
      }),
      waitForBridgeHealth: async () => false,
    })).rejects.toThrow("did not become healthy");

    const pairingPath = defaultDataPaths(codexPadPaths(test.home).root).pairing;
    await expect(readFile(pairingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an existing HTTPS route without changing launchd or writing a pairing secret", async () => {
    const test = await fixture();
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "mac.example.ts.net." },
        }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve") {
        return commandResult(JSON.stringify({
          Web: {
            "mac.example.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
            },
          },
        }));
      }
      return commandResult();
    });

    await expect(setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
    })).rejects.toThrow("will not overwrite");

    expect(runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
    const pairingPath = defaultDataPaths(codexPadPaths(test.home).root).pairing;
    await expect(readFile(pairingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses Funnel and keeps the existing paired bridge untouched", async () => {
    const test = await fixture();
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "mac.example.ts.net." },
        }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") {
        return commandResult(JSON.stringify({ AllowFunnel: { "mac.example.ts.net:443": true } }));
      }
      return commandResult(readyServeStatus());
    });

    await expect(setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
    })).rejects.toThrow("Funnel is not proven disabled");
    expect(runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
  });

  it("refuses a symlinked LaunchAgents directory before touching Tailscale", async () => {
    const test = await fixture();
    const library = join(test.home, "Library");
    const trap = join(test.root, "launch-agent-trap");
    await mkdir(library);
    await mkdir(trap);
    await symlink(trap, join(library, "LaunchAgents"));
    const runCommand = vi.fn(async () => commandResult());

    await expect(setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
    })).rejects.toThrow("unsafe LaunchAgent directory");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rotates pairing later with one command and restarts only the installed Codex Pad job", async () => {
    const test = await fixture();
    let serveReady = false;
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({ BackendState: "Running", Self: { Online: true, DNSName: "mac.example.ts.net." } }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
        return commandResult(serveReady ? readyServeStatus() : "null");
      }
      if (executable === test.tailscale && arguments_[0] === "serve") {
        serveReady = true;
        return commandResult();
      }
      if (executable === test.codex && arguments_[2] === "version") {
        return commandResult(JSON.stringify({ status: "running", cliVersion: "test", managedCodexVersion: "test", appServerVersion: "test" }));
      }
      if (executable === test.codex) return commandResult();
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") return commandResult("", 1, "not loaded");
      return commandResult();
    });
    const common = {
      platform: "darwin" as const,
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
      inspectPreflight: inspectReadyPreflight,
    };
    await setupMac(common);
    runCommand.mockClear();
    const paired = await createMacPairing(common);
    expect(paired.publicOrigin).toBe("https://mac.example.ts.net");
    expect(runCommand).toHaveBeenCalledWith(
      "/bin/launchctl",
      ["kickstart", "-k", `gui/501/${LAUNCH_AGENT_LABEL}`],
      10_000,
    );
    expect(runCommand.mock.calls.some(([executable, arguments_]) => executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "--bg")).toBe(false);
  });

  it("refuses a later pairing before Tailscale or a pairing secret when setup was never installed", async () => {
    const test = await fixture();
    const runCommand = vi.fn(async () => commandResult());

    await expect(createMacPairing({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      uid: 501,
      runCommand,
      fetch: async () => Response.json({ ok: true, data: { version: "0.1.0" } }),
    })).rejects.toThrow("Run `npm run setup:mac` first");

    expect(runCommand).not.toHaveBeenCalled();
    const pairingPath = defaultDataPaths(codexPadPaths(test.home).root).pairing;
    await expect(readFile(pairingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inspects read-only, removes only exact Nerva-owned service state, and retains product data", async () => {
    const test = await fixture();
    const harness = managedBridgeHarness(test);
    const installed = await setupMac(harness.common);
    const retained = join(codexPadPaths(test.home).root, "retained-product-state.txt");
    await writeFile(retained, "keep me");
    harness.runCommand.mockClear();

    const inspection = await inspectMacUninstall(harness.common);
    expect(inspection).toMatchObject({
      state: "ready",
      launchAgent: { state: "owned" },
      serve: { state: "owned" },
    });
    expect(harness.runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
    expect(harness.runCommand.mock.calls.some(([, arguments_]) => arguments_.includes("off"))).toBe(false);

    harness.runCommand.mockClear();
    const result = await uninstallMac(harness.common);
    expect(result).toMatchObject({
      state: "complete",
      launchAgentRemoved: true,
      serveRemoved: true,
      dataRetained: true,
      logsRetained: true,
    });
    expect(harness.exactServeReady()).toBe(false);
    expect(harness.runCommand).toHaveBeenCalledWith(
      test.tailscale,
      ["serve", "--bg", "--https=443", "http://127.0.0.1:8787", "off"],
      60_000,
    );
    expect(harness.runCommand.mock.calls.some(([, arguments_]) => (
      arguments_.includes("reset") || arguments_.includes("--yes")
    ))).toBe(false);
    expect(harness.runCommand.mock.calls.some(([executable, arguments_]) => (
      executable === test.codex
      || arguments_[0] === "setenv"
      || arguments_[0] === "down"
      || arguments_[0] === "logout"
    ))).toBe(false);
    await expect(readFile(installed.launchAgentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(retained, "utf8")).resolves.toBe("keep me");

    harness.runCommand.mockClear();
    await expect(uninstallMac(harness.common)).resolves.toMatchObject({
      state: "complete",
      launchAgentRemoved: false,
      serveRemoved: false,
    });
    expect(harness.runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
    expect(harness.runCommand.mock.calls.some(([, arguments_]) => arguments_.includes("off"))).toBe(false);
  });

  it("blocks unrecognized, symlinked, and multiply-linked LaunchAgent targets without mutations", async () => {
    for (const unsafeShape of ["contents", "symlink", "hardlink"] as const) {
      const test = await fixture();
      const harness = managedBridgeHarness(test);
      const installed = await setupMac(harness.common);
      if (unsafeShape === "contents") {
        await writeFile(installed.launchAgentPath, "foreign launch agent\n");
        await chmod(installed.launchAgentPath, 0o600);
      } else if (unsafeShape === "symlink") {
        const trap = join(test.root, "foreign.plist");
        await writeFile(trap, "foreign launch agent\n");
        await rm(installed.launchAgentPath);
        await symlink(trap, installed.launchAgentPath);
      } else {
        await link(installed.launchAgentPath, join(test.root, "second-link.plist"));
      }
      harness.runCommand.mockClear();

      const inspection = await inspectMacUninstall(harness.common);
      expect(inspection.state).toBe("blocked");
      expect(inspection.launchAgent.state).toBe("blocked");
      await expect(uninstallMac(harness.common)).rejects.toThrow("Mac uninstall is blocked");
      expect(harness.runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
      expect(harness.runCommand.mock.calls.some(([, arguments_]) => arguments_.includes("off"))).toBe(false);
    }
  });

  it("retains a pre-existing identical Serve route that setup did not create", async () => {
    const test = await fixture();
    const harness = managedBridgeHarness(test, { exactServeReady: true });
    await setupMac(harness.common);
    harness.runCommand.mockClear();

    const inspection = await inspectMacUninstall(harness.common);
    expect(inspection.state).toBe("blocked");
    expect(inspection.serve).toMatchObject({ state: "blocked" });
    expect(inspection.serve.detail).toContain("predates verifiable Serve ownership");
    await expect(uninstallMac(harness.common)).rejects.toThrow("Mac uninstall is blocked");
    expect(harness.runCommand.mock.calls.some(([, arguments_]) => arguments_.includes("off"))).toBe(false);
  });

  it("rolls back a newly created Serve route when its post-configuration proof fails", async () => {
    const test = await fixture();
    let configured = false;
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (executable === test.tailscale && arguments_[0] === "status") {
        return commandResult(JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "mac.example.ts.net." },
        }));
      }
      if (executable === test.tailscale && arguments_[0] === "funnel") return commandResult("{}");
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_[1] === "status") {
        return commandResult(configured ? "{unreadable" : "null");
      }
      if (executable === test.tailscale && arguments_[0] === "serve") {
        configured = arguments_.at(-1) !== "off";
        return commandResult();
      }
      return commandResult("", 1, "unexpected command");
    });

    await expect(setupMac({
      platform: "darwin",
      homeDirectory: test.home,
      repositoryRoot: test.repository,
      environment: { PATH: test.bin, CODEX_PAD_CODEX_BINARY: test.codex },
      filesystemUid: process.getuid?.() ?? 0,
      runCommand,
      inspectPreflight: async () => limitedPreflight,
    })).rejects.toThrow("new route was rolled back");
    expect(configured).toBe(false);
    expect(runCommand.mock.calls.some(([, arguments_]) => arguments_.at(-1) === "off")).toBe(true);
    expect(runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
  });

  it("rotates stdout and stderr together into four private setup-time generations", async () => {
    const test = await fixture();
    const harness = managedBridgeHarness(test);
    await setupMac(harness.common);
    const runtime = codexPadPaths(test.home).runtime;
    const stdout = join(runtime, "bridge.stdout.log");
    const stderr = join(runtime, "bridge.stderr.log");
    await writeFile(stdout, "o".repeat(MANAGED_LOG_ROTATION_BYTES));
    await writeFile(stderr, "current stderr");
    await writeFile(`${stdout}.1`, "previous stdout");
    await writeFile(`${stderr}.1`, "previous stderr");
    await writeFile(`${stdout}.4`, "oldest stdout");
    await writeFile(`${stderr}.4`, "oldest stderr");

    await setupMac(harness.common);

    await expect(readFile(`${stdout}.1`, "utf8")).resolves.toHaveLength(MANAGED_LOG_ROTATION_BYTES);
    await expect(readFile(`${stdout}.2`, "utf8")).resolves.toBe("previous stdout");
    await expect(readFile(`${stderr}.1`, "utf8")).resolves.toBe("current stderr");
    await expect(readFile(`${stderr}.2`, "utf8")).resolves.toBe("previous stderr");
    await expect(readFile(`${stdout}.4`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${stderr}.4`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(`${stdout}.1`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${stderr}.1`)).mode & 0o777).toBe(0o600);
  });

  it("refuses unsafe managed log links before stopping the service", async () => {
    const test = await fixture();
    const harness = managedBridgeHarness(test);
    await setupMac(harness.common);
    const runtime = codexPadPaths(test.home).runtime;
    const stderr = join(runtime, "bridge.stderr.log");
    await writeFile(stderr, "e".repeat(MANAGED_LOG_ROTATION_BYTES));
    await link(stderr, join(test.root, "bridge-log-hardlink"));
    harness.runCommand.mockClear();

    await expect(setupMac(harness.common)).rejects.toThrow("unsafe managed bridge log path");
    expect(harness.runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
    await expect(readFile(stderr, "utf8")).resolves.toHaveLength(MANAGED_LOG_ROTATION_BYTES);
  });

  it("retains current log evidence when the exact LaunchAgent cannot be stopped", async () => {
    const test = await fixture();
    const harness = managedBridgeHarness(test);
    await setupMac(harness.common);
    const stderr = join(codexPadPaths(test.home).runtime, "bridge.stderr.log");
    await writeFile(stderr, "e".repeat(MANAGED_LOG_ROTATION_BYTES));
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[], _timeoutMs?: number) => {
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") {
        return commandResult("", 77, "operation not permitted");
      }
      return harness.runCommand(executable, arguments_);
    });

    await expect(setupMac({ ...harness.common, runCommand })).rejects.toThrow(
      "Could not stop the exact Nerva LaunchAgent before log rotation",
    );
    await expect(readFile(stderr, "utf8")).resolves.toHaveLength(MANAGED_LOG_ROTATION_BYTES);
    await expect(readFile(`${stderr}.1`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(runCommand.mock.calls.some(([, arguments_]) => arguments_[0] === "bootstrap")).toBe(false);
  });

  it("retains a LaunchAgent that changes after bootout instead of unlinking a replacement", async () => {
    const test = await fixture();
    const harness = managedBridgeHarness(test);
    const installed = await setupMac(harness.common);
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[], _timeoutMs?: number) => {
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") {
        await writeFile(installed.launchAgentPath, "replacement plist\n");
        await chmod(installed.launchAgentPath, 0o600);
        return commandResult();
      }
      return harness.runCommand(executable, arguments_);
    });

    await expect(uninstallMac({ ...harness.common, runCommand })).resolves.toMatchObject({
      state: "partial",
      serveRemoved: true,
      launchAgentRemoved: false,
      errors: [expect.stringContaining("LaunchAgent changed while uninstalling")],
    });
    await expect(readFile(installed.launchAgentPath, "utf8")).resolves.toBe("replacement plist\n");
    expect(harness.exactServeReady()).toBe(false);
  });

  it("detects unrelated Serve mutation and stops before changing launchd", async () => {
    const test = await fixture();
    const harness = managedBridgeHarness(test);
    const installed = await setupMac(harness.common);
    let afterRemoval = false;
    const runCommand = vi.fn(async (executable: string, arguments_: readonly string[], _timeoutMs?: number) => {
      if (executable === test.tailscale && arguments_[0] === "serve" && arguments_.at(-1) === "off") {
        const result = await harness.runCommand(executable, arguments_);
        afterRemoval = true;
        return result;
      }
      if (
        afterRemoval
        && executable === test.tailscale
        && arguments_[0] === "serve"
        && arguments_[1] === "status"
      ) {
        return commandResult(JSON.stringify({
          TCP: { "8443": { HTTPS: true } },
          Web: {
            "mac.example.ts.net:8443": {
              Handlers: { "/docs": { Proxy: "http://127.0.0.1:9001" } },
            },
          },
        }));
      }
      return harness.runCommand(executable, arguments_);
    });

    await expect(uninstallMac({ ...harness.common, runCommand })).resolves.toMatchObject({
      state: "partial",
      serveRemoved: true,
      launchAgentRemoved: false,
      errors: [expect.stringContaining("unrelated Tailscale Serve route changed")],
    });
    await expect(readFile(installed.launchAgentPath, "utf8")).resolves.toContain(LAUNCH_AGENT_LABEL);
    expect(runCommand.mock.calls.some(([executable]) => executable === "/bin/launchctl")).toBe(false);
  });
});

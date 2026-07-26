import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LAUNCH_AGENT_LABEL,
  createMacPairing,
  setupMac,
} from "../src/mac-setup.js";
import { defaultDataPaths } from "../src/paths.js";
import { pairingNonceFromUrl } from "../src/pairing.js";
import { codexPadPaths } from "../src/setup.js";
import type { CommandResult } from "../src/doctor.js";

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
    Web: {
      "mac.example.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } },
      },
    },
  });
}

describe("macOS one-command setup", () => {
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
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    expect(first.serveChanged).toBe(true);
    expect(first.launchAgentChanged).toBe(true);
    expect(first.managedDaemonConfigured).toBe(true);
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
    expect(commands).toContainEqual({
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
    });

    expect(result.legacyAppServerLaunchAgentRemoved).toBe(true);
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a managed daemon whose Codex version differs from Desktop before changing launchd", async () => {
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
        return commandResult(JSON.stringify({
          status: "running",
          cliVersion: "0.146.0-alpha.3.1",
          managedCodexVersion: "0.145.0",
          appServerVersion: "0.145.0",
        }));
      }
      if (executable === test.codex) return commandResult();
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") return commandResult("", 1);
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
    })).rejects.toThrow("Managed app-server version mismatch");

    expect(runCommand.mock.calls.some(([executable, arguments_]) => (
      executable === "/bin/launchctl" && arguments_[0] === "setenv"
    ))).toBe(false);
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
      if (executable === "/bin/launchctl" && arguments_[0] === "bootout") return commandResult("", 1);
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
});

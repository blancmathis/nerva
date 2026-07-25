import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctorCodexPad, formatDoctorReport, runCommand, type CommandResult } from "../src/doctor.js";
import { PairingStore, pairingNonceFromUrl } from "../src/pairing.js";
import { defaultDataPaths } from "../src/paths.js";
import { setupCodexPad } from "../src/setup.js";
import type { WssProbeResult } from "../src/wss-probe.js";

async function fakeDesktop(): Promise<{ home: string; app: string; binary: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-doctor-test-"));
  const home = join(root, "home");
  const app = join(root, "ChatGPT.app");
  const binary = join(app, "Contents", "Resources", "codex");
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await mkdir(home);
  await writeFile(join(app, "Contents", "Info.plist"), "plist");
  await writeFile(binary, "binary");
  await chmod(binary, 0o700);
  return { home, app, binary };
}

function result(stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { stdout, exitCode, stderr };
}

async function networkReadyDoctor(
  probeResult: WssProbeResult,
  bridgeHealthy = true,
  funnelStatus: CommandResult = result("{}"),
) {
  const fixture = await fakeDesktop();
  const setup = await setupCodexPad({ homeDirectory: fixture.home, platform: "darwin" });
  const paths = defaultDataPaths(setup.paths.root);
  const pairing = await new PairingStore({ paths }).rotate({
    publicOrigin: "https://mac.example.ts.net",
  });
  const tailscale = join(fixture.home, "tailscale");
  await writeFile(tailscale, "fixture");
  await chmod(tailscale, 0o700);
  const probeWss = vi.fn(async () => probeResult);
  const runCommand = vi.fn(async (executable: string, arguments_: readonly string[]) => {
    if (executable === "/usr/bin/plutil") return result("test\n");
    if (executable === fixture.binary) return result("codex-cli test\n");
    if (executable === "/bin/ps") {
      return result(" 101 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n");
    }
    if (executable === tailscale && arguments_[0] === "funnel") {
      return funnelStatus;
    }
    if (executable === tailscale && arguments_[0] === "status") {
      return result(JSON.stringify({
        BackendState: "Running",
        Self: { Online: true, DNSName: "mac.example.ts.net." },
      }));
    }
    if (executable === tailscale && arguments_[0] === "serve") {
      return result(JSON.stringify({
        Web: { "mac.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } },
      }));
    }
    if (executable === "/usr/sbin/lsof") {
      return result("node 123 user 20u IPv4 TCP 127.0.0.1:8787 (LISTEN)\n");
    }
    return result("", 1, "not running");
  });
  const report = await doctorCodexPad({
    homeDirectory: fixture.home,
    platform: "darwin",
    architecture: "arm64",
    applicationCandidates: [fixture.app],
    environment: { PATH: fixture.home },
    runCommand,
    fetch: async (input) => {
      if (String(input).endsWith("/api/health") && bridgeHealthy) {
        return Response.json({ ok: true, data: { version: "0.1.0", state: "ready" } });
      }
      return new Response("not found", { status: 404 });
    },
    probeWss,
  });
  return { report, probeWss, pairing, runCommand, tailscale };
}

describe("doctorCodexPad", () => {
  it("forces the bundled macOS Tailscale executable into CLI mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-pad-tailscale-cli-test-"));
    const executable = join(root, "Tailscale");
    await writeFile(executable, "#!/bin/sh\nprintf '%s' \"$TAILSCALE_BE_CLI\"\n");
    await chmod(executable, 0o700);

    await expect(runCommand(executable, [])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "1",
    });
  });

  it("separates installation proof from missing managed transport and CDP", async () => {
    const fixture = await fakeDesktop();
    await setupCodexPad({ homeDirectory: fixture.home, platform: "darwin" });
    const commands: string[] = [];
    const report = await doctorCodexPad({
      homeDirectory: fixture.home,
      platform: "darwin",
      architecture: "arm64",
      applicationCandidates: [fixture.app],
      environment: { PATH: "" },
      runCommand: async (executable, arguments_) => {
        commands.push(`${executable} ${arguments_.join(" ")}`);
        if (executable === "/usr/bin/plutil") {
          const key = arguments_[1];
          if (key === "CFBundleIdentifier") return result("com.openai.codex\n");
          if (key === "CFBundleShortVersionString") return result("26.test\n");
          return result("1\n");
        }
        if (executable === fixture.binary) return result("codex-cli 0.test\n");
        if (executable === "/bin/ps") {
          return result(" 101 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n");
        }
        return result("", 1, "not running");
      },
      fetch: async () => new Response("not found", { status: 404 }),
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    expect(report.desktop).toMatchObject({ binaryVersion: "codex-cli 0.test" });
    expect(report.checks.find((check) => check.id === "desktop-installation")?.status).toBe("green");
    expect(report.checks.find((check) => check.id === "managed-app-server")?.status).toBe("red");
    expect(report.checks.find((check) => check.id === "desktop-shared-ownership")?.status).toBe("red");
    expect(report.checks.find((check) => check.id === "cdp-loopback")?.status).toBe("red");
    expect(report.checks.find((check) => check.id === "micro-six-slots")?.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "tailscale-funnel")?.status).toBe("red");
    expect(report.overall).toBe("red");
    expect(commands.some((command) => command.includes("daemon bootstrap"))).toBe(false);
    expect(commands.some((command) => command.includes("tailscale serve --bg"))).toBe(false);
    expect(formatDoctorReport(report)).toContain("Explicit commands (never run by doctor)");
    expect(formatDoctorReport(report)).toContain("ownership has not been attested");
  });

  it("marks the six-slot adapter green only for six fresh authoritative slots", async () => {
    const fixture = await fakeDesktop();
    const report = await doctorCodexPad({
      homeDirectory: fixture.home,
      platform: "darwin",
      applicationCandidates: [fixture.app],
      environment: { PATH: "" },
      runCommand: async (executable, arguments_) => {
        if (executable === "/usr/bin/plutil") return result("test\n");
        if (executable === fixture.binary) return result("codex-cli test\n");
        if (executable === "/bin/ps") {
          return result(
            " 101 1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222\n",
          );
        }
        if (executable === "/usr/sbin/lsof") return result("", 1);
        return result("", 1);
      },
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/json/list")) {
          return new Response(JSON.stringify([{ type: "page", url: "app://codex/index.html" }]));
        }
        return new Response("not found", { status: 404 });
      },
      probeMicro: async (port) => ({ ready: port === 9222, stale: false, slotCount: 6 }),
    });

    expect(report.checks.find((check) => check.id === "cdp-loopback")?.status).toBe("green");
    expect(report.checks.find((check) => check.id === "micro-six-slots")?.status).toBe("green");
  });

  it("marks Serve green only after a bounded same-origin WSS upgrade reaches the auth close", async () => {
    const { report, probeWss, pairing, runCommand, tailscale } = await networkReadyDoctor({
      outcome: "upgraded",
      closeCode: 4401,
      receivedData: false,
    });

    expect(probeWss).toHaveBeenCalledOnce();
    expect(probeWss).toHaveBeenCalledWith({
      url: "wss://mac.example.ts.net/ws",
      origin: "https://mac.example.ts.net",
      timeoutMs: 3_000,
    });
    expect(runCommand).toHaveBeenCalledWith(tailscale, ["funnel", "status", "--json"]);
    expect(report.checks.find((check) => check.id === "tailscale-funnel")?.status).toBe("green");
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("green");
    expect(report.checks.find((check) => check.id === "tailscale-wss")).toMatchObject({
      status: "green",
      detail: "Upgrade succeeded; bridge close code 4401.",
    });
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.remediation?.[0]).toBe(
      `TAILSCALE_BE_CLI=1 '${tailscale}' serve --bg --https=443 http://127.0.0.1:8787`,
    );
    expect(report.safeCommands).toContainEqual({
      purpose: "Publish only the loopback bridge through tailnet HTTPS",
      command: `TAILSCALE_BE_CLI=1 '${tailscale}' serve --bg --https=443 http://127.0.0.1:8787`,
      requiresExplicitUserAction: true,
    });
    expect(formatDoctorReport(report)).not.toContain(
      pairingNonceFromUrl(pairing.qrPayload) ?? "secret-that-is-not-present",
    );
  });

  it("fails red and withholds private Serve green when Funnel is enabled for the bridge route", async () => {
    const { report, probeWss, runCommand, tailscale } = await networkReadyDoctor({
      outcome: "upgraded",
      closeCode: 4401,
      receivedData: false,
    }, true, result(JSON.stringify({
      AllowFunnel: { "mac.example.ts.net:443": true },
    })));

    expect(probeWss).toHaveBeenCalledOnce();
    expect(report.checks.find((check) => check.id === "tailscale-funnel")).toMatchObject({
      status: "red",
      detail: "Funnel is enabled for the configured bridge route.",
    });
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "tailscale-wss")?.status).toBe("green");
    expect(report.overall).toBe("red");
    const tailscaleCalls = runCommand.mock.calls
      .filter(([executable]) => executable === tailscale)
      .map(([, arguments_]) => arguments_);
    expect(tailscaleCalls).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
      ["funnel", "status", "--json"],
    ]);
  });

  it("fails red when the authoritative Funnel query is unavailable", async () => {
    const { report } = await networkReadyDoctor({
      outcome: "upgraded",
      closeCode: 4401,
      receivedData: false,
    }, true, result("", 1, "unsupported"));

    expect(report.checks.find((check) => check.id === "tailscale-funnel")).toMatchObject({
      status: "red",
      detail: "`tailscale funnel status --json` did not complete successfully.",
    });
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("warn");
    expect(report.overall).toBe("red");
  });

  it("fails red when Funnel status JSON is ambiguous", async () => {
    const { report } = await networkReadyDoctor({
      outcome: "upgraded",
      closeCode: 4401,
      receivedData: false,
    }, true, result(JSON.stringify({ AllowFunnel: [] })));

    expect(report.checks.find((check) => check.id === "tailscale-funnel")).toMatchObject({
      status: "red",
      detail: "Funnel status does not match the supported ServeConfig JSON shape.",
    });
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("warn");
    expect(report.overall).toBe("red");
  });

  it("fails red when Funnel status output is not JSON", async () => {
    const { report } = await networkReadyDoctor({
      outcome: "upgraded",
      closeCode: 4401,
      receivedData: false,
    }, true, result("Funnel off"));

    expect(report.checks.find((check) => check.id === "tailscale-funnel")).toMatchObject({
      status: "red",
      detail: "Funnel status JSON is unreadable.",
    });
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("warn");
  });

  it("detects an ephemeral foreground Funnel allowance for the bridge route", async () => {
    const { report } = await networkReadyDoctor({
      outcome: "upgraded",
      closeCode: 4401,
      receivedData: false,
    }, true, result(JSON.stringify({
      Foreground: {
        session: { AllowFunnel: { "mac.example.ts.net:443": true } },
      },
    })));

    expect(report.checks.find((check) => check.id === "tailscale-funnel")).toMatchObject({
      status: "red",
      detail: "Funnel is enabled for the configured bridge route.",
    });
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("warn");
  });

  it("keeps parsed Serve output warning-only when the live WSS attempt fails", async () => {
    const { report, probeWss } = await networkReadyDoctor({
      outcome: "network-error",
      upgraded: false,
    });

    expect(probeWss).toHaveBeenCalledOnce();
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "tailscale-wss")).toMatchObject({
      status: "warn",
      detail: "The bounded WSS probe failed before a protocol switch.",
    });
  });

  it("does not contact public WSS when the local bridge prerequisite is not healthy", async () => {
    const { report, probeWss } = await networkReadyDoctor({
      outcome: "upgraded",
      closeCode: 4401,
      receivedData: false,
    }, false);

    expect(probeWss).not.toHaveBeenCalled();
    expect(report.checks.find((check) => check.id === "tailscale-serve")?.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "tailscale-wss")).toMatchObject({
      status: "warn",
      detail: "The local Codex Pad bridge health/listener prerequisite failed.",
    });
  });

  it("offers attestation creation only after a positive co-presence probe", async () => {
    const fixture = await fakeDesktop();
    const report = await doctorCodexPad({
      homeDirectory: fixture.home,
      platform: "darwin",
      applicationCandidates: [fixture.app],
      environment: { PATH: "" },
      runCommand: async (executable) => {
        if (executable === "/usr/bin/plutil") return result("test\n");
        if (executable === fixture.binary) return result("codex-cli test\n");
        if (executable === "/bin/ps") return result("");
        return result("", 1);
      },
      fetch: async () => new Response("not found", { status: 404 }),
      inspectOwnership: async () => ({
        verified: false,
        canCreate: true,
        code: "attestation-missing",
        summary: "Shared Desktop ownership has not been attested; app-server mutations are disabled.",
      }),
    });

    expect(report.checks.find((check) => check.id === "desktop-shared-ownership")).toMatchObject({
      status: "red",
      detail: "Positive co-presence evidence is available for an explicit local attestation.",
    });
    expect(report.safeCommands).toContainEqual({
      purpose: "Create a local Desktop ownership attestation from the currently verified topology",
      command: "npm run setup -- --attest-desktop-ownership",
      requiresExplicitUserAction: true,
    });
  });
});

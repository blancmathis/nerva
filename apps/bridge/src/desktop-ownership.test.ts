import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectDesktopOwnershipEvidence,
  createDesktopOwnershipAttestation,
  inspectDesktopOwnership,
  verifyOfficialDesktopSignature,
  verifyDesktopProcessIdentityAtWriteBoundary,
  type DesktopOwnershipEvidence,
  type DesktopOwnershipInstallation,
  type OwnershipCommandRunner,
} from "./desktop-ownership.js";

const installation: DesktopOwnershipInstallation = {
  appPath: "/Applications/ChatGPT.app",
  bundleId: "com.openai.codex",
  appVersion: "26.test",
  buildVersion: "5591",
  binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  binaryVersion: "codex-cli 0.test",
  daemonBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  daemonBinaryVersion: "codex-cli 0.test",
};

function evidence(socketPath: string, daemonPid = 201): DesktopOwnershipEvidence {
  return {
    socket: {
      path: socketPath,
      device: "1",
      inode: "2",
      uid: process.getuid?.() ?? 501,
      listenerAddress: "a0",
      listenerKernelInode: "b0",
      listenerGeneration: "10",
    },
    daemon: { pid: daemonPid, startedAt: "Mon Jul 20 10:00:00 2026" },
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
      kind: "managed-proxy",
      pid: 301,
      startedAt: "Mon Jul 20 10:01:00 2026",
      serverEndpointAddress: "a1",
      serverEndpointGeneration: "12",
      clientEndpointAddress: "a2",
      clientEndpointGeneration: "11",
    },
    codex: {
      desktopBinaryPath: installation.binaryPath,
      desktopBinaryVersion: installation.binaryVersion,
      daemonBinaryPath: installation.daemonBinaryPath ?? installation.binaryPath,
      daemonBinaryVersion: installation.daemonBinaryVersion ?? installation.binaryVersion,
    },
  };
}

function netstatRow(input: {
  address: string;
  inode?: string;
  connection?: string;
  pid: number;
  state?: string;
  options?: string;
  generation: string;
  path?: string;
}): string {
  return [
    input.address,
    "stream",
    "0",
    "0",
    input.inode ?? "0",
    input.connection ?? "0",
    "0",
    "0",
    "0",
    "0",
    "8192",
    "8192",
    `test:${input.pid}`,
    input.state ?? "00102",
    input.options ?? "00000100",
    input.generation,
    "00008000",
    "00000000",
    "2",
    "0",
    "000000",
    ...(input.path === undefined ? [] : [input.path]),
  ].join(" ");
}

async function fixture(): Promise<{
  root: string;
  attestationPath: string;
  socketPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-ownership-test-"));
  const security = join(root, "security");
  await mkdir(security, { mode: 0o700 });
  return {
    root,
    attestationPath: join(security, "desktop-ownership-attestation.json"),
    socketPath: join(root, "managed.sock"),
  };
}

const unusedCommand: OwnershipCommandRunner = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "unused",
});

describe("Desktop ownership attestation", () => {
  it("accepts only the official bundle, Team ID, Developer ID and notarized assessment", async () => {
    const command: OwnershipCommandRunner = async (executable, arguments_) => {
      if (executable === "/usr/bin/codesign" && arguments_[0] === "--verify") {
        return { exitCode: 0, stdout: "", stderr: "valid on disk" };
      }
      if (executable === "/usr/bin/codesign" && arguments_[1] === "--verbose=4") {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "Identifier=com.openai.codex\nTeamIdentifier=2DC432GLL2\nAuthority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
        };
      }
      if (executable === "/usr/bin/codesign") {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "designated => identifier \"com.openai.codex\" and certificate leaf[subject.OU] = \"2DC432GLL2\"",
        };
      }
      return { exitCode: 0, stdout: "accepted\nsource=Notarized Developer ID", stderr: "" };
    };
    await expect(verifyOfficialDesktopSignature(installation, command)).resolves.toBe(true);
    await expect(verifyOfficialDesktopSignature({ ...installation, bundleId: "invalid.bundle" }, command)).resolves.toBe(false);
  });

  it("keeps mutation unavailable when the attestation is missing", async () => {
    const paths = await fixture();
    const current = evidence(paths.socketPath);
    const inspection = await inspectDesktopOwnership({
      attestationPath: paths.attestationPath,
      socketPath: paths.socketPath,
      codexBinaryPath: installation.binaryPath,
      installation,
      platform: "darwin",
      runCommand: unusedCommand,
      collectEvidence: async () => current,
    });

    expect(inspection).toMatchObject({
      verified: false,
      canCreate: true,
      code: "attestation-missing",
    });
    expect(inspection.summary).not.toMatch(/\/(?:Applications|Users)|PID|\.sock/i);
  });

  it("accepts only an exact current evidence match", async () => {
    const paths = await fixture();
    const current = evidence(paths.socketPath);
    await createDesktopOwnershipAttestation({
      attestationPath: paths.attestationPath,
      socketPath: paths.socketPath,
      installation,
      platform: "darwin",
      runCommand: unusedCommand,
      collectEvidence: async () => current,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    });

    await expect(
      inspectDesktopOwnership({
        attestationPath: paths.attestationPath,
        socketPath: paths.socketPath,
        codexBinaryPath: installation.binaryPath,
        platform: "darwin",
        runCommand: unusedCommand,
        collectEvidence: async () => current,
      }),
    ).resolves.toMatchObject({ verified: true, canCreate: false, code: "verified" });
  });

  it("rejects a stale daemon, socket, or Desktop process identity", async () => {
    const paths = await fixture();
    const attested = evidence(paths.socketPath);
    await createDesktopOwnershipAttestation({
      attestationPath: paths.attestationPath,
      socketPath: paths.socketPath,
      installation,
      platform: "darwin",
      runCommand: unusedCommand,
      collectEvidence: async () => attested,
    });

    const changedEvidence: DesktopOwnershipEvidence[] = [
      evidence(paths.socketPath, 202),
      { ...attested, socket: { ...attested.socket, inode: "3" } },
      { ...attested, socket: { ...attested.socket, listenerGeneration: "20" } },
      { ...attested, desktop: { ...attested.desktop, pid: 102 } },
      { ...attested, desktop: { ...attested.desktop, appVersion: "26.changed" } },
    ];
    for (const current of changedEvidence) {
      const inspection = await inspectDesktopOwnership({
        attestationPath: paths.attestationPath,
        socketPath: paths.socketPath,
        codexBinaryPath: installation.binaryPath,
        platform: "darwin",
        runCommand: unusedCommand,
        collectEvidence: async () => current,
      });

      expect(inspection).toMatchObject({
        verified: false,
        canCreate: true,
        code: "attestation-stale",
      });
    }
  });

  it("renews only a previously valid attestation after two identical safe topology probes", async () => {
    const paths = await fixture();
    const prior = evidence(paths.socketPath);
    await createDesktopOwnershipAttestation({
      attestationPath: paths.attestationPath,
      socketPath: paths.socketPath,
      installation,
      platform: "darwin",
      runCommand: unusedCommand,
      collectEvidence: async () => prior,
    });
    const updated: DesktopOwnershipEvidence = {
      ...prior,
      desktop: { ...prior.desktop, appVersion: "26.updated", buildVersion: "6000" },
      codex: {
        desktopBinaryPath: installation.binaryPath,
        desktopBinaryVersion: "codex-cli 0.updated",
        daemonBinaryPath: installation.daemonBinaryPath ?? installation.binaryPath,
        daemonBinaryVersion: "codex-cli 0.updated",
      },
    };
    const collectEvidence = vi.fn(async () => updated);
    const inspection = await inspectDesktopOwnership({
      attestationPath: paths.attestationPath,
      socketPath: paths.socketPath,
      codexBinaryPath: installation.binaryPath,
      installation: {
        ...installation,
        appVersion: "26.updated",
        buildVersion: "6000",
        binaryVersion: "codex-cli 0.updated",
        daemonBinaryVersion: "codex-cli 0.updated",
      },
      platform: "darwin",
      runCommand: unusedCommand,
      collectEvidence,
      allowSafeRenewal: true,
    });
    expect(inspection).toMatchObject({ verified: true, renewed: true, code: "verified" });
    expect(collectEvidence).toHaveBeenCalledTimes(2);
  });

  it("rejects a world-readable attestation even when its contents match", async () => {
    const paths = await fixture();
    const current = evidence(paths.socketPath);
    await createDesktopOwnershipAttestation({
      attestationPath: paths.attestationPath,
      socketPath: paths.socketPath,
      installation,
      platform: "darwin",
      runCommand: unusedCommand,
      collectEvidence: async () => current,
    });
    await chmod(paths.attestationPath, 0o644);

    await expect(
      inspectDesktopOwnership({
        attestationPath: paths.attestationPath,
        socketPath: paths.socketPath,
        codexBinaryPath: installation.binaryPath,
        installation,
        platform: "darwin",
        runCommand: unusedCommand,
        collectEvidence: async () => current,
      }),
    ).resolves.toMatchObject({ verified: false, code: "attestation-unsafe" });
  });

  it("requires a single daemon and Desktop-owned proxy on the same socket", async () => {
    const paths = await fixture();
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(paths.socketPath, () => resolveListen());
    });
    await chmod(paths.socketPath, 0o600);
    const desktopExecutable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const processTable = [
      `101 1 Mon Jul 20 09:59:00 2026 ${desktopExecutable}`,
      `201 1 Mon Jul 20 10:00:00 2026 ${installation.binaryPath} app-server daemon run`,
      `301 101 Mon Jul 20 10:01:00 2026 ${installation.binaryPath} app-server proxy --sock ${paths.socketPath}`,
      "401 1 Mon Jul 20 10:02:00 2026 /opt/tools/codex app-server",
    ].join("\n");
    const netstat = [
      netstatRow({
        address: "a0",
        inode: "b0",
        pid: 201,
        state: "00100",
        options: "00000002",
        generation: "10",
        path: paths.socketPath,
      }),
      netstatRow({
        address: "a1",
        connection: "a2",
        pid: 201,
        generation: "12",
        path: paths.socketPath,
      }),
      netstatRow({
        address: "a2",
        connection: "a1",
        pid: 301,
        generation: "11",
      }),
    ].join("\n");
    const runCommand: OwnershipCommandRunner = async (executable, arguments_) => {
      if (executable === "/bin/ps") return { exitCode: 0, stdout: processTable, stderr: "" };
      if (executable === "/usr/sbin/netstat") {
        return { exitCode: 0, stdout: netstat, stderr: "" };
      }
      const pid = Number(arguments_[arguments_.indexOf("-p") + 1]);
      const socketProbe = arguments_.includes("-U");
      if (pid === 101) {
        return socketProbe
          ? { exitCode: 1, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: `p101\nn${desktopExecutable}\n`, stderr: "" };
      }
      if (pid === 201 || pid === 301) {
        return socketProbe
          ? {
              exitCode: 0,
              stdout: pid === 201
                ? `p${pid}\nn${paths.socketPath}\n`
                : `p${pid}\nn->0x8ebd381c9f1e62bf\n`,
              stderr: "",
            }
          : { exitCode: 0, stdout: `p${pid}\nn${installation.binaryPath}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown process" };
    };

    try {
      const current = await collectDesktopOwnershipEvidence({
        installation,
        socketPath: paths.socketPath,
        platform: "darwin",
        runCommand,
        verifyDesktopSignature: async () => true,
      });
      expect(current).toMatchObject({
        daemon: { pid: 201 },
        desktop: { pid: 101, appVersion: "26.test" },
        desktopClient: { kind: "managed-proxy", pid: 301 },
      });
      expect(current.socket.inode).toMatch(/^\d+$/);
      expect(current.socket).toMatchObject({
        listenerAddress: "a0",
        listenerKernelInode: "b0",
        listenerGeneration: "10",
      });
      expect(current.desktopClient).toMatchObject({
        serverEndpointAddress: "a1",
        clientEndpointAddress: "a2",
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects a Desktop peer left on unlinked socket A after pathname replacement by socket B", async () => {
    const paths = await fixture();
    const serverB = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      serverB.once("error", rejectListen);
      serverB.listen(paths.socketPath, () => resolveListen());
    });
    await chmod(paths.socketPath, 0o600);
    const desktopExecutable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const processTable = [
      `101 1 Mon Jul 20 09:59:00 2026 ${desktopExecutable}`,
      `201 1 Mon Jul 20 10:00:00 2026 ${installation.binaryPath} app-server daemon run`,
      `301 101 Mon Jul 20 10:01:00 2026 ${installation.binaryPath} app-server proxy --sock ${paths.socketPath}`,
    ].join("\n");
    const splitGeneration = [
      // Replacement listener B was created after the accepted Desktop endpoint on A.
      netstatRow({
        address: "b0",
        inode: "b1",
        pid: 201,
        state: "00100",
        options: "00000002",
        generation: "20",
        path: paths.socketPath,
      }),
      netstatRow({
        address: "a1",
        connection: "a2",
        pid: 201,
        generation: "12",
        path: paths.socketPath,
      }),
      netstatRow({
        address: "a2",
        connection: "a1",
        pid: 301,
        generation: "11",
      }),
    ].join("\n");
    const runCommand: OwnershipCommandRunner = async (executable, arguments_) => {
      if (executable === "/bin/ps") return { exitCode: 0, stdout: processTable, stderr: "" };
      if (executable === "/usr/sbin/netstat") {
        return { exitCode: 0, stdout: splitGeneration, stderr: "" };
      }
      const pid = Number(arguments_[arguments_.indexOf("-p") + 1]);
      const socketProbe = arguments_.includes("-U");
      if (pid === 101) {
        return { exitCode: 0, stdout: `p101\nn${desktopExecutable}\n`, stderr: "" };
      }
      if (pid === 201) {
        return socketProbe
          ? { exitCode: 0, stdout: `p201\nn${paths.socketPath}\n`, stderr: "" }
          : { exitCode: 0, stdout: `p201\nn${installation.binaryPath}\n`, stderr: "" };
      }
      if (pid === 301) {
        return { exitCode: 0, stdout: `p301\nn${installation.binaryPath}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown process" };
    };

    try {
      await expect(
        collectDesktopOwnershipEvidence({
          installation,
          socketPath: paths.socketPath,
          platform: "darwin",
          runCommand,
          verifyDesktopSignature: async () => true,
        }),
      ).rejects.toMatchObject({ code: "topology-ambiguous" });
    } finally {
      await new Promise<void>((resolveClose) => serverB.close(() => resolveClose()));
    }
  });

  it("rechecks the exact Desktop PID, start generation, command, and executable at the write boundary", () => {
    const executablePath = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const identity = {
      pid: 101,
      startedAt: "Mon Jul 20 09:59:00 2026",
      executablePath,
    };
    const runCommand = (executable: string): string => executable === "/bin/ps"
      ? `101 1 Mon Jul 20 09:59:00 2026 ${executablePath}\n`
      : `p101\nn${executablePath}\n`;

    expect(verifyDesktopProcessIdentityAtWriteBoundary(identity, {
      platform: "darwin",
      runCommand,
    })).toBe(true);
    expect(verifyDesktopProcessIdentityAtWriteBoundary({
      ...identity,
      startedAt: "Mon Jul 20 10:00:00 2026",
    }, {
      platform: "darwin",
      runCommand,
    })).toBe(false);
    expect(verifyDesktopProcessIdentityAtWriteBoundary(identity, {
      platform: "darwin",
      runCommand: (executable) => executable === "/bin/ps"
        ? `101 1 Mon Jul 20 09:59:00 2026 ${executablePath}\n`
        : "p101\nn/Applications/Other.app/Contents/MacOS/Other\n",
    })).toBe(false);
  });
});

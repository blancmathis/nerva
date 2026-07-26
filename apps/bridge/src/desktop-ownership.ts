import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  collectUnixSocketTopology,
  UnixSocketTopologyError,
  type UnixSocketPeerIdentity,
} from "./unix-socket-generation.js";

export interface DesktopOwnershipInstallation {
  readonly appPath: string;
  readonly bundleId: string;
  readonly appVersion: string;
  readonly buildVersion: string;
  readonly binaryPath: string;
  readonly binaryVersion: string;
  readonly daemonBinaryPath?: string;
  readonly daemonBinaryVersion?: string;
}

export interface DesktopOwnershipEvidence {
  readonly socket: {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly uid: number;
    readonly listenerAddress: string;
    readonly listenerKernelInode: string;
    readonly listenerGeneration: string;
  };
  readonly daemon: {
    readonly pid: number;
    readonly startedAt: string;
  };
  readonly desktop: {
    readonly pid: number;
    readonly startedAt: string;
    readonly appPath: string;
    readonly executablePath: string;
    readonly bundleId: string;
    readonly appVersion: string;
    readonly buildVersion: string;
  };
  readonly desktopClient: {
    readonly kind: "direct" | "managed-proxy";
    readonly pid: number;
    readonly startedAt: string;
    readonly serverEndpointAddress: string;
    readonly serverEndpointGeneration: string;
    readonly clientEndpointAddress: string;
    readonly clientEndpointGeneration: string;
  };
  readonly codex: {
    readonly desktopBinaryPath: string;
    readonly desktopBinaryVersion: string;
    readonly daemonBinaryPath: string;
    readonly daemonBinaryVersion: string;
  } | {
    /** Legacy in-memory fixture shape. Attestation parsing never accepts it. */
    readonly binaryPath: string;
    readonly binaryVersion: string;
  };
}

export interface DesktopOwnershipAttestation {
  readonly formatVersion: 2;
  readonly createdAt: string;
  readonly evidence: DesktopOwnershipEvidence;
  readonly evidenceSha256: string;
}

export type DesktopOwnershipFailureCode =
  | "attestation-missing"
  | "attestation-unsafe"
  | "attestation-invalid"
  | "attestation-stale"
  | "topology-unavailable"
  | "topology-ambiguous"
  | "platform-unsupported";

export interface DesktopOwnershipInspection {
  readonly verified: boolean;
  readonly canCreate: boolean;
  readonly code: "verified" | DesktopOwnershipFailureCode;
  /** Safe for public health output: never contains paths, process IDs, or local content. */
  readonly summary: string;
  /** Private local evidence used only to create an attestation after a positive probe. */
  readonly currentEvidence?: DesktopOwnershipEvidence;
  readonly renewed?: boolean;
}

export interface OwnershipCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type OwnershipCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  timeoutMs?: number,
) => Promise<OwnershipCommandResult>;

const MAX_COMMAND_OUTPUT = 512 * 1024;

export const runOwnershipCommand: OwnershipCommandRunner = async (
  executable,
  arguments_,
  timeoutMs = 5_000,
) =>
  new Promise((resolveCommand) => {
    execFile(
      executable,
      [...arguments_],
      { encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException & { code?: number | string } | null)?.code;
        resolveCommand({
          exitCode: typeof code === "number" ? code : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error?.message ?? ""),
        });
      },
    );
  });

export interface CollectDesktopOwnershipOptions {
  readonly installation: DesktopOwnershipInstallation;
  readonly socketPath: string;
  readonly platform?: NodeJS.Platform;
  readonly runCommand: OwnershipCommandRunner;
  readonly verifyDesktopSignature?: (
    installation: DesktopOwnershipInstallation,
    runCommand: OwnershipCommandRunner,
  ) => Promise<boolean>;
}

export interface InspectDesktopOwnershipOptions {
  readonly attestationPath?: string;
  readonly socketPath: string;
  readonly codexBinaryPath: string;
  readonly installation?: DesktopOwnershipInstallation;
  readonly platform?: NodeJS.Platform;
  readonly runCommand: OwnershipCommandRunner;
  readonly collectEvidence?: (
    options: CollectDesktopOwnershipOptions,
  ) => Promise<DesktopOwnershipEvidence>;
  readonly allowSafeRenewal?: boolean;
  readonly now?: () => Date;
}

export interface CreateDesktopOwnershipAttestationOptions
  extends Omit<InspectDesktopOwnershipOptions, "codexBinaryPath"> {
  readonly installation: DesktopOwnershipInstallation;
  readonly now?: () => Date;
}

export interface DesktopOwnershipVerifier {
  verify(): Promise<DesktopOwnershipInspection>;
  verifyDesktopProcessAtWriteBoundary?(
    identity: DesktopProcessBoundaryIdentity,
  ): boolean;
}

export interface DesktopProcessBoundaryIdentity {
  readonly pid: number;
  readonly startedAt: string;
  readonly executablePath: string;
}

export interface VerifyDesktopProcessBoundaryOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: (executable: string, arguments_: readonly string[]) => string;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startedAt: string;
  readonly command: string;
}

class OwnershipProbeError extends Error {
  readonly code: "topology-unavailable" | "topology-ambiguous" | "platform-unsupported";

  constructor(
    code: "topology-unavailable" | "topology-ambiguous" | "platform-unsupported",
    message: string,
  ) {
    super(message);
    this.name = "OwnershipProbeError";
    this.code = code;
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HEX_PATTERN = /^[a-f0-9]+$/;
const PROCESS_START_PATTERN = /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;
const DEFAULT_SOCKET_PATH = join(
  homedir(),
  ".codex",
  "app-server-control",
  "app-server-control.sock",
);
const OPENAI_TEAM_ID = "2DC432GLL2";
const CODEX_BUNDLE_ID = "com.openai.codex";

export async function verifyOfficialDesktopSignature(
  installation: DesktopOwnershipInstallation,
  command: OwnershipCommandRunner,
): Promise<boolean> {
  if (installation.bundleId !== CODEX_BUNDLE_ID) return false;
  const [verify, details, requirement, assessment] = await Promise.all([
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", installation.appPath], 10_000),
    command("/usr/bin/codesign", ["-dv", "--verbose=4", installation.appPath], 10_000),
    command("/usr/bin/codesign", ["-d", "-r-", installation.appPath], 10_000),
    command("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", installation.appPath], 10_000),
  ]);
  const signature = `${details.stdout}\n${details.stderr}`;
  const designated = `${requirement.stdout}\n${requirement.stderr}`;
  const notarization = `${assessment.stdout}\n${assessment.stderr}`;
  return verify.exitCode === 0
    && details.exitCode === 0
    && requirement.exitCode === 0
    && assessment.exitCode === 0
    && signature.includes(`Identifier=${CODEX_BUNDLE_ID}`)
    && signature.includes(`TeamIdentifier=${OPENAI_TEAM_ID}`)
    && signature.includes(`Authority=Developer ID Application: OpenAI OpCo, LLC (${OPENAI_TEAM_ID})`)
    && designated.includes(`identifier \"${CODEX_BUNDLE_ID}\"`)
    && new RegExp(`certificate leaf\\[subject\\.OU\\].*\"${OPENAI_TEAM_ID}\"`).test(designated)
    && /accepted/i.test(notarization)
    && /Notarized Developer ID/i.test(notarization);
}

export function defaultDesktopOwnershipAttestationPath(homeDirectory = homedir()): string {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "CodexPad",
    "security",
    "desktop-ownership-attestation.json",
  );
}

function publicSummary(code: DesktopOwnershipInspection["code"]): string {
  switch (code) {
    case "verified":
      return "Shared Desktop ownership attestation matches the current managed transport topology.";
    case "attestation-missing":
      return "Shared Desktop ownership has not been attested; app-server mutations are disabled.";
    case "attestation-unsafe":
      return "The Desktop ownership attestation file is not private; app-server mutations are disabled.";
    case "attestation-invalid":
      return "The Desktop ownership attestation is invalid; app-server mutations are disabled.";
    case "attestation-stale":
      return "The Desktop ownership attestation no longer matches the running topology; app-server mutations are disabled.";
    case "topology-ambiguous":
      return "Desktop and managed app-server ownership is ambiguous; app-server mutations are disabled.";
    case "platform-unsupported":
      return "Desktop ownership attestation is supported only on macOS; app-server mutations are disabled.";
    case "topology-unavailable":
      return "Desktop is not positively connected to the managed app-server; app-server mutations are disabled.";
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonEmptyString(value: unknown, maxLength = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function absolutePath(value: unknown): value is string {
  return nonEmptyString(value) && isAbsolute(value) && !value.includes("\0");
}

function parseEvidence(value: unknown): DesktopOwnershipEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const socket = candidate.socket as Record<string, unknown> | undefined;
  const daemon = candidate.daemon as Record<string, unknown> | undefined;
  const desktop = candidate.desktop as Record<string, unknown> | undefined;
  const desktopClient = candidate.desktopClient as Record<string, unknown> | undefined;
  const codex = candidate.codex as Record<string, unknown> | undefined;
  if (
    socket === undefined ||
    daemon === undefined ||
    desktop === undefined ||
    desktopClient === undefined ||
    codex === undefined ||
    !absolutePath(socket.path) ||
    typeof socket.device !== "string" ||
    !/^\d+$/.test(socket.device) ||
    typeof socket.inode !== "string" ||
    !/^\d+$/.test(socket.inode) ||
    !Number.isSafeInteger(socket.uid) ||
    Number(socket.uid) < 0 ||
    typeof socket.listenerAddress !== "string" ||
    !HEX_PATTERN.test(socket.listenerAddress) ||
    typeof socket.listenerKernelInode !== "string" ||
    !HEX_PATTERN.test(socket.listenerKernelInode) ||
    typeof socket.listenerGeneration !== "string" ||
    !HEX_PATTERN.test(socket.listenerGeneration) ||
    !positiveInteger(daemon.pid) ||
    typeof daemon.startedAt !== "string" ||
    !PROCESS_START_PATTERN.test(daemon.startedAt) ||
    !positiveInteger(desktop.pid) ||
    typeof desktop.startedAt !== "string" ||
    !PROCESS_START_PATTERN.test(desktop.startedAt) ||
    !absolutePath(desktop.appPath) ||
    !absolutePath(desktop.executablePath) ||
    !nonEmptyString(desktop.bundleId, 256) ||
    !nonEmptyString(desktop.appVersion, 256) ||
    !nonEmptyString(desktop.buildVersion, 256) ||
    !["direct", "managed-proxy"].includes(String(desktopClient.kind)) ||
    !positiveInteger(desktopClient.pid) ||
    typeof desktopClient.startedAt !== "string" ||
    !PROCESS_START_PATTERN.test(desktopClient.startedAt) ||
    typeof desktopClient.serverEndpointAddress !== "string" ||
    !HEX_PATTERN.test(desktopClient.serverEndpointAddress) ||
    typeof desktopClient.serverEndpointGeneration !== "string" ||
    !HEX_PATTERN.test(desktopClient.serverEndpointGeneration) ||
    typeof desktopClient.clientEndpointAddress !== "string" ||
    !HEX_PATTERN.test(desktopClient.clientEndpointAddress) ||
    typeof desktopClient.clientEndpointGeneration !== "string" ||
    !HEX_PATTERN.test(desktopClient.clientEndpointGeneration) ||
    !absolutePath(codex.desktopBinaryPath) ||
    !nonEmptyString(codex.desktopBinaryVersion, 256) ||
    !absolutePath(codex.daemonBinaryPath) ||
    !nonEmptyString(codex.daemonBinaryVersion, 256)
  ) {
    return undefined;
  }
  return {
    socket: {
      path: socket.path,
      device: socket.device,
      inode: socket.inode,
      uid: Number(socket.uid),
      listenerAddress: socket.listenerAddress,
      listenerKernelInode: socket.listenerKernelInode,
      listenerGeneration: socket.listenerGeneration,
    },
    daemon: { pid: daemon.pid, startedAt: daemon.startedAt },
    desktop: {
      pid: desktop.pid,
      startedAt: desktop.startedAt,
      appPath: desktop.appPath,
      executablePath: desktop.executablePath,
      bundleId: desktop.bundleId,
      appVersion: desktop.appVersion,
      buildVersion: desktop.buildVersion,
    },
    desktopClient: {
      kind: desktopClient.kind as "direct" | "managed-proxy",
      pid: desktopClient.pid,
      startedAt: desktopClient.startedAt,
      serverEndpointAddress: desktopClient.serverEndpointAddress,
      serverEndpointGeneration: desktopClient.serverEndpointGeneration,
      clientEndpointAddress: desktopClient.clientEndpointAddress,
      clientEndpointGeneration: desktopClient.clientEndpointGeneration,
    },
    codex: {
      desktopBinaryPath: codex.desktopBinaryPath,
      desktopBinaryVersion: codex.desktopBinaryVersion,
      daemonBinaryPath: codex.daemonBinaryPath,
      daemonBinaryVersion: codex.daemonBinaryVersion,
    },
  };
}

function evidenceDigest(evidence: DesktopOwnershipEvidence): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function parseAttestation(value: unknown): DesktopOwnershipAttestation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const evidence = parseEvidence(candidate.evidence);
  if (
    candidate.formatVersion !== 2 ||
    !nonEmptyString(candidate.createdAt, 64) ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    evidence === undefined ||
    typeof candidate.evidenceSha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.evidenceSha256) ||
    candidate.evidenceSha256 !== evidenceDigest(evidence)
  ) {
    return undefined;
  }
  return {
    formatVersion: 2,
    createdAt: candidate.createdAt,
    evidence,
    evidenceSha256: candidate.evidenceSha256,
  };
}

function parseProcessRows(output: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
    );
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const startedAt = match[3];
    const command = match[4];
    if (
      positiveInteger(pid) &&
      Number.isSafeInteger(ppid) &&
      ppid >= 0 &&
      startedAt !== undefined &&
      PROCESS_START_PATTERN.test(startedAt) &&
      command !== undefined
    ) {
      rows.push({ pid, ppid, startedAt, command });
    }
  }
  return rows;
}

function executableArguments(command: string, executablePath: string): string | undefined {
  const candidates = [executablePath, `\"${executablePath}\"`, basename(executablePath)];
  for (const candidate of candidates) {
    if (command === candidate) return "";
    if (command.startsWith(`${candidate} `)) return command.slice(candidate.length + 1);
  }
  return undefined;
}

function hasExactSocketArgument(arguments_: string, socketPath: string): boolean {
  const escaped = socketPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)--sock(?:=|\\s+)(?:\"${escaped}\"|'${escaped}'|${escaped})(?:\\s|$)`).test(
    arguments_,
  );
}

function isDescendant(
  candidate: ProcessRow,
  ancestorPid: number,
  byPid: ReadonlyMap<number, ProcessRow>,
): boolean {
  const visited = new Set<number>();
  let parent = candidate.ppid;
  while (parent > 0 && !visited.has(parent)) {
    if (parent === ancestorPid) return true;
    visited.add(parent);
    parent = byPid.get(parent)?.ppid ?? 0;
  }
  return false;
}

function lsofNames(output: string): readonly string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

/**
 * Synchronous final-sink proof for the attested Desktop process generation.
 * The asynchronous ownership probe is not enough: a Desktop parent can exit
 * after issuance while its app-server socket client remains connected.
 */
export function verifyDesktopProcessIdentityAtWriteBoundary(
  expected: DesktopProcessBoundaryIdentity,
  options: VerifyDesktopProcessBoundaryOptions = {},
): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  if (
    !positiveInteger(expected.pid)
    || !PROCESS_START_PATTERN.test(expected.startedAt)
    || !absolutePath(expected.executablePath)
  ) {
    return false;
  }
  const run = options.runCommand ?? ((executable: string, arguments_: readonly string[]): string =>
    execFileSync(executable, [...arguments_], {
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT,
      timeout: 3_000,
    }));
  try {
    const rows = parseProcessRows(run("/bin/ps", [
      "-p",
      String(expected.pid),
      "-o",
      "pid=,ppid=,lstart=,command=",
    ]));
    const row = rows.length === 1 ? rows[0] : undefined;
    if (
      row === undefined
      || row.pid !== expected.pid
      || row.startedAt !== expected.startedAt
      || executableArguments(row.command, expected.executablePath) === undefined
    ) {
      return false;
    }
    return lsofNames(run("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      String(expected.pid),
      "-d",
      "txt",
      "-Fn",
    ])).includes(expected.executablePath);
  } catch {
    return false;
  }
}

async function processHasExactExecutable(
  runCommand: OwnershipCommandRunner,
  pid: number,
  executablePath: string,
): Promise<boolean> {
  const result = await runCommand(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"],
    3_000,
  );
  return result.exitCode === 0 && lsofNames(result.stdout).includes(executablePath);
}

async function processHasSocket(
  runCommand: OwnershipCommandRunner,
  pid: number,
  socketPath: string,
): Promise<boolean> {
  const result = await runCommand(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), "-U", "-Fn"],
    3_000,
  );
  return result.exitCode === 0 && lsofNames(result.stdout).some((name) =>
    name === socketPath ||
    name.startsWith(`${socketPath} `) ||
    name.startsWith(`${socketPath}->`) ||
    name.endsWith(`->${socketPath}`) ||
    name.includes(`->${socketPath} `),
  );
}

function desktopExecutablePath(appPath: string): string {
  return join(appPath, "Contents", "MacOS", basename(appPath, ".app"));
}

function normalizedInstallation(
  installation: DesktopOwnershipInstallation,
): Required<DesktopOwnershipInstallation> {
  if (
    !absolutePath(installation.appPath) ||
    !absolutePath(installation.binaryPath) ||
    !nonEmptyString(installation.bundleId, 256) ||
    !nonEmptyString(installation.appVersion, 256) ||
    !nonEmptyString(installation.buildVersion, 256) ||
    !nonEmptyString(installation.binaryVersion, 256)
    || (installation.daemonBinaryPath !== undefined && !absolutePath(installation.daemonBinaryPath))
    || (installation.daemonBinaryVersion !== undefined && !nonEmptyString(installation.daemonBinaryVersion, 256))
  ) {
    throw new OwnershipProbeError(
      "topology-unavailable",
      "Installed Desktop identity is incomplete.",
    );
  }
  return {
    appPath: resolve(installation.appPath),
    bundleId: installation.bundleId,
    appVersion: installation.appVersion,
    buildVersion: installation.buildVersion,
    binaryPath: resolve(installation.binaryPath),
    binaryVersion: installation.binaryVersion,
    daemonBinaryPath: resolve(installation.daemonBinaryPath ?? installation.binaryPath),
    daemonBinaryVersion: installation.daemonBinaryVersion ?? installation.binaryVersion,
  };
}

export async function collectDesktopOwnershipEvidence(
  options: CollectDesktopOwnershipOptions,
): Promise<DesktopOwnershipEvidence> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new OwnershipProbeError("platform-unsupported", "macOS is required.");
  }
  const installation = normalizedInstallation(options.installation);
  if (!(await (options.verifyDesktopSignature ?? verifyOfficialDesktopSignature)(installation, options.runCommand))) {
    throw new OwnershipProbeError(
      "topology-unavailable",
      "Codex Desktop signature, Team ID, bundle identity, or notarization is not trusted.",
    );
  }
  if (!absolutePath(options.socketPath)) {
    throw new OwnershipProbeError(
      "topology-unavailable",
      "The managed socket path is invalid.",
    );
  }
  const socketPath = resolve(options.socketPath);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(socketPath, { bigint: true });
  } catch {
    throw new OwnershipProbeError("topology-unavailable", "The managed socket is absent.");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    before.isSymbolicLink() ||
    !before.isSocket() ||
    (before.mode & 0o077n) !== 0n ||
    (currentUid !== undefined && before.uid !== BigInt(currentUid))
  ) {
    throw new OwnershipProbeError("topology-unavailable", "The managed socket is not private.");
  }

  const processResult = await options.runCommand(
    "/bin/ps",
    ["-axo", "pid=,ppid=,lstart=,command="],
    5_000,
  );
  if (processResult.exitCode !== 0) {
    throw new OwnershipProbeError("topology-unavailable", "Process topology is unavailable.");
  }
  const processes = parseProcessRows(processResult.stdout);
  const byPid = new Map(processes.map((process_) => [process_.pid, process_]));
  const desktopExecutable = desktopExecutablePath(installation.appPath);
  const desktopCandidates = processes.filter(
    (process_) => executableArguments(process_.command, desktopExecutable) !== undefined,
  );
  if (desktopCandidates.length !== 1) {
    throw new OwnershipProbeError(
      desktopCandidates.length > 1 ? "topology-ambiguous" : "topology-unavailable",
      "Exactly one main Desktop process is required.",
    );
  }
  const desktop = desktopCandidates[0];
  if (
    desktop === undefined ||
    !(await processHasExactExecutable(options.runCommand, desktop.pid, desktopExecutable))
  ) {
    throw new OwnershipProbeError(
      "topology-unavailable",
      "The main Desktop executable could not be verified.",
    );
  }

  const daemonCandidates: ProcessRow[] = [];
  const proxyCandidates: ProcessRow[] = [];
  for (const process_ of processes) {
    const daemonArguments = executableArguments(process_.command, installation.daemonBinaryPath);
    const desktopCodexArguments = executableArguments(process_.command, installation.binaryPath);
    if (daemonArguments !== undefined && /^app-server\s+daemon(?:\s|$)/.test(daemonArguments)) {
      daemonCandidates.push(process_);
    }
    if (
      desktopCodexArguments !== undefined
      && /^app-server\s+proxy(?:\s|$)/.test(desktopCodexArguments) &&
      hasExactSocketArgument(desktopCodexArguments, socketPath) &&
      isDescendant(process_, desktop.pid, byPid)
    ) {
      proxyCandidates.push(process_);
    }
  }
  const verifiedDaemons: ProcessRow[] = [];
  for (const daemon of daemonCandidates) {
    if (
      (await processHasExactExecutable(options.runCommand, daemon.pid, installation.daemonBinaryPath)) &&
      (await processHasSocket(options.runCommand, daemon.pid, socketPath))
    ) {
      verifiedDaemons.push(daemon);
    }
  }
  if (verifiedDaemons.length !== 1) {
    throw new OwnershipProbeError(
      verifiedDaemons.length > 1 ? "topology-ambiguous" : "topology-unavailable",
      "Exactly one managed daemon must own the configured socket.",
    );
  }

  const daemon = verifiedDaemons[0];
  if (daemon === undefined) {
    throw new OwnershipProbeError("topology-unavailable", "Ownership evidence is incomplete.");
  }
  let socketTopology: Awaited<ReturnType<typeof collectUnixSocketTopology>>;
  try {
    socketTopology = await collectUnixSocketTopology({
      socketPath,
      daemonPid: daemon.pid,
      runCommand: options.runCommand,
    });
  } catch (error) {
    if (error instanceof UnixSocketTopologyError) {
      throw new OwnershipProbeError(
        error.code === "ambiguous" ? "topology-ambiguous" : "topology-unavailable",
        "The managed socket generation could not be proven.",
      );
    }
    throw new OwnershipProbeError(
      "topology-unavailable",
      "The managed socket generation could not be inspected.",
    );
  }

  if (socketTopology.peers.length !== 1) {
    throw new OwnershipProbeError(
      socketTopology.peers.length > 1 ? "topology-ambiguous" : "topology-unavailable",
      "The managed socket must have exactly one Desktop-owned peer before the bridge connects.",
    );
  }

  const peerForPid = (pid: number): UnixSocketPeerIdentity | undefined => {
    const peers = socketTopology.peers.filter((peer) => peer.clientPid === pid);
    if (peers.length > 1) {
      throw new OwnershipProbeError(
        "topology-ambiguous",
        "A Desktop-owned client has multiple managed socket peers.",
      );
    }
    return peers[0];
  };
  const verifiedClients: Array<ProcessRow & {
    readonly kind: "direct" | "managed-proxy";
    readonly peer: UnixSocketPeerIdentity;
  }> = [];
  const directPeer = peerForPid(desktop.pid);
  if (directPeer !== undefined) {
    verifiedClients.push({ ...desktop, kind: "direct", peer: directPeer });
  }
  for (const proxy of proxyCandidates) {
    const peer = peerForPid(proxy.pid);
    if (
      peer !== undefined
      && (await processHasExactExecutable(options.runCommand, proxy.pid, installation.binaryPath))
    ) {
      verifiedClients.push({ ...proxy, kind: "managed-proxy", peer });
    }
  }
  if (verifiedClients.length !== 1) {
    throw new OwnershipProbeError(
      verifiedClients.length > 1 ? "topology-ambiguous" : "topology-unavailable",
      "Exactly one Desktop-owned client must be connected to the managed socket.",
    );
  }

  const after = await lstat(socketPath, { bigint: true }).catch(() => undefined);
  if (
    after === undefined ||
    !after.isSocket() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== before.uid
  ) {
    throw new OwnershipProbeError(
      "topology-ambiguous",
      "The managed socket identity changed during inspection.",
    );
  }
  const desktopClient = verifiedClients[0];
  if (daemon === undefined || desktopClient === undefined) {
    throw new OwnershipProbeError("topology-unavailable", "Ownership evidence is incomplete.");
  }
  return {
    socket: {
      path: socketPath,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      uid: Number(before.uid),
      listenerAddress: socketTopology.listener.address,
      listenerKernelInode: socketTopology.listener.kernelInode,
      listenerGeneration: socketTopology.listener.generation,
    },
    daemon: { pid: daemon.pid, startedAt: daemon.startedAt },
    desktop: {
      pid: desktop.pid,
      startedAt: desktop.startedAt,
      appPath: installation.appPath,
      executablePath: desktopExecutable,
      bundleId: installation.bundleId,
      appVersion: installation.appVersion,
      buildVersion: installation.buildVersion,
    },
    desktopClient: {
      kind: desktopClient.kind,
      pid: desktopClient.pid,
      startedAt: desktopClient.startedAt,
      serverEndpointAddress: desktopClient.peer.serverAddress,
      serverEndpointGeneration: desktopClient.peer.serverGeneration,
      clientEndpointAddress: desktopClient.peer.clientAddress,
      clientEndpointGeneration: desktopClient.peer.clientGeneration,
    },
    codex: {
      desktopBinaryPath: installation.binaryPath,
      desktopBinaryVersion: installation.binaryVersion,
      daemonBinaryPath: installation.daemonBinaryPath,
      daemonBinaryVersion: installation.daemonBinaryVersion,
    },
  };
}

async function readAttestation(
  attestationPath: string,
): Promise<
  | { readonly kind: "ok"; readonly value: DesktopOwnershipAttestation }
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "invalid" }
> {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  try {
    const parent = await lstat(dirname(attestationPath));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0 ||
      (currentUid !== undefined && parent.uid !== currentUid)
    ) {
      return { kind: "unsafe" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(attestationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (currentUid !== undefined && metadata.uid !== currentUid)
  ) {
    return { kind: "unsafe" };
  }
  try {
    const parsed = parseAttestation(JSON.parse(await readFile(attestationPath, "utf8")));
    return parsed === undefined ? { kind: "invalid" } : { kind: "ok", value: parsed };
  } catch {
    return { kind: "invalid" };
  }
}

function installationFromEvidence(evidence: DesktopOwnershipEvidence): DesktopOwnershipInstallation {
  const codex = "desktopBinaryPath" in evidence.codex
    ? evidence.codex
    : {
        desktopBinaryPath: evidence.codex.binaryPath,
        desktopBinaryVersion: evidence.codex.binaryVersion,
        daemonBinaryPath: evidence.codex.binaryPath,
        daemonBinaryVersion: evidence.codex.binaryVersion,
      };
  return {
    appPath: evidence.desktop.appPath,
    bundleId: evidence.desktop.bundleId,
    appVersion: evidence.desktop.appVersion,
    buildVersion: evidence.desktop.buildVersion,
    binaryPath: codex.desktopBinaryPath,
    binaryVersion: codex.desktopBinaryVersion,
    daemonBinaryPath: codex.daemonBinaryPath,
    daemonBinaryVersion: codex.daemonBinaryVersion,
  };
}

export async function inspectDesktopOwnership(
  options: InspectDesktopOwnershipOptions,
): Promise<DesktopOwnershipInspection> {
  if ((options.platform ?? process.platform) !== "darwin") {
    return {
      verified: false,
      canCreate: false,
      code: "platform-unsupported",
      summary: publicSummary("platform-unsupported"),
    };
  }
  if (!absolutePath(options.socketPath) || !absolutePath(options.codexBinaryPath)) {
    return {
      verified: false,
      canCreate: false,
      code: "topology-unavailable",
      summary: publicSummary("topology-unavailable"),
    };
  }
  const attestationPath = options.attestationPath ?? defaultDesktopOwnershipAttestationPath();
  const existing = await readAttestation(attestationPath);
  const installation =
    options.installation ??
    (existing.kind === "ok" ? installationFromEvidence(existing.value.evidence) : undefined);
  let currentEvidence: DesktopOwnershipEvidence | undefined;
  let probeFailure: OwnershipProbeError | undefined;
  if (installation !== undefined) {
    try {
      if (resolve(options.codexBinaryPath) !== resolve(installation.binaryPath)) {
        throw new OwnershipProbeError(
          "topology-ambiguous",
          "The configured binary differs from the attested Desktop binary.",
        );
      }
      currentEvidence = await (options.collectEvidence ?? collectDesktopOwnershipEvidence)({
        installation,
        socketPath: options.socketPath,
        platform: options.platform ?? process.platform,
        runCommand: options.runCommand,
      });
    } catch (error) {
      probeFailure =
        error instanceof OwnershipProbeError
          ? error
          : new OwnershipProbeError("topology-unavailable", "Ownership inspection failed.");
    }
  }

  if (existing.kind === "missing") {
    return {
      verified: false,
      canCreate: currentEvidence !== undefined,
      code: "attestation-missing",
      summary: publicSummary("attestation-missing"),
      ...(currentEvidence === undefined ? {} : { currentEvidence }),
    };
  }
  if (existing.kind === "unsafe") {
    return {
      verified: false,
      canCreate: currentEvidence !== undefined,
      code: "attestation-unsafe",
      summary: publicSummary("attestation-unsafe"),
      ...(currentEvidence === undefined ? {} : { currentEvidence }),
    };
  }
  if (existing.kind === "invalid") {
    return {
      verified: false,
      canCreate: currentEvidence !== undefined,
      code: "attestation-invalid",
      summary: publicSummary("attestation-invalid"),
      ...(currentEvidence === undefined ? {} : { currentEvidence }),
    };
  }
  if (existing.kind !== "ok") {
    return {
      verified: false,
      canCreate: false,
      code: "attestation-invalid",
      summary: publicSummary("attestation-invalid"),
    };
  }
  if (probeFailure !== undefined || currentEvidence === undefined) {
    const code = probeFailure?.code ?? "topology-unavailable";
    return {
      verified: false,
      canCreate: false,
      code,
      summary: publicSummary(code),
    };
  }
  if (
    resolve(existing.value.evidence.socket.path) !== resolve(options.socketPath) ||
    resolve("desktopBinaryPath" in existing.value.evidence.codex
      ? existing.value.evidence.codex.desktopBinaryPath
      : existing.value.evidence.codex.binaryPath) !== resolve(options.codexBinaryPath) ||
    evidenceDigest(existing.value.evidence) !== evidenceDigest(currentEvidence)
  ) {
    const existingInstallation = installationFromEvidence(existing.value.evidence);
    const pathsAndSignerPolicyUnchanged =
      resolve(existingInstallation.appPath) === resolve(currentEvidence.desktop.appPath)
      && existingInstallation.bundleId === currentEvidence.desktop.bundleId
      && resolve(existingInstallation.binaryPath) === resolve(
        "desktopBinaryPath" in currentEvidence.codex
          ? currentEvidence.codex.desktopBinaryPath
          : currentEvidence.codex.binaryPath,
      )
      && resolve(existingInstallation.daemonBinaryPath ?? existingInstallation.binaryPath) === resolve(
        "daemonBinaryPath" in currentEvidence.codex
          ? currentEvidence.codex.daemonBinaryPath
          : currentEvidence.codex.binaryPath,
      );
    if (options.allowSafeRenewal === true && pathsAndSignerPolicyUnchanged && installation !== undefined) {
      const revalidated = await (options.collectEvidence ?? collectDesktopOwnershipEvidence)({
        installation,
        socketPath: options.socketPath,
        platform: options.platform ?? process.platform,
        runCommand: options.runCommand,
      });
      if (evidenceDigest(revalidated) === evidenceDigest(currentEvidence)) {
        const renewed: DesktopOwnershipAttestation = {
          formatVersion: 2,
          createdAt: (options.now ?? (() => new Date()))().toISOString(),
          evidence: revalidated,
          evidenceSha256: evidenceDigest(revalidated),
        };
        await writeAttestationAtomic(attestationPath, renewed);
        return {
          verified: true,
          canCreate: false,
          code: "verified",
          summary: "Shared Desktop ownership was safely renewed for the current compatible Codex update.",
          currentEvidence: revalidated,
          renewed: true,
        };
      }
    }
    return {
      verified: false,
      canCreate: true,
      code: "attestation-stale",
      summary: publicSummary("attestation-stale"),
      currentEvidence,
    };
  }
  return {
    verified: true,
    canCreate: false,
    code: "verified",
    summary: publicSummary("verified"),
    currentEvidence,
  };
}

async function writeAttestationAtomic(
  attestationPath: string,
  attestation: DesktopOwnershipAttestation,
): Promise<void> {
  const parent = dirname(attestationPath);
  const parentMetadata = await lstat(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (parentMetadata.mode & 0o077) !== 0 ||
    (currentUid !== undefined && parentMetadata.uid !== currentUid)
  ) {
    throw new Error("Refusing to write a Desktop ownership attestation outside private storage.");
  }
  const existing = await lstat(attestationPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("Refusing to replace a non-regular Desktop ownership attestation.");
  }
  const temporaryPath = join(
    parent,
    `.desktop-ownership.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(attestation, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, attestationPath);
    await chmod(attestationPath, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function createDesktopOwnershipAttestation(
  options: CreateDesktopOwnershipAttestationOptions,
): Promise<DesktopOwnershipAttestation> {
  const evidence = await (options.collectEvidence ?? collectDesktopOwnershipEvidence)({
    installation: options.installation,
    socketPath: options.socketPath,
    platform: options.platform ?? process.platform,
    runCommand: options.runCommand,
  });
  const attestation: DesktopOwnershipAttestation = {
    formatVersion: 2,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    evidence,
    evidenceSha256: evidenceDigest(evidence),
  };
  await writeAttestationAtomic(
    options.attestationPath ?? defaultDesktopOwnershipAttestationPath(),
    attestation,
  );
  return attestation;
}

export class FileDesktopOwnershipVerifier implements DesktopOwnershipVerifier {
  readonly #options: Omit<InspectDesktopOwnershipOptions, "installation">;

  constructor(options: {
    readonly attestationPath?: string;
    readonly socketPath?: string;
    readonly codexBinaryPath: string;
    readonly platform?: NodeJS.Platform;
    readonly runCommand: OwnershipCommandRunner;
    readonly collectEvidence?: InspectDesktopOwnershipOptions["collectEvidence"];
  }) {
    this.#options = {
      attestationPath: options.attestationPath ?? defaultDesktopOwnershipAttestationPath(),
      socketPath: options.socketPath ?? DEFAULT_SOCKET_PATH,
      codexBinaryPath: options.codexBinaryPath,
      platform: options.platform ?? process.platform,
      runCommand: options.runCommand,
      ...(options.collectEvidence === undefined ? {} : { collectEvidence: options.collectEvidence }),
    };
  }

  verify(): Promise<DesktopOwnershipInspection> {
    return inspectDesktopOwnership(this.#options);
  }

  verifyDesktopProcessAtWriteBoundary(identity: DesktopProcessBoundaryIdentity): boolean {
    return verifyDesktopProcessIdentityAtWriteBoundary(identity, {
      platform: this.#options.platform ?? process.platform,
    });
  }
}

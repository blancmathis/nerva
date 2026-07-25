import { execFileSync } from "node:child_process";
import { lstatSync, type BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface UnixSocketCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type UnixSocketCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  timeoutMs?: number,
) => Promise<UnixSocketCommandResult>;

export interface UnixSocketListenerIdentity {
  readonly address: string;
  readonly kernelInode: string;
  readonly generation: string;
}

export interface UnixSocketPeerIdentity {
  readonly serverAddress: string;
  readonly serverGeneration: string;
  readonly clientAddress: string;
  readonly clientGeneration: string;
  readonly clientPid: number;
}

export interface UnixSocketTopology {
  readonly listener: UnixSocketListenerIdentity;
  readonly peers: readonly UnixSocketPeerIdentity[];
}

export interface ManagedSocketPeerExpectation {
  readonly socket: {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly uid: number;
    readonly listenerAddress: string;
    readonly listenerKernelInode: string;
    readonly listenerGeneration: string;
  };
  readonly daemonPid: number;
  readonly desktopClient: {
    readonly pid: number;
    readonly serverEndpointAddress: string;
    readonly serverEndpointGeneration: string;
    readonly clientEndpointAddress: string;
    readonly clientEndpointGeneration: string;
  };
}

export class UnixSocketTopologyError extends Error {
  readonly code: "unavailable" | "ambiguous";

  constructor(code: "unavailable" | "ambiguous", message: string) {
    super(message);
    this.name = "UnixSocketTopologyError";
    this.code = code;
  }
}

interface NetstatUnixRow {
  readonly address: string;
  readonly inode: string;
  readonly connection: string;
  readonly processPid: number;
  readonly state: string;
  readonly options: string;
  readonly generation: string;
  readonly path?: string;
}

const HEX_PATTERN = /^[0-9a-f]+$/i;

function normalizeHex(value: string): string | undefined {
  if (!HEX_PATTERN.test(value)) return undefined;
  try {
    return BigInt(`0x${value}`).toString(16);
  } catch {
    return undefined;
  }
}

function processPid(value: string): number | undefined {
  const separator = value.lastIndexOf(":");
  if (separator < 0) return undefined;
  const parsed = Number(value.slice(separator + 1));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse the fixed columns emitted by macOS `netstat -anv -f unix`. */
function parseNetstatUnixRows(output: string): readonly NetstatUnixRow[] {
  const rows: NetstatUnixRow[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 21 || fields[1] !== "stream") continue;
    const address = normalizeHex(fields[0] ?? "");
    const inode = normalizeHex(fields[4] ?? "");
    const connection = normalizeHex(fields[5] ?? "");
    const pid = processPid(fields[12] ?? "");
    const state = normalizeHex(fields[13] ?? "");
    const options = normalizeHex(fields[14] ?? "");
    const generation = normalizeHex(fields[15] ?? "");
    if (
      address === undefined ||
      inode === undefined ||
      connection === undefined ||
      pid === undefined ||
      state === undefined ||
      options === undefined ||
      generation === undefined
    ) {
      continue;
    }
    const path = fields.length > 21 ? fields.slice(21).join(" ") : undefined;
    rows.push({
      address,
      inode,
      connection,
      processPid: pid,
      state,
      options,
      generation,
      ...(path === undefined ? {} : { path }),
    });
  }
  return rows;
}

function isListener(row: NetstatUnixRow): boolean {
  return row.connection === "0"
    && row.inode !== "0"
    && (BigInt(`0x${row.options}`) & 2n) === 2n;
}

function reciprocalPeers(
  rows: readonly NetstatUnixRow[],
  server: NetstatUnixRow,
): readonly NetstatUnixRow[] {
  return rows.filter((candidate) =>
    candidate.address === server.connection
    && candidate.connection === server.address
  );
}

function topologyFromNetstatOutput(
  output: string,
  socketPath: string,
  daemonPid: number,
): UnixSocketTopology {
  const rows = parseNetstatUnixRows(output);
  const pathRows = rows.filter((row) => row.path === socketPath);
  const listeners = pathRows.filter(isListener);
  if (listeners.length !== 1) {
    throw new UnixSocketTopologyError(
      listeners.length > 1 ? "ambiguous" : "unavailable",
      "Exactly one current listener is required for the managed socket.",
    );
  }
  const listener = listeners[0];
  if (listener === undefined || listener.processPid !== daemonPid) {
    throw new UnixSocketTopologyError(
      "ambiguous",
      "The current managed socket listener is not owned by the selected daemon.",
    );
  }

  const listenerGeneration = BigInt(`0x${listener.generation}`);
  const connectedServers = pathRows.filter((row) => row.connection !== "0");
  const peers: UnixSocketPeerIdentity[] = [];
  for (const server of connectedServers) {
    if (
      server.processPid !== daemonPid
      || BigInt(`0x${server.generation}`) <= listenerGeneration
    ) {
      throw new UnixSocketTopologyError(
        "ambiguous",
        "A connected endpoint belongs to a different or replaced socket generation.",
      );
    }
    const reciprocal = reciprocalPeers(rows, server);
    if (reciprocal.length !== 1) {
      throw new UnixSocketTopologyError(
        "ambiguous",
        "A managed socket endpoint has no unique reciprocal process peer.",
      );
    }
    const client = reciprocal[0];
    if (client === undefined) {
      throw new UnixSocketTopologyError("unavailable", "Managed socket peer evidence is incomplete.");
    }
    peers.push({
      serverAddress: server.address,
      serverGeneration: server.generation,
      clientAddress: client.address,
      clientGeneration: client.generation,
      clientPid: client.processPid,
    });
  }

  return {
    listener: {
      address: listener.address,
      kernelInode: listener.inode,
      generation: listener.generation,
    },
    peers,
  };
}

/**
 * Resolve one current listening generation and all of its positively reciprocal
 * clients. The kernel generation counter is monotonic: an accepted endpoint for
 * this listener must have been created after the listener. This makes an
 * unlinked socket A distinguishable from a replacement socket B even when both
 * retain the same pathname and daemon PID.
 */
export async function collectUnixSocketTopology(options: {
  readonly socketPath: string;
  readonly daemonPid: number;
  readonly runCommand: UnixSocketCommandRunner;
}): Promise<UnixSocketTopology> {
  if (!isAbsolute(options.socketPath) || options.socketPath.includes("\0")) {
    throw new UnixSocketTopologyError("unavailable", "The managed socket path is invalid.");
  }
  const socketPath = resolve(options.socketPath);
  const result = await options.runCommand(
    "/usr/sbin/netstat",
    ["-anv", "-f", "unix"],
    5_000,
  );
  if (result.exitCode !== 0) {
    throw new UnixSocketTopologyError("unavailable", "Unix socket topology is unavailable.");
  }
  return topologyFromNetstatOutput(result.stdout, socketPath, options.daemonPid);
}

function matchesFilesystemIdentity(
  metadata: BigIntStats,
  expected: ManagedSocketPeerExpectation["socket"],
): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return !metadata.isSymbolicLink()
    && metadata.isSocket()
    && (metadata.mode & 0o077n) === 0n
    && metadata.dev.toString() === expected.device
    && metadata.ino.toString() === expected.inode
    && metadata.uid === BigInt(expected.uid)
    && (currentUid === undefined || metadata.uid === BigInt(currentUid));
}

function topologyMatchesExpectation(
  topology: UnixSocketTopology,
  expected: ManagedSocketPeerExpectation,
  clientPid: number,
): boolean {
  const desktopPeers = topology.peers.filter((peer) =>
    peer.clientPid === expected.desktopClient.pid
    && peer.serverAddress === expected.desktopClient.serverEndpointAddress
    && peer.serverGeneration === expected.desktopClient.serverEndpointGeneration
    && peer.clientAddress === expected.desktopClient.clientEndpointAddress
    && peer.clientGeneration === expected.desktopClient.clientEndpointGeneration
  );
  const bridgePeers = topology.peers.filter((peer) => peer.clientPid === clientPid);
  const allowedPids = new Set([expected.desktopClient.pid, clientPid]);
  return topology.listener.address === expected.socket.listenerAddress
    && topology.listener.kernelInode === expected.socket.listenerKernelInode
    && topology.listener.generation === expected.socket.listenerGeneration
    && expected.desktopClient.pid !== clientPid
    && desktopPeers.length === 1
    && bridgePeers.length === 1
    && topology.peers.length === 2
    && topology.peers.every((peer) => allowedPids.has(peer.clientPid));
}

/**
 * Runtime proof for Codex Pad's own managed socket client. It rechecks both the
 * filesystem socket identity and the exact reciprocal kernel peer on every
 * health/mutation probe.
 */
export async function verifyManagedSocketPeer(options: {
  readonly expected: ManagedSocketPeerExpectation;
  readonly clientPid: number;
  readonly platform?: NodeJS.Platform;
  readonly runCommand: UnixSocketCommandRunner;
}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const expected = options.expected;
  const before = await lstat(expected.socket.path, { bigint: true }).catch(() => undefined);
  if (before === undefined || !matchesFilesystemIdentity(before, expected.socket)) return false;
  try {
    const topology = await collectUnixSocketTopology({
      socketPath: expected.socket.path,
      daemonPid: expected.daemonPid,
      runCommand: options.runCommand,
    });
    if (!topologyMatchesExpectation(topology, expected, options.clientPid)) return false;
  } catch {
    return false;
  }
  const after = await lstat(expected.socket.path, { bigint: true }).catch(() => undefined);
  return after !== undefined
    && matchesFilesystemIdentity(after, expected.socket)
    && after.dev === before.dev
    && after.ino === before.ino
    && after.uid === before.uid;
}

/** Synchronous final check used directly adjacent to the managed stream write. */
export function verifyManagedSocketPeerAtWriteBoundary(options: {
  readonly expected: ManagedSocketPeerExpectation;
  readonly clientPid: number;
  readonly platform?: NodeJS.Platform;
}): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const expected = options.expected;
  try {
    const before = lstatSync(expected.socket.path, { bigint: true });
    if (!matchesFilesystemIdentity(before, expected.socket)) return false;
    const output = execFileSync(
      "/usr/sbin/netstat",
      ["-anv", "-f", "unix"],
      { encoding: "utf8", maxBuffer: 512 * 1024, timeout: 3_000 },
    );
    const topology = topologyFromNetstatOutput(
      output,
      resolve(expected.socket.path),
      expected.daemonPid,
    );
    if (!topologyMatchesExpectation(topology, expected, options.clientPid)) return false;
    const after = lstatSync(expected.socket.path, { bigint: true });
    return matchesFilesystemIdentity(after, expected.socket)
      && after.dev === before.dev
      && after.ino === before.ino
      && after.uid === before.uid;
  } catch {
    return false;
  }
}

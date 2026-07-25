import { chmod, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  verifyManagedSocketPeer,
  type ManagedSocketPeerExpectation,
  type UnixSocketCommandRunner,
} from "./unix-socket-generation.js";

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

async function socketFixture(): Promise<{
  socketPath: string;
  close(): Promise<void>;
  expected: ManagedSocketPeerExpectation;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-socket-generation-"));
  const socketPath = join(root, "managed.sock");
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  await chmod(socketPath, 0o600);
  const metadata = await lstat(socketPath, { bigint: true });
  return {
    socketPath,
    close: async () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    expected: {
      socket: {
        path: socketPath,
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
        uid: Number(metadata.uid),
        listenerAddress: "b0",
        listenerKernelInode: "b1",
        listenerGeneration: "20",
      },
      daemonPid: 201,
      desktopClient: {
        pid: 301,
        serverEndpointAddress: "b2",
        serverEndpointGeneration: "22",
        clientEndpointAddress: "b3",
        clientEndpointGeneration: "21",
      },
    },
  };
}

function topology(socketPath: string, extraRows: readonly string[] = []): string {
  return [
    netstatRow({
      address: "b0",
      inode: "b1",
      pid: 201,
      state: "00100",
      options: "00000002",
      generation: "20",
      path: socketPath,
    }),
    netstatRow({
      address: "b2",
      connection: "b3",
      pid: 201,
      generation: "22",
      path: socketPath,
    }),
    netstatRow({ address: "b3", connection: "b2", pid: 301, generation: "21" }),
    netstatRow({
      address: "b4",
      connection: "b5",
      pid: 201,
      generation: "24",
      path: socketPath,
    }),
    netstatRow({ address: "b5", connection: "b4", pid: 401, generation: "23" }),
    ...extraRows,
  ].join("\n");
}

function runner(output: string): UnixSocketCommandRunner {
  return async (executable) => executable === "/usr/sbin/netstat"
    ? { exitCode: 0, stdout: output, stderr: "" }
    : { exitCode: 1, stdout: "", stderr: "unexpected command" };
}

describe("managed Unix socket generation proof", () => {
  it("accepts exactly the attested Desktop peer and current bridge peer on one listener", async () => {
    const fixture = await socketFixture();
    try {
      await expect(verifyManagedSocketPeer({
        expected: fixture.expected,
        clientPid: 401,
        platform: "darwin",
        runCommand: runner(topology(fixture.socketPath)),
      })).resolves.toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("fails closed when a third managed peer is connected", async () => {
    const fixture = await socketFixture();
    const thirdPeer = [
      netstatRow({
        address: "b6",
        connection: "b7",
        pid: 201,
        generation: "26",
        path: fixture.socketPath,
      }),
      netstatRow({ address: "b7", connection: "b6", pid: 501, generation: "25" }),
    ];
    try {
      await expect(verifyManagedSocketPeer({
        expected: fixture.expected,
        clientPid: 401,
        platform: "darwin",
        runCommand: runner(topology(fixture.socketPath, thirdPeer)),
      })).resolves.toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("fails closed when Desktop remains on socket A after listener B replaces the pathname", async () => {
    const fixture = await socketFixture();
    const splitGeneration = [
      netstatRow({
        address: "b0",
        inode: "b1",
        pid: 201,
        state: "00100",
        options: "00000002",
        generation: "20",
        path: fixture.socketPath,
      }),
      // This accepted endpoint predates listener B, so it belongs to unlinked socket A.
      netstatRow({
        address: "a2",
        connection: "a3",
        pid: 201,
        generation: "12",
        path: fixture.socketPath,
      }),
      netstatRow({ address: "a3", connection: "a2", pid: 301, generation: "11" }),
      netstatRow({
        address: "b4",
        connection: "b5",
        pid: 201,
        generation: "24",
        path: fixture.socketPath,
      }),
      netstatRow({ address: "b5", connection: "b4", pid: 401, generation: "23" }),
    ].join("\n");
    try {
      await expect(verifyManagedSocketPeer({
        expected: fixture.expected,
        clientPid: 401,
        platform: "darwin",
        runCommand: runner(splitGeneration),
      })).resolves.toBe(false);
    } finally {
      await fixture.close();
    }
  });
});

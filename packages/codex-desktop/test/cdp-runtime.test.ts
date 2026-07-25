import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import { CdpNativeMicroRuntime } from "../src/cdp-runtime.js";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const ACTION_DISPATCH = {
  kind: "action",
  expectedAgentSlot: 0,
  slot: "ACT06",
  key: "ACT06",
  expectedKeycapId: "FAST",
  expectedNativeCommandId: "mode.fast",
  expectedThreadId: THREAD_ID,
} as const;

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  writeError: Error | null = null;
  readonly sent: string[] = [];

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    if (this.writeError !== null) queueMicrotask(() => callback?.(this.writeError ?? undefined));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function runtime(socket = new FakeSocket()): {
  socket: FakeSocket;
  runtime: CdpNativeMicroRuntime;
} {
  return {
    socket,
    runtime: new CdpNativeMicroRuntime(socket as unknown as WebSocket),
  };
}

describe("CdpNativeMicroRuntime delivery boundary", () => {
  it("marks a native dispatch timeout as delivery-unknown after Runtime.evaluate was sent", async () => {
    vi.useFakeTimers();
    try {
      const target = runtime();
      const pending = target.runtime.dispatch(ACTION_DISPATCH);
      const assertion = expect(pending).rejects.toMatchObject({ code: "delivery-unknown" });
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks disconnect and write-callback failures after dispatch as delivery-unknown", async () => {
    const disconnected = runtime();
    const pendingDisconnect = disconnected.runtime.dispatch(ACTION_DISPATCH);
    disconnected.socket.emit("close");
    await expect(pendingDisconnect).rejects.toMatchObject({ code: "delivery-unknown" });

    const callbackFailure = runtime();
    callbackFailure.socket.writeError = new Error("socket callback failed");
    await expect(callbackFailure.runtime.dispatch(ACTION_DISPATCH)).rejects.toMatchObject({ code: "delivery-unknown" });
  });

  it("uses the renderer dispatch marker to distinguish partial native sequences from pre-dispatch exceptions", async () => {
    const partial = runtime();
    const partialPromise = partial.runtime.dispatch(ACTION_DISPATCH);
    const partialId = (JSON.parse(partial.socket.sent[0] ?? "{}") as { id?: number }).id;
    partial.socket.emit("message", JSON.stringify({
      id: partialId,
      result: { exceptionDetails: { text: "CODEX_PAD_DELIVERY_UNKNOWN: thread changed after press" } },
    }));
    await expect(partialPromise).rejects.toMatchObject({ code: "delivery-unknown" });

    const definitive = runtime();
    const definitivePromise = definitive.runtime.dispatch(ACTION_DISPATCH);
    const definitiveId = (JSON.parse(definitive.socket.sent[0] ?? "{}") as { id?: number }).id;
    definitive.socket.emit("message", JSON.stringify({
      id: definitiveId,
      result: { exceptionDetails: { text: "Active thread changed before native dispatch." } },
    }));
    await expect(definitivePromise).rejects.toMatchObject({ code: "native-discovery-failed" });
  });

  it("keeps pre-dispatch connection and snapshot failures definitive", async () => {
    const closedSocket = new FakeSocket();
    closedSocket.readyState = WebSocket.CLOSED;
    const closed = runtime(closedSocket);
    await expect(closed.runtime.dispatch(ACTION_DISPATCH)).rejects.toMatchObject({ code: "cdp-connection-failed" });

    vi.useFakeTimers();
    try {
      const snapshot = runtime();
      const pendingSnapshot = snapshot.runtime.readSnapshot();
      const assertion = expect(pendingSnapshot).rejects.toMatchObject({ code: "cdp-connection-failed" });
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

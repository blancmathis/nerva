import WebSocket from "ws";
import { discoverCodexCdpTarget, isLoopbackUrl } from "./cdp-discovery.js";
import { CodexDesktopAdapterError } from "./errors.js";
import {
  buildFixedComposerAttachmentExpression,
  buildFixedComposerBatchAttachmentExpression,
  buildFixedComposerTextAppendExpression,
  buildFixedComposerFileBatchAttachmentExpression,
  buildFixedDispatchExpression,
  FIXED_NATIVE_SNAPSHOT_EXPRESSION,
} from "./renderer-expression.js";
import type {
  CdpDiscoveryOptions,
  DesktopProcessIdentity,
  NativeComposerImageAttachment,
  NativeComposerImageBatch,
  NativeComposerTextAppend,
  NativeComposerFileBatch,
  NativeDispatch,
  NativeMicroRuntime,
} from "./types.js";

interface CdpResponse {
  readonly id?: number;
  readonly error?: { readonly message?: string };
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: {
      readonly text?: string;
      readonly exception?: { readonly description?: string };
    };
  };
}

interface PendingEvaluation {
  readonly kind: "snapshot" | "dispatch" | "attachment" | "composer-text";
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  dispatchStarted: boolean;
}

const DELIVERY_UNKNOWN_MARKER = "CODEX_PAD_DELIVERY_UNKNOWN:";
const BATCH_NONE_MARKER = "CODEX_PAD_BATCH_NONE:";
const BATCH_PARTIAL_MARKER = "CODEX_PAD_BATCH_PARTIAL:";

function evaluationFailure(pending: PendingEvaluation, error: CodexDesktopAdapterError): CodexDesktopAdapterError {
  if (pending.kind !== "snapshot" && pending.dispatchStarted) {
    return new CodexDesktopAdapterError(
      "delivery-unknown",
      "Codex Desktop may have accepted the native control, but its acknowledgement was not received.",
      { cause: error },
    );
  }
  return error;
}

export async function connectCodexNativeRuntime(discovery: CdpDiscoveryOptions = {}): Promise<NativeMicroRuntime> {
  const { target, desktopIdentity } = await discoverCodexCdpTarget(discovery);
  const debuggerUrl = target.webSocketDebuggerUrl;
  if (!debuggerUrl || !isLoopbackUrl(debuggerUrl, ["ws:", "wss:"])) {
    throw new CodexDesktopAdapterError("target-not-found", "Codex renderer did not provide a loopback WebSocket endpoint.");
  }
  return CdpNativeMicroRuntime.connect(debuggerUrl, desktopIdentity);
}

export class CdpNativeMicroRuntime implements NativeMicroRuntime {
  private nextId = 0;
  private readonly pending = new Map<number, PendingEvaluation>();
  private closed = false;
  readonly desktopIdentity?: DesktopProcessIdentity;

  constructor(
    private readonly socket: WebSocket,
    desktopIdentity?: DesktopProcessIdentity,
  ) {
    if (desktopIdentity !== undefined) this.desktopIdentity = desktopIdentity;
    socket.on("message", (raw) => this.handleMessage(String(raw)));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  static async connect(
    url: string,
    desktopIdentity?: DesktopProcessIdentity,
  ): Promise<CdpNativeMicroRuntime> {
    const socket = new WebSocket(url, { handshakeTimeout: 3_000, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexDesktopAdapterError("cdp-connection-failed", "Codex renderer connection timed out.")), 3_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new CodexDesktopAdapterError("cdp-connection-failed", "Codex renderer connection failed.", { cause: error }));
      });
    });
    return new CdpNativeMicroRuntime(socket, desktopIdentity);
  }

  readSnapshot(): Promise<unknown> {
    return this.evaluate(FIXED_NATIVE_SNAPSHOT_EXPRESSION, "snapshot");
  }

  async dispatch(event: NativeDispatch): Promise<void> {
    // Local event validation and expression construction happen before the CDP
    // frame is sent, so failures here are definitive and safe to retry.
    await this.evaluate(buildFixedDispatchExpression(event), "dispatch");
  }

  async appendTextToComposer(input: NativeComposerTextAppend): Promise<void> {
    await this.evaluate(buildFixedComposerTextAppendExpression(input), "composer-text");
  }

  async attachFilesToComposer(batch: NativeComposerFileBatch): Promise<void> {
    await this.evaluate(buildFixedComposerFileBatchAttachmentExpression(batch), "attachment");
  }

  async attachImageToComposer(attachment: NativeComposerImageAttachment): Promise<void> {
    await this.evaluate(buildFixedComposerAttachmentExpression(attachment), "attachment");
  }

  async attachImagesToComposer(batch: NativeComposerImageBatch): Promise<void> {
    await this.evaluate(buildFixedComposerBatchAttachmentExpression(batch), "attachment");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.rejectAll(new CodexDesktopAdapterError("cdp-connection-failed", "Codex renderer connection closed."));
  }

  private evaluate(expression: string, kind: PendingEvaluation["kind"]): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CodexDesktopAdapterError("cdp-connection-failed", "Codex renderer is not connected."));
    }
    const id = ++this.nextId;
    // Retaining the bridge-authored promise avoids renderer GC while dynamic
    // imports settle. This reliability pattern is adapted from codex-stream-deck.
    const key = `codex-pad-${id}`;
    const retained = `(() => { const values = globalThis.__codexPadPending ??= new Map(); const pending = Promise.resolve((${expression})); values.set(${JSON.stringify(key)}, pending); setTimeout(() => values.delete(${JSON.stringify(key)}), 10000); return pending; })()`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(evaluationFailure(
          pending,
          new CodexDesktopAdapterError("cdp-connection-failed", "Codex renderer evaluation timed out."),
        ));
      }, 6_000);
      const pending: PendingEvaluation = { kind, resolve, reject, timer, dispatchStarted: false };
      this.pending.set(id, pending);
      const frame = JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression: retained, awaitPromise: true, returnByValue: true }
      });
      try {
        pending.dispatchStarted = true;
        this.socket.send(frame, (error) => {
          if (!error) return;
          const current = this.pending.get(id);
          if (!current) return;
          clearTimeout(current.timer);
          this.pending.delete(id);
          current.reject(evaluationFailure(
            current,
            new CodexDesktopAdapterError("cdp-connection-failed", "Codex renderer evaluation write failed.", { cause: error }),
          ));
        });
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        // ws.send synchronous throws occur before the frame is accepted by the
        // WebSocket implementation, so this remains a definitive pre-dispatch failure.
        reject(new CodexDesktopAdapterError(
          "cdp-connection-failed",
          "Codex renderer evaluation could not be dispatched.",
          { cause: error },
        ));
      }
    });
  }

  private handleMessage(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new CodexDesktopAdapterError("cdp-connection-failed", message.error.message ?? "Codex CDP returned an error."));
      return;
    }
    if (message.result?.exceptionDetails) {
      const description = message.result.exceptionDetails.exception?.description
        ?? message.result.exceptionDetails.text
        ?? "Codex native evaluation failed.";
      if (pending.kind !== "snapshot" && description.includes(DELIVERY_UNKNOWN_MARKER)) {
        pending.reject(new CodexDesktopAdapterError(
          "delivery-unknown",
          "Codex Desktop may have accepted part or all of the native control sequence, but its completion could not be verified.",
        ));
        return;
      }
      if (pending.kind === "attachment" && description.includes(BATCH_PARTIAL_MARKER)) {
        pending.reject(new CodexDesktopAdapterError(
          "delivery-unknown",
          "Only part of the attachment batch is visible in the exact composer. Resolve it on the Mac before retrying; Nerva will not complete the batch automatically.",
        ));
        return;
      }
      if (pending.kind === "attachment" && description.includes(BATCH_NONE_MARKER)) {
        pending.reject(new CodexDesktopAdapterError(
          "delivery-unknown",
          "No named file from the batch is visible yet. The exact retained batch can be retried manually after reconciliation confirms no attachment.",
        ));
        return;
      }
      pending.reject(new CodexDesktopAdapterError(
        "native-discovery-failed",
        description,
      ));
      return;
    }
    pending.resolve(message.result?.result?.value);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new CodexDesktopAdapterError("cdp-connection-failed", "Codex renderer disconnected."));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const adapterError = error instanceof CodexDesktopAdapterError
        ? error
        : new CodexDesktopAdapterError("cdp-connection-failed", error.message, { cause: error });
      pending.reject(evaluationFailure(pending, adapterError));
    }
    this.pending.clear();
  }
}

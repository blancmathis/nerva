import WebSocket from "ws";

export const DOCTOR_WSS_SUBPROTOCOL = "codex-pad-doctor-v1";

export interface WssProbeOptions {
  readonly url: string;
  readonly origin: string;
  readonly timeoutMs: number;
}

export type WssProbeResult =
  | {
      readonly outcome: "upgraded";
      readonly closeCode: number | null;
      readonly receivedData: boolean;
    }
  | {
      readonly outcome: "http-response";
      readonly statusCode: number;
    }
  | {
      readonly outcome: "timeout" | "network-error";
      readonly upgraded: boolean;
    };

export type WssProbe = (options: WssProbeOptions) => Promise<WssProbeResult>;

/**
 * Attempt one bounded, credential-free WSS upgrade. The bridge recognizes the
 * doctor subprotocol only to complete the HTTP 101 exchange, then closes the
 * unauthenticated socket before sending application data.
 */
export const probeWssUpgrade: WssProbe = async ({ url, origin, timeoutMs }) =>
  new Promise((resolve) => {
    try {
      const target = new URL(url);
      const sourceOrigin = new URL(origin);
      if (
        target.protocol !== "wss:"
        || target.username !== ""
        || target.password !== ""
        || target.pathname !== "/ws"
        || target.search !== ""
        || target.hash !== ""
        || sourceOrigin.protocol !== "https:"
        || target.host !== sourceOrigin.host
        || sourceOrigin.origin !== origin
      ) {
        resolve({ outcome: "network-error", upgraded: false });
        return;
      }
    } catch {
      resolve({ outcome: "network-error", upgraded: false });
      return;
    }

    let upgraded = false;
    let settled = false;
    let socket: WebSocket | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: WssProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) {
        socket.terminate();
      }
      resolve(result);
    };

    try {
      socket = new WebSocket(url, DOCTOR_WSS_SUBPROTOCOL, {
        origin,
        handshakeTimeout: timeoutMs,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: 1_024,
      });
    } catch {
      resolve({ outcome: "network-error", upgraded: false });
      return;
    }

    timer = setTimeout(() => {
      finish({ outcome: "timeout", upgraded });
    }, timeoutMs);

    socket.once("open", () => {
      upgraded = true;
    });
    socket.once("message", () => {
      finish({ outcome: "upgraded", closeCode: null, receivedData: true });
    });
    socket.once("close", (closeCode) => {
      if (upgraded) {
        finish({ outcome: "upgraded", closeCode, receivedData: false });
      } else {
        finish({ outcome: "network-error", upgraded: false });
      }
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish({ outcome: "http-response", statusCode: response.statusCode ?? 0 });
    });
    socket.once("error", () => {
      finish({ outcome: "network-error", upgraded });
    });
  });

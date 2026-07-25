import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { lookup } from "node:dns/promises";
import { connect as connectSocket, type Socket } from "node:net";
import { Transform, type TransformCallback } from "node:stream";

import { assertUrlWithinOrigin } from "@codex-pad/site-review";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_CAPTURE_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_CAPTURE_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_TOTAL_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_TOTAL_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface CaptureEgressProxy {
  readonly proxyUrl: string;
  close(): Promise<void>;
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function filteredHeaders(
  headers: IncomingHttpHeaders,
  host?: string,
): IncomingHttpHeaders {
  const connectionHeaders = new Set(
    (headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const output: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined
      || normalizedName === "host"
      || HOP_BY_HOP_HEADERS.has(normalizedName)
      || connectionHeaders.has(normalizedName)
    ) {
      continue;
    }
    output[normalizedName] = value;
  }
  if (host !== undefined) output.host = host;
  return output;
}

function endProxyError(response: import("node:http").ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
  response.end("Capture request blocked");
}

function contentLength(headers: IncomingHttpHeaders): number | null {
  const value = headers["content-length"];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/u.test(value)) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

class ByteLimitTransform extends Transform {
  #total = 0;

  constructor(
    readonly maximum: number,
    readonly consume: (bytes: number) => boolean,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.#total += chunk.byteLength;
    if (this.#total > this.maximum || !this.consume(chunk.byteLength)) {
      callback(new Error("Capture proxy byte limit exceeded"));
      return;
    }
    callback(null, chunk);
  }
}

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

function isTailscaleAddress(address: string, family: number): boolean {
  if (family === 6) return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
  const octets = address.split(".").map(Number);
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100
    && (octets[1] ?? 0) >= 64
    && (octets[1] ?? 0) <= 127;
}

async function resolvePinnedAddress(approved: URL): Promise<PinnedAddress> {
  if (approved.hostname === "localhost" || approved.hostname === "127.0.0.1") {
    return { address: "127.0.0.1", family: 4 };
  }
  const resolved = await lookup(approved.hostname, { all: true, verbatim: true });
  const candidate = resolved.find(({ address, family }) => isTailscaleAddress(address, family));
  if (candidate === undefined || (candidate.family !== 4 && candidate.family !== 6)) {
    throw new Error("Approved private HTTPS site did not resolve to a pinned Tailscale address");
  }
  return { address: candidate.address, family: candidate.family };
}

function rawHost(headers: readonly string[]): string | null {
  const values: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    if ((headers[index] ?? "").toLowerCase() === "host") values.push(headers[index + 1] ?? "");
  }
  return values.length === 1 ? values[0] ?? null : null;
}

function authorityMatches(value: string | null, expected: URL): boolean {
  if (value === null || value.length === 0 || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(`${expected.protocol}//${value}`);
    return parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.hostname.toLowerCase() === expected.hostname.toLowerCase()
      && effectivePort(parsed) === effectivePort(expected);
  } catch {
    return false;
  }
}

function parseConnectAuthority(authority: string): URL | null {
  if (
    authority.length === 0
    || authority !== authority.trim()
    || authority.includes("/")
    || authority.includes("@")
    || /[\u0000-\u001f\u007f]/u.test(authority)
  ) {
    return null;
  }
  try {
    const parsed = new URL(`https://${authority}`);
    return parsed.pathname === "/" && parsed.search === "" && parsed.hash === "" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Starts a browser-only proxy that can reach exactly one approved origin.
 * Chrome is forced through this listener, including for loopback addresses;
 * rejected navigations therefore cannot open a foreign destination socket.
 */
export async function startCaptureEgressProxy(
  approvedOrigin: string,
  timeoutMs: number,
  maxRedirects: number,
): Promise<CaptureEgressProxy> {
  const approved = new URL(approvedOrigin);
  assertUrlWithinOrigin(approved.href, approvedOrigin);
  const pinned = await resolvePinnedAddress(approved);
  const sockets = new Set<Socket>();
  let acceptedRedirects = 0;
  let remainingRequestBytes = MAX_CAPTURE_TOTAL_REQUEST_BYTES;
  let remainingResponseBytes = MAX_CAPTURE_TOTAL_RESPONSE_BYTES;
  const consumeRequestBytes = (bytes: number): boolean => {
    if (bytes > remainingRequestBytes) return false;
    remainingRequestBytes -= bytes;
    return true;
  };
  const consumeResponseBytes = (bytes: number): boolean => {
    if (bytes > remainingResponseBytes) return false;
    remainingResponseBytes -= bytes;
    return true;
  };

  const server = createServer((incoming, outgoing) => {
    let target: URL;
    try {
      if (incoming.url === undefined || !/^https?:\/\//iu.test(incoming.url)) {
        throw new Error("Proxy requests must use absolute-form URLs");
      }
      target = assertUrlWithinOrigin(incoming.url, approvedOrigin);
      if (target.protocol !== "http:") {
        throw new Error("HTTPS capture traffic must use an approved CONNECT tunnel");
      }
      if (!authorityMatches(rawHost(incoming.rawHeaders), target)) {
        throw new Error("Capture proxy request Host did not match its absolute target");
      }
    } catch {
      outgoing.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Capture destination blocked");
      return;
    }

    const method = incoming.method?.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      outgoing.writeHead(405, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Capture proxy allows only safe retrieval methods");
      return;
    }

    if ((contentLength(incoming.headers) ?? 0) > MAX_CAPTURE_REQUEST_BYTES) {
      outgoing.writeHead(413, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Capture request exceeded its byte limit");
      return;
    }

    const requestHeaders = filteredHeaders(incoming.headers, target.host);
    requestHeaders["accept-encoding"] = "identity";
    const upstream = httpRequest({
      protocol: "http:",
      hostname: pinned.address,
      family: pinned.family,
      port: effectivePort(target),
      path: `${target.pathname}${target.search}`,
      method: incoming.method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
    upstream.on("socket", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    upstream.once("response", (response) => {
      if (REDIRECT_STATUSES.has(response.statusCode ?? 0)) {
        const location = response.headers.location;
        try {
          if (location === undefined || acceptedRedirects >= maxRedirects) {
            throw new Error("Capture redirect blocked");
          }
          assertUrlWithinOrigin(new URL(location, target).href, approvedOrigin);
          acceptedRedirects += 1;
        } catch {
          response.destroy();
          outgoing.destroy();
          return;
        }
      }
      if ((contentLength(response.headers) ?? 0) > MAX_CAPTURE_RESPONSE_BYTES) {
        response.destroy();
        endProxyError(outgoing);
        return;
      }
      const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (contentEncoding !== undefined && contentEncoding !== "identity") {
        response.destroy();
        endProxyError(outgoing);
        return;
      }
      outgoing.writeHead(
        response.statusCode ?? 502,
        response.statusMessage,
        filteredHeaders(response.headers),
      );
      const limiter = new ByteLimitTransform(MAX_CAPTURE_RESPONSE_BYTES, consumeResponseBytes);
      limiter.once("error", () => {
        response.destroy();
        outgoing.destroy();
      });
      response.pipe(limiter).pipe(outgoing);
    });
    upstream.once("error", () => endProxyError(outgoing));
    incoming.once("aborted", () => upstream.destroy());
    const limiter = new ByteLimitTransform(MAX_CAPTURE_REQUEST_BYTES, consumeRequestBytes);
    limiter.once("error", () => upstream.destroy());
    incoming.pipe(limiter).pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => {
    // WebSockets are not required to render a bounded screenshot.
    socket.destroy();
  });
  server.on("connect", (request, clientSocket, head) => {
    const requested = parseConnectAuthority(request.url ?? "");
    const requestedHost = parseConnectAuthority(rawHost(request.rawHeaders) ?? "");
    if (
      requested === null
      || requestedHost === null
      || approved.protocol !== "https:"
      || requested.hostname.toLowerCase() !== approved.hostname.toLowerCase()
      || effectivePort(requested) !== effectivePort(approved)
      || requestedHost.hostname.toLowerCase() !== requested.hostname.toLowerCase()
      || effectivePort(requestedHost) !== effectivePort(requested)
    ) {
      clientSocket.destroy();
      return;
    }

    const upstream = connectSocket({
      host: pinned.address,
      family: pinned.family,
      port: effectivePort(approved),
      timeout: timeoutMs,
    });
    const requestLimiter = new ByteLimitTransform(
      MAX_CAPTURE_REQUEST_BYTES,
      consumeRequestBytes,
    );
    const responseLimiter = new ByteLimitTransform(
      MAX_CAPTURE_RESPONSE_BYTES,
      consumeResponseBytes,
    );
    const deadline = setTimeout(() => {
      clientSocket.destroy();
      upstream.destroy();
    }, timeoutMs);
    deadline.unref();
    const clearDeadline = (): void => clearTimeout(deadline);
    const destroyTunnel = (): void => {
      clientSocket.destroy();
      upstream.destroy();
    };
    requestLimiter.once("error", destroyTunnel);
    responseLimiter.once("error", destroyTunnel);
    sockets.add(upstream);
    upstream.once("close", () => {
      clearDeadline();
      sockets.delete(upstream);
      clientSocket.destroy();
    });
    clientSocket.once("close", () => {
      clearDeadline();
      upstream.destroy();
    });
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.pipe(requestLimiter).pipe(upstream);
      upstream.pipe(responseLimiter).pipe(clientSocket);
      if (head.byteLength > 0) requestLimiter.write(head);
    });
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("error", () => clientSocket.destroy());
    clientSocket.once("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Capture egress proxy did not bind an IPv4 listener");
  }

  let closed = false;
  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

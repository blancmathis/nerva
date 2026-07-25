import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOptionalSystemChromeDriver } from "../src/site-capture.js";

const ENABLED = process.env.CODEX_PAD_REAL_CHROME_CAPTURE === "1";
const CHROME_EXECUTABLE = process.env.CODEX_PAD_CHROME_EXECUTABLE
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Capture fixture did not bind an IPv4 listener");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe.skipIf(!ENABLED)("real system-Chrome capture diagnostic", () => {
  it("captures the approved fixture while a forbidden loopback listener receives zero TCP connections", async () => {
    if (!existsSync(CHROME_EXECUTABLE)) {
      throw new Error(`System Chrome is missing at ${CHROME_EXECUTABLE}`);
    }

    let forbiddenConnections = 0;
    const forbidden = createServer((_request, response) => {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    });
    forbidden.on("connection", () => {
      forbiddenConnections += 1;
    });
    const forbiddenPort = await listen(forbidden);

    const approvedRequests: Array<{ url: string; acceptEncoding: string }> = [];
    const approved = createServer((request, response) => {
      approvedRequests.push({
        url: request.url ?? "",
        acceptEncoding: String(request.headers["accept-encoding"] ?? ""),
      });
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(`<!doctype html>
        <html>
          <head>
            <title>pending</title>
            <style>html,body{margin:0;width:100%;height:100%;background:#0b5fff}</style>
            <script src="http://127.0.0.1:${forbiddenPort}/forbidden.js"></script>
            <script>document.title="capture-ready"</script>
          </head>
          <body><main>Approved local capture</main></body>
        </html>`);
    });
    const approvedPort = await listen(approved);
    const approvedOrigin = `http://localhost:${approvedPort}`;

    // This injection is diagnostic-only. Production deliberately keeps the
    // capability closed because a finite probe is not OS/VM confinement.
    const optional = await createOptionalSystemChromeDriver({
      executableCandidates: [CHROME_EXECUTABLE],
      networkSandboxAvailable: async () => true,
    });
    expect(optional).toMatchObject({ available: true, executablePath: CHROME_EXECUTABLE });
    if (!optional.available) throw new Error(optional.detail);

    const result = await optional.driver.capture({
      targetUrl: `${approvedOrigin}/capture`,
      approvedOrigin,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
      scroll: { x: 0, y: 0 },
      maxRedirects: 2,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      finalUrl: `${approvedOrigin}/capture`,
      title: "capture-ready",
      redirectCount: 0,
      scroll: { x: 0, y: 0 },
    });
    expect([...result.png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const png = new DataView(result.png.buffer, result.png.byteOffset, result.png.byteLength);
    expect([png.getUint32(16), png.getUint32(20)]).toEqual([390, 844]);
    expect(approvedRequests).toContainEqual({ url: "/capture", acceptEncoding: "identity" });
    expect(forbiddenConnections).toBe(0);
  }, 30_000);
});

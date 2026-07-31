import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { pairingNonceFromUrl } from "@codex-pad/bridge/pairing";
import type { BridgeHandle } from "@codex-pad/bridge";
import {
  API_CONTRACT_HEADER,
  API_CONTRACT_VERSION,
  BUILD_REVISION_HEADER,
} from "@codex-pad/protocol";
import {
  REAL_BRIDGE_COMMAND_ID,
  REAL_BRIDGE_PAIRING_ORIGIN,
  REAL_BRIDGE_THREAD_ID,
  freeLoopbackPort,
  startRealBridgeHarness,
  type RealBridgeHarness,
} from "./real-bridge-harness";

interface PairingResponse {
  readonly ok: true;
  readonly data: {
    readonly paired: true;
    readonly device: { readonly id: string };
    readonly bearerToken: string;
  };
}

interface SnapshotResponse {
  readonly ok: true;
  readonly data: {
    readonly bridgeInstanceId: string;
    readonly sequence: number;
    readonly bridgeVersion?: string;
    readonly buildRevision?: string;
    readonly apiContractVersion?: number;
  };
}

async function pairThroughBuiltPwa(
  page: Page,
  request: APIRequestContext,
  handle: BridgeHandle,
): Promise<PairingResponse["data"]> {
  const pairing = await handle.createPairing(REAL_BRIDGE_PAIRING_ORIGIN, "Real bridge iPad");
  const nonce = pairingNonceFromUrl(pairing.qrPayload);
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  // The production bridge is configured for its HTTPS tailnet origin while
  // the harness is reached on HTTP loopback. WebKit will not let Playwright
  // override the forbidden Origin header on a page fetch, so forward this one
  // request through Playwright's HTTP client and fulfill the browser response.
  // The payload still comes from the built PWA and the production Fastify
  // pairing route performs the real one-time, exact-origin redemption.
  await page.route("**/api/pair", async (route) => {
    const upstream = await request.post(`${handle.url}/api/pair`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: REAL_BRIDGE_PAIRING_ORIGIN,
      },
      data: route.request().postDataJSON(),
    });
    await route.fulfill({
      status: upstream.status(),
      contentType: "application/json",
      body: await upstream.body(),
    });
  });
  await page.goto(`${handle.url}/pair?nonce=${nonce}`);
  await expect(page.getByRole("heading", { name: /^Connect to /u })).toBeVisible({ timeout: 15_000 });
  const pairingResponsePromise = page.waitForResponse((candidate) => (
    candidate.url() === `${handle.url}/api/pair`
    && candidate.request().method() === "POST"
  ));
  const ticketResponsePromise = page.waitForResponse((candidate) => (
    candidate.url() === `${handle.url}/api/ws-ticket`
    && candidate.request().method() === "POST"
  ));
  const socketPromise = new Promise<string>((resolveSocket) => {
    page.once("websocket", (socket) => resolveSocket(socket.url()));
  });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const response = await pairingResponsePromise;
  expect(response.status()).toBe(201);
  const body = await response.json() as PairingResponse;
  expect(body).toMatchObject({ ok: true, data: { paired: true } });
  expect(body.data.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const ticketResponse = await ticketResponsePromise;
  const ticketBody = await ticketResponse.json() as unknown;
  expect(ticketResponse.status(), JSON.stringify(ticketBody)).toBe(200);
  expect(ticketResponse.request().headers().authorization).toBe(`Bearer ${body.data.bearerToken}`);
  await expect(socketPromise).resolves.toBe(handle.url.replace(/^http/u, "ws") + "/ws");
  await expect(page.locator(".cp-connection.phase-online")).toBeVisible({ timeout: 15_000 });
  await page.unroute("**/api/pair");
  return body.data;
}

async function authenticatedJson<T>(
  request: APIRequestContext,
  url: string,
  bearerToken: string,
): Promise<T> {
  const response = await request.get(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${bearerToken}` },
  });
  expect(response.status()).toBe(200);
  return await response.json() as T;
}

test("the built PWA crosses the real bridge for auth, state, WebSocket, ledger, restart and revocation", async ({ page, request }) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "nerva-real-bridge-e2e-"));
  const webRoot = resolve(
    process.env.CODEX_PAD_REAL_BRIDGE_WEB_ROOT ?? resolve(process.cwd(), "apps/web/dist"),
  );
  const port = await freeLoopbackPort();
  let harness: RealBridgeHarness | null = null;

  try {
    harness = await startRealBridgeHarness({ dataRoot, webRoot, port });
    const pairing = await pairThroughBuiltPwa(page, request, harness.handle);

    const healthResponse = await request.get(`${harness.handle.url}/api/health`);
    expect(healthResponse.status()).toBe(200);
    const health = await healthResponse.json() as {
      ok: true;
      data: {
        version: string;
        bridgeVersion: string;
        buildRevision: string;
        apiContractVersion: number;
        pairingConfigured: boolean;
        unsafeLan: boolean;
      };
    };
    expect(health.data).toMatchObject({
      version: expect.any(String),
      bridgeVersion: expect.any(String),
      buildRevision: expect.stringMatching(/^(?:[0-9a-f]{7,64}(?:-dirty)?|development)$/u),
      apiContractVersion: API_CONTRACT_VERSION,
      pairingConfigured: true,
      unsafeLan: false,
    });
    expect(health.data.version).toBe(health.data.bridgeVersion);
    expect(health.data.buildRevision).not.toBe("development");
    expect(health.data.buildRevision).not.toBe("0000000000000000");
    expect(healthResponse.headers()[BUILD_REVISION_HEADER]).toBe(health.data.buildRevision);
    expect(healthResponse.headers()[API_CONTRACT_HEADER]).toBe(String(API_CONTRACT_VERSION));

    await expect(page.getByRole("heading", { name: "Real bridge integration", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Open Nerva Home" }).click();
    await expect(page.getByRole("heading", { name: "Your working set." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unpinned Sessions 1" })).toBeVisible();
    await page.getByRole("button", { name: "Open Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    const savedState = page.waitForResponse((response) => (
      response.url() === `${harness!.handle.url}/api/product-state`
      && response.request().method() === "PUT"
      && response.status() === 200
    ));
    await page.getByLabel("Theme").selectOption("light");
    await savedState;

    await expect.poll(async () => {
      const body = await authenticatedJson<{ data: { preferences: { theme: string } } }>(
        request,
        `${harness!.handle.url}/api/product-state`,
        pairing.bearerToken,
      );
      return body.data.preferences.theme;
    }).toBe("light");

    const commandResult = await page.evaluate(async ({ bearerToken, commandId, threadId, apiContractVersion, buildRevisionHeader }) => {
      const snapshotResponse = await fetch("/api/snapshot", {
        headers: { Accept: "application/json", Authorization: `Bearer ${bearerToken}` },
        cache: "no-store",
      });
      const snapshot = await snapshotResponse.json() as SnapshotResponse;
      const command = {
        type: "selectAgent",
        commandId,
        expectedBridgeInstanceId: snapshot.data.bridgeInstanceId,
        expectedSequence: snapshot.data.sequence,
        expectedThreadId: threadId,
        slot: 0,
      };
      const response = await fetch("/api/command", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "X-Codex-Pad-Command-Id": commandId,
          "X-Codex-Pad-Api-Contract": String(apiContractVersion),
          "X-Codex-Pad-Build-Revision": snapshot.data.buildRevision ?? buildRevisionHeader,
        },
        body: JSON.stringify({ command }),
      });
      return { body: await response.json(), command };
    }, {
      bearerToken: pairing.bearerToken,
      commandId: REAL_BRIDGE_COMMAND_ID,
      threadId: REAL_BRIDGE_THREAD_ID,
      apiContractVersion: API_CONTRACT_VERSION,
      buildRevisionHeader: health.data.buildRevision,
    });
    expect(commandResult.body).toMatchObject({
      ok: true,
      data: { commandId: REAL_BRIDGE_COMMAND_ID, status: "succeeded", disposition: "accepted" },
    });
    expect(harness.adapterCommands).toEqual([
      expect.objectContaining({ action: "select-slot", slotIndex: 0, expectedThreadId: REAL_BRIDGE_THREAD_ID }),
    ]);
    expect(harness.transportSelections).toEqual([REAL_BRIDGE_THREAD_ID]);

    const firstGeneration = (await authenticatedJson<SnapshotResponse>(
      request,
      `${harness.handle.url}/api/snapshot`,
      pairing.bearerToken,
    )).data;
    expect(firstGeneration).toMatchObject({
      bridgeVersion: health.data.bridgeVersion,
      buildRevision: health.data.buildRevision,
      apiContractVersion: API_CONTRACT_VERSION,
    });
    const firstStatus = await authenticatedJson<{ data: { commandId: string; status: string } }>(
      request,
      `${harness.handle.url}/api/commands/${REAL_BRIDGE_COMMAND_ID}`,
      pairing.bearerToken,
    );
    expect(firstStatus.data).toMatchObject({ commandId: REAL_BRIDGE_COMMAND_ID, status: "succeeded" });
    await harness.handle.close();
    harness = await startRealBridgeHarness({ dataRoot, webRoot, port });
    await page.reload();
    await expect(page.locator(".cp-connection.phase-online")).toBeVisible();
    const restartedSnapshot = await authenticatedJson<SnapshotResponse>(
      request,
      `${harness.handle.url}/api/snapshot`,
      pairing.bearerToken,
    );
    expect(restartedSnapshot.data.bridgeInstanceId).not.toBe(firstGeneration.bridgeInstanceId);
    expect(restartedSnapshot.data).toMatchObject({
      bridgeVersion: health.data.bridgeVersion,
      apiContractVersion: API_CONTRACT_VERSION,
    });
    expect((await authenticatedJson<{ data: { preferences: { theme: string } } }>(
      request,
      `${harness.handle.url}/api/product-state`,
      pairing.bearerToken,
    )).data.preferences.theme).toBe("light");

    const duplicate = await page.evaluate(async ({ bearerToken, command, apiContractVersion, buildRevision }) => {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "X-Codex-Pad-Command-Id": command.commandId,
          "X-Codex-Pad-Api-Contract": String(apiContractVersion),
          "X-Codex-Pad-Build-Revision": buildRevision,
        },
        body: JSON.stringify({ command }),
      });
      return await response.json();
    }, {
      bearerToken: pairing.bearerToken,
      command: commandResult.command,
      apiContractVersion: API_CONTRACT_VERSION,
      buildRevision: health.data.buildRevision,
    });
    expect(duplicate).toMatchObject({
      ok: true,
      data: { commandId: REAL_BRIDGE_COMMAND_ID, status: "succeeded", disposition: "duplicate" },
    });
    expect(harness.adapterCommands).toHaveLength(0);

    expect(await harness.handle.revokeDevice(pairing.device.id)).toBe(true);
    await expect(page.getByRole("heading", { name: "Scan the QR on your Mac" })).toBeVisible({ timeout: 15_000 });
    const revoked = await request.get(`${harness.handle.url}/api/snapshot`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${pairing.bearerToken}` },
    });
    expect(revoked.status()).toBe(401);
  } finally {
    await harness?.handle.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  }
});

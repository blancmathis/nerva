import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mapNativeStatus, type MicroSnapshot, type ProductState } from "@codex-pad/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultProductState } from "../src/product-state-store.js";
import {
  IntelligentNotificationEngine,
  PushSubscriptionInputSchema,
  PushSubscriptionStore,
  VapidKeyStore,
  type PushDelivery,
  type PushDeliveryOptions,
  type PushSubscriptionInput,
} from "../src/push-notifications.js";

const THREAD_A = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";
const THREAD_B = "019f7ec2-68eb-7183-bb3a-0e67312a8ba2";
const DEVICE_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba3";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryFile(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nerva-push-test-"));
  roots.push(root);
  return join(root, "security", name);
}

function subscription(seed = 1): PushSubscriptionInput {
  return {
    endpoint: `https://web.push.apple.com/Q${seed}`,
    expirationTime: null,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, seed)]).toString("base64url"),
      auth: Buffer.alloc(16, seed).toString("base64url"),
    },
  };
}

function disabledAssignment() {
  return { keycapId: null, nativeCommandId: null, label: null, enabled: false };
}

function disabledJoystickAssignment() {
  return { type: null, commandId: null, label: null, enabled: false } as const;
}

function snapshot(
  entries: readonly { threadId: string; nativeStatus: string; title?: string }[],
  options: { readonly health?: MicroSnapshot["bridgeHealth"]["state"]; readonly approvalThreadId?: string } = {},
): MicroSnapshot {
  const slots = Array.from({ length: 6 }, (_, index) => {
    const entry = entries[index];
    if (!entry) return {
      slot: index,
      threadId: null,
      title: null,
      activityLabel: null,
      nativeStatus: "off",
      visualStatus: "empty" as const,
      selected: false,
      activityAt: null,
      ownedByHost: true,
    };
    return {
      slot: index,
      threadId: entry.threadId,
      title: entry.title ?? `Private task ${index + 1}`,
      activityLabel: null,
      nativeStatus: entry.nativeStatus,
      visualStatus: mapNativeStatus(entry.nativeStatus),
      selected: index === 0,
      activityAt: 1_750_000_000_000,
      ownedByHost: true,
    };
  }) as MicroSnapshot["slots"];
  const approvalThreadId = options.approvalThreadId;
  return {
    bridgeInstanceId: "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812",
    sequence: 1,
    timestamp: 1_750_000_000_000,
    codexVersion: "test",
    bridgeHealth: {
      state: options.health ?? "live",
      reason: null,
      changedAt: 1_750_000_000_000,
      lastSuccessfulRefreshAt: 1_750_000_000_000,
    },
    agentSource: "pinned",
    slots,
    actionAssignments: {
      micro: {
        ACT06: disabledAssignment(),
        ACT07: disabledAssignment(),
        ACT08: disabledAssignment(),
        ACT09: disabledAssignment(),
        ACT10_ACT11: disabledAssignment(),
        ACT12: disabledAssignment(),
      },
      joystick: {
        up: disabledJoystickAssignment(),
        right: disabledJoystickAssignment(),
        down: disabledJoystickAssignment(),
        left: disabledJoystickAssignment(),
      },
    },
    activeThreadId: entries[0]?.threadId ?? null,
    selectedThreadId: entries[0]?.threadId ?? null,
    pendingApprovals: approvalThreadId ? [{
      requestId: "approval-1",
      threadId: approvalThreadId,
      turnId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba4",
      itemId: "approval-item-1",
      kind: "commandExecution",
      actionable: true,
      summary: "private command",
    }] : [],
    reasoning: null,
    theme: "dark",
  };
}

function productState(pinnedThreadIds: readonly string[] = [THREAD_A, THREAD_B]): ProductState {
  const initial = defaultProductState(1_750_000_000_000);
  return {
    ...initial,
    homeLayout: {
      ...initial.homeLayout,
      pinnedThreadIds: [...pinnedThreadIds],
      manual: { sections: [], looseThreadIds: [...pinnedThreadIds] },
    },
    preferences: {
      ...initial.preferences,
      notifications: { needsApproval: true, waiting: true, completed: true, error: true },
    },
  };
}

class CapturingDelivery implements PushDelivery {
  readonly sends: Array<{ subscription: PushSubscriptionInput; payload: string; options: PushDeliveryOptions }> = [];
  error: Error | null = null;

  async send(subscriptionValue: PushSubscriptionInput, payload: string, options: PushDeliveryOptions) {
    if (this.error) throw this.error;
    this.sends.push({ subscription: subscriptionValue, payload, options });
    return { statusCode: 201 };
  }
}

async function engineFixture(state = productState()) {
  const subscriptions = new PushSubscriptionStore({ filePath: await temporaryFile("subscriptions.json") });
  await subscriptions.upsert(DEVICE_ID, subscription());
  const delivery = new CapturingDelivery();
  const engine = new IntelligentNotificationEngine({
    subscriptions,
    delivery,
    productState: { read: async () => state },
    completionGroupDelayMs: 60_000,
    now: () => 1_750_000_000_001,
    logger: { warn: vi.fn() },
  });
  return { subscriptions, delivery, engine };
}

describe("Web Push private stores", () => {
  it("stores one validated subscription per paired device with private permissions", async () => {
    const filePath = await temporaryFile("subscriptions.json");
    const store = new PushSubscriptionStore({ filePath, now: () => 10 });
    await store.upsert(DEVICE_ID, subscription(1));
    await store.upsert(DEVICE_ID, subscription(2));

    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]).toMatchObject({ deviceId: DEVICE_ID, endpoint: "https://web.push.apple.com/Q2" });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await store.removeDevice(DEVICE_ID)).toBe(true);
    expect(await store.hasDevice(DEVICE_ID)).toBe(false);
  });

  it("rejects arbitrary endpoints and malformed browser keys before storage", () => {
    expect(PushSubscriptionInputSchema.safeParse({
      ...subscription(),
      endpoint: "https://internal.example.test/push",
    }).success).toBe(false);
    expect(PushSubscriptionInputSchema.safeParse({
      ...subscription(),
      keys: { ...subscription().keys, auth: Buffer.alloc(15).toString("base64url") },
    }).success).toBe(false);
  });

  it("creates one persistent private VAPID identity", async () => {
    const filePath = await temporaryFile("vapid.json");
    const firstStore = new VapidKeyStore({ filePath, now: () => 10 });
    const first = await firstStore.getOrCreate();
    const second = await new VapidKeyStore({ filePath, now: () => 20 }).getOrCreate();

    expect(second).toEqual(first);
    expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(first.privateKey, "base64url")).toHaveLength(32);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});

describe("IntelligentNotificationEngine", () => {
  it.each([
    ["input", "question", "high"],
    ["awaiting-approval", "approval", "high"],
    ["error", "error", "high"],
  ] as const)("sends only the %s transition with generic encrypted copy and an exact target", async (nativeStatus, kind, urgency) => {
    const { delivery, engine } = await engineFixture();
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "working", title: "Secret project" }]));
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus, title: "Secret project" }]));

    expect(delivery.sends).toHaveLength(1);
    const sent = delivery.sends[0]!;
    const payload = JSON.parse(sent.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ kind, target: { view: "session", threadId: THREAD_A } });
    expect(sent.options).toMatchObject({ urgency, ttlSeconds: 3_600 });
    expect(sent.payload).not.toContain("Secret project");
    expect(sent.payload).not.toContain("private command");
    expect(sent.payload).not.toContain("approve");
    engine.close();
  });

  it("groups several pinned completions into one Mission Control review alert", async () => {
    const { delivery, engine } = await engineFixture();
    await engine.observe(snapshot([
      { threadId: THREAD_A, nativeStatus: "working" },
      { threadId: THREAD_B, nativeStatus: "working" },
    ]));
    await engine.observe(snapshot([
      { threadId: THREAD_A, nativeStatus: "completed" },
      { threadId: THREAD_B, nativeStatus: "completed" },
    ]));
    expect(delivery.sends).toHaveLength(0);

    await engine.flushCompletions();

    expect(delivery.sends).toHaveLength(1);
    expect(JSON.parse(delivery.sends[0]!.payload)).toMatchObject({
      kind: "results",
      body: "2 important results are ready in Mission Control.",
      target: { view: "mission" },
    });
    expect(delivery.sends[0]!.options).toMatchObject({ urgency: "normal", ttlSeconds: 21_600 });
    engine.close();
  });

  it("does not notify an unpinned completion or seed notifications from stale state", async () => {
    const { delivery, engine } = await engineFixture(productState([]));
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "working" }], { health: "stale" }));
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "working" }]));
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "completed" }]));
    await engine.flushCompletions();

    expect(delivery.sends).toHaveLength(0);
    engine.close();
  });

  it("keeps fresh native status alerts available when only another bridge layer is degraded", async () => {
    const { delivery, engine } = await engineFixture();
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "working" }], { health: "degraded" }));
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "input" }], { health: "degraded" }));

    expect(delivery.sends).toHaveLength(1);
    expect(JSON.parse(delivery.sends[0]!.payload)).toMatchObject({ kind: "question" });
    engine.close();
  });

  it("removes a browser subscription after a terminal push-service response", async () => {
    const { subscriptions, delivery, engine } = await engineFixture();
    delivery.error = Object.assign(new Error("gone"), { statusCode: 410 });
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "working" }]));
    await engine.observe(snapshot([{ threadId: THREAD_A, nativeStatus: "error" }]));

    expect(await subscriptions.hasDevice(DEVICE_ID)).toBe(false);
    engine.close();
  });
});

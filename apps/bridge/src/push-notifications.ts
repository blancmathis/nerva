import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { MicroSnapshot, ProductPreferences } from "@codex-pad/protocol";
import webPush, { WebPushError, type PushSubscription as WebPushSubscription } from "web-push";
import { z } from "zod";

import {
  assertPrivateRegularFile,
  atomicWritePrivateJson,
  withPrivateFileLock,
} from "./atomic-file.js";
import { defaultDataPaths, type BridgeDataPaths } from "./paths.js";
import type { ProductStateStore } from "./product-state-store.js";

const MAX_SUBSCRIPTIONS = 128;
const MAX_PUSH_PAYLOAD_BYTES = 3_000;
const DEFAULT_COMPLETION_GROUP_DELAY_MS = 8_000;
const PUSH_SEND_TIMEOUT_MS = 10_000;
const MAX_DEGRADED_NATIVE_PROOF_AGE_MS = 5_000;

const base64UrlSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);

function decodedLength(value: string): number {
  try {
    return Buffer.from(value, "base64url").byteLength;
  } catch {
    return -1;
  }
}

function trustedPushEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol !== "https:"
      || endpoint.username !== ""
      || endpoint.password !== ""
      || endpoint.port !== ""
      || endpoint.hash !== ""
    ) return false;
    const hostname = endpoint.hostname.toLowerCase();
    return hostname === "web.push.apple.com"
      || hostname.endsWith(".push.apple.com")
      || hostname === "fcm.googleapis.com"
      || hostname === "updates.push.services.mozilla.com"
      || hostname === "push.services.mozilla.com";
  } catch {
    return false;
  }
}

export const PushSubscriptionInputSchema = z.object({
  endpoint: z.string().url().max(2_048).refine(trustedPushEndpoint, "Unsupported Web Push endpoint"),
  expirationTime: z.number().int().nonnegative().safe().nullable().optional(),
  keys: z.object({
    p256dh: base64UrlSchema.refine((value) => decodedLength(value) === 65, "Invalid p256dh key"),
    auth: base64UrlSchema.refine((value) => decodedLength(value) === 16, "Invalid auth secret"),
  }).strict(),
}).strict();

export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;

const storedSubscriptionSchema = PushSubscriptionInputSchema.extend({
  deviceId: z.uuid(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
}).strict();

const subscriptionFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(storedSubscriptionSchema).max(MAX_SUBSCRIPTIONS),
}).strict();

type StoredPushSubscription = z.infer<typeof storedSubscriptionSchema>;
type SubscriptionFile = z.infer<typeof subscriptionFileSchema>;

const vapidFileSchema = z.object({
  version: z.literal(1),
  publicKey: base64UrlSchema.refine((value) => decodedLength(value) === 65),
  privateKey: base64UrlSchema.refine((value) => decodedLength(value) === 32),
  createdAt: z.number().int().nonnegative().safe(),
}).strict();

export interface VapidKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

function emptySubscriptionFile(): SubscriptionFile {
  return { version: 1, subscriptions: [] };
}

export class PushSubscriptionStore {
  readonly filePath: string;
  readonly #now: () => number;
  #mutation = Promise.resolve();

  constructor(options: { readonly paths?: BridgeDataPaths; readonly filePath?: string; readonly now?: () => number } = {}) {
    this.filePath = options.filePath
      ?? options.paths?.pushSubscriptions
      ?? defaultDataPaths().pushSubscriptions;
    this.#now = options.now ?? Date.now;
  }

  async list(): Promise<readonly StoredPushSubscription[]> {
    return (await this.#read()).subscriptions;
  }

  async hasDevice(deviceId: string): Promise<boolean> {
    return (await this.#read()).subscriptions.some((subscription) => subscription.deviceId === deviceId);
  }

  async upsert(deviceId: string, inputValue: PushSubscriptionInput): Promise<void> {
    const input = PushSubscriptionInputSchema.parse(inputValue);
    await this.#mutate((file) => {
      const now = this.#now();
      const existing = file.subscriptions.find((subscription) => subscription.deviceId === deviceId);
      const next: StoredPushSubscription = {
        ...input,
        expirationTime: input.expirationTime ?? null,
        deviceId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const subscriptions = [
        ...file.subscriptions.filter((subscription) => subscription.deviceId !== deviceId),
        next,
      ];
      return subscriptionFileSchema.parse({ version: 1, subscriptions });
    });
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    let removed = false;
    await this.#mutate((file) => {
      const subscriptions = file.subscriptions.filter((subscription) => subscription.deviceId !== deviceId);
      removed = subscriptions.length !== file.subscriptions.length;
      return { version: 1, subscriptions };
    });
    return removed;
  }

  async #read(): Promise<SubscriptionFile> {
    try {
      await assertPrivateRegularFile(this.filePath);
      return subscriptionFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySubscriptionFile();
      throw error;
    }
  }

  #mutate(operation: (file: SubscriptionFile) => SubscriptionFile): Promise<void> {
    const run = this.#mutation.then(async () => withPrivateFileLock(this.filePath, async () => {
      const next = subscriptionFileSchema.parse(operation(await this.#read()));
      await atomicWritePrivateJson(this.filePath, next);
    }));
    this.#mutation = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class VapidKeyStore {
  readonly filePath: string;
  readonly #now: () => number;
  #keysPromise: Promise<VapidKeyPair> | null = null;

  constructor(options: { readonly paths?: BridgeDataPaths; readonly filePath?: string; readonly now?: () => number } = {}) {
    this.filePath = options.filePath
      ?? options.paths?.pushVapidKeys
      ?? defaultDataPaths().pushVapidKeys;
    this.#now = options.now ?? Date.now;
  }

  getOrCreate(): Promise<VapidKeyPair> {
    this.#keysPromise ??= withPrivateFileLock(this.filePath, async () => {
      try {
        await assertPrivateRegularFile(this.filePath);
        const stored = vapidFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
        return { publicKey: stored.publicKey, privateKey: stored.privateKey };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const generated = webPush.generateVAPIDKeys();
        const stored = vapidFileSchema.parse({ version: 1, ...generated, createdAt: this.#now() });
        await atomicWritePrivateJson(this.filePath, stored);
        return { publicKey: stored.publicKey, privateKey: stored.privateKey };
      }
    });
    return this.#keysPromise;
  }
}

export type IntelligentPushKind = "approval" | "question" | "error" | "completed" | "results";

export interface IntelligentPushPayload {
  readonly version: 1;
  readonly kind: IntelligentPushKind;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly badgeCount: number;
  readonly generatedAt: number;
  readonly target:
    | { readonly view: "session"; readonly threadId: string }
    | { readonly view: "mission" };
}

export interface PushDeliveryOptions {
  readonly ttlSeconds: number;
  readonly urgency: "normal" | "high";
  readonly topic: string;
}

export interface PushDelivery {
  send(
    subscription: PushSubscriptionInput,
    payload: string,
    options: PushDeliveryOptions,
  ): Promise<{ readonly statusCode: number }>;
}

export class StandardsWebPushDelivery implements PushDelivery {
  constructor(
    readonly keys: VapidKeyPair,
    readonly subject: string,
  ) {
    const parsed = new URL(subject);
    if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
      throw new Error("The VAPID subject must use HTTPS or mailto");
    }
  }

  async send(
    subscription: PushSubscriptionInput,
    payload: string,
    options: PushDeliveryOptions,
  ): Promise<{ readonly statusCode: number }> {
    const result = await webPush.sendNotification(subscription as WebPushSubscription, payload, {
      vapidDetails: { subject: this.subject, ...this.keys },
      TTL: options.ttlSeconds,
      urgency: options.urgency,
      topic: options.topic,
      timeout: PUSH_SEND_TIMEOUT_MS,
      contentEncoding: "aes128gcm",
    });
    return { statusCode: result.statusCode };
  }
}

interface NotificationCandidate {
  readonly kind: Exclude<IntelligentPushKind, "results">;
  readonly threadId: string;
}

interface ObservedSlotState {
  readonly nativeStatus: string;
  readonly visualStatus: MicroSnapshot["slots"][number]["visualStatus"];
  readonly approvalPending: boolean;
}

function normalizedNativeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/gu, "-");
}

function notificationKind(
  slot: MicroSnapshot["slots"][number],
  approvalPending: boolean,
): NotificationCandidate["kind"] | null {
  const nativeStatus = normalizedNativeStatus(slot.nativeStatus);
  if (approvalPending || nativeStatus.includes("approval")) return "approval";
  if (["input", "awaiting-response", "needs-input", "needs-response"].includes(nativeStatus)) return "question";
  if (slot.visualStatus === "error") return "error";
  if (slot.visualStatus === "completed") return "completed";
  return null;
}

function preferenceFor(kind: IntelligentPushKind): keyof ProductPreferences["notifications"] {
  if (kind === "approval") return "needsApproval";
  if (kind === "question") return "waiting";
  if (kind === "error") return "error";
  return "completed";
}

function fixedNotificationCopy(kind: IntelligentPushKind, count = 1): readonly [string, string] {
  if (kind === "approval") return ["Approval needed", "A Codex task is waiting for your approval on the Mac."];
  if (kind === "question") return ["Your answer is needed", "A Codex task is blocked until you answer."];
  if (kind === "error") return ["A task needs attention", "A Codex task hit an error. Open Nerva to inspect it."];
  if (kind === "results") return ["Results ready to review", `${count} important results are ready in Mission Control.`];
  return ["Important result ready", "A pinned Codex task has a new result to review."];
}

function opaqueTopic(kind: IntelligentPushKind, threadId?: string): string {
  if (kind === "results") return "nerva-results";
  return createHash("sha256").update(`${kind}\0${threadId ?? ""}`).digest("base64url").slice(0, 24);
}

function payloadString(payload: IntelligentPushPayload): string {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PUSH_PAYLOAD_BYTES) {
    throw new Error("The bounded Web Push payload is unexpectedly too large");
  }
  return serialized;
}

function statusChanged(previous: ObservedSlotState | undefined, current: ObservedSlotState): boolean {
  return previous !== undefined && (
    previous.nativeStatus !== current.nativeStatus
    || previous.visualStatus !== current.visualStatus
    || previous.approvalPending !== current.approvalPending
  );
}

function hasFreshNotificationAuthority(snapshot: MicroSnapshot): boolean {
  if (snapshot.bridgeHealth.state === "live") return true;
  if (snapshot.bridgeHealth.state !== "degraded") return false;
  const provenAt = snapshot.bridgeHealth.lastSuccessfulRefreshAt;
  return provenAt !== null
    && snapshot.timestamp >= provenAt
    && snapshot.timestamp - provenAt <= MAX_DEGRADED_NATIVE_PROOF_AGE_MS;
}

export class IntelligentNotificationEngine {
  readonly #subscriptions: PushSubscriptionStore;
  readonly #delivery: PushDelivery;
  readonly #productState: Pick<ProductStateStore, "read">;
  readonly #logger: Pick<Console, "warn">;
  readonly #now: () => number;
  readonly #completionGroupDelayMs: number;
  #previous: ReadonlyMap<string, ObservedSlotState> | null = null;
  #latestSnapshot: MicroSnapshot | null = null;
  #pendingCompletions = new Set<string>();
  #completionTimer: ReturnType<typeof setTimeout> | null = null;
  #observationChain = Promise.resolve();

  constructor(options: {
    readonly subscriptions: PushSubscriptionStore;
    readonly delivery: PushDelivery;
    readonly productState: Pick<ProductStateStore, "read">;
    readonly logger?: Pick<Console, "warn">;
    readonly now?: () => number;
    readonly completionGroupDelayMs?: number;
  }) {
    this.#subscriptions = options.subscriptions;
    this.#delivery = options.delivery;
    this.#productState = options.productState;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
    this.#completionGroupDelayMs = Math.max(0, options.completionGroupDelayMs ?? DEFAULT_COMPLETION_GROUP_DELAY_MS);
  }

  observe(snapshot: MicroSnapshot): Promise<void> {
    const run = this.#observationChain.then(() => this.#observe(snapshot));
    this.#observationChain = run.catch(() => undefined);
    return run;
  }

  async flushCompletions(): Promise<void> {
    if (this.#completionTimer !== null) {
      clearTimeout(this.#completionTimer);
      this.#completionTimer = null;
    }
    const pending = [...this.#pendingCompletions];
    this.#pendingCompletions.clear();
    if (pending.length === 0 || this.#latestSnapshot === null) return;
    const productState = await this.#productState.read();
    if (!productState.preferences.notifications.completed) return;
    const pinned = new Set(productState.homeLayout.pinnedThreadIds);
    const stillImportant = pending.filter((threadId) => pinned.has(threadId));
    if (stillImportant.length === 0) return;
    const ready = this.#latestSnapshot.slots.filter((slot) => (
      slot.threadId !== null
      && pinned.has(slot.threadId)
      && slot.visualStatus === "completed"
    ));
    if (stillImportant.length > 1 || ready.length > 1) {
      await this.#deliver("results", null, Math.max(stillImportant.length, ready.length), productState.preferences.notifications);
      return;
    }
    await this.#deliver("completed", stillImportant[0]!, 1, productState.preferences.notifications);
  }

  close(): void {
    if (this.#completionTimer !== null) clearTimeout(this.#completionTimer);
    this.#completionTimer = null;
    this.#pendingCompletions.clear();
  }

  async #observe(snapshot: MicroSnapshot): Promise<void> {
    // Notification state is read-only and does not require app-server mutation
    // ownership. A fresh native slot proof remains usable when an unrelated
    // control/transport layer makes aggregate bridge health degraded.
    if (!hasFreshNotificationAuthority(snapshot)) return;
    this.#latestSnapshot = snapshot;
    const approvals = new Set(snapshot.pendingApprovals.map((approval) => approval.threadId));
    const next = new Map<string, ObservedSlotState>();
    for (const slot of snapshot.slots) {
      if (slot.threadId === null) continue;
      next.set(slot.threadId, {
        nativeStatus: normalizedNativeStatus(slot.nativeStatus),
        visualStatus: slot.visualStatus,
        approvalPending: approvals.has(slot.threadId),
      });
    }
    if (this.#previous === null) {
      this.#previous = next;
      return;
    }
    const candidates: NotificationCandidate[] = [];
    for (const slot of snapshot.slots) {
      if (slot.threadId === null) continue;
      const current = next.get(slot.threadId)!;
      if (!statusChanged(this.#previous.get(slot.threadId), current)) continue;
      const kind = notificationKind(slot, current.approvalPending);
      if (kind !== null) candidates.push({ kind, threadId: slot.threadId });
    }
    this.#previous = next;
    if (candidates.length === 0) return;
    const productState = await this.#productState.read();
    const pinned = new Set(productState.homeLayout.pinnedThreadIds);
    for (const candidate of candidates) {
      if (!productState.preferences.notifications[preferenceFor(candidate.kind)]) continue;
      if (candidate.kind === "completed") {
        if (!pinned.has(candidate.threadId)) continue;
        this.#pendingCompletions.add(candidate.threadId);
        this.#scheduleCompletionFlush();
        continue;
      }
      await this.#deliver(candidate.kind, candidate.threadId, 1, productState.preferences.notifications);
    }
  }

  #scheduleCompletionFlush(): void {
    if (this.#completionTimer !== null) return;
    this.#completionTimer = setTimeout(() => {
      this.#completionTimer = null;
      void this.flushCompletions().catch(() => {
        this.#logger.warn("Nerva could not dispatch a grouped completion notification.");
      });
    }, this.#completionGroupDelayMs);
    this.#completionTimer.unref?.();
  }

  async #deliver(
    kind: IntelligentPushKind,
    threadId: string | null,
    count: number,
    preferences: ProductPreferences["notifications"],
  ): Promise<void> {
    if (!preferences[preferenceFor(kind)]) return;
    const subscriptions = await this.#subscriptions.list();
    if (subscriptions.length === 0) return;
    const [title, body] = fixedNotificationCopy(kind, count);
    const badgeCount = await this.#badgeCount(preferences);
    const topic = opaqueTopic(kind, threadId ?? undefined);
    const payload: IntelligentPushPayload = {
      version: 1,
      kind,
      title,
      body,
      tag: `nerva-${topic}`,
      badgeCount,
      generatedAt: this.#now(),
      target: kind === "results"
        ? { view: "mission" }
        : { view: "session", threadId: threadId! },
    };
    const serialized = payloadString(payload);
    const expiredDevices: string[] = [];
    await Promise.all(subscriptions.map(async (stored) => {
      const { deviceId, createdAt: _createdAt, updatedAt: _updatedAt, ...subscription } = stored;
      try {
        await this.#delivery.send(subscription, serialized, {
          ttlSeconds: kind === "completed" || kind === "results" ? 21_600 : 3_600,
          urgency: kind === "completed" || kind === "results" ? "normal" : "high",
          topic,
        });
      } catch (error) {
        const statusCode = error instanceof WebPushError ? error.statusCode : (error as { statusCode?: unknown }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          expiredDevices.push(deviceId);
          return;
        }
        this.#logger.warn(`Nerva Web Push delivery failed${typeof statusCode === "number" ? ` (${statusCode})` : ""}.`);
      }
    }));
    await Promise.all(expiredDevices.map((deviceId) => this.#subscriptions.removeDevice(deviceId)));
  }

  async #badgeCount(preferences: ProductPreferences["notifications"]): Promise<number> {
    if (this.#latestSnapshot === null) return 0;
    const state = await this.#productState.read();
    const pinned = new Set(state.homeLayout.pinnedThreadIds);
    const approvals = new Set(this.#latestSnapshot.pendingApprovals.map((approval) => approval.threadId));
    return this.#latestSnapshot.slots.filter((slot) => {
      if (slot.threadId === null || !pinned.has(slot.threadId)) return false;
      const kind = notificationKind(slot, approvals.has(slot.threadId));
      return kind !== null && preferences[preferenceFor(kind)];
    }).length;
  }
}

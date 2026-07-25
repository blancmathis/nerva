import type { SessionActivityEvent } from "./activity-timeline";
import type { ProductSession } from "./session-presentation";
import type { UiPreferences } from "./storage";
import type { BrowserPushSubscription, PushServerStatus } from "./bridge-client";

type NotificationPreferenceKey = keyof UiPreferences["notifications"];

const NOTIFICATION_STATUS: Readonly<Partial<Record<SessionActivityEvent["status"], NotificationPreferenceKey>>> = {
  "awaiting-approval": "needsApproval",
  "awaiting-response": "waiting",
  unread: "completed",
  error: "error",
};

const PRIVATE_NOTIFICATION_COPY: Readonly<Partial<Record<SessionActivityEvent["status"], readonly [string, string]>>> = {
  "awaiting-approval": ["Approval needed", "A Codex task is waiting for your approval on the Mac."],
  "awaiting-response": ["Your answer is needed", "A Codex task is blocked until you answer."],
  unread: ["Important result ready", "A pinned Codex task has a new result to review."],
  error: ["A task needs attention", "A Codex task hit an error. Open Nerva to inspect it."],
};

export type NervaNotificationPermission = NotificationPermission | "unsupported";

export type NervaNotificationTarget =
  | { readonly view: "session"; readonly threadId: string }
  | { readonly view: "mission" };

export interface NervaNotificationOpenMessage {
  readonly type: "nerva-notification-open";
  readonly target: NervaNotificationTarget;
}

export function notificationTargetFromMessage(value: unknown): NervaNotificationTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Partial<NervaNotificationOpenMessage>;
  if (message.type !== "nerva-notification-open" || typeof message.target !== "object" || message.target === null) return null;
  if (message.target.view === "mission") return { view: "mission" };
  return message.target.view === "session"
    && typeof message.target.threadId === "string"
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(message.target.threadId)
    ? { view: "session", threadId: message.target.threadId.toLowerCase() }
    : null;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/gu, "+").replace(/_/gu, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error("The bridge returned an invalid Web Push key.");
  return bytes;
}

function serializedSubscription(subscription: PushSubscription): BrowserPushSubscription {
  const json = subscription.toJSON();
  if (
    typeof json.endpoint !== "string"
    || !json.keys
    || typeof json.keys.p256dh !== "string"
    || typeof json.keys.auth !== "string"
  ) throw new Error("iPadOS returned an incomplete Web Push subscription.");
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

export function pushManagerSupported(): boolean {
  return notificationPermission() !== "unsupported" && "PushManager" in window;
}

export function notificationPermission(): NervaNotificationPermission {
  return "Notification" in window && "serviceWorker" in navigator
    ? Notification.permission
    : "unsupported";
}

export async function requestNotificationPermission(): Promise<NervaNotificationPermission> {
  if (notificationPermission() === "unsupported") return "unsupported";
  return Notification.requestPermission();
}

export async function enableIntelligentPush(
  status: PushServerStatus,
  save: (subscription: BrowserPushSubscription) => Promise<void>,
): Promise<void> {
  if (!pushManagerSupported()) throw new Error("Background Web Push is unavailable in this browser context.");
  const permission = await requestNotificationPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "Notifications are blocked in iPadOS Settings."
      : "Notification permission was not granted.");
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(status.publicKey),
  });
  await save(serializedSubscription(subscription));
}

export async function disableIntelligentPush(
  removeFromBridge: () => Promise<void>,
): Promise<void> {
  await removeFromBridge();
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

export async function reconcileIntelligentPush(
  status: PushServerStatus,
  save: (subscription: BrowserPushSubscription) => Promise<void>,
  removeFromBridge: () => Promise<void>,
): Promise<void> {
  if (!pushManagerSupported() || notificationPermission() !== "granted") return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && !status.subscribed) {
    await save(serializedSubscription(subscription));
  } else if (!subscription && status.subscribed) {
    await removeFromBridge();
  }
}

export function notificationTargetFromUrl(location: Pick<Location, "search">): NervaNotificationTarget | null {
  const parameters = new URLSearchParams(location.search);
  const view = parameters.get("open");
  if (view === "mission") return { view: "mission" };
  const threadId = parameters.get("thread");
  return view === "session" && threadId !== null && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(threadId)
    ? { view: "session", threadId: threadId.toLowerCase() }
    : null;
}

export async function notifySessionActivity(
  event: SessionActivityEvent,
  _sessionTitle: string,
  preferences: UiPreferences["notifications"],
  backgroundPushSubscribed = false,
): Promise<void> {
  const preference = NOTIFICATION_STATUS[event.status];
  if (
    !preference
    || !preferences[preference]
    || backgroundPushSubscribed
    || notificationPermission() !== "granted"
    || document.visibilityState === "visible"
  ) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const target = { view: "session" as const, threadId: event.threadId };
    const [title, body] = PRIVATE_NOTIFICATION_COPY[event.status]!;
    await registration.showNotification(title, {
      body,
      tag: `nerva:${event.threadId}:${event.status}`,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: `/?open=session&thread=${encodeURIComponent(event.threadId)}`, target },
    });
  } catch {
    // The app state remains authoritative; a notification is never retried as
    // a side effect because iPadOS may have suspended the worker.
  }
}

export async function syncAgentBadge(
  sessions: readonly ProductSession[],
  preferences: UiPreferences["notifications"],
): Promise<void> {
  if (!("setAppBadge" in navigator)) return;
  const count = sessions.filter((session) => {
    const preference = NOTIFICATION_STATUS[session.status];
    return preference !== undefined && preferences[preference];
  }).length;
  try {
    if (count === 0) await navigator.clearAppBadge();
    else await navigator.setAppBadge(count);
  } catch {
    // Badging is optional platform chrome and never affects task state.
  }
}

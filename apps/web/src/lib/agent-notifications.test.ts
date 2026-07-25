import { afterEach, describe, expect, it, vi } from "vitest";

import {
  notificationTargetFromMessage,
  notificationTargetFromUrl,
  notifySessionActivity,
} from "./agent-notifications";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(globalThis, "Notification");
});

describe("notification deep links", () => {
  it("accepts only exact Session and legacy Home Priority targets", () => {
    expect(notificationTargetFromMessage({
      type: "nerva-notification-open",
      target: { view: "session", threadId: THREAD_ID.toUpperCase() },
    })).toEqual({ view: "session", threadId: THREAD_ID });
    expect(notificationTargetFromMessage({
      type: "nerva-notification-open",
      target: { view: "mission" },
    })).toEqual({ view: "mission" });
    expect(notificationTargetFromMessage({
      type: "nerva-notification-open",
      target: { view: "approval", decision: "approve" },
    })).toBeNull();
  });

  it("does not accept arbitrary URLs from a notification launch", () => {
    expect(notificationTargetFromUrl({ search: `?open=session&thread=${THREAD_ID}` } as Location))
      .toEqual({ view: "session", threadId: THREAD_ID });
    expect(notificationTargetFromUrl({ search: "?open=mission" } as Location))
      .toEqual({ view: "mission" });
    expect(notificationTargetFromUrl({ search: "?open=https://evil.example" } as Location)).toBeNull();
  });
});

describe("foreground fallback notifications", () => {
  it("uses generic lock-screen copy and keeps only the exact encrypted target", async () => {
    const showNotification = vi.fn(async (_title: string, _options: NotificationOptions) => undefined);
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted" },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({ showNotification }) },
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    await notifySessionActivity({
      id: "event-1",
      threadId: THREAD_ID,
      status: "awaiting-approval",
      at: 1,
      title: "Secret customer migration",
      detail: "Run a private destructive command",
    }, "Secret customer migration", {
      needsApproval: true,
      completed: true,
      error: true,
      waiting: true,
    });

    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = showNotification.mock.calls[0]!;
    expect(title).toBe("Approval needed");
    expect(options).toMatchObject({
      body: "A Codex task is waiting for your approval on the Mac.",
      data: {
        url: `/?open=session&thread=${THREAD_ID}`,
        target: { view: "session", threadId: THREAD_ID },
      },
    });
    expect(JSON.stringify(showNotification.mock.calls[0])).not.toContain("Secret customer migration");
    expect(JSON.stringify(showNotification.mock.calls[0])).not.toContain("destructive command");
  });
});

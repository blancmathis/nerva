import { describe, expect, it, vi } from "vitest";

import { createSerialMutationQueue } from "./serial-mutation-queue";

describe("serial mutation queue", () => {
  it("does not let a later persistence mutation overtake a slow earlier one", async () => {
    const queue = createSerialMutationQueue();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.enqueue(async () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseFirst();
    await Promise.all([first, second, queue.settled()]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues with the newest mutation after an earlier write rejects", async () => {
    const queue = createSerialMutationQueue();
    const first = queue.enqueue(async () => { throw new Error("storage unavailable"); });
    const second = queue.enqueue(async () => "newest saved");

    await expect(first).rejects.toThrow("storage unavailable");
    await expect(second).resolves.toBe("newest saved");
    await expect(queue.settled()).resolves.toBeUndefined();
  });
});

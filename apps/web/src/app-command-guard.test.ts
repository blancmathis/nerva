import { describe, expect, it } from "vitest";
import { releaseCommandMutation, tryAcquireCommandMutation } from "./App";

describe("command mutation guard", () => {
  it("rejects a second synchronous dispatch until the active command releases the lock", () => {
    const lock = { current: false };

    expect(tryAcquireCommandMutation(lock)).toBe(true);
    expect(tryAcquireCommandMutation(lock)).toBe(false);

    releaseCommandMutation(lock);
    expect(tryAcquireCommandMutation(lock)).toBe(true);
  });
});

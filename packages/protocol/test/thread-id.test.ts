import { describe, expect, it } from "vitest";

import { extractThreadUuid, isSafeNativeThreadKey } from "../src/index.js";

const UUID = "019f6de7-44c2-7fe2-9d17-9322c952e626";

describe("extractThreadUuid", () => {
  it.each([
    UUID,
    `local:${UUID}`,
    `client-new-thread:${UUID}`,
    `local:client-new-thread:${UUID}`,
  ])("extracts a canonical UUID from %s", (threadKey) => {
    expect(extractThreadUuid(threadKey.toUpperCase())).toBe(UUID);
    expect(isSafeNativeThreadKey(threadKey)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "",
    `local:../../${UUID}`,
    `../${UUID}`,
    `/tmp/${UUID}`,
    `codex://threads/${UUID}`,
    `${UUID}/child`,
    `local:${UUID}?query=1`,
    `unsafe prefix:${UUID}`,
    `one:two:three:four:${UUID}`,
    "not-a-uuid",
  ])("rejects non-identity thread keys (%s)", (threadKey) => {
    expect(extractThreadUuid(threadKey)).toBeNull();
    expect(isSafeNativeThreadKey(threadKey)).toBe(false);
  });
});

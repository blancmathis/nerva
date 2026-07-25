import { afterEach, describe, expect, it, vi } from "vitest";

import { createUuidV4 } from "./uuid";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createUuidV4", () => {
  it("uses getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(target: T): T => {
      const bytes = target as Uint8Array;
      bytes.forEach((_value, index) => {
        bytes[index] = index;
      });
      return target;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    expect(createUuidV4()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("sets the RFC 4122 version and variant bits", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView | null>(target: T): T => {
        (target as Uint8Array).fill(0xff);
        return target;
      },
    });

    expect(createUuidV4()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("keeps non-secret UI identities usable without Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const first = createUuidV4();
    const second = createUuidV4();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});

import { describe, expect, it } from "vitest";
import { classifySnapshot, isFreshSnapshot } from "./snapshot-order";

const FIRST = "7d35b974-62cc-4db8-9b4e-5a8dc8a4d812";
const RESTARTED = "0bb7bb32-f477-4792-ad7b-06fef8287138";

describe("isFreshSnapshot", () => {
  it("accepts the first snapshot", () => {
    expect(isFreshSnapshot(null, { bridgeInstanceId: FIRST, seq: 73 })).toBe(true);
  });

  it("enforces strict monotonicity inside one bridge generation", () => {
    const current = { bridgeInstanceId: FIRST, seq: 73 };
    expect(isFreshSnapshot(current, { bridgeInstanceId: FIRST, seq: 74 })).toBe(true);
    expect(isFreshSnapshot(current, { bridgeInstanceId: FIRST, seq: 73 })).toBe(false);
    expect(isFreshSnapshot(current, { bridgeInstanceId: FIRST, seq: 1 })).toBe(false);
  });

  it("accepts a lower sequence after the bridge generation changes", () => {
    expect(isFreshSnapshot(
      { bridgeInstanceId: FIRST, seq: 73 },
      { bridgeInstanceId: RESTARTED, seq: 1 },
    )).toBe(true);
  });

  it("classifies an exact duplicate as current socket attestation", () => {
    const cursor = { bridgeInstanceId: FIRST, seq: 73 };
    expect(classifySnapshot(cursor, cursor)).toBe("current");
    expect(classifySnapshot(cursor, { ...cursor, seq: 72 })).toBe("rejected");
    expect(classifySnapshot(cursor, { bridgeInstanceId: RESTARTED, seq: 73 })).toBe("advanced");
  });
});

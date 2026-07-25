import { describe, expect, it } from "vitest";
import { drawingDeliveryIsUnresolved } from "./drawing-delivery";

describe("drawing delivery reconciliation", () => {
  it("locks explicit unknown and every in-flight acknowledgement to the same command ID", () => {
    expect(drawingDeliveryIsUnresolved({ ok: false, deliveryUnknown: true })).toBe(true);
    expect(drawingDeliveryIsUnresolved({ ok: false, pending: true })).toBe(true);
    expect(drawingDeliveryIsUnresolved({ ok: true, pending: true })).toBe(true);
  });

  it("allows a fresh ID only after a definitive rejection", () => {
    expect(drawingDeliveryIsUnresolved({ ok: false, pending: false })).toBe(false);
    expect(drawingDeliveryIsUnresolved({ ok: true, pending: false })).toBe(false);
  });
});

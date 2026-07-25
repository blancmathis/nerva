import { describe, expect, it } from "vitest";

import {
  DeviceRevocationResponseSchema,
  PairedDevicesResponseSchema,
} from "../src/devices";

const currentDeviceId = "11111111-1111-4111-8111-111111111111";

describe("paired-device protocol", () => {
  it("accepts a bounded current-device list and exact revocation result", () => {
    expect(PairedDevicesResponseSchema.parse({
      currentDeviceId,
      devices: [{
        id: currentDeviceId,
        name: "Mathis’s iPad",
        createdAt: "2026-07-20T12:00:00.000Z",
        revokedAt: null,
      }],
    }).devices).toHaveLength(1);

    expect(DeviceRevocationResponseSchema.parse({
      revoked: true,
      deviceId: currentDeviceId,
    })).toEqual({ revoked: true, deviceId: currentDeviceId });
  });

  it("rejects malformed identities and excess device records", () => {
    expect(PairedDevicesResponseSchema.safeParse({ currentDeviceId: "recent-ipad", devices: [] }).success).toBe(false);
    expect(PairedDevicesResponseSchema.safeParse({
      currentDeviceId,
      devices: Array.from({ length: 129 }, (_, index) => ({
        id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        name: `iPad ${index}`,
        createdAt: "2026-07-20T12:00:00.000Z",
        revokedAt: null,
      })),
    }).success).toBe(false);
  });
});

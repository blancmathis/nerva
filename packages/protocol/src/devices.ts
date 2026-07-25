import { z } from "zod";

import { createApiEnvelopeSchema } from "./api.js";

export const PairedDeviceSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
}).strict();

export const PairedDevicesResponseSchema = z.object({
  currentDeviceId: z.uuid(),
  devices: z.array(PairedDeviceSchema).max(128),
}).strict();

export const DeviceRevocationResponseSchema = z.object({
  revoked: z.literal(true),
  deviceId: z.uuid(),
}).strict();

export const PairedDevicesApiResponseSchema = createApiEnvelopeSchema(PairedDevicesResponseSchema);
export const DeviceRevocationApiResponseSchema = createApiEnvelopeSchema(DeviceRevocationResponseSchema);

export type PairedDevice = z.infer<typeof PairedDeviceSchema>;
export type PairedDevicesResponse = z.infer<typeof PairedDevicesResponseSchema>;


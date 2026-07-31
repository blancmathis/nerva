import { z } from "zod";

/**
 * Version of the Nerva bridge/PWA request contract. Bump only when a client
 * mutation produced by an older contract can no longer be interpreted safely.
 */
export const API_CONTRACT_VERSION = 1 as const;

/** Existing authenticated mutation requests can advertise their contract here. */
export const API_CONTRACT_HEADER = "x-codex-pad-api-contract" as const;
export const BUILD_REVISION_HEADER = "x-codex-pad-build-revision" as const;

export const ApiContractVersionSchema = z.number().int().positive().max(65_535);
export const BuildRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^(?:[0-9a-f]{7,64}(?:-dirty)?|development)$/u);
export const BridgeVersionSchema = z.string().trim().min(1).max(100);

export const RuntimeIdentitySchema = z
  .object({
    bridgeVersion: BridgeVersionSchema,
    buildRevision: BuildRevisionSchema,
    apiContractVersion: ApiContractVersionSchema,
  })
  .strict();

export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

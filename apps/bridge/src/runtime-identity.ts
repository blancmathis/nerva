import {
  API_CONTRACT_VERSION,
  RuntimeIdentitySchema,
  type RuntimeIdentity,
} from "@codex-pad/protocol";

declare const __CODEX_PAD_BUILD_REVISION__: string | undefined;

export const BRIDGE_VERSION = "0.1.0";

const compiledRevision = typeof __CODEX_PAD_BUILD_REVISION__ === "string"
  ? __CODEX_PAD_BUILD_REVISION__
  : "development";

/** Captured by tsup at build time; never inferred from a newer checkout at runtime. */
export const BRIDGE_RUNTIME_IDENTITY: RuntimeIdentity = RuntimeIdentitySchema.parse({
  bridgeVersion: BRIDGE_VERSION,
  buildRevision: compiledRevision,
  apiContractVersion: API_CONTRACT_VERSION,
});

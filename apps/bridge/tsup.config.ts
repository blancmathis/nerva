import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";
import { resolveBuildRevision } from "../../scripts/build-revision.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  entry: [
    "src/server.ts",
    "src/auth.ts",
    "src/pairing.ts",
    "src/runtime-identity.ts",
    "src/site-registry.ts",
    "src/diagram-store.ts",
    "src/cli.ts",
    "src/mac-setup.ts",
  ],
  format: ["esm"],
  clean: true,
  outDir: "dist",
  define: {
    __CODEX_PAD_BUILD_REVISION__: JSON.stringify(resolveBuildRevision(repositoryRoot)),
  },
});

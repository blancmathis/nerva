import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { API_CONTRACT_VERSION } from "@codex-pad/protocol";

import { renderServiceWorker, serviceWorkerBuildId } from "./src/build-service-worker.js";
import { configuredWebBuildRevision } from "./src/web-build-revision.js";

const serviceWorkerTemplate = readFileSync(new URL("./src/sw-template.js", import.meta.url), "utf8");
const webPackage = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function buildServiceWorker(buildRevision: string): Plugin {
  return {
    name: "codex-pad-build-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle).map((output) => ({
        fileName: output.fileName,
        source: output.type === "chunk" ? output.code : output.source,
      }));
      const buildId = serviceWorkerBuildId(serviceWorkerTemplate, outputs);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: renderServiceWorker(serviceWorkerTemplate, outputs),
      });
      this.emitFile({
        type: "asset",
        fileName: "app-meta.json",
        source: JSON.stringify({
          product: "Nerva",
          version: webPackage.version,
          buildId,
          buildRevision,
          apiContractVersion: API_CONTRACT_VERSION,
        }),
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const buildRevision = configuredWebBuildRevision(command, mode, repositoryRoot);
  return {
    define: {
      __NERVA_VERSION__: JSON.stringify(webPackage.version),
      __NERVA_BUILD_ID__: JSON.stringify(process.env.CODEX_PAD_BUILD_ID ?? webPackage.version),
      __NERVA_BUILD_REVISION__: JSON.stringify(buildRevision),
    },
    plugins: [react(), buildServiceWorker(buildRevision)],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:8787",
        "/ws": {
          target: "ws://127.0.0.1:8787",
          ws: true,
        },
      },
    },
    build: {
      target: "safari17",
      sourcemap: true,
    },
  };
});

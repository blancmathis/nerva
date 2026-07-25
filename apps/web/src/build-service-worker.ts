import { createHash } from "node:crypto";

export const SHELL_CACHE_TOKEN = "__CODEX_PAD_SHELL_CACHE__";
export const SHELL_ASSETS_TOKEN = "__NERVA_BUILD_ASSETS__";

export interface ServiceWorkerBuildOutput {
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

export function serviceWorkerBuildId(
  template: string,
  outputs: readonly ServiceWorkerBuildOutput[],
): string {
  const hash = createHash("sha256");
  hash.update(template);
  for (const output of [...outputs].sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    hash.update("\0");
    hash.update(output.fileName);
    hash.update("\0");
    hash.update(output.source);
  }
  return hash.digest("hex").slice(0, 16);
}

export function renderServiceWorker(
  template: string,
  outputs: readonly ServiceWorkerBuildOutput[],
): string {
  if (template.split(SHELL_CACHE_TOKEN).length !== 2) {
    throw new Error("The service-worker template must contain exactly one shell-cache token");
  }
  if (template.split(SHELL_ASSETS_TOKEN).length !== 2) {
    throw new Error("The service-worker template must contain exactly one build-assets token");
  }
  const buildId = serviceWorkerBuildId(template, outputs);
  const buildAssets = outputs
    .map((output) => output.fileName)
    .filter((fileName) => fileName.startsWith("assets/") && /\.(?:css|js)$/u.test(fileName))
    .sort()
    .map((fileName) => `/${fileName}`);
  return template
    .replace(SHELL_CACHE_TOKEN, `codex-pad-shell-${buildId}`)
    .replace(SHELL_ASSETS_TOKEN, JSON.stringify(buildAssets));
}

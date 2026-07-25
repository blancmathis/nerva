import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderServiceWorker, serviceWorkerBuildId, SHELL_ASSETS_TOKEN, SHELL_CACHE_TOKEN } from "./build-service-worker";

const template = `const SHELL_CACHE = "${SHELL_CACHE_TOKEN}"; const BUILD_ASSETS = ${SHELL_ASSETS_TOKEN};`;

describe("service-worker build generation", () => {
  it("gives each hashed asset generation its own deterministic shell cache", () => {
    const first = [{ fileName: "assets/app-first.js", source: "first bundle" }];
    const second = [{ fileName: "assets/app-second.js", source: "second bundle" }];

    expect(serviceWorkerBuildId(template, first)).toBe(serviceWorkerBuildId(template, [...first]));
    expect(serviceWorkerBuildId(template, second)).not.toBe(serviceWorkerBuildId(template, first));

    const firstWorker = renderServiceWorker(template, first);
    const secondWorker = renderServiceWorker(template, second);
    expect(firstWorker).toMatch(/codex-pad-shell-[0-9a-f]{16}/u);
    expect(secondWorker).toMatch(/codex-pad-shell-[0-9a-f]{16}/u);
    expect(secondWorker).not.toBe(firstWorker);
    expect(firstWorker).not.toContain(SHELL_CACHE_TOKEN);
    expect(firstWorker).not.toContain(SHELL_ASSETS_TOKEN);
    expect(firstWorker).toContain('"/assets/app-first.js"');
  });

  it("keeps push navigation strict and exposes no Lock Screen approval action", () => {
    const worker = readFileSync(join(process.cwd(), "apps/web/src/sw-template.js"), "utf8");
    expect(worker).toContain('type: "nerva-notification-open"');
    expect(worker).toContain('target?.view === "mission"');
    expect(worker).toContain('target?.view === "session"');
    expect(worker).not.toMatch(/\bactions\s*:/u);
    expect(worker).not.toContain("approve");
  });
});

import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSiteOriginPolicy,
  directModeMetadata,
  projectCwdIdentifier,
} from "../../../packages/site-review/src/index.js";
import { defaultDataPaths } from "../src/paths.js";
import { SiteRegistry, addSite, listSites, removeSite } from "../src/site-registry.js";

const THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e626";
const OTHER_THREAD_ID = "019f6de7-44c2-7fe2-9d17-9322c952e627";
const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-site-registry-"));
  tempRoots.push(root);
  return root;
}

const policy = createSiteOriginPolicy({
  allowedLoopbackPorts: [3000, 5173],
  allowedMagicDnsOrigins: ["https://codex-mac.example-tail.ts.net:5173"],
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SiteRegistry", () => {
  it("stores explicit approvals atomically in a mode-0600 app-support file", async () => {
    const root = await tempRoot();
    const registry = new SiteRegistry({
      appSupportPath: root,
      originPolicy: policy,
      bridgePublicOrigin: "https://codex-mac.example-tail.ts.net",
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });
    const approved = await registry.approve({
      siteId: "dashboard",
      label: "Dashboard",
      origin: "http://localhost:3000",
      association: { threadId: THREAD_ID },
    });

    expect(approved).toMatchObject({
      siteId: "dashboard",
      association: { kind: "thread", threadId: THREAD_ID },
      remoteBrowser: {
        status: "unavailable",
        reason: "thread-tab-mapping-unproven",
      },
      publicOrigin: "https://codex-mac.example-tail.ts.net:3000",
    });
    expect((await stat(registry.filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(registry.filePath, "utf8"))).toMatchObject({
      version: 1,
      generation: 1,
      sites: [{ siteId: "dashboard" }],
    });
    expect(directModeMetadata(approved).tailscaleServe?.command).toBe(
      "tailscale serve --bg --https=3000 http://127.0.0.1:3000",
    );
  });

  it("authorizes only the exact thread or normalized project association", async () => {
    const registry = new SiteRegistry({ appSupportPath: await tempRoot(), originPolicy: policy });
    await registry.approve({
      siteId: "thread-site",
      label: "Thread site",
      origin: "http://127.0.0.1:3000",
      association: { threadId: THREAD_ID },
    });
    await registry.approve({
      siteId: "project-site",
      label: "Project site",
      origin: "http://127.0.0.1:5173",
      association: { projectCwd: "/workspace/work/../project" },
    });

    expect(
      await registry.listForContext({ threadId: THREAD_ID, projectCwd: "/workspace/project" }),
    ).toMatchObject([{ siteId: "thread-site" }, { siteId: "project-site" }]);
    await expect(
      registry.requireApprovedForContext("thread-site", { threadId: OTHER_THREAD_ID }),
    ).rejects.toMatchObject({ code: "SITE_NOT_APPROVED" });
    await expect(
      registry.requireApprovedForContext("project-site", { projectCwd: "/workspace/project" }),
    ).resolves.toMatchObject({ siteId: "project-site" });
    await expect(
      registry.requireApprovedForContext("project-site", {
        projectId: projectCwdIdentifier("/workspace/project"),
      }),
    ).resolves.toMatchObject({ siteId: "project-site" });
  });

  it("keeps site ids bound to one origin while allowing multiple sites per association", async () => {
    const registry = new SiteRegistry({ appSupportPath: await tempRoot(), originPolicy: policy });
    await registry.approve({
      siteId: "site",
      label: "Old",
      origin: "http://localhost:3000",
      association: { threadId: THREAD_ID },
    });
    await registry.approve({
      siteId: "site",
      label: "New",
      origin: "http://localhost:3000",
      association: { threadId: THREAD_ID },
    });
    expect(await registry.listAll()).toMatchObject([
      { siteId: "site", label: "New", origin: "http://localhost:3000" },
    ]);
    await expect(registry.approve({
      siteId: "site",
      label: "Retargeted",
      origin: "http://localhost:5173",
      association: { threadId: THREAD_ID },
    })).rejects.toThrow(/cannot be reassigned/u);
    await registry.approve({
      siteId: "second-site",
      label: "Second",
      origin: "http://localhost:5173",
      association: { threadId: THREAD_ID },
    });
    expect(await registry.listForContext({ threadId: THREAD_ID })).toMatchObject([
      { siteId: "site", label: "New" },
      { siteId: "second-site", label: "Second" },
    ]);
    await expect(registry.snapshot()).resolves.toMatchObject({ generation: 3 });
    await expect(registry.revoke("site")).resolves.toBe(true);
    await expect(registry.snapshot()).resolves.toMatchObject({
      generation: 4,
      sites: [{ siteId: "second-site" }],
    });
    await expect(registry.revoke("site")).resolves.toBe(false);
    await expect(registry.revoke("second-site")).resolves.toBe(true);
    await expect(registry.listAll()).resolves.toEqual([]);
  });

  it("keeps same-origin site identities distinct and sorts normalized labels by stable id", async () => {
    const registry = new SiteRegistry({ appSupportPath: await tempRoot(), originPolicy: policy });
    await registry.approve({
      siteId: "same-zulu",
      label: "Cafe\u0301",
      origin: "http://127.0.0.1:3000",
      association: { threadId: THREAD_ID },
    });
    await registry.approve({
      siteId: "same-alpha",
      label: "Café",
      origin: "http://127.0.0.1:3000",
      association: { threadId: THREAD_ID },
    });

    const sites = await registry.listForContext({ threadId: THREAD_ID });
    expect(sites.map((site) => ({ siteId: site.siteId, label: site.label }))).toEqual([
      { siteId: "same-alpha", label: "Café" },
      { siteId: "same-zulu", label: "Café" },
    ]);
    await expect(
      registry.requireApprovedForContext("same-zulu", { threadId: THREAD_ID }),
    ).resolves.toMatchObject({ siteId: "same-zulu", origin: "http://127.0.0.1:3000" });
  });

  it("rejects insecure permissions and symlinked registries", async () => {
    const root = await tempRoot();
    const filePath = join(root, "sites.json");
    await writeFile(filePath, '{"version":1,"sites":[]}\n', { mode: 0o600 });
    const registry = new SiteRegistry({ filePath, originPolicy: policy });

    await chmod(filePath, 0o644);
    await expect(registry.listAll()).rejects.toThrow(/0600/u);

    await rm(filePath);
    const target = join(root, "target.json");
    await writeFile(target, '{"version":1,"sites":[]}\n', { mode: 0o600 });
    await symlink(target, filePath);
    await expect(registry.listAll()).rejects.toThrow(/symlinked/u);
  });

  it("revalidates persisted origins instead of trusting edited JSON", async () => {
    const root = await tempRoot();
    const filePath = join(root, "sites.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        sites: [
          {
            version: 1,
            siteId: "metadata",
            label: "Metadata",
            association: { kind: "thread", threadId: THREAD_ID },
            origin: "http://169.254.169.254:3000",
            approvedAt: "2026-07-20T10:00:00.000Z",
            updatedAt: "2026-07-20T10:00:00.000Z",
            remoteBrowser: {
              status: "unavailable",
              reason: "thread-tab-mapping-unproven",
              detail: "disabled",
            },
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const registry = new SiteRegistry({ filePath, originPolicy: policy });
    await expect(registry.listAll()).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
  });

  it("keeps the bridge list/add/remove projection without weakening validation", async () => {
    const paths = defaultDataPaths(await tempRoot());
    const added = await addSite(
      {
        targetKind: "thread",
        targetId: THREAD_ID,
        loopbackUrl: "http://127.0.0.1:3000",
        name: "Preview",
      },
      { paths },
    );
    expect(added).toMatchObject({
      associationId: expect.any(String),
      targetKind: "thread",
      targetId: THREAD_ID,
      name: "Preview",
      loopbackUrl: "http://127.0.0.1:3000",
      publicOrigin: null,
    });
    const second = await addSite(
      {
        targetKind: "thread",
        targetId: THREAD_ID,
        loopbackUrl: "http://127.0.0.1:5173",
        name: "Second preview",
      },
      { paths },
    );
    expect(second.associationId).not.toBe(added.associationId);
    const sameOrigin = await addSite(
      {
        targetKind: "thread",
        targetId: THREAD_ID,
        loopbackUrl: "http://127.0.0.1:3000",
        name: "Same origin tab",
      },
      { paths },
    );
    expect(sameOrigin.associationId).not.toBe(added.associationId);
    const renamed = await addSite(
      {
        siteId: added.associationId,
        targetKind: "thread",
        targetId: THREAD_ID,
        loopbackUrl: "http://127.0.0.1:3000",
        name: "Preview renamed",
      },
      { paths },
    );
    expect(renamed.associationId).toBe(added.associationId);
    await expect(listSites({ paths })).resolves.toMatchObject([
      { targetId: THREAD_ID, name: "Preview renamed" },
      { targetId: THREAD_ID, name: "Same origin tab" },
      { targetId: THREAD_ID, name: "Second preview" },
    ]);
    await expect(removeSite(added.associationId, { paths })).resolves.toBe(true);

    await expect(addSite({
      targetKind: "thread",
      targetId: THREAD_ID,
      loopbackUrl: "http://127.0.0.1:3000",
      publicOrigin: "https://codex-mac.example-tail.ts.net:3000",
    }, { paths })).rejects.toMatchObject({ code: "INVALID_ORIGIN" });

    const project = await addSite(
      {
        targetKind: "project",
        targetId: "/workspace/private/acme-secret-project",
        loopbackUrl: "http://127.0.0.1:3000",
      },
      { paths },
    );
    expect(project).toMatchObject({
      targetKind: "project",
      targetId: projectCwdIdentifier("/workspace/private/acme-secret-project"),
      name: "Registered project site",
    });
    expect(project.name).not.toContain("acme");
    await expect(removeSite(project.associationId, { paths })).resolves.toBe(true);

    await expect(
      addSite(
        {
          targetKind: "project",
          targetId: "friendly-but-not-a-cwd",
          loopbackUrl: "http://127.0.0.1:3000",
        },
        { paths },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ASSOCIATION" });
    await expect(
      addSite(
        {
          targetKind: "project",
          targetId: projectCwdIdentifier("/workspace/project"),
          loopbackUrl: "https://localhost:3000",
        },
        { paths },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
  });

  it("binds an explicit MagicDNS public origin to the configured bridge hostname before write", async () => {
    const registry = new SiteRegistry({
      appSupportPath: await tempRoot(),
      originPolicy: policy,
      bridgePublicOrigin: "https://codex-mac.example-tail.ts.net",
    });
    await expect(
      registry.approve({
        siteId: "public-preview",
        label: "Public preview",
        origin: "http://127.0.0.1:5173",
        publicOrigin: "https://codex-mac.example-tail.ts.net:5173",
        association: { threadId: THREAD_ID },
      }),
    ).resolves.toMatchObject({
      origin: "http://127.0.0.1:5173",
      publicOrigin: "https://codex-mac.example-tail.ts.net:5173",
    });
    await expect(
      registry.approve({
        siteId: "wrong-port",
        label: "Wrong port",
        origin: "http://127.0.0.1:5173",
        publicOrigin: "https://codex-mac.example-tail.ts.net:3000",
        association: { threadId: THREAD_ID },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
    for (const publicOrigin of [
      "https://other-mac.example-tail.ts.net:5173",
      "https://codex-macc.example-tail.ts.net:5173",
    ]) {
      await expect(
        registry.approve({
          siteId: "public-preview",
          label: "Public preview",
          origin: "http://127.0.0.1:5173",
          publicOrigin,
          association: { threadId: THREAD_ID },
        }),
      ).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
    }
    await expect(registry.snapshot()).resolves.toMatchObject({
      generation: 1,
      sites: [{
        siteId: "public-preview",
        publicOrigin: "https://codex-mac.example-tail.ts.net:5173",
      }],
    });
  });

  it("revalidates a persisted public hostname against the configured bridge", async () => {
    const root = await tempRoot();
    const filePath = join(root, "sites.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        generation: 4,
        sites: [{
          version: 1,
          siteId: "public-preview",
          label: "Public preview",
          association: { kind: "thread", threadId: THREAD_ID },
          origin: "http://127.0.0.1:5173",
          publicOrigin: "https://other-mac.example-tail.ts.net:5173",
          approvedAt: "2026-07-20T10:00:00.000Z",
          updatedAt: "2026-07-20T10:00:00.000Z",
          remoteBrowser: {
            status: "unavailable",
            reason: "thread-tab-mapping-unproven",
            detail: "disabled",
          },
        }],
      })}\n`,
      { mode: 0o600 },
    );
    const registry = new SiteRegistry({
      filePath,
      originPolicy: policy,
      bridgePublicOrigin: "https://codex-mac.example-tail.ts.net",
    });
    await expect(registry.listAll()).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
  });
});

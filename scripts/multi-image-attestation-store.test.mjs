import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  canonicalImageInputAttestationPath,
  testOnlyAttestationStore,
} from "./multi-image-attestation-store.mjs";

const temporaryRoots = [];
const uid = userInfo().uid;

function record(overrides = {}) {
  return {
    version: 1,
    codexBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexVersion: "codex-cli 0.145.0-alpha.18",
    schemaSha256: "a".repeat(64),
    serverUserAgent: "codex-app-server/0.145.0-alpha.18",
    verifiedAt: "2026-07-20T10:00:00.000Z",
    probe: "runtime-disposable-thread-bounded-multi-local-image",
    singleImageStartVerified: true,
    maxStartImages: 12,
    maxSteerImages: 0,
    disposableThreadDeleted: true,
    ...overrides,
  };
}

async function fixture() {
  const homeDirectory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "codex-pad-probe-store-"));
  temporaryRoots.push(homeDirectory);
  await mkdir(join(homeDirectory, "Library", "Application Support"), {
    recursive: true,
    mode: 0o700,
  });
  const store = testOnlyAttestationStore.storeForIdentity({ homeDirectory, uid });
  return { homeDirectory, store };
}

async function seed(store, value = record(), mode = 0o600) {
  await mkdir(store.securityDirectory, { recursive: true, mode: 0o700 });
  await writeFile(store.attestationPath, `${JSON.stringify(value)}\n`, { mode });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the production path ignores HOME and the removed capability-path override", () => {
  const originalHome = process.env.HOME;
  const originalOverride = process.env.CODEX_PAD_CAPABILITY_PATH;
  try {
    process.env.HOME = "/tmp/not-the-account-home";
    process.env.CODEX_PAD_CAPABILITY_PATH = "/tmp/not-the-attestation";
    assert.equal(
      canonicalImageInputAttestationPath(),
      join(
        userInfo().homedir,
        "Library",
        "Application Support",
        "CodexPad",
        "security",
        "image-input-capability.json",
      ),
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOverride === undefined) delete process.env.CODEX_PAD_CAPABILITY_PATH;
    else process.env.CODEX_PAD_CAPABILITY_PATH = originalOverride;
  }
});

test("a failed non-mutating preflight cannot invalidate an arbitrary path", async () => {
  const { homeDirectory } = await fixture();
  const sentinel = join(homeDirectory, "sentinel.json");
  await writeFile(sentinel, "keep\n", { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "multi-image-capability-probe.mjs"), "--write-attestation"],
    {
      cwd: dirname(import.meta.dirname),
      encoding: "utf8",
      env: { ...process.env, CODEX_PAD_CAPABILITY_PATH: sentinel },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).failure.code, "DISPOSABLE_THREAD_ACKNOWLEDGEMENT_REQUIRED");
  assert.equal(await readFile(sentinel, "utf8"), "keep\n");
});

test("write and invalidation accept only a private strict regular record", async (context) => {
  const { store } = await fixture();
  await testOnlyAttestationStore.writeStore(store, record());
  const written = await lstat(store.attestationPath);
  assert.equal(written.isFile(), true);
  assert.equal(written.uid, uid);
  assert.equal(written.nlink, 1);
  assert.equal(written.mode & 0o777, 0o600);
  await testOnlyAttestationStore.invalidateStore(store);
  await assert.rejects(lstat(store.attestationPath), { code: "ENOENT" });

  const rejected = async (name, arrange) => context.test(name, async () => {
    await rm(store.applicationRoot, { recursive: true, force: true });
    await mkdir(store.securityDirectory, { recursive: true, mode: 0o700 });
    const arrangedStore = await arrange();
    await assert.rejects(testOnlyAttestationStore.invalidateStore(arrangedStore ?? store));
  });

  await rejected("a final symlink", async () => {
    const outside = join(store.homeDirectory, "outside.json");
    await writeFile(outside, `${JSON.stringify(record())}\n`, { mode: 0o600 });
    await symlink(outside, store.attestationPath);
  });
  await rejected("a non-regular target", async () => {
    await mkdir(store.attestationPath, { mode: 0o700 });
  });
  await rejected("permissions other than 0600", async () => {
    await seed(store, record(), 0o640);
  });
  await rejected("more than one hard link", async () => {
    await seed(store);
    await link(store.attestationPath, join(store.securityDirectory, "second-link.json"));
  });
  await rejected("malformed JSON", async () => {
    await writeFile(store.attestationPath, "{not-json\n", { mode: 0o600 });
  });
  await rejected("a non-strict JSON record", async () => {
    await seed(store, record({ unexpected: true }));
  });
  await rejected("an owner mismatch", async () => {
    await seed(store);
    return { ...store, uid: uid + 1 };
  });
});

test("the writer refuses an application parent symlink", async () => {
  const { homeDirectory, store } = await fixture();
  const outside = join(homeDirectory, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, store.applicationRoot);
  await assert.rejects(testOnlyAttestationStore.writeStore(store, record()));
  await assert.rejects(lstat(join(outside, "security", "image-input-capability.json")), {
    code: "ENOENT",
  });
});

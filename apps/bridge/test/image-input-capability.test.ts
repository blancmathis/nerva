import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectInstalledMultiImageInputCapability,
  loadInstalledMultiImageInputCapability,
  readImageInputCapabilityRecord,
  readVerifiedMultiImageInputCapability,
  writeImageInputCapabilityRecord,
  type ImageInputCapabilityEvidence,
} from "../src/image-input-capability.js";

const temporaryRoots: string[] = [];
const CAPABILITY_FILE_NAME = "image-input-capability.json";

async function temporarySecurityDirectory(): Promise<{ root: string; securityDirectory: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-pad-image-capability-"));
  temporaryRoots.push(root);
  const securityDirectory = join(root, "security");
  await mkdir(securityDirectory, { mode: 0o700 });
  await chmod(securityDirectory, 0o700);
  return { root, securityDirectory, file: join(securityDirectory, CAPABILITY_FILE_NAME) };
}

function evidence(securityDirectory: string): ImageInputCapabilityEvidence {
  return {
    securityDirectory,
    codexBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexVersion: "codex-cli 0.145.0-alpha.18",
    serverUserAgent: "codex-app-server/0.145.0-alpha.18",
    verifiedAt: "2026-07-20T10:00:00.000Z",
    schemaSha256: "a".repeat(64),
  };
}

function rawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    codexBinaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexVersion: "codex-cli 0.145.0-alpha.18",
    serverUserAgent: "codex-app-server/0.145.0-alpha.18",
    verifiedAt: "2026-07-20T10:00:00.000Z",
    probe: "runtime-disposable-thread-bounded-multi-local-image",
    singleImageStartVerified: true,
    maxStartImages: 12,
    maxSteerImages: 0,
    disposableThreadDeleted: true,
    schemaSha256: "a".repeat(64),
    ...overrides,
  };
}

async function seed(file: string, record: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

async function seedSchemaCache(root: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const schemaDirectory = join(root, "cache", "app-server-schemas", "codex-cli-test");
  await mkdir(join(schemaDirectory, "nested"), { recursive: true, mode: 0o700 });
  const files = [
    { relativePath: "client.json", contents: Buffer.from('{"title":"client"}\n') },
    { relativePath: "nested/server.json", contents: Buffer.from('{"title":"server"}\n') },
  ];
  for (const file of files) {
    await writeFile(join(schemaDirectory, file.relativePath), file.contents, { mode: 0o600 });
  }
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.relativePath);
    digest.update("\0");
    digest.update(file.contents);
    digest.update("\0");
  }
  const schemaSha256 = digest.digest("hex");
  await seed(join(schemaDirectory, "manifest.json"), {
    formatVersion: 1,
    codexBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexVersion: "codex-cli 0.145.0-alpha.18",
    generatedAt: "2026-07-20T09:00:00.000Z",
    schemaSha256,
    files: files.map((file) => file.relativePath),
    ...overrides,
  });
  return schemaSha256;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private image-input capability persistence", () => {
  it("round-trips an atomic mode-0600 record and projects its bounded capability", async () => {
    const { securityDirectory, file } = await temporarySecurityDirectory();
    const input = evidence(securityDirectory);

    const written = await writeImageInputCapabilityRecord(input);
    expect(written).toEqual(rawRecord());
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(rawRecord());
    const metadata = await stat(file);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);

    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toEqual(rawRecord());
    await expect(readVerifiedMultiImageInputCapability({
      securityDirectory,
      codexBinaryPath: input.codexBinaryPath,
      codexVersion: input.codexVersion,
      schemaSha256: input.schemaSha256,
    })).resolves.toEqual({
      verified: true,
      serverUserAgent: input.serverUserAgent,
      verifiedAt: input.verifiedAt,
      probe: "runtime-disposable-thread-bounded-multi-local-image",
      maxImages: 12,
    });
  });

  it("returns undefined for a missing record", async () => {
    const { securityDirectory } = await temporarySecurityDirectory();
    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();
    await expect(readVerifiedMultiImageInputCapability({
      securityDirectory,
      codexBinaryPath: evidence(securityDirectory).codexBinaryPath,
      codexVersion: evidence(securityDirectory).codexVersion,
      schemaSha256: evidence(securityDirectory).schemaSha256,
    })).resolves.toBeUndefined();
  });

  it("fails closed for malformed, oversized, and non-strict records", async () => {
    const { securityDirectory, file } = await temporarySecurityDirectory();
    await writeFile(file, "{not-json\n", { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();

    await seed(file, rawRecord({ unexpected: true }));
    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();

    await writeFile(file, "x".repeat(16 * 1024 + 1), { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();
  });

  it("does not follow a symlink record or overwrite one through the writer", async () => {
    const { root, securityDirectory, file } = await temporarySecurityDirectory();
    const outside = join(root, "outside.json");
    await seed(outside, rawRecord());
    await symlink(outside, file);

    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();
    await expect(writeImageInputCapabilityRecord(evidence(securityDirectory))).rejects.toThrow(
      "Unable to persist the private image-input capability record",
    );
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual(rawRecord());
  });

  it("rejects a record whose open permissions are not exactly 0600", async () => {
    const { securityDirectory, file } = await temporarySecurityDirectory();
    await seed(file, rawRecord());
    await chmod(file, 0o640);
    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();
  });

  it("projects only an exact binary path, binary version, and schema hash match", async () => {
    const { securityDirectory, file } = await temporarySecurityDirectory();
    const input = evidence(securityDirectory);
    await writeImageInputCapabilityRecord(input);

    for (const mismatch of [
      { codexBinaryPath: "/Applications/Other.app/Contents/Resources/codex" },
      { codexVersion: "codex-cli 0.146.0" },
      { schemaSha256: "b".repeat(64) },
    ]) {
      await expect(readVerifiedMultiImageInputCapability({
        securityDirectory,
        codexBinaryPath: input.codexBinaryPath,
        codexVersion: input.codexVersion,
        schemaSha256: input.schemaSha256,
        ...mismatch,
      })).resolves.toBeUndefined();
    }

    await seed(file, rawRecord({ version: 2 }));
    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();
  });

  it.each([
    ["single-image start proof", { singleImageStartVerified: false }],
    ["start image bound", { maxStartImages: 11 }],
    ["steer image bound", { maxSteerImages: 1 }],
    ["disposable-thread deletion", { disposableThreadDeleted: false }],
  ])("rejects an invalid %s", async (_label, overrides) => {
    const { securityDirectory, file } = await temporarySecurityDirectory();
    await seed(file, rawRecord(overrides));
    await expect(readImageInputCapabilityRecord(securityDirectory)).resolves.toBeUndefined();
  });

  it("requires the caller to supply a valid schema hash and absolute binary identity", async () => {
    const { securityDirectory } = await temporarySecurityDirectory();
    await expect(writeImageInputCapabilityRecord({
      ...evidence(securityDirectory),
      schemaSha256: "not-a-sha256",
    })).rejects.toThrow("Invalid image-input capability evidence");
    await expect(writeImageInputCapabilityRecord({
      ...evidence(securityDirectory),
      codexBinaryPath: "relative/codex",
    })).rejects.toThrow("Invalid image-input capability evidence");
  });

  it("loads only after recomputing the exact installed-version schema cache", async () => {
    const { root, securityDirectory } = await temporarySecurityDirectory();
    const schemaSha256 = await seedSchemaCache(root);
    await writeImageInputCapabilityRecord({
      ...evidence(securityDirectory),
      schemaSha256,
    });
    const identity = {
      dataRoot: root,
      codexBinaryPath: evidence(securityDirectory).codexBinaryPath,
      codexVersion: evidence(securityDirectory).codexVersion,
    };

    await expect(loadInstalledMultiImageInputCapability(identity)).resolves.toMatchObject({
      verified: true,
      maxImages: 12,
    });
    await expect(inspectInstalledMultiImageInputCapability(identity)).resolves.toMatchObject({
      attestationStatus: "valid",
      capability: { verified: true, maxImages: 12 },
    });
  });

  it("fails closed when schema bytes or strict manifest identity are stale", async () => {
    for (const scenario of ["bytes", "files", "hash", "version", "binary", "extra"] as const) {
      const { root, securityDirectory } = await temporarySecurityDirectory();
      const overrides = scenario === "files"
        ? { files: ["client.json"] }
        : scenario === "hash"
          ? { schemaSha256: "b".repeat(64) }
        : scenario === "version"
          ? { codexVersion: "codex-cli 0.146.0" }
          : scenario === "binary"
            ? { codexBinary: "/Applications/Other.app/Contents/Resources/codex" }
            : scenario === "extra"
              ? { unexpected: true }
              : {};
      const schemaSha256 = await seedSchemaCache(root, overrides);
      await writeImageInputCapabilityRecord({ ...evidence(securityDirectory), schemaSha256 });
      if (scenario === "bytes") {
        await writeFile(
          join(root, "cache", "app-server-schemas", "codex-cli-test", "client.json"),
          '{"title":"tampered"}\n',
        );
      }
      const identity = {
        dataRoot: root,
        codexBinaryPath: evidence(securityDirectory).codexBinaryPath,
        codexVersion: evidence(securityDirectory).codexVersion,
      };

      await expect(loadInstalledMultiImageInputCapability(identity)).resolves.toBeUndefined();
      await expect(inspectInstalledMultiImageInputCapability(identity)).resolves.toEqual({
        attestationStatus: "invalid-or-stale",
      });
    }
  });

  it("treats a missing private attestation as a normal absent capability", async () => {
    const { root, securityDirectory } = await temporarySecurityDirectory();
    await seedSchemaCache(root);
    await expect(inspectInstalledMultiImageInputCapability({
      dataRoot: root,
      codexBinaryPath: evidence(securityDirectory).codexBinaryPath,
      codexVersion: evidence(securityDirectory).codexVersion,
    })).resolves.toEqual({ attestationStatus: "absent" });
  });
});

import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataPaths } from "../src/paths.js";
import {
  MAX_SKETCH_BYTES,
  SketchValidationError,
  validateAndNormalizeSketch,
} from "../src/sketch.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root() {
  const path = await mkdtemp(join(tmpdir(), "codex-pad-sketch-test-"));
  roots.push(path);
  return defaultDataPaths(path);
}

describe("sketch validation", () => {
  it("decodes, strips metadata, and writes a random mode-0600 PNG", async () => {
    const paths = await root();
    const png = await sharp({
      create: { width: 32, height: 24, channels: 4, background: "#2563eb" },
    }).png().withMetadata({ exif: { IFD0: { Copyright: "not retained" } } }).toBuffer();
    const normalized = await validateAndNormalizeSketch({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      snapshotSeq: 4,
      targetThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      instruction: "Use this layout",
      pngBase64: png.toString("base64"),
    }, paths);
    expect(normalized.width).toBe(32);
    expect(normalized.height).toBe(24);
    expect((await stat(normalized.path)).mode & 0o777).toBe(0o600);
    expect((await sharp(normalized.path).metadata()).exif).toBeUndefined();
    await normalized.cleanup();
    await expect(stat(normalized.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("downscales when metadata stripping makes a valid high-entropy PNG exceed the cap", async () => {
    const paths = await root();
    const width = 2_560;
    const height = 954;
    const rgba = Buffer.alloc(width * height * 4);
    let state = 0x12345678;
    for (let offset = 0; offset < rgba.length; offset += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      rgba[offset] = state & 255;
      rgba[offset + 1] = (state >>> 8) & 255;
      rgba[offset + 2] = (state >>> 16) & 255;
      rgba[offset + 3] = 255;
    }
    // This filter/compression combination is intentionally a little smaller
    // than the bridge's canonical Sharp output for the same incompressible RGB.
    const sourcePng = await sharp(rgba, {
      raw: { width, height, channels: 4 },
    }).png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
    const canonicalAtOriginalSize = await sharp(sourcePng)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    expect(sourcePng.length).toBeLessThanOrEqual(MAX_SKETCH_BYTES);
    expect(canonicalAtOriginalSize.length).toBeGreaterThan(MAX_SKETCH_BYTES);

    const normalized = await validateAndNormalizeSketch({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      snapshotSeq: 4,
      targetThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      instruction: "Use this high-detail layout",
      pngBase64: sourcePng.toString("base64"),
    }, paths);

    expect(normalized.bytes).toBeLessThanOrEqual(MAX_SKETCH_BYTES);
    expect(normalized.width).toBeGreaterThanOrEqual(1_024);
    expect(normalized.width).toBeLessThan(width);
    expect(normalized.height).toBeLessThan(height);
    await normalized.cleanup();
  }, 30_000);

  it("rejects non-PNG and non-canonical base64", async () => {
    const paths = await root();
    const input = {
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      snapshotSeq: 4,
      targetThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      instruction: "Use this layout",
    };
    await expect(validateAndNormalizeSketch({ ...input, pngBase64: Buffer.from("not a png").toString("base64") }, paths))
      .rejects.toBeInstanceOf(SketchValidationError);
    await expect(validateAndNormalizeSketch({ ...input, pngBase64: "aGVsbG8" }, paths))
      .rejects.toBeInstanceOf(SketchValidationError);
  });

  it.each(["runtime", "sketches"] as const)(
    "fails closed instead of following a pre-existing %s symlink",
    async (symlinkAt) => {
      const paths = await root();
      const foreign = join(paths.root, `foreign-${symlinkAt}`);
      await mkdir(foreign, { mode: 0o700 });
      await chmod(foreign, 0o700);
      if (symlinkAt === "runtime") {
        await symlink(foreign, paths.runtime);
      } else {
        await mkdir(paths.runtime, { mode: 0o700 });
        await chmod(paths.runtime, 0o700);
        await symlink(foreign, join(paths.runtime, "sketches"));
      }
      const png = await sharp({
        create: { width: 4, height: 4, channels: 4, background: "#2563eb" },
      }).png().toBuffer();

      await expect(validateAndNormalizeSketch({
        commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
        snapshotSeq: 4,
        targetThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
        instruction: "Use this layout",
        pngBase64: png.toString("base64"),
      }, paths)).rejects.toMatchObject({ code: "UNSAFE_RUNTIME_DIRECTORY" });
      expect((await stat(foreign)).mode & 0o777).toBe(0o700);
      await expect(readdir(foreign)).resolves.toEqual([]);
    },
  );

  it("fails closed without chmod-hardening a weak pre-existing runtime directory", async () => {
    const paths = await root();
    await mkdir(paths.runtime, { mode: 0o755 });
    await chmod(paths.runtime, 0o755);
    const png = await sharp({
      create: { width: 4, height: 4, channels: 4, background: "#2563eb" },
    }).png().toBuffer();

    await expect(validateAndNormalizeSketch({
      commandId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
      snapshotSeq: 4,
      targetThreadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2",
      instruction: "Use this layout",
      pngBase64: png.toString("base64"),
    }, paths)).rejects.toMatchObject({ code: "UNSAFE_RUNTIME_DIRECTORY" });
    expect((await stat(paths.runtime)).mode & 0o777).toBe(0o755);
  });
});

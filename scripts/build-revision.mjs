import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VALID_REVISION = /^(?:[0-9a-f]{7,64}(?:-dirty)?|development)$/u;

function git(repositoryRoot, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Return a build identity shared by the PWA and bridge.
 *
 * A plain `<sha>-dirty` cannot distinguish two bundles compiled from different
 * dirty working trees at the same commit. Hashing every non-ignored source file
 * closes that stale-runtime gap while preserving the ordinary Git SHA for clean
 * checkouts.
 */
export function resolveBuildRevision(repositoryRoot, override = process.env.CODEX_PAD_BUILD_REVISION) {
  const explicit = override?.trim();
  if (explicit && VALID_REVISION.test(explicit)) return explicit;

  try {
    const head = git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]).trim();
    const dirty = git(repositoryRoot, ["status", "--porcelain"]).trim().length > 0;
    if (!dirty) return head;

    const filesBuffer = git(repositoryRoot, ["ls-files", "-co", "--exclude-standard", "-z"], "buffer");
    const files = filesBuffer
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const digest = createHash("sha256");
    digest.update(head);
    for (const file of files) {
      digest.update("\0");
      digest.update(file);
      digest.update("\0");
      try {
        digest.update(readFileSync(resolve(repositoryRoot, file)));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          // `git ls-files -c` intentionally includes tracked files deleted from
          // the working tree. Their absence is part of the dirty source state,
          // so hash a deletion marker instead of losing the entire identity.
          digest.update("<deleted>");
          continue;
        }
        throw error;
      }
    }
    return `${digest.digest("hex")}-dirty`;
  } catch {
    return "development";
  }
}

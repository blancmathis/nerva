import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  collectRuntimeLicenseInventory,
  type RuntimeLicenseInventory,
} from "./runtime-dependencies.ts";

const execFileAsync = promisify(execFile);
const root = resolve(process.cwd());

const requiredReleaseFiles = [
  "LICENSE",
  "THIRD_PARTY_LICENSES.json",
  "THIRD_PARTY_NOTICES.md",
  "docs/research.md",
] as const;

const reviewedRuntimeLicenseExpressions = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
]);

// http_ece@1.2.0 declares MIT in its immutable registry metadata, but its
// three-file npm tarball omits the upstream LICENSE. Keep this exception exact
// and require commit-pinned evidence in THIRD_PARTY_NOTICES.md.
const reviewedMissingInstalledLicenseEvidence = new Map([
  [
    "http_ece@1.2.0",
    "https://github.com/martinthomson/encrypted-content-encoding/blob/0562510a30819f52424724a6fd5504becacd98a1/LICENSE",
  ],
]);

const knownProtectedAssetNames = new Set([
  "status-leds.gif",
  "multi-session.gif",
  "workflow-flick.gif",
  "layers.gif",
  "command-keys.gif",
  "thinking-dial.gif",
  "default-gamesir-g7-pro-controls.png",
  "open-micro-banner.png",
  "open-micro-logo.png",
  "default-dualsense-controls.png",
  "agent-status-preview-dark.svg",
  "agent-status-preview.svg",
  "plugin-icon@2x.png",
  "plugin-icon.png",
  "key@2x.svg",
  "key.svg",
  "category-icon@2x.svg",
  "category-icon.svg",
]);

const knownProtectedAssetHashes = new Set([
  "3cc8c22d2548be6526f1c7ec1d7496572e60dae67740fd498f3754ed62219cc4",
  "e65baecf3cf8f50ff8d8748fb1037e2134fd61124c35c227454338a3b81975b3",
  "e10258f686a971c102915d62fae36a0866b903fb6ff97ba97b5d28cecc92abcd",
  "a7f5b031c965692fbe5b4b54ccca9cdc5c574c2814a3ccbb9a4e636f36964f9b",
  "cbe9611b6fea2152370695944027b774126e5f23c363db6d64c40aede594ab8e",
  "1201fcba2b296228496648c664f922d55ae14c383da20334fb0148a71830226f",
  "b2e1248348291287a42b7fe329dfedc989c17449b26090073c642f09c84200ea",
  "cf596ceb98f8674f4af04317be7c28225b3d999b2fd72de21b47367778963ebf",
  "6887fccfbc8e866a2da27a174185fdae3ea81ea7244c74b59749089226843638",
  "c7786a46904502bd0a1fa70ddd30b5377cf9ca9717558374f62923f795edda93",
  "8cbb46602991e0d595d2e7b4b7d2d2e805e26e0e2074c36cded673426195fbdf",
  "32c6d3de6a4140cf98d7dd7b45ff58b11046c1952d582fb19f0bf27742488a9f",
  "64b380818556a74cd1e3ae80b052e312f0872db13346fed1a29686520af536fa",
  "bebe5438b9013bc44f971b998903e55f4a993cae3e2eb5a5d54ab8c140b68f45",
  "a6173a4f9c442ffc74c0c95655ede12eb9972513705129e1e9258a5692b3a5c5",
  "6d2ae235e40a5f8923661f59ecccba320aafe57a652d0ea6ccd9366a3fdf596b",
  "dd1c9e1033f75c070b4e63934aa7212b9b7c462a548fa3523554a67116c0285c",
  "afd0732ec93812e5ec25d517db79641e9d56a24f3fc575f34ef77bbcb36fb8ea",
]);

const textExtensions = /\.(?:c?js|mjs|ts|tsx|jsx|json|md|html|css|scss|svg|toml|ya?ml|txt)$/iu;

async function releaseFiles(): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function packageIdentity(entry: { readonly name: string; readonly version: string }): string {
  return `${entry.name}@${entry.version}`;
}

async function validateInstalledLicenseEvidence(
  inventory: RuntimeLicenseInventory,
  failures: string[],
): Promise<void> {
  for (const dependency of inventory.packages) {
    for (const lockPath of dependency.lockPaths) {
      const absolute = resolve(root, lockPath);
      const metadata = await stat(absolute).catch(() => undefined);
      if (!metadata?.isDirectory()) {
        if (!dependency.optional) {
          failures.push(`non-optional production package is not installed: ${lockPath}`);
        }
        continue;
      }

      const manifest = JSON.parse(
        await readFile(resolve(absolute, "package.json"), "utf8"),
      ) as { name?: string; version?: string; license?: string };
      if (
        manifest.name !== dependency.name ||
        manifest.version !== dependency.version ||
        manifest.license !== dependency.license
      ) {
        failures.push(
          `installed metadata differs from package-lock.json for ${lockPath}`,
        );
      }

      const rootFiles = await readdir(absolute);
      const legalFiles = rootFiles.filter((name) =>
        /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(name),
      );
      if (legalFiles.length > 0) continue;

      const readmes = rootFiles.filter((name) => /^readme(?:\.|$)/iu.test(name));
      const readmeHasLicenseEvidence = (
        await Promise.all(
          readmes.map(async (name) =>
            /licen[cs](?:e|ing)|\b(?:MIT|ISC|BSD|LGPL|Apache)\b/iu.test(
              await readFile(resolve(absolute, name), "utf8"),
            ),
          ),
        )
      ).some(Boolean);
      if (!readmeHasLicenseEvidence) {
        if (reviewedMissingInstalledLicenseEvidence.has(packageIdentity(dependency))) continue;
        failures.push(
          `installed production package has no root license/notice evidence: ${lockPath}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const files = await releaseFiles();
  const fileSet = new Set(files);

  for (const required of requiredReleaseFiles) {
    try {
      await access(resolve(root, required));
      if (!fileSet.has(required)) failures.push(`${required} exists but is ignored from release inputs`);
    } catch {
      failures.push(`missing required release file: ${required}`);
    }
  }

  const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    license?: string;
    files?: readonly string[];
  };
  if (rootPackage.license !== "MIT") {
    failures.push("root package.json must declare the repository MIT license");
  }
  for (const manifestPath of files.filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(file))) {
    const workspacePackage = JSON.parse(await readFile(resolve(root, manifestPath), "utf8")) as {
      license?: string;
    };
    if (workspacePackage.license !== "MIT") {
      failures.push(`${manifestPath} must declare the repository MIT license`);
    }
  }
  if (rootPackage.files) {
    for (const required of requiredReleaseFiles) {
      const covered = rootPackage.files.some(
        (entry) => entry === required || entry === "." || entry === "*" || (entry.endsWith("/") && required.startsWith(entry)),
      );
      if (!covered) failures.push(`package.json files allowlist excludes required attribution input ${required}`);
    }
  } else {
    const ignorePath = fileSet.has(".npmignore") ? ".npmignore" : ".gitignore";
    const ignoreRules = fileSet.has(ignorePath)
      ? (await readFile(resolve(root, ignorePath), "utf8"))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
      : [];
    for (const required of requiredReleaseFiles) {
      if (ignoreRules.includes(required) || ignoreRules.includes(`${required}/`)) {
        failures.push(`${ignorePath} excludes required attribution input ${required} from default packaging`);
      }
    }
  }

  let expectedLicenseInventory: RuntimeLicenseInventory | undefined;
  try {
    expectedLicenseInventory = await collectRuntimeLicenseInventory(root);
  } catch (error) {
    failures.push(
      `cannot derive production license inventory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (expectedLicenseInventory && fileSet.has("THIRD_PARTY_LICENSES.json")) {
    let committedLicenseInventory: RuntimeLicenseInventory | undefined;
    try {
      committedLicenseInventory = JSON.parse(
        await readFile(resolve(root, "THIRD_PARTY_LICENSES.json"), "utf8"),
      ) as RuntimeLicenseInventory;
    } catch (error) {
      failures.push(
        `THIRD_PARTY_LICENSES.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (committedLicenseInventory) {
      const expected = JSON.stringify(expectedLicenseInventory);
      const committed = JSON.stringify(committedLicenseInventory);
      if (expected !== committed) {
        const expectedIds = new Set(
          expectedLicenseInventory.packages.map(packageIdentity),
        );
        const committedIds = new Set(
          committedLicenseInventory.packages.map(packageIdentity),
        );
        const missing = [...expectedIds].filter((identity) => !committedIds.has(identity));
        const stale = [...committedIds].filter((identity) => !expectedIds.has(identity));
        const detail = [
          missing.length > 0 ? `missing ${missing.slice(0, 4).join(", ")}` : "",
          stale.length > 0 ? `stale ${stale.slice(0, 4).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ");
        failures.push(
          `THIRD_PARTY_LICENSES.json differs from package-lock.json${detail ? ` (${detail})` : ""}; run npm run licenses:generate`,
        );
      }
    }

    for (const dependency of expectedLicenseInventory.packages) {
      if (!dependency.license) {
        failures.push(`${packageIdentity(dependency)} has no license in package-lock.json`);
      } else if (!reviewedRuntimeLicenseExpressions.has(dependency.license)) {
        failures.push(
          `${packageIdentity(dependency)} introduces unreviewed license expression ${dependency.license}`,
        );
      }
      if (!dependency.source) {
        failures.push(`${packageIdentity(dependency)} has no source tarball in package-lock.json`);
      }
    }
    await validateInstalledLicenseEvidence(expectedLicenseInventory, failures);
  }

  if (fileSet.has("THIRD_PARTY_NOTICES.md")) {
    const notices = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    const normalizedNotices = notices.replace(/\s+/gu, " ");
    for (const upstream of ["codex-stream-deck", "OpenMicro", "muxboard", "cmux-mobile"]) {
      if (!notices.includes(upstream)) failures.push(`THIRD_PARTY_NOTICES.md omits ${upstream}`);
    }
    if (expectedLicenseInventory) {
      for (const dependency of expectedLicenseInventory.packages.filter(
        (entry) => entry.directFrom.length > 0,
      )) {
        const expectedRowStart = `| \`${dependency.name}\` | \`${dependency.version}\` | \`${dependency.license}\` |`;
        if (!notices.includes(expectedRowStart)) {
          failures.push(
            `THIRD_PARTY_NOTICES.md omits direct runtime dependency ${packageIdentity(dependency)}`,
          );
        }
      }
      for (const license of reviewedRuntimeLicenseExpressions) {
        if (!notices.includes(`\`${license}\``)) {
          failures.push(`THIRD_PARTY_NOTICES.md omits reviewed license expression ${license}`);
        }
      }
      for (const [identity, evidenceUrl] of reviewedMissingInstalledLicenseEvidence) {
        if (!notices.includes(identity) || !notices.includes(evidenceUrl)) {
          failures.push(`THIRD_PARTY_NOTICES.md omits reviewed missing-tarball license evidence for ${identity}`);
        }
      }
      const scheduler = expectedLicenseInventory.packages.find(
        (entry) => entry.name === "scheduler",
      );
      if (
        scheduler &&
        !notices.includes(
          `\`scheduler\` \`${scheduler.version}\`, licensed \`${scheduler.license}\``,
        )
      ) {
        failures.push("THIRD_PARTY_NOTICES.md omits the browser-bundled scheduler notice");
      }
      if (
        expectedLicenseInventory.packages.some((entry) =>
          entry.name.startsWith("@img/sharp-libvips-"),
        ) &&
        ![
          "`@img/sharp-libvips-*`",
          "`LGPL-3.0-or-later`",
          "MPL-2.0",
          "source/relink or replacement rights",
        ].every((requiredNotice) => normalizedNotices.includes(requiredNotice))
      ) {
        failures.push(
          "THIRD_PARTY_NOTICES.md omits sharp/libvips native redistribution obligations",
        );
      }
    }
  }

  if (fileSet.has("docs/research.md")) {
    const research = await readFile(resolve(root, "docs/research.md"), "utf8");
    const inspectedCommits = [
      "f3b61903311e9205e6366bb068977fb7adfd5481",
      "73a153dbdbf877505df0fff6dda1f9ec4cd34dfc",
      "e4b8375bfb533937cec9815485bad14fdd8b40f4",
      "d1c2584bbacbfca1b2cf997ac28e632af97158bd",
    ];
    for (const commit of inspectedCommits) {
      if (!research.includes(commit)) failures.push(`docs/research.md omits inspected commit ${commit}`);
    }
  }

  for (const file of files) {
    const absolute = resolve(root, file);
    const metadata = await stat(absolute).catch(() => undefined);
    if (!metadata?.isFile()) continue;
    const name = file.split("/").at(-1) ?? file;
    if (knownProtectedAssetNames.has(name)) {
      failures.push(`known upstream asset filename is forbidden: ${file}`);
    }
    if (metadata.size <= 20 * 1024 * 1024 && knownProtectedAssetHashes.has(await sha256(absolute))) {
      failures.push(`file matches a protected upstream asset hash: ${file}`);
    }
    if (!textExtensions.test(file) || file === "package-lock.json" || metadata.size > 2 * 1024 * 1024) {
      continue;
    }
    const text = await readFile(absolute, "utf8");
    if (/\/Users\/(?!Shared(?:\/|$)|REDACTED(?:\/|$)|<)/u.test(text)) {
      failures.push(`absolute personal home path found in ${file}`);
    }
    if (/\.codex\/attachments\/|\/private\/tmp\/codex-pad-research/u.test(text)) {
      failures.push(`temporary research/attachment path found in ${file}`);
    }
    if (
      !/(?:^|\/)test(?:s)?\//u.test(file) &&
      !/\.test\.[cm]?[jt]sx?$/u.test(file) &&
      /(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(
        text,
      )
    ) {
      failures.push(`credential-shaped secret found in release source: ${file}`);
    }
    if (
      /^(?:apps|packages)\//u.test(file) &&
      /codex-micro-[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js/u.test(text)
    ) {
      failures.push(`version-hashed Codex private module name is hard-coded in ${file}`);
    }
  }

  for (const file of files.filter(
    (candidate) =>
      candidate === "apps/web/index.html" ||
      candidate.startsWith("apps/web/src/") ||
      candidate.startsWith("apps/web/public/"),
  )) {
    if (!textExtensions.test(file) || /\.test\.[cm]?[jt]sx?$/u.test(file)) continue;
    const absolute = resolve(root, file);
    const metadata = await stat(absolute).catch(() => undefined);
    if (!metadata?.isFile()) continue;
    const text = await readFile(absolute, "utf8");
    const remoteRuntimePatterns = [
      /<(?:script|img|iframe|source)\b[^>]*\bsrc=["']https?:\/\//iu,
      /<link\b[^>]*\bhref=["']https?:\/\//iu,
      /url\(\s*["']?https?:\/\//iu,
      /(?:import\s*\(|from\s+|fetch\s*\()\s*["']https?:\/\//u,
    ];
    if (remoteRuntimePatterns.some((pattern) => pattern.test(text))) {
      failures.push(`PWA loads a remote runtime asset/resource in ${file}`);
    }
  }

  if (failures.length > 0) {
    console.error("Codex Pad release audit failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Codex Pad release audit passed (${files.length} release input files inspected).`);
  console.log(
    `Verified ${expectedLicenseInventory?.packages.length ?? 0} production dependency license records, direct notices, installed legal metadata, protected-asset boundaries, secret/path hygiene, and PWA runtime locality.`,
  );
}

await main();

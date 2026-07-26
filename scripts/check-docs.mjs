#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";

const root = resolve(process.cwd());
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const npmScripts = new Set(Object.keys(packageJson.scripts ?? {}));
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage", "test-results", "playwright-report"]);
const failures = [];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

function githubSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function headings(markdown) {
  const counts = new Map();
  const anchors = new Set();
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (!match) continue;
    const base = githubSlug(match[2]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of markdown.matchAll(/<(?:a|span)[^>]+(?:id|name)=["']([^"']+)["']/giu)) {
    anchors.add(match[1]);
  }
  return anchors;
}

function localTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) targets.push(match[1]);
  for (const match of markdown.matchAll(/<(?:a|img)[^>]+(?:href|src)=["']([^"']+)["']/giu)) targets.push(match[1]);
  return targets;
}

function decodeTarget(value) {
  try {
    return decodeURIComponent(value.replaceAll("&amp;", "&"));
  } catch {
    return value;
  }
}

const files = await markdownFiles(root);
const contentByPath = new Map(await Promise.all(files.map(async (path) => [path, await readFile(path, "utf8")])));
const anchorsByPath = new Map([...contentByPath].map(([path, content]) => [path, headings(content)]));

for (const [path, markdown] of contentByPath) {
  const label = relative(root, path);
  for (const rawTarget of localTargets(markdown)) {
    if (/^(?:https?:|mailto:|app:|data:)/iu.test(rawTarget)) continue;
    const decoded = decodeTarget(rawTarget);
    const [pathname, fragment] = decoded.split("#", 2);
    const targetPath = pathname ? resolve(dirname(path), pathname) : path;
    try {
      const metadata = await stat(targetPath);
      if (!metadata.isFile() && !metadata.isDirectory()) failures.push(`${label}: target is not a file or directory: ${rawTarget}`);
    } catch {
      failures.push(`${label}: missing relative target: ${rawTarget}`);
      continue;
    }
    if (fragment && targetPath.endsWith(".md")) {
      const anchors = anchorsByPath.get(targetPath) ?? headings(await readFile(targetPath, "utf8"));
      if (!anchors.has(fragment.toLowerCase())) failures.push(`${label}: missing Markdown anchor: ${rawTarget}`);
    }
  }
  for (const match of markdown.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/gu)) {
    if (!npmScripts.has(match[1])) failures.push(`${label}: documents unknown npm script: ${match[1]}`);
  }
  if (
    label !== "THIRD_PARTY_NOTICES.md"
    && (/[àâçéèêëîïôùûüœ]/iu.test(markdown)
      || /\b(?:aucun|aucune|cette|dans|doit|parcours|preuve|utilisateur)\b/iu.test(markdown))
  ) {
    failures.push(`${label}: public documentation must remain English-only`);
  }
}

const readme = contentByPath.get(join(root, "README.md")) ?? "";
if (!readme.includes("docs/product/CURRENT_STATE.md")) failures.push("README.md: must link to the canonical Current State document");
for (const target of ["FEATURES_target.md", "PAIRING_target.md", "SITE_QA_RECORDER_target.md"]) {
  const path = join(root, "docs", "product", target);
  const content = contentByPath.get(path) ?? "";
  if (!/^---[\s\S]*?status: draft[\s\S]*?---/u.test(content)) failures.push(`docs/product/${target}: target document must remain status: draft`);
  if (!/target|does not prove|not necessarily|acceptance target/iu.test(content)) failures.push(`docs/product/${target}: target document must state that it is not current implementation proof`);
}

const currentState = contentByPath.get(join(root, "docs", "product", "CURRENT_STATE.md")) ?? "";
for (const proof of ["0a95911", "30204589636", "927", "293", "387.70 kB", "438 files", "0.145.0", "0.146.0-alpha.3.1"]) {
  if (!currentState.includes(proof)) failures.push(`docs/product/CURRENT_STATE.md: missing current validation proof: ${proof}`);
}
for (const stale of ["30172381118", "b6e731c", "902 unit", "275 E2E", "427 files"]) {
  for (const [path, content] of contentByPath) {
    if (content.includes(stale)) failures.push(`${relative(root, path)}: stale validation reference remains: ${stale}`);
  }
}

if (failures.length > 0) {
  console.error(`Documentation check failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed for ${files.length} Markdown files.`);
}

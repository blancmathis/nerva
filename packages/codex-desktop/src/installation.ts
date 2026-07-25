import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DesktopDetectionOptions, DesktopInstallation } from "./types.js";

const execFile = promisify(execFileCallback);
const ACCEPTED_BUNDLE_IDS = new Set(["com.openai.codex", "com.openai.chatgpt"]);

export async function detectCodexDesktop(options: DesktopDetectionOptions = {}): Promise<DesktopInstallation | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;

  const candidates = options.appCandidates ?? [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(homedir(), "Applications", "ChatGPT.app"),
    join(homedir(), "Applications", "Codex.app")
  ];
  const canAccess = options.access ?? (async (path: string) => access(path));
  const readValue = options.readPlistValue ?? readPlistValue;

  for (const appPath of candidates) {
    const plistPath = join(appPath, "Contents", "Info.plist");
    try {
      await canAccess(plistPath);
    } catch {
      continue;
    }

    const [bundleIdentifier, version, build, executableName] = await Promise.all([
      readValue(plistPath, "CFBundleIdentifier"),
      readValue(plistPath, "CFBundleShortVersionString"),
      readValue(plistPath, "CFBundleVersion"),
      readValue(plistPath, "CFBundleExecutable")
    ]);
    if (!bundleIdentifier || !ACCEPTED_BUNDLE_IDS.has(bundleIdentifier) || !version || !build || !executableName) continue;

    return {
      appPath,
      executablePath: join(appPath, "Contents", "MacOS", executableName),
      bundleIdentifier: bundleIdentifier as DesktopInstallation["bundleIdentifier"],
      version,
      build
    };
  }

  return null;
}

async function readPlistValue(plistPath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("/usr/bin/plutil", ["-extract", key, "raw", "--", plistPath], {
      encoding: "utf8",
      timeout: 3_000
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

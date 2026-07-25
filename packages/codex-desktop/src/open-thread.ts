import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { CodexDesktopAdapterError } from "./errors.js";
import { extractThreadId } from "./snapshot.js";
import type { DesktopProcessIdentity } from "./types.js";

const execFile = promisify(execFileCallback);

export interface OpenThreadOptions {
  readonly platform?: NodeJS.Platform;
  readonly execFile?: (file: string, args: readonly string[]) => Promise<void>;
  /** Synchronous revocation hook invoked after validation at the dispatch sink. */
  readonly beforeDispatch?: () => void;
  /** Exact application identity from the fresh Desktop ownership grant. */
  readonly desktopIdentity?: DesktopProcessIdentity;
}

/**
 * Opens an exact non-native task using Codex Desktop's public thread deep-link
 * shape. The deep-link behavior is corroborated by OpenMicro (MIT); only a
 * canonical UUID is accepted, and it is passed as one argv value, never a shell.
 */
export async function openThread(threadId: string, options: OpenThreadOptions = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new CodexDesktopAdapterError("desktop-not-installed", "Codex thread deep links are supported only on macOS.");
  }
  const canonical = extractThreadId(threadId);
  if (!canonical || canonical !== threadId) {
    throw new CodexDesktopAdapterError("invalid-thread-key", "Thread deep links require one canonical lowercase UUID.");
  }
  const run = options.execFile ?? defaultExecFile;
  const identity = options.desktopIdentity;
  if (
    identity !== undefined
    && (
      !isAbsolute(identity.appPath)
      || identity.appPath.includes("\0")
      || !identity.appPath.endsWith(".app")
      || !isAbsolute(identity.executablePath)
      || identity.executablePath.includes("\0")
      || !identity.executablePath.startsWith(`${identity.appPath}/Contents/MacOS/`)
      || (identity.bundleId !== "com.openai.codex" && identity.bundleId !== "com.openai.chatgpt")
    )
  ) {
    throw new CodexDesktopAdapterError("invalid-thread-key", "The attested Desktop application identity is invalid.");
  }
  options.beforeDispatch?.();
  await run(
    "/usr/bin/open",
    identity === undefined
      // Let LaunchServices resolve the registered codex:// handler. Current
      // Codex Desktop builds may be installed as either Codex.app or
      // ChatGPT.app, so pinning the navigation-only path to one bundle id can
      // silently target an app that is not installed.
      ? [`codex://threads/${canonical}`]
      : ["-a", identity.appPath, `codex://threads/${canonical}`],
  );
}

async function defaultExecFile(file: string, args: readonly string[]): Promise<void> {
  await execFile(file, [...args], { timeout: 5_000 });
}

import { describe, expect, it, vi } from "vitest";
import {
  detectCodexDesktop,
  openThread,
  type DesktopProcessIdentity,
} from "../src/index.js";

const DESKTOP_IDENTITY: DesktopProcessIdentity = {
  pid: 42,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/Codex.app",
  executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  bundleId: "com.openai.codex",
};

describe("macOS Codex Desktop helpers", () => {
  it("detects the accepted app bundle and versions", async () => {
    const values: Record<string, string> = {
      CFBundleIdentifier: "com.openai.codex",
      CFBundleShortVersionString: "26.715.52143",
      CFBundleVersion: "5591",
      CFBundleExecutable: "ChatGPT"
    };
    await expect(detectCodexDesktop({
      platform: "darwin",
      appCandidates: ["/Applications/ChatGPT.app"],
      access: async () => undefined,
      readPlistValue: async (_path, key) => values[key] ?? null
    })).resolves.toEqual({
      appPath: "/Applications/ChatGPT.app",
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      bundleIdentifier: "com.openai.codex",
      version: "26.715.52143",
      build: "5591"
    });
  });

  it("opens only a canonical UUID through a fixed argv deep link", async () => {
    const exec = vi.fn(async () => undefined);
    await openThread("019f7ec2-68eb-7183-bb3a-0e67312a8ba1", { platform: "darwin", execFile: exec });
    expect(exec).toHaveBeenCalledWith("/usr/bin/open", [
      "codex://threads/019f7ec2-68eb-7183-bb3a-0e67312a8ba1"
    ]);
  });

  it("rejects shell fragments and non-canonical variants before exec", async () => {
    const exec = vi.fn(async () => undefined);
    await expect(openThread("019f7ec2-68eb-7183-bb3a-0e67312a8ba1;open https://evil.invalid", { platform: "darwin", execFile: exec })).rejects.toMatchObject({ code: "invalid-thread-key" });
    await expect(openThread("019F7EC2-68EB-7183-BB3A-0E67312A8BA1", { platform: "darwin", execFile: exec })).rejects.toMatchObject({ code: "invalid-thread-key" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("revokes at the exact sink before opening the attested application", async () => {
    const order: string[] = [];
    const exec = vi.fn(async () => {
      order.push("exec");
    });
    await openThread("019f7ec2-68eb-7183-bb3a-0e67312a8ba1", {
      platform: "darwin",
      desktopIdentity: DESKTOP_IDENTITY,
      beforeDispatch: () => order.push("revoke"),
      execFile: exec,
    });
    expect(order).toEqual(["revoke", "exec"]);
    expect(exec).toHaveBeenCalledWith("/usr/bin/open", [
      "-a",
      "/Applications/Codex.app",
      "codex://threads/019f7ec2-68eb-7183-bb3a-0e67312a8ba1",
    ]);
  });

  it("writes no process frame when sink revocation fails", async () => {
    const exec = vi.fn(async () => undefined);
    const refusal = new Error("stale native mutation permit");
    await expect(openThread("019f7ec2-68eb-7183-bb3a-0e67312a8ba1", {
      platform: "darwin",
      desktopIdentity: DESKTOP_IDENTITY,
      beforeDispatch: () => {
        throw refusal;
      },
      execFile: exec,
    })).rejects.toBe(refusal);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent attested application identity before dispatch", async () => {
    const exec = vi.fn(async () => undefined);
    const beforeDispatch = vi.fn();
    await expect(openThread("019f7ec2-68eb-7183-bb3a-0e67312a8ba1", {
      platform: "darwin",
      desktopIdentity: {
        ...DESKTOP_IDENTITY,
        executablePath: "/Applications/Other.app/Contents/MacOS/Other",
      },
      beforeDispatch,
      execFile: exec,
    })).rejects.toMatchObject({ code: "invalid-thread-key" });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});

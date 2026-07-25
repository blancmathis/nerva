import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CodexDesktopAdapterError } from "./errors.js";
import type {
  CdpCandidate,
  CdpDiscoveryOptions,
  CdpTarget,
  DesktopProcessIdentity,
  DiscoveredCdpTarget,
  DiscoveredCdpTargets,
} from "./types.js";

const execFile = promisify(execFileCallback);
const CODEX_PROCESS = /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/i;
const PROCESS_START = /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;
const MAX_PROCESS_LINEAGE_DEPTH = 8;

interface ProcessGeneration {
  readonly pid: number;
  readonly parentPid: number;
  readonly startedAt: string;
  readonly executablePath: string;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function isLoopbackUrl(value: string, protocols: readonly string[] = ["http:", "ws:"]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function parseLoopbackProcessArgument(commandLine: string): number | null {
  if (!CODEX_PROCESS.test(commandLine)) return null;
  const address = commandLine.match(/--remote-debugging-address(?:=|\s+)([^\s"']+)/)?.[1];
  if (!address || !isLoopbackHostname(address)) return null;
  const rawPort = commandLine.match(/--remote-debugging-port(?:=|\s+)(\d+)/)?.[1];
  return parsePort(rawPort);
}

/** Exact per-user files Chromium writes when `--remote-debugging-port=0` is used. */
export function defaultDevToolsActivePortFiles(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform !== "darwin") return [];
  const applicationSupport = join(homedir(), "Library", "Application Support");
  return [
    join(applicationSupport, "ChatGPT", "DevToolsActivePort"),
    join(applicationSupport, "Codex", "DevToolsActivePort"),
    join(applicationSupport, "com.openai.codex", "DevToolsActivePort"),
    join(applicationSupport, "com.openai.chatgpt", "DevToolsActivePort")
  ];
}

export function selectCodexRendererTarget(targets: readonly CdpTarget[]): CdpTarget | undefined {
  const ranked = targets
    .filter((target) => target.type === "page" && isCodexAppUrl(target.url) && target.webSocketDebuggerUrl !== undefined)
    .filter((target) => !isAuxiliaryTarget(target))
    .filter((target) => isLoopbackUrl(target.webSocketDebuggerUrl ?? "", ["ws:", "wss:"]))
    .map((target) => ({ target, rank: rankTarget(target) }))
    .sort((left, right) =>
      left.rank - right.rank ||
      (left.target.id ?? "").localeCompare(right.target.id ?? "") ||
      left.target.url.localeCompare(right.target.url)
    );
  const best = ranked[0];
  if (best === undefined || ranked[1]?.rank === best.rank) return undefined;
  return best.target;
}

function isCodexAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "app:" && url.hostname === "-" && url.pathname === "/index.html";
  } catch {
    return false;
  }
}

export async function discoverCodexCdpTarget(options: CdpDiscoveryOptions = {}): Promise<DiscoveredCdpTarget> {
  const candidates = await collectCandidates(options);
  if (candidates.length === 0) {
    throw new CodexDesktopAdapterError("cdp-unavailable", "No loopback Codex Desktop DevTools endpoint was configured or discovered.");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 1_500;
  let reachedEndpoint = false;
  for (const candidate of candidates) {
    const initialListenerProof = options.expectedDesktopIdentity === undefined
      ? null
      : await proveAttestedListenerOwner(options, candidate.port, options.expectedDesktopIdentity);
    if (options.expectedDesktopIdentity !== undefined && initialListenerProof === null) continue;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const endpoint = `http://127.0.0.1:${candidate.port}/json/list`;
      const response = await fetchImpl(endpoint, { signal: controller.signal, redirect: "error" });
      if (!response.ok) continue;
      reachedEndpoint = true;
      const targets = await response.json() as CdpTarget[];
      if (!Array.isArray(targets)) continue;
      const target = selectCodexRendererTarget(targets);
      if (target && targetBelongsToCandidate(target, candidate.port)) {
        if (options.expectedDesktopIdentity === undefined) return { candidate, target };
        const finalListenerProof = await proveAttestedListenerOwner(
          options,
          candidate.port,
          options.expectedDesktopIdentity,
        );
        if (finalListenerProof !== null && finalListenerProof === initialListenerProof) {
          return { candidate, target, desktopIdentity: options.expectedDesktopIdentity };
        }
      }
    } catch {
      // Try only the next explicitly derived loopback candidate; never scan ports.
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new CodexDesktopAdapterError(
    reachedEndpoint ? "target-not-found" : "cdp-unavailable",
    reachedEndpoint
      ? "A DevTools endpoint responded, but no safe Codex Desktop renderer target was present."
      : "The configured loopback Codex Desktop DevTools endpoint did not respond."
  );
}

/**
 * Returns the page inventory from the same exact Desktop-owned DevTools
 * listener used by the native adapter. A verified main renderer must be
 * present, and every returned target is constrained to that one listener.
 */
export async function discoverCodexCdpTargets(options: CdpDiscoveryOptions = {}): Promise<DiscoveredCdpTargets> {
  const candidates = await collectCandidates(options);
  if (candidates.length === 0) {
    throw new CodexDesktopAdapterError("cdp-unavailable", "No loopback Codex Desktop DevTools endpoint was configured or discovered.");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 1_500;
  let reachedEndpoint = false;
  for (const candidate of candidates) {
    const initialListenerProof = options.expectedDesktopIdentity === undefined
      ? null
      : await proveAttestedListenerOwner(options, candidate.port, options.expectedDesktopIdentity);
    if (options.expectedDesktopIdentity !== undefined && initialListenerProof === null) continue;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${candidate.port}/json/list`, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) continue;
      reachedEndpoint = true;
      const targets = await response.json() as CdpTarget[];
      if (!Array.isArray(targets)) continue;
      const ownedTargets = targets.filter((target) => targetBelongsToCandidate(target, candidate.port));
      if (selectCodexRendererTarget(ownedTargets) === undefined) continue;
      if (options.expectedDesktopIdentity === undefined) return { candidate, targets: ownedTargets };
      const finalListenerProof = await proveAttestedListenerOwner(
        options,
        candidate.port,
        options.expectedDesktopIdentity,
      );
      if (finalListenerProof !== null && finalListenerProof === initialListenerProof) {
        return { candidate, targets: ownedTargets, desktopIdentity: options.expectedDesktopIdentity };
      }
    } catch {
      // Try only the next explicitly derived loopback candidate; never scan ports.
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new CodexDesktopAdapterError(
    reachedEndpoint ? "target-not-found" : "cdp-unavailable",
    reachedEndpoint
      ? "A DevTools endpoint responded, but no safe Codex Desktop renderer inventory was present."
      : "The configured loopback Codex Desktop DevTools endpoint did not respond.",
  );
}

/**
 * Proves that an identity-bound port is currently owned by the attested app.
 * The returned proof describes the exact listener generation and its complete
 * in-app lineage so discovery can reject ownership changes during the fetch.
 */
async function proveAttestedListenerOwner(
  options: CdpDiscoveryOptions,
  port: number,
  identity: DesktopProcessIdentity,
): Promise<string | null> {
  const run = options.execFile ?? defaultExecFile;
  let listenerOutput: string;
  try {
    listenerOutput = await run("/usr/sbin/lsof", [
      "-nP",
      "-a",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fpn",
    ]);
  } catch {
    return null;
  }
  const listenerPid = parseExactLoopbackListenerOwner(listenerOutput, port);
  if (listenerPid === null) return null;

  const lineage: ProcessGeneration[] = [];
  const seen = new Set<number>();
  let currentPid = listenerPid;
  for (let depth = 0; depth < MAX_PROCESS_LINEAGE_DEPTH; depth += 1) {
    if (seen.has(currentPid)) return null;
    seen.add(currentPid);
    const generation = await readProcessGeneration(run, currentPid);
    if (generation === null) return null;
    lineage.push(generation);

    if (generation.pid === identity.pid) {
      if (
        generation.startedAt !== identity.startedAt
        || generation.executablePath !== identity.executablePath
      ) return null;
      return lineage
        .map(({ pid, parentPid, startedAt, executablePath }) => (
          `${pid}\u0000${parentPid}\u0000${startedAt}\u0000${executablePath}`
        ))
        .join("\u0001");
    }

    if (!isExecutableInsideApp(generation.executablePath, identity.appPath)) return null;
    if (generation.parentPid <= 0 || generation.parentPid === generation.pid) return null;
    currentPid = generation.parentPid;
  }
  return null;
}

function parseExactLoopbackListenerOwner(output: string, port: number): number | null {
  const processes = new Map<number, string[]>();
  let currentPid: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const pid = parsePositiveInteger(line.slice(1));
      currentPid = pid;
      if (pid !== null && !processes.has(pid)) processes.set(pid, []);
      continue;
    }
    if (line.startsWith("n") && currentPid !== null) {
      processes.get(currentPid)?.push(line.slice(1));
    }
  }
  if (processes.size !== 1) return null;
  const [entry] = processes.entries();
  if (entry === undefined) return null;
  const [pid, names] = entry;
  if (names.length === 0 || names.some((name) => !isExactLoopbackListenerName(name, port))) return null;
  return pid;
}

function isExactLoopbackListenerName(name: string, port: number): boolean {
  const ipv6 = name.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6?.[1] !== undefined && ipv6[2] !== undefined) {
    return isLoopbackHostname(ipv6[1]) && parsePort(ipv6[2]) === port;
  }
  const separator = name.lastIndexOf(":");
  if (separator <= 0) return false;
  return isLoopbackHostname(name.slice(0, separator)) && parsePort(name.slice(separator + 1)) === port;
}

async function readProcessGeneration(
  run: NonNullable<CdpDiscoveryOptions["execFile"]>,
  pid: number,
): Promise<ProcessGeneration | null> {
  let output: string;
  try {
    output = await run("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "pid=,ppid=,lstart=,comm=",
    ]);
  } catch {
    return null;
  }
  const rows = output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) return [];
    const parsedPid = parsePositiveInteger(match[1]);
    const parentPid = parsePositiveInteger(match[2]);
    return parsedPid === null || parentPid === null || !PROCESS_START.test(match[3])
      ? []
      : [{ pid: parsedPid, parentPid, startedAt: match[3], executablePath: match[4] }];
  });
  return rows.length === 1 && rows[0]?.pid === pid ? rows[0] : null;
}

function isExecutableInsideApp(executablePath: string, appPath: string): boolean {
  return isAbsolute(executablePath)
    && resolve(executablePath) === executablePath
    && executablePath.startsWith(`${appPath}/`);
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function targetBelongsToCandidate(target: CdpTarget, port: number): boolean {
  try {
    const debuggerUrl = new URL(target.webSocketDebuggerUrl ?? "");
    return isLoopbackHostname(debuggerUrl.hostname) && Number(debuggerUrl.port) === port;
  } catch {
    return false;
  }
}

async function collectCandidates(options: CdpDiscoveryOptions): Promise<CdpCandidate[]> {
  if (options.expectedDesktopIdentity !== undefined) {
    return collectAttestedProcessCandidate(options, options.expectedDesktopIdentity);
  }
  const candidates: CdpCandidate[] = [];
  if (options.explicitPort !== undefined) {
    const port = parsePort(options.explicitPort);
    if (port === null) throw new CodexDesktopAdapterError("cdp-unavailable", "The explicit DevTools port is invalid.");
    candidates.push({ port, source: "explicit" });
  }

  const readText = options.readFile ?? readOwnedRegularFile;
  for (const path of options.devToolsActivePortFiles ?? defaultDevToolsActivePortFiles()) {
    try {
      const firstLine = (await readText(path)).split(/\r?\n/, 1)[0];
      const port = parsePort(firstLine);
      if (port !== null) candidates.push({ port, source: "devtools-active-port" });
    } catch {
      // A caller may provide multiple known profile paths; a missing one is not exceptional.
    }
  }

  let commandLines = options.processArgs;
  if (commandLines === undefined && (options.inspectMacProcesses ?? true) && process.platform === "darwin") {
    const run = options.execFile ?? defaultExecFile;
    try {
      commandLines = (await run("/bin/ps", ["-axo", "command="])).split("\n");
    } catch {
      commandLines = [];
    }
  }
  for (const line of commandLines ?? []) {
    const port = parseLoopbackProcessArgument(line);
    if (port !== null) candidates.push({ port, source: "process-args" });
  }

  const seen = new Set<number>();
  return candidates.filter(({ port }) => !seen.has(port) && seen.add(port));
}

async function collectAttestedProcessCandidate(
  options: CdpDiscoveryOptions,
  identity: DesktopProcessIdentity,
): Promise<CdpCandidate[]> {
  if (!validDesktopProcessIdentity(identity)) {
    throw new CodexDesktopAdapterError("cdp-unavailable", "The attested Desktop process identity is invalid.");
  }
  const run = options.execFile ?? defaultExecFile;
  let output: string;
  try {
    output = await run("/bin/ps", [
      "-p",
      String(identity.pid),
      "-o",
      "pid=,lstart=,command=",
    ]);
  } catch {
    return [];
  }
  const rows = output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    return match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined
      ? []
      : [{ pid: Number(match[1]), startedAt: match[2], command: match[3] }];
  });
  if (rows.length !== 1) return [];
  const row = rows[0];
  if (row?.pid !== identity.pid || row.startedAt !== identity.startedAt) return [];
  const arguments_ = exactExecutableArguments(row.command, identity.executablePath);
  if (arguments_ === null) return [];
  const address = exactArgument(arguments_, "remote-debugging-address");
  if (address === null || !isLoopbackHostname(address)) return [];
  const rawPort = exactArgument(arguments_, "remote-debugging-port");
  if (rawPort === null) return [];
  const port = parsePort(rawPort);
  if (port !== null) return [{ port, source: "attested-process" }];
  if (rawPort !== "0") return [];

  // A random Chromium port belongs to this process only when the exact process
  // names its private profile. Default/global ActivePort files are ambiguous.
  const userDataDirectory = exactArgument(arguments_, "user-data-dir");
  if (
    userDataDirectory === null
    || !isAbsolute(userDataDirectory)
    || userDataDirectory.length > 1_024
    || /[\u0000\r\n]/u.test(userDataDirectory)
  ) return [];
  const readText = options.readFile ?? readOwnedRegularFile;
  try {
    const firstLine = (await readText(join(resolve(userDataDirectory), "DevToolsActivePort"))).split(/\r?\n/, 1)[0];
    const profilePort = parsePort(firstLine);
    return profilePort === null ? [] : [{ port: profilePort, source: "attested-process-profile" }];
  } catch {
    return [];
  }
}

function validDesktopProcessIdentity(identity: DesktopProcessIdentity): boolean {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  if (!PROCESS_START.test(identity.startedAt)) return false;
  if (!isAbsolute(identity.appPath) || !isAbsolute(identity.executablePath)) return false;
  if (!identity.executablePath.startsWith(`${identity.appPath}/Contents/MacOS/`)) return false;
  return identity.bundleId === "com.openai.codex" || identity.bundleId === "com.openai.chatgpt";
}

function exactExecutableArguments(command: string, executablePath: string): string | null {
  for (const candidate of [executablePath, `"${executablePath}"`, `'${executablePath}'`]) {
    if (command === candidate) return "";
    if (command.startsWith(`${candidate} `)) return command.slice(candidate.length + 1);
  }
  return null;
}

function exactArgument(arguments_: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(?:^|\\s)--${escaped}(?:=|\\s+)(?:"([^"\\r\\n]{1,4096})"|'([^'\\r\\n]{1,4096})'|([^\\s"']{1,4096}))(?=\\s|$)`, "g");
  const values: string[] = [];
  for (const match of arguments_.matchAll(matcher)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) values.push(value);
  }
  return values.length === 1 ? values[0] ?? null : null;
}

async function readOwnedRegularFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile()) throw new Error("DevToolsActivePort is not a regular file.");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && before.uid !== currentUid) throw new Error("DevToolsActivePort is not owned by the current user.");

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("DevToolsActivePort changed while opening it.");
    }
    if (currentUid !== null && after.uid !== currentUid) throw new Error("DevToolsActivePort owner changed while opening it.");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function rankTarget(target: CdpTarget): number {
  try {
    const url = new URL(target.url);
    if (url.pathname === "/index.html" && url.search === "") return 0;
    if (url.pathname === "/index.html" && !url.searchParams.has("initialRoute")) return 10;
    if (url.pathname === "/index.html") return 20;
    return 30;
  } catch {
    return 100;
  }
}

function isAuxiliaryTarget(target: CdpTarget): boolean {
  return /avatar-overlay|composition-surface|mascot-badge|activity-slot|devtools/i.test(`${target.url} ${target.title ?? ""}`);
}

function parsePort(value: unknown): number | null {
  const port = typeof value === "number" ? value : Number.parseInt(typeof value === "string" ? value.trim() : "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

async function defaultExecFile(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile(file, [...args], { encoding: "utf8", timeout: 3_000 });
  return stdout;
}

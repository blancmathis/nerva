import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { showPairingInfo } from "./pairing.js";
import { defaultDataPaths } from "./paths.js";
import { codexPadPaths, DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from "./setup.js";
import { probeWssUpgrade, type WssProbe, type WssProbeResult } from "./wss-probe.js";
import {
  inspectDesktopOwnership,
  type DesktopOwnershipInspection,
  type InspectDesktopOwnershipOptions,
} from "./desktop-ownership.js";
import {
  probeRuntimeCompatibility,
  type ProbeRuntimeCompatibilityOptions,
  type RuntimeCapabilityResult,
  type RuntimeCompatibilityResult,
} from "./runtime-compatibility.js";

export type CheckStatus = "green" | "warn" | "red";
export type DoctorState = "ready" | "limited" | "blocked";

export interface DoctorCheck {
  readonly id: string;
  readonly category: "system" | "codex" | "transport" | "micro" | "network" | "bridge" | "security";
  readonly status: CheckStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly remediation?: readonly string[];
  readonly proofBoundary: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  executable: string,
  arguments_: readonly string[],
  timeoutMs?: number,
) => Promise<CommandResult>;

export interface DesktopInstallation {
  readonly appPath: string;
  readonly bundleId?: string;
  readonly appVersion?: string;
  readonly buildVersion?: string;
  readonly binaryPath: string;
  readonly binaryVersion?: string;
}

export interface DoctorReport {
  readonly generatedAt: string;
  readonly state?: DoctorState;
  readonly overall: CheckStatus;
  readonly checks: readonly DoctorCheck[];
  readonly desktop?: DesktopInstallation;
  readonly versions?: {
    readonly desktop?: string;
    readonly daemonCli?: string;
    readonly daemonAppServer?: string;
    readonly daemonManagedCodex?: string;
    readonly userAgent?: string;
  };
  readonly compatibility?: RuntimeCompatibilityResult;
  readonly capabilities?: readonly RuntimeCapabilityResult[];
  readonly safeCommands: readonly {
    readonly purpose: string;
    readonly command: string;
    readonly requiresExplicitUserAction: true;
  }[];
  readonly proofBoundaries: readonly string[];
}

export interface DoctorDependencies {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly applicationCandidates?: readonly string[];
  readonly runCommand?: CommandRunner;
  readonly fetch?: typeof globalThis.fetch;
  readonly probeWss?: WssProbe;
  readonly now?: () => Date;
  readonly probeMicro?: (port: number) => Promise<{
    readonly ready: boolean;
    readonly stale: boolean;
    readonly slotCount: number;
    readonly detail?: string;
  }>;
  readonly inspectOwnership?: (
    options: InspectDesktopOwnershipOptions,
  ) => Promise<DesktopOwnershipInspection>;
  readonly probeCompatibility?: (
    options: ProbeRuntimeCompatibilityOptions,
  ) => Promise<RuntimeCompatibilityResult>;
}

const MAX_COMMAND_OUTPUT = 512 * 1024;
const WSS_PROBE_TIMEOUT_MS = 3_000;

export const runCommand: CommandRunner = async (executable, arguments_, timeoutMs = 5_000) =>
  new Promise((resolve) => {
    const forceTailscaleCli = basename(executable).toLowerCase() === "tailscale";
    execFile(
      executable,
      [...arguments_],
      {
        encoding: "utf8",
        maxBuffer: MAX_COMMAND_OUTPUT,
        timeout: timeoutMs,
        ...(forceTailscaleCli
          ? { env: { ...process.env, TAILSCALE_BE_CLI: "1" } }
          : {}),
      },
      (error, stdout, stderr) => {
        const maybeCode = (error as NodeJS.ErrnoException & { code?: number | string } | null)?.code;
        resolve({
          exitCode: typeof maybeCode === "number" ? maybeCode : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error?.message ?? ""),
        });
      },
    );
  });

async function exists(path: string, mode = fsConstants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readPlistValue(
  plistPath: string,
  key: string,
  command: CommandRunner,
): Promise<string | undefined> {
  const result = await command("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export async function locateDesktopInstallation(
  dependencies: Pick<
    DoctorDependencies,
    "applicationCandidates" | "environment" | "runCommand"
  > = {},
): Promise<DesktopInstallation | undefined> {
  const environment = dependencies.environment ?? process.env;
  const command = dependencies.runCommand ?? runCommand;
  const candidates = [
    ...(environment.CODEX_PAD_CODEX_APP ? [environment.CODEX_PAD_CODEX_APP] : []),
    ...(dependencies.applicationCandidates ?? ["/Applications/ChatGPT.app", "/Applications/Codex.app"]),
  ];

  for (const appPath of [...new Set(candidates)]) {
    const plistPath = join(appPath, "Contents", "Info.plist");
    if (!(await exists(plistPath))) {
      continue;
    }
    const binaryPath = join(appPath, "Contents", "Resources", "codex");
    const binaryExists = await exists(binaryPath, fsConstants.X_OK);
    const [bundleId, appVersion, buildVersion, binaryVersionResult] = await Promise.all([
      readPlistValue(plistPath, "CFBundleIdentifier", command),
      readPlistValue(plistPath, "CFBundleShortVersionString", command),
      readPlistValue(plistPath, "CFBundleVersion", command),
      binaryExists
        ? command(binaryPath, ["--version"])
        : Promise.resolve<CommandResult>({ exitCode: 1, stdout: "", stderr: "missing" }),
    ]);
    const binaryVersion =
      binaryVersionResult.exitCode === 0 ? binaryVersionResult.stdout.trim() : undefined;
    return {
      appPath,
      binaryPath,
      ...(bundleId ? { bundleId } : {}),
      ...(appVersion ? { appVersion } : {}),
      ...(buildVersion ? { buildVersion } : {}),
      ...(binaryVersion ? { binaryVersion } : {}),
    };
  }
  return undefined;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

function parseProcesses(output: string): readonly ProcessRow[] {
  return output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3] ?? "",
    }));
}

function isStandaloneAppServer(command: string): boolean {
  if (!/(?:^|\s)app-server(?:\s|$)/.test(command)) {
    return false;
  }
  // The durable manager launches its server with an inherited Unix listener,
  // rendered by ps as an empty `unix://` URL. It is the managed socket owner,
  // not an independent stdio writer.
  if (/(?:^|\s)app-server\s+--remote-control\s+--listen\s+unix:\/\/(?:\s|$)/.test(command)) {
    return false;
  }
  return !/(?:^|\s)app-server\s+(?:daemon|proxy|generate-|help)(?:\s|$)/.test(command);
}

function hasExactTailscaleServeRoute(
  result: CommandResult,
  dnsName: string | undefined,
): boolean {
  if (result.exitCode !== 0 || dnsName === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.Web)) return false;
  const route = parsed.Web[`${dnsName}:443`];
  if (!isRecord(route) || !isRecord(route.Handlers)) return false;
  const root = route.Handlers["/"];
  return Object.keys(route.Handlers).length === 1
    && isRecord(root)
    && root.Proxy === `http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;
}

function findDebuggingArgument(processes: readonly ProcessRow[]): {
  readonly address?: string;
  readonly port?: number;
  readonly unsafeAddress: boolean;
} {
  for (const process_ of processes) {
    if (!/(?:ChatGPT|Codex)(?:\.app)?/.test(process_.command)) {
      continue;
    }
    const address = process_.command.match(/--remote-debugging-address(?:=|\s+)([^\s]+)/)?.[1];
    const portText = process_.command.match(/--remote-debugging-port(?:=|\s+)(\d+)/)?.[1];
    if (address || portText) {
      const safeAddress = address === undefined || ["127.0.0.1", "localhost", "::1"].includes(address);
      return {
        ...(address ? { address } : {}),
        ...(portText ? { port: Number(portText) } : {}),
        unsafeAddress: !safeAddress,
      };
    }
  }
  return { unsafeAddress: false };
}

async function readDevToolsPort(homeDirectory: string): Promise<number | undefined> {
  const candidates = [
    join(homeDirectory, "Library", "Application Support", "Codex", "DevToolsActivePort"),
    join(homeDirectory, "Library", "Application Support", "ChatGPT", "DevToolsActivePort"),
  ];
  for (const candidate of candidates) {
    try {
      const firstLine = (await readFile(candidate, "utf8")).split("\n")[0]?.trim();
      const port = Number(firstLine);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        return port;
      }
    } catch {
      // Absence is expected unless Desktop was explicitly launched with CDP.
    }
  }
  return undefined;
}

async function fetchJson(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
): Promise<{ readonly ok: boolean; readonly status: number; readonly body?: unknown }> {
  try {
    const response = await fetchImplementation(url, {
      signal: AbortSignal.timeout(1_500),
      redirect: "error",
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, ...(body === undefined ? {} : { body }) };
  } catch {
    return { ok: false, status: 0 };
  }
}

function isBridgeHealthResponse(
  response: { readonly ok: boolean; readonly body?: unknown },
): boolean {
  if (!response.ok || typeof response.body !== "object" || response.body === null) return false;
  const body = response.body as { ok?: unknown; data?: unknown };
  if (body.ok !== true || typeof body.data !== "object" || body.data === null) return false;
  return typeof (body.data as { version?: unknown }).version === "string";
}

export function normalizeTailscaleDnsName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length === 0
    || normalized.length > 253
    || !normalized.endsWith(".ts.net")
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized)
    || normalized.includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

export type FunnelRouteState = "disabled" | "enabled" | "ambiguous";

const SERVE_CONFIG_KEYS = new Set([
  "TCP",
  "Web",
  "Services",
  "AllowFunnel",
  "Foreground",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFunnelRoute(value: string): string | undefined {
  const match = value.match(/^(.+):(\d+)$/u);
  if (match === null) return undefined;
  const hostname = normalizeTailscaleDnsName(match[1]);
  const port = Number(match[2]);
  if (hostname === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return `${hostname}:${port}`;
}

function inspectFunnelConfig(value: unknown, targetRoute: string | undefined): FunnelRouteState {
  // A successful JSON `null` response is how the current CLI represents no
  // Serve/Funnel configuration at all, so it is authoritative negative proof.
  if (value === null) return "disabled";
  if (!isRecord(value)) return "ambiguous";
  if (Object.keys(value).some((key) => !SERVE_CONFIG_KEYS.has(key))) return "ambiguous";

  let exactRouteEnabled = false;
  let anyRouteEnabled = false;
  const allowFunnel = value.AllowFunnel;
  if (allowFunnel !== undefined) {
    if (!isRecord(allowFunnel)) return "ambiguous";
    for (const [route, enabled] of Object.entries(allowFunnel)) {
      const normalizedRoute = normalizeFunnelRoute(route);
      if (normalizedRoute === undefined || typeof enabled !== "boolean") return "ambiguous";
      if (enabled) {
        anyRouteEnabled = true;
        if (targetRoute !== undefined && normalizedRoute === targetRoute) exactRouteEnabled = true;
      }
    }
  }

  const foreground = value.Foreground;
  if (foreground !== undefined) {
    if (!isRecord(foreground)) return "ambiguous";
    for (const config of Object.values(foreground)) {
      const state = inspectFunnelConfig(config, targetRoute);
      if (state === "ambiguous") return "ambiguous";
      if (state === "enabled") {
        if (targetRoute !== undefined) exactRouteEnabled = true;
        else anyRouteEnabled = true;
      }
    }
  }

  if (exactRouteEnabled || (targetRoute === undefined && anyRouteEnabled)) return "enabled";
  return "disabled";
}

export function inspectFunnelStatus(
  result: CommandResult | undefined,
  targetRoute: string | undefined,
): { readonly state: FunnelRouteState; readonly detail: string } {
  if (result === undefined) {
    return { state: "ambiguous", detail: "Tailscale CLI is unavailable; Funnel status was not queried." };
  }
  if (result.exitCode !== 0) {
    return { state: "ambiguous", detail: "`tailscale funnel status --json` did not complete successfully." };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { state: "ambiguous", detail: "Funnel status JSON is unreadable." };
  }
  const state = inspectFunnelConfig(value, targetRoute);
  if (state === "enabled") {
    return {
      state,
      detail: targetRoute === undefined
        ? "Funnel is enabled and the intended bridge route cannot be identified."
        : "Funnel is enabled for the configured bridge route.",
    };
  }
  if (state === "ambiguous") {
    return { state, detail: "Funnel status does not match the supported ServeConfig JSON shape." };
  }
  return {
    state,
    detail: targetRoute === undefined
      ? "The authoritative status contains no enabled Funnel route."
      : "Funnel is explicitly absent from the configured bridge route.",
  };
}

async function configuredPublicOrigin(
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<URL | undefined> {
  let candidate = environment.CODEX_PAD_PUBLIC_ORIGIN;
  if (candidate === undefined) {
    try {
      const pairing = await showPairingInfo({ paths: defaultDataPaths(codexPadPaths(homeDirectory).root) });
      candidate = pairing === null ? undefined : new URL(pairing.qrPayload).origin;
    } catch {
      return undefined;
    }
  }
  if (candidate === undefined) return undefined;
  try {
    const origin = new URL(candidate);
    if (
      origin.protocol !== "https:"
      || origin.username !== ""
      || origin.password !== ""
      || origin.pathname !== "/"
      || origin.search !== ""
      || origin.hash !== ""
      || !origin.hostname.toLowerCase().endsWith(".ts.net")
    ) {
      return undefined;
    }
    return origin;
  } catch {
    return undefined;
  }
}

function wssProbeDetail(result: WssProbeResult): string {
  if (result.outcome === "upgraded") {
    if (result.receivedData) return "Upgrade succeeded, but application data arrived before authentication.";
    return result.closeCode === null
      ? "Upgrade succeeded without the expected authentication close."
      : `Upgrade succeeded; bridge close code ${result.closeCode}.`;
  }
  if (result.outcome === "http-response") {
    return `The HTTPS endpoint returned HTTP ${result.statusCode} instead of switching protocols.`;
  }
  return result.outcome === "timeout"
    ? "The bounded WSS probe timed out."
    : "The bounded WSS probe failed before a protocol switch.";
}

async function defaultMicroProbe(port: number): Promise<{
  readonly ready: boolean;
  readonly stale: boolean;
  readonly slotCount: number;
  readonly detail?: string;
}> {
  try {
    const packageName = "@codex-pad/codex-desktop";
    const module_ = (await import(packageName)) as {
      probeCodexDesktop?: (options: { cdpPort: number }) => Promise<unknown>;
    };
    if (!module_.probeCodexDesktop) {
      return { ready: false, stale: true, slotCount: 0, detail: "Adapter probe export is unavailable." };
    }
    const state = (await module_.probeCodexDesktop({ cdpPort: port })) as {
      health?: { status?: string; detail?: string };
      stale?: boolean;
      snapshot?: { slots?: readonly unknown[] };
    };
    return {
      ready: state.health?.status === "ready",
      stale: state.stale ?? true,
      slotCount: state.snapshot?.slots?.length ?? 0,
      ...(state.health?.detail ? { detail: state.health.detail } : {}),
    };
  } catch (error) {
    return { ready: false, stale: true, slotCount: 0, detail: String(error) };
  }
}

export async function findTailscaleBinary(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathCandidates = (environment.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((directory) => join(directory, "tailscale"));
  const candidates = [
    ...pathCandidates,
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await exists(candidate, fsConstants.X_OK)) {
      return candidate;
    }
  }
  return undefined;
}

function permissionString(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function securityModeCheck(homeDirectory: string): Promise<DoctorCheck> {
  const paths = codexPadPaths(homeDirectory);
  if (!(await exists(paths.root))) {
    return {
      id: "security-storage",
      category: "security",
      status: "warn",
      summary: "Codex Pad security storage has not been created yet.",
      remediation: ["Run: npm run setup"],
      proofBoundary: "No Codex Pad-owned credential files were present to inspect.",
    };
  }

  const findings: string[] = [];
  const directories = [paths.root, paths.security, paths.runtime, paths.cache];
  for (const directory of directories) {
    if (!(await exists(directory))) {
      findings.push(`${basename(directory)} is missing`);
      continue;
    }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      findings.push(`${basename(directory)} is ${permissionString(metadata.mode)}, expected owner-only`);
    }
  }

  const privateFiles = [paths.config];
  if (await exists(paths.security)) {
    for (const entry of await readdir(paths.security, { withFileTypes: true })) {
      if (entry.isFile()) {
        privateFiles.push(join(paths.security, entry.name));
      }
    }
  }
  for (const file of privateFiles) {
    if (!(await exists(file))) {
      continue;
    }
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      findings.push(`${basename(file)} is ${permissionString(metadata.mode)}, expected owner-only`);
    }
  }

  return findings.length === 0
    ? {
        id: "security-storage",
        category: "security",
        status: "green",
        summary: "Codex Pad-owned directories and inspected security files are owner-only.",
        proofBoundary: "This proves filesystem modes, not Keychain state or resistance to same-user processes.",
      }
    : {
        id: "security-storage",
        category: "security",
        status: "red",
        summary: "Codex Pad security storage permissions are unsafe or incomplete.",
        detail: findings.join("; "),
        remediation: ["Run `npm run setup` to harden Codex Pad-owned paths."],
        proofBoundary: "Only Codex Pad-owned Application Support paths were inspected.",
      };
}

async function hashDirectory(root: string, current = root): Promise<{
  readonly hash: string;
  readonly files: readonly string[];
}> {
  const collected: { relative: string; contents: Buffer }[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name !== "manifest.json") {
        collected.push({ relative: absolute.slice(root.length + 1), contents: await readFile(absolute) });
      }
    }
  }
  await visit(current);
  const digest = createHash("sha256");
  for (const file of collected) {
    digest.update(file.relative);
    digest.update("\0");
    digest.update(file.contents);
    digest.update("\0");
  }
  return { hash: digest.digest("hex"), files: collected.map((file) => file.relative) };
}

async function schemaCacheCheck(
  homeDirectory: string,
  desktop: DesktopInstallation | undefined,
): Promise<DoctorCheck> {
  if (!desktop?.binaryVersion) {
    return {
      id: "protocol-schema",
      category: "transport",
      status: "warn",
      summary: "Installed-version app-server schemas cannot be matched without a bundled binary version.",
      proofBoundary: "No generated schema code is committed or trusted without version provenance.",
    };
  }
  const schemaRoot = join(codexPadPaths(homeDirectory).cache, "app-server-schemas");
  if (!(await exists(schemaRoot))) {
    return {
      id: "protocol-schema",
      category: "transport",
      status: "warn",
      summary: `No cached app-server schema exists for ${desktop.binaryVersion}.`,
      remediation: ["Run: npm run setup -- --generate-schemas"],
      proofBoundary: "Runtime schemas are generated from the installed Desktop binary and are never committed.",
    };
  }
  const manifests: string[] = [];
  for (const entry of await readdir(schemaRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && (await exists(join(schemaRoot, entry.name, "manifest.json")))) {
      manifests.push(join(schemaRoot, entry.name, "manifest.json"));
    }
  }
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        codexVersion?: string;
        schemaSha256?: string;
        files?: readonly string[];
      };
      if (manifest.codexVersion !== desktop.binaryVersion) {
        continue;
      }
      const directory = dirname(manifestPath);
      const actual = await hashDirectory(directory);
      const matches =
        actual.hash === manifest.schemaSha256 &&
        JSON.stringify(actual.files) === JSON.stringify(manifest.files);
      return matches
        ? {
            id: "protocol-schema",
            category: "transport",
            status: "green",
            summary: `Cached app-server schemas match installed ${desktop.binaryVersion}.`,
            detail: `SHA-256 ${actual.hash}`,
            proofBoundary: "The cache matches its manifest and installed binary version; live daemon compatibility is separate.",
          }
        : {
            id: "protocol-schema",
            category: "transport",
            status: "warn",
            summary: "Cached app-server schema files fail manifest validation.",
            remediation: ["Move the Codex Pad schema cache aside, then run: npm run setup -- --generate-schemas"],
            proofBoundary: "No corrupted or version-mismatched cache is accepted.",
          };
    } catch (error) {
      return {
        id: "protocol-schema",
        category: "transport",
        status: "warn",
        summary: "Cached app-server schema manifest is unreadable.",
        detail: String(error),
        proofBoundary: "No unreadable cache is accepted as protocol proof.",
      };
    }
  }
  return {
    id: "protocol-schema",
    category: "transport",
    status: "warn",
    summary: `Schema cache exists, but none matches installed ${desktop.binaryVersion}.`,
    remediation: ["Run: npm run setup -- --generate-schemas"],
    proofBoundary: "Schemas from another Codex version are not treated as compatible.",
  };
}

/**
 * Read-only, path-free proof of whether the cached app-server schemas match
 * the Codex binary currently bundled with Desktop.
 */
export async function inspectInstalledProtocolSchema(
  desktop: DesktopInstallation | undefined,
  homeDirectory = homedir(),
): Promise<DoctorCheck> {
  return schemaCacheCheck(homeDirectory, desktop);
}

function overallStatus(checks: readonly DoctorCheck[]): CheckStatus {
  return checks.some((check) => check.status === "red")
    ? "red"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "green";
}

function doctorState(
  checks: readonly DoctorCheck[],
  compatibility: RuntimeCompatibilityResult,
  ownership: DesktopOwnershipInspection,
): DoctorState {
  if (checks.some((check) => check.status === "red")) return "blocked";
  const structuralReads = ["sessions", "models"].every((id) =>
    compatibility.capabilities.some((capability) => capability.id === id && capability.state === "available"));
  const coreMutations = compatibility.capabilities.some((capability) =>
    capability.id === "exactTaskMutations" && capability.state === "available");
  return structuralReads && coreMutations && ownership.verified ? "ready" : "limited";
}

function effectiveDoctorCapabilities(
  compatibility: RuntimeCompatibilityResult,
  ownership: DesktopOwnershipInspection,
): readonly RuntimeCapabilityResult[] {
  return compatibility.capabilities.map((capability) => {
    if (
      ownership.verified
      || capability.state !== "available"
      || (capability.id !== "exactTaskMutations" && capability.id !== "taskCreation")
    ) {
      return capability;
    }
    return {
      ...capability,
      state: "unverified" as const,
      reason: "The protocol is compatible, but Desktop ownership on the exact managed socket is not attested; app-server mutations are unavailable.",
    };
  });
}

export async function doctorCodexPad(
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const environment = dependencies.environment ?? process.env;
  const command = dependencies.runCommand ?? runCommand;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const checks: DoctorCheck[] = [];

  checks.push({
    id: "system",
    category: "system",
    status: platform === "darwin" ? "green" : "red",
    summary: `${platform} ${architecture}`,
    ...(platform === "darwin" ? {} : { remediation: ["Run the bridge on the Mac that hosts Codex Desktop."] }),
    proofBoundary: "Platform and architecture only; this is not a runtime compatibility test.",
  });

  const desktop = await locateDesktopInstallation({
    ...(dependencies.applicationCandidates ? { applicationCandidates: dependencies.applicationCandidates } : {}),
    environment,
    runCommand: command,
  });
  checks.push(
    desktop
      ? {
          id: "desktop-installation",
          category: "codex",
          status: desktop.binaryVersion ? "green" : "red",
          summary: `Codex Desktop found at ${desktop.appPath}.`,
          detail: [desktop.appVersion, desktop.buildVersion, desktop.binaryVersion].filter(Boolean).join(" / "),
          ...(desktop.binaryVersion
            ? {}
            : { remediation: ["Reinstall or update Codex Desktop; its bundled codex binary is missing."] }),
          proofBoundary: "This verifies installed metadata and the bundled CLI version, not a running Desktop session.",
        }
      : {
          id: "desktop-installation",
          category: "codex",
          status: "red",
          summary: "Codex Desktop was not found in the inspected application paths.",
          proofBoundary: "Only configured and standard /Applications locations were inspected.",
        },
  );

  const processResult = await command("/bin/ps", ["-axo", "pid=,ppid=,command="], 5_000);
  const processes = processResult.exitCode === 0 ? parseProcesses(processResult.stdout) : [];
  const writerProcesses = processes.filter((row) => isStandaloneAppServer(row.command));
  // npm/global CLI shims commonly exec a native codex child. Count that chain as
  // one writer instead of reporting both the wrapper and its backend.
  const writers = writerProcesses.filter(
    (candidate) => !writerProcesses.some((child) => child.ppid === candidate.pid),
  );
  checks.push({
    id: "app-server-writers",
    category: "transport",
    status: writers.length > 0 ? "warn" : "green",
    summary:
      writers.length === 0
        ? "No independent stdio app-server writer was observed."
        : `${writers.length} independent stdio app-server writer${writers.length === 1 ? "" : "s"} observed.`,
    ...(writers.length > 0
      ? { detail: writers.map((writer) => `PID ${writer.pid}, parent ${writer.ppid}`).join("; ") }
      : {}),
    proofBoundary: "These stdio writers are diagnostic only. They do not block the private managed socket unless an exact socket peer/topology check links them to it.",
  });

  const controlSocket = join(homeDirectory, ".codex", "app-server-control", "app-server-control.sock");
  let managedSocketReady = false;
  let managedSocketPrivate = false;
  if (await exists(controlSocket)) {
    const metadata = await lstat(controlSocket);
    managedSocketReady = metadata.isSocket() && !metadata.isSymbolicLink();
    managedSocketPrivate = (metadata.mode & 0o077) === 0;
  }
  const daemonVersion =
    managedSocketReady && managedSocketPrivate && desktop
      ? await command(desktop.binaryPath, ["app-server", "daemon", "version"], 3_000)
      : undefined;
  let daemonCliVersion: string | undefined;
  let daemonAppServerVersion: string | undefined;
  let daemonManagedCodexVersion: string | undefined;
  let managedDaemonVersionCompatible = false;
  if (daemonVersion?.exitCode === 0) {
    try {
      const parsed = JSON.parse(daemonVersion.stdout) as unknown;
      if (isRecord(parsed)) {
        const cliVersion = typeof parsed.cliVersion === "string" ? parsed.cliVersion : undefined;
        const appServerVersion = typeof parsed.appServerVersion === "string" ? parsed.appServerVersion : undefined;
        const managedCodexVersion = typeof parsed.managedCodexVersion === "string" ? parsed.managedCodexVersion : undefined;
        daemonCliVersion = cliVersion;
        daemonAppServerVersion = appServerVersion;
        daemonManagedCodexVersion = managedCodexVersion;
        managedDaemonVersionCompatible = Boolean(
          cliVersion
          && appServerVersion
          && managedCodexVersion
          && cliVersion === appServerVersion
          && cliVersion === managedCodexVersion,
        );
      }
    } catch {
      managedDaemonVersionCompatible = false;
    }
  }
  const managedDaemonResponsive =
    managedSocketReady
    && managedSocketPrivate
    && daemonVersion?.exitCode === 0;
  const daemonBinaryPath = join(
    environment.CODEX_HOME?.trim() || join(homeDirectory, ".codex"),
    "packages",
    "standalone",
    "current",
    "codex",
  );
  const compatibility = managedDaemonResponsive && desktop
      ? await (dependencies.probeCompatibility ?? probeRuntimeCompatibility)({
        desktopBinaryPath: desktop.binaryPath,
        daemonBinaryPath,
        socketPath: controlSocket,
        cacheRoot: codexPadPaths(homeDirectory).cache,
        attestationPath: join(codexPadPaths(homeDirectory).security, "protocol-compatibility-attestation.json"),
        now,
        ...(desktop.binaryVersion ? { desktopVersion: desktop.binaryVersion } : {}),
        ...(daemonManagedCodexVersion
          ? { daemonVersion: `codex-cli ${daemonManagedCodexVersion.replace(/^codex-cli\s+/u, "")}` }
          : {}),
      })
    : {
        state: "unavailable" as const,
        source: "none" as const,
        capabilities: [],
        checkedAt: now().toISOString(),
        detail: "The private managed daemon is not available for a read-only compatibility probe.",
      };
  checks.push({
    id: "managed-app-server",
    category: "transport",
    status: managedSocketReady && !managedSocketPrivate
      ? "red"
      : managedDaemonResponsive && compatibility.state !== "unavailable" ? "green" : "warn",
    summary: managedDaemonResponsive && compatibility.state !== "unavailable"
      ? managedDaemonVersionCompatible
        ? "Managed app-server control socket is private, responsive and protocol-compatible."
        : "Managed app-server versions differ, but the read-only compatibility probe passed."
      : managedSocketReady && !managedSocketPrivate
        ? "Managed app-server control socket permissions are unsafe."
        : managedSocketReady && daemonVersion?.exitCode === 0
          ? "Managed app-server is responsive, but compatibility is not attested."
          : managedSocketReady
            ? "Managed app-server control socket did not answer the installed binary."
          : "Managed app-server control socket is absent.",
    ...(daemonVersion?.exitCode === 0 && daemonVersion.stdout.trim()
      ? { detail: daemonVersion.stdout.trim() }
      : {}),
    ...(managedDaemonResponsive && compatibility.state !== "unavailable"
      ? {}
      : {
          remediation: desktop
            ? daemonVersion?.exitCode === 0
              ? [
                  "Generate current Desktop and daemon schemas, then rerun the read-only compatibility probe.",
                  "Do not grant mutations from version equality alone.",
                ]
              : [
                  `${shellQuote(desktop.binaryPath)} app-server daemon bootstrap --remote-control`,
                  "Then explicitly restart Codex Desktop only after saving active composer/turn state.",
                ]
            : ["Install Codex Desktop before bootstrapping its managed daemon."],
        }),
    proofBoundary: "The probe proves initialize plus structural reads for exact binary/schema fingerprints. It does not grant mutation authority or Desktop co-presence.",
  });

  const ownershipInstallation = desktop?.bundleId
    && desktop.appVersion
    && desktop.buildVersion
    && desktop.binaryVersion
    ? {
        appPath: desktop.appPath,
        bundleId: desktop.bundleId,
        appVersion: desktop.appVersion,
        buildVersion: desktop.buildVersion,
        binaryPath: desktop.binaryPath,
        binaryVersion: desktop.binaryVersion,
        daemonBinaryPath,
        daemonBinaryVersion: daemonManagedCodexVersion ?? daemonCliVersion ?? "unknown",
      }
    : undefined;
  const ownership = await (dependencies.inspectOwnership ?? inspectDesktopOwnership)({
    attestationPath: codexPadPaths(homeDirectory).desktopOwnershipAttestation,
    socketPath: controlSocket,
    codexBinaryPath: desktop?.binaryPath
      ?? join("/Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    ...(ownershipInstallation === undefined ? {} : { installation: ownershipInstallation }),
    platform,
    runCommand: command,
    allowSafeRenewal: compatibility.state !== "unavailable",
    now,
  });
  checks.push({
    id: "desktop-shared-ownership",
    category: "transport",
    status: ownership.verified ? "green" : "warn",
    summary: ownership.summary,
    ...(ownership.canCreate
      ? { detail: "Positive co-presence evidence is available for an explicit local attestation." }
      : {}),
    ...(!ownership.verified
      ? {
          remediation: ownership.canCreate
            ? ["Run: npm run setup -- --attest-desktop-ownership"]
            : [
                "Save active work, then establish one Desktop-owned client on the managed daemon before attesting.",
                "Do not create or edit the attestation file by hand.",
              ],
        }
      : {}),
    proofBoundary: "A matching attestation binds the socket device/inode, current kernel listener generation, daemon, Desktop process/version, and exact reciprocal Desktop peer; runtime still proves the bridge socket client is the only other peer before stateful resume or mutation.",
  });

  const debugging = findDebuggingArgument(processes);
  const resolvedDebugPort =
    debugging.port && debugging.port > 0 ? debugging.port : await readDevToolsPort(homeDirectory);
  let cdpReachable = false;
  let mainTarget = false;
  if (resolvedDebugPort && !debugging.unsafeAddress) {
    const targetResponse = await fetchJson(
      fetchImplementation,
      `http://127.0.0.1:${resolvedDebugPort}/json/list`,
    );
    cdpReachable = targetResponse.ok;
    mainTarget =
      Array.isArray(targetResponse.body) &&
      targetResponse.body.some(
        (target) =>
          typeof target === "object" &&
          target !== null &&
          "url" in target &&
          typeof target.url === "string" &&
          target.url.startsWith("app://"),
      );
  }
  checks.push({
    id: "cdp-loopback",
    category: "micro",
    status: debugging.unsafeAddress ? "red" : cdpReachable && mainTarget ? "green" : "warn",
    summary: debugging.unsafeAddress
      ? `Desktop CDP address ${debugging.address ?? "unknown"} is not loopback.`
      : cdpReachable && mainTarget
        ? `Desktop CDP is reachable on loopback port ${resolvedDebugPort}.`
        : "Desktop CDP is unavailable; native six-slot discovery is degraded.",
    ...(cdpReachable && mainTarget
      ? {}
      : {
          remediation: [
            "After saving active work, explicitly quit Desktop and relaunch it with --remote-debugging-address=127.0.0.1 --remote-debugging-port=0.",
            "Never expose CDP on a LAN, tailnet, wildcard, or public interface.",
          ],
        }),
    proofBoundary: "Only a loopback renderer endpoint and app:// target are accepted; CDP is never proxied to iPad.",
  });

  const microProbe =
    resolvedDebugPort && cdpReachable && mainTarget && !debugging.unsafeAddress
      ? await (dependencies.probeMicro ?? defaultMicroProbe)(resolvedDebugPort)
      : { ready: false, stale: true, slotCount: 0, detail: "CDP prerequisite is unavailable." };
  const exactSlots = microProbe.ready && !microProbe.stale && microProbe.slotCount === 6;
  checks.push({
    id: "micro-six-slots",
    category: "micro",
    status: exactSlots ? "green" : "warn",
    summary: exactSlots
      ? "The native Codex Micro adapter returned exactly six fresh slots."
      : "The native Codex Micro adapter is degraded; commands must fail closed.",
    ...(exactSlots
      ? { detail: "6/6 authoritative slots" }
      : microProbe.detail
        ? { detail: microProbe.detail }
        : {}),
    proofBoundary: "A green result covers current renderer shape only; installed updates can invalidate private adapter discovery.",
  });

  const tailscaleBinary = await findTailscaleBinary(environment);
  const tailscaleCli = tailscaleBinary === undefined
    ? "tailscale"
    : `TAILSCALE_BE_CLI=1 ${shellQuote(tailscaleBinary)}`;
  let tailscaleOnline = false;
  let tailscaleStatusDetail = "not installed";
  let tailscaleDnsName: string | undefined;
  let serveConfigured = false;
  let funnelStatusResult: CommandResult | undefined;
  if (tailscaleBinary) {
    const statusResult = await command(tailscaleBinary, ["status", "--json"]);
    if (statusResult.exitCode === 0) {
      try {
        const status = JSON.parse(statusResult.stdout) as {
          BackendState?: string;
          Self?: { Online?: boolean; DNSName?: string };
        };
        tailscaleOnline = status.BackendState === "Running" && status.Self?.Online === true;
        tailscaleDnsName = normalizeTailscaleDnsName(status.Self?.DNSName);
        tailscaleStatusDetail = `${status.BackendState ?? "unknown"}${status.Self?.DNSName ? ` / ${status.Self.DNSName}` : ""}`;
      } catch {
        tailscaleStatusDetail = "status JSON unreadable";
      }
    } else {
      tailscaleStatusDetail = statusResult.stderr.trim() || "status command failed";
    }
    const serveResult = await command(tailscaleBinary, ["serve", "status", "--json"]);
    serveConfigured = hasExactTailscaleServeRoute(serveResult, tailscaleDnsName);
    funnelStatusResult = await command(tailscaleBinary, ["funnel", "status", "--json"]);
  }
  checks.push({
    id: "tailscale",
    category: "network",
    status: tailscaleOnline ? "green" : "warn",
    summary: tailscaleOnline ? "Tailscale is installed and online." : "Tailscale is not ready for iPad access.",
    detail: tailscaleStatusDetail,
    remediation: tailscaleBinary
      ? [`Run \`${tailscaleCli} status --json\` and complete login without resetting existing network state.`]
      : ["Install Tailscale from its official distribution, then sign in on Mac and iPad."],
    proofBoundary: "Online status does not prove iPad ACL access or a working HTTPS Serve route.",
  });

  const paths = codexPadPaths(homeDirectory);
  let configuredHost = DEFAULT_BRIDGE_HOST;
  let configuredPort = DEFAULT_BRIDGE_PORT;
  let configuredServeHttpsPort = 443;
  let configReadable = false;
  if (await exists(paths.config)) {
    try {
      const config = JSON.parse(await readFile(paths.config, "utf8")) as {
        bridge?: { host?: string; port?: number };
        tailscale?: { serveHttpsPort?: number };
      };
      configuredHost = config.bridge?.host ?? configuredHost;
      configuredPort = config.bridge?.port ?? configuredPort;
      configuredServeHttpsPort = config.tailscale?.serveHttpsPort ?? configuredServeHttpsPort;
      configReadable = true;
    } catch {
      configReadable = false;
    }
  }
  const safeBind = configuredHost === DEFAULT_BRIDGE_HOST;
  const funnelTargetRoute = tailscaleDnsName === undefined
    ? undefined
    : `${tailscaleDnsName}:${configuredServeHttpsPort}`;
  const funnelStatus = inspectFunnelStatus(funnelStatusResult, funnelTargetRoute);
  const funnelDisabled = funnelStatus.state === "disabled";
  checks.push({
    id: "tailscale-funnel",
    category: "network",
    status: funnelDisabled ? "green" : "red",
    summary: funnelDisabled
      ? "Tailscale Funnel is disabled for the configured bridge route."
      : funnelStatus.state === "enabled"
        ? "Tailscale Funnel exposes or may expose the configured bridge route publicly."
        : "Tailscale Funnel absence is not authoritatively proven.",
    detail: funnelStatus.detail,
    ...(funnelDisabled
      ? {}
      : {
          remediation: [
            `Inspect \`${tailscaleCli} funnel status --json\` and disable the exact bridge route before remote control.`,
            "Doctor never changes Serve or Funnel configuration.",
          ],
        }),
    proofBoundary: "Green requires a successful read-only Funnel status query whose supported JSON shape contains no enabled allowance for the exact bridge host and HTTPS port.",
  });
  checks.push({
    id: "bridge-config",
    category: "bridge",
    status: configReadable && safeBind ? "green" : safeBind ? "warn" : "red",
    summary: configReadable
      ? safeBind
        ? `Bridge config is loopback-only at ${configuredHost}:${configuredPort}.`
        : `Bridge config attempts a non-loopback bind at ${configuredHost}:${configuredPort}.`
      : "Bridge config is absent or unreadable.",
    remediation: safeBind ? ["Run: npm run setup"] : ["Restore bridge.host to 127.0.0.1."],
    proofBoundary: "Configuration intent is separate from the address of a running listener.",
  });

  const health = safeBind
    ? await fetchJson(fetchImplementation, `http://${DEFAULT_BRIDGE_HOST}:${configuredPort}/api/health`)
    : { ok: false, status: 0 as const };
  const listenerResult = await command(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${configuredPort}`, "-sTCP:LISTEN"],
    3_000,
  );
  const listenerText = listenerResult.stdout;
  const loopbackListener =
    listenerResult.exitCode === 0 &&
    (listenerText.includes(`127.0.0.1:${configuredPort}`) || listenerText.includes(`[::1]:${configuredPort}`));
  const wildcardListener =
    listenerResult.exitCode === 0 &&
    (listenerText.includes(`*:${configuredPort}`) || listenerText.includes(`0.0.0.0:${configuredPort}`));
  const bridgeHealthVerified = isBridgeHealthResponse(health);
  const bridgeRuntimeHealthy = bridgeHealthVerified && loopbackListener && !wildcardListener;
  checks.push({
    id: "bridge-runtime",
    category: "bridge",
    status: wildcardListener ? "red" : bridgeRuntimeHealthy ? "green" : "warn",
    summary: wildcardListener
      ? "Bridge listener is exposed on a wildcard interface."
      : bridgeRuntimeHealthy
        ? "Bridge health responds on a verified loopback listener."
        : "Bridge is not currently proven healthy on loopback.",
    ...(health.ok ? { detail: bridgeHealthVerified ? `Codex Pad health, HTTP ${health.status}` : `Unexpected HTTP ${health.status} response` } : {}),
    remediation: wildcardListener
      ? ["Stop the bridge and restart with the default loopback bind."]
      : ["Run: npm run start"],
    proofBoundary: "This is a local health/bind check, not HTTPS, pairing, WebSocket, or iPad end-to-end proof.",
  });

  const publicOrigin = await configuredPublicOrigin(homeDirectory, environment);
  const publicOriginMatchesTailnet = publicOrigin !== undefined
    && tailscaleDnsName !== undefined
    && publicOrigin.hostname.toLowerCase() === tailscaleDnsName
    && (configuredServeHttpsPort === 443
      ? publicOrigin.port === ""
      : publicOrigin.port === String(configuredServeHttpsPort));
  let wssProbeResult: WssProbeResult | undefined;
  let wssSkipReason: string | undefined;
  if (!tailscaleOnline) {
    wssSkipReason = "Tailscale is not online.";
  } else if (!serveConfigured) {
    wssSkipReason = "No matching HTTPS Serve declaration was found.";
  } else if (!bridgeRuntimeHealthy) {
    wssSkipReason = "The local Codex Pad bridge health/listener prerequisite failed.";
  } else if (!publicOriginMatchesTailnet || publicOrigin === undefined) {
    wssSkipReason = "No exact HTTPS MagicDNS origin matching the bridge and Serve port is configured.";
  } else {
    const wssUrl = new URL("/ws", publicOrigin);
    wssUrl.protocol = "wss:";
    wssProbeResult = await (dependencies.probeWss ?? probeWssUpgrade)({
      url: wssUrl.href,
      origin: publicOrigin.origin,
      timeoutMs: WSS_PROBE_TIMEOUT_MS,
    });
  }

  const wssProbeHealthy = wssProbeResult?.outcome === "upgraded"
    && !wssProbeResult.receivedData
    && wssProbeResult.closeCode === 4401;
  const wssProbeLeakedData = wssProbeResult?.outcome === "upgraded" && wssProbeResult.receivedData;
  const privateServeVerified = serveConfigured && wssProbeHealthy && funnelDisabled;
  checks.push({
    id: "tailscale-serve",
    category: "network",
    status: privateServeVerified ? "green" : "warn",
    summary: privateServeVerified
      ? "Tailscale Serve declares HTTPS and passed a live WSS route probe."
      : serveConfigured && wssProbeHealthy && !funnelDisabled
        ? "The HTTPS/WSS route works, but its private-only Funnel boundary is not proven."
        : serveConfigured
          ? "Tailscale Serve declares HTTPS, but its live WSS route is not proven."
          : "Tailscale Serve is not proven for the loopback bridge.",
    remediation: [
      `${tailscaleCli} serve --bg --https=443 http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`,
      "Do not enable Funnel and do not reset an existing tailnet configuration.",
    ],
    proofBoundary: "A green result requires a matching Serve declaration, an actual bounded WSS upgrade, and authoritative negative Funnel evidence for the exact route; command text alone remains warning-only.",
  });
  checks.push({
    id: "tailscale-wss",
    category: "network",
    status: wssProbeLeakedData ? "red" : wssProbeHealthy ? "green" : "warn",
    summary: wssProbeLeakedData
      ? "The unauthenticated doctor WSS probe received application data."
      : wssProbeHealthy
        ? "A same-origin WSS upgrade reached /ws and closed unauthenticated before data."
        : wssProbeResult === undefined
          ? "The live same-origin WSS upgrade was not attempted."
          : "The live same-origin WSS upgrade did not meet the bridge probe contract.",
    ...(wssProbeResult !== undefined
      ? { detail: wssProbeDetail(wssProbeResult) }
      : wssSkipReason !== undefined
        ? { detail: wssSkipReason }
        : {}),
    remediation: wssProbeLeakedData
      ? ["Stop the bridge and investigate the WebSocket authentication boundary before remote use."]
      : ["Verify the exact HTTPS MagicDNS origin, Serve route, bridge listener, and installed Tailscale state, then rerun doctor."],
    proofBoundary: "The probe performs one credential-free WSS upgrade and inspects only protocol outcome/close code; it does not prove a paired iPad, ACL reachability, resume, or message delivery.",
  });

  checks.push(await securityModeCheck(homeDirectory));
  checks.push(await schemaCacheCheck(homeDirectory, desktop));

  const safeCommands: DoctorReport["safeCommands"] = [
    ...(ownership.canCreate
      ? [
          {
            purpose: "Create a local Desktop ownership attestation from the currently verified topology",
            command: "npm run setup -- --attest-desktop-ownership",
            requiresExplicitUserAction: true as const,
          },
        ]
      : []),
    ...(desktop
      ? [
          {
            purpose: "Bootstrap the managed app-server daemon after resolving writer ownership",
            command: `${shellQuote(desktop.binaryPath)} app-server daemon bootstrap --remote-control`,
            requiresExplicitUserAction: true as const,
          },
          {
            purpose: "Relaunch Desktop with loopback-only CDP after saving active work",
            command: `${shellQuote(join(desktop.appPath, "Contents", "MacOS", basename(desktop.appPath, ".app")))} --remote-debugging-address=127.0.0.1 --remote-debugging-port=0`,
            requiresExplicitUserAction: true as const,
          },
        ]
      : []),
    {
      purpose: "Publish only the loopback bridge through tailnet HTTPS",
      command: `${tailscaleCli} serve --bg --https=443 http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`,
      requiresExplicitUserAction: true,
    },
  ];
  const capabilities = effectiveDoctorCapabilities(compatibility, ownership);

  return {
    generatedAt: now().toISOString(),
    state: doctorState(checks, compatibility, ownership),
    overall: overallStatus(checks),
    checks,
    ...(desktop ? { desktop } : {}),
    versions: {
      ...(desktop?.binaryVersion ? { desktop: desktop.binaryVersion } : {}),
      ...(daemonCliVersion ? { daemonCli: daemonCliVersion } : {}),
      ...(daemonAppServerVersion ? { daemonAppServer: daemonAppServerVersion } : {}),
      ...(daemonManagedCodexVersion ? { daemonManagedCodex: daemonManagedCodexVersion } : {}),
      ...(compatibility.userAgent ? { userAgent: compatibility.userAgent } : {}),
    },
    compatibility,
    capabilities,
    safeCommands,
    proofBoundaries: [
      "Doctor is read-only except for temporary process/HTTP activity; it never restarts Desktop or changes launchctl/global environment state.",
      "Local green checks do not establish live Desktop co-presence, iPad reachability, Tailscale ACLs, or end-to-end sketch routing.",
      "Mutation authority revalidates the private Desktop attestation and exact two-peer listener generation immediately before stateful thread/resume and every app-server write.",
      "The undocumented CDP adapter and experimental managed app-server transport can regress after a Codex update.",
    ],
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const glyph: Record<CheckStatus, string> = { green: "GREEN", warn: "WARN", red: "RED" };
  const stateLabel: Record<DoctorState, string> = {
    ready: "READY",
    limited: "READY WITH LIMITATIONS",
    blocked: "BLOCKED",
  };
  const state = report.state ?? (report.overall === "red" ? "blocked" : report.overall === "warn" ? "limited" : "ready");
  const lines = [`Nerva doctor: ${stateLabel[state]} (${glyph[report.overall]})`, ""];
  for (const check of report.checks) {
    lines.push(`[${glyph[check.status]}] ${check.summary}`);
    if (check.detail) lines.push(`  ${check.detail}`);
    lines.push(`  Proof: ${check.proofBoundary}`);
    for (const remediation of check.remediation ?? []) lines.push(`  Next: ${remediation}`);
  }
  if (report.capabilities?.length) {
    lines.push("", "Capabilities:");
    for (const capability of report.capabilities) {
      lines.push(`- ${capability.id}: ${capability.state}`, `  ${capability.reason}`);
    }
  }
  lines.push("", "Explicit commands (never run by doctor):");
  for (const command of report.safeCommands) {
    lines.push(`- ${command.purpose}:`, `  ${command.command}`);
  }
  lines.push("", "Proof boundaries:", ...report.proofBoundaries.map((boundary) => `- ${boundary}`));
  return lines.join("\n");
}

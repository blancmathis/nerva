import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  doctorCodexPad,
  findTailscaleBinary,
  inspectFunnelStatus,
  normalizeTailscaleDnsName,
  runCommand,
  type CommandResult,
  type CommandRunner,
  type DoctorReport,
} from "./doctor.js";
import {
  rotatePairingCode,
  showPairingInfo,
  type PairingInfo,
} from "./pairing.js";
import { defaultDataPaths } from "./paths.js";
import {
  codexPadPaths,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  generateProtocolSchemas,
  setupCodexPad,
  type SetupResult,
} from "./setup.js";

export const LAUNCH_AGENT_LABEL = "com.codex-pad.bridge";
export const LAUNCH_AGENT_FILE = `${LAUNCH_AGENT_LABEL}.plist`;
const LEGACY_APP_SERVER_LAUNCH_AGENT_LABEL = "com.codex-pad.app-server";
const LEGACY_APP_SERVER_LAUNCH_AGENT_FILE = `${LEGACY_APP_SERVER_LAUNCH_AGENT_LABEL}.plist`;
const DEFAULT_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
const SERVE_HTTPS_PORT = 443;
const BRIDGE_TARGET = `http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;
export const MANAGED_LOG_ROTATION_BYTES = 512 * 1_024;
export const MANAGED_LOG_ARCHIVE_COUNT = 4;

type FetchLike = typeof globalThis.fetch;

export interface MacSetupDependencies {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly repositoryRoot?: string;
  readonly nodeExecutable?: string;
  readonly codexBinaryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly uid?: number;
  /** Filesystem owner expected for Nerva-owned user files. Kept separate from
   * the launchd GUI-domain uid so tests cannot weaken either boundary. */
  readonly filesystemUid?: number;
  readonly runCommand?: CommandRunner;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly nodeVersion?: string;
  readonly inspectDoctor?: (dependencies?: MacSetupDependencies) => Promise<DoctorReport>;
  readonly inspectPreflight?: (dependencies?: MacSetupDependencies) => Promise<MacSetupPreflight>;
  readonly waitForBridgeHealth?: (fetchImplementation: FetchLike) => Promise<boolean>;
}

export interface MacPairingResult {
  readonly publicOrigin: string;
  readonly pairing: PairingInfo;
  readonly tailscaleBinary: string;
  readonly launchAgentPath: string;
  readonly bridgeHealthy: boolean;
}

export interface MacSetupResult extends MacPairingResult {
  readonly setup: SetupResult;
  readonly installationState: "ready" | "limited" | "degraded";
  readonly serveChanged: boolean;
  readonly launchAgentChanged: boolean;
  readonly managedDaemonConfigured: boolean;
  readonly legacyAppServerLaunchAgentRemoved: boolean;
  readonly nativeIntegration: MacSetupNativeIntegration;
}

export type MacSetupIssueCode =
  | "unsupported-platform"
  | "unsupported-node"
  | "unsafe-installation-path"
  | "desktop-unavailable"
  | "standalone-unavailable"
  | "codex-version-mismatch"
  | "app-server-writers"
  | "managed-app-server-unavailable"
  | "desktop-ownership-unverified"
  | "cdp-unavailable"
  | "micro-adapter-unavailable"
  | "protocol-schema-unavailable"
  | "tailscale-unavailable"
  | "funnel-not-disabled"
  | "serve-route-conflict";

export interface MacSetupIssue {
  readonly code: MacSetupIssueCode;
  readonly detail: string;
  readonly remediation: readonly string[];
}

export interface MacSetupNativeIntegration {
  readonly state: "ready" | "limited" | "degraded";
  readonly desktopCodexVersion?: string;
  readonly standaloneCodexVersion?: string;
  readonly reasons: readonly MacSetupIssue[];
}

export interface MacSetupPreflight {
  readonly installationState: "ready" | "limited" | "degraded" | "blocked";
  readonly nativeIntegration: MacSetupNativeIntegration;
  readonly blockers: readonly MacSetupIssue[];
}

export interface MacUninstallTarget {
  readonly state: "absent" | "owned" | "blocked";
  readonly detail: string;
  readonly path?: string;
}

export interface MacUninstallInspection {
  readonly state: "ready" | "blocked";
  readonly launchAgent: MacUninstallTarget;
  readonly serve: MacUninstallTarget & {
    readonly binary?: string;
    readonly dnsName?: string;
  };
  readonly retainedDataRoot: string;
  readonly retainedRuntime: string;
}

export interface MacUninstallResult {
  readonly inspection: MacUninstallInspection;
  readonly state: "complete" | "partial";
  readonly launchAgentRemoved: boolean;
  readonly serveRemoved: boolean;
  readonly dataRetained: true;
  readonly logsRetained: true;
  readonly errors: readonly string[];
}

interface TailscaleIdentity {
  readonly binary: string;
  readonly dnsName: string;
  readonly publicOrigin: string;
}

interface ServeInspection {
  readonly state: "ready" | "available" | "conflict" | "ambiguous";
  readonly detail: string;
}

interface OwnedLaunchAgentTarget extends MacUninstallTarget {
  readonly state: "owned";
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface NonOwnedLaunchAgentTarget extends MacUninstallTarget {
  readonly state: "absent" | "blocked";
}

type LaunchAgentInspection = OwnedLaunchAgentTarget | NonOwnedLaunchAgentTarget;

interface ManagedLogFile {
  readonly path: string;
  readonly device?: number;
  readonly inode?: number;
}

interface ManagedLogRotation {
  readonly current: ManagedLogFile;
  readonly archives: readonly ManagedLogFile[];
  readonly filesystemUid: number;
}

interface ManagedServeReceipt {
  readonly version: 1;
  readonly dnsName: string;
  readonly httpsPort: typeof SERVE_HTTPS_PORT;
  readonly target: typeof BRIDGE_TARGET;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string, mode = fsConstants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchAgentXml(input: {
  readonly nodeExecutable: string;
  readonly cliPath: string;
  readonly workingDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}, options: { readonly includeUmask?: boolean } = {}): string {
  const value = (text: string): string => `<string>${xmlEscape(text)}</string>`;
  const umask = options.includeUmask === false
    ? ""
    : "  <key>Umask</key>\n  <integer>63</integer>\n";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${value(LAUNCH_AGENT_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${value(input.nodeExecutable)}
    ${value(input.cliPath)}
    ${value("start")}
  </array>
  <key>WorkingDirectory</key>
  ${value(input.workingDirectory)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
${umask}  <key>StandardOutPath</key>
  ${value(input.stdoutPath)}
  <key>StandardErrorPath</key>
  ${value(input.stderrPath)}
</dict>
</plist>
`;
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function parseOwnedLaunchAgent(
  contents: string,
  homeDirectory: string,
): {
  readonly nodeExecutable: string;
  readonly cliPath: string;
  readonly workingDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
} | undefined {
  const values = [...contents.matchAll(/<string>([\s\S]*?)<\/string>/gu)]
    .map((match) => xmlUnescape(match[1] ?? ""));
  if (values.length !== 8) return undefined;
  const [label, nodeExecutable, cliPath, start, workingDirectory, processType, stdoutPath, stderrPath] = values;
  if (
    label !== LAUNCH_AGENT_LABEL
    || start !== "start"
    || processType !== "Background"
    || !nodeExecutable
    || !cliPath
    || !workingDirectory
    || !isAbsolute(nodeExecutable)
    || !isAbsolute(workingDirectory)
    || resolve(workingDirectory) !== workingDirectory
    || cliPath !== join(workingDirectory, "apps", "bridge", "dist", "cli.js")
  ) {
    return undefined;
  }
  const runtime = codexPadPaths(homeDirectory).runtime;
  if (
    stdoutPath !== join(runtime, "bridge.stdout.log")
    || stderrPath !== join(runtime, "bridge.stderr.log")
  ) {
    return undefined;
  }
  const parsed = { nodeExecutable, cliPath, workingDirectory, stdoutPath, stderrPath };
  // Accept the immediately preceding Nerva-generated plist as owned so users
  // can safely uninstall without first reinstalling. New installs use Umask
  // 0077 so launchd-created logs are private.
  return contents === launchAgentXml(parsed)
    || contents === launchAgentXml(parsed, { includeUmask: false })
    ? parsed
    : undefined;
}

async function atomicWritePrivate(path: string, contents: string): Promise<boolean> {
  const parent = dirname(path);
  if (!(await exists(parent))) await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe LaunchAgent directory: ${parent}`);
  }
  if (await exists(path)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace unsafe LaunchAgent path: ${path}`);
    }
    const current = await readFile(path, "utf8");
    if (current === contents) {
      await chmod(path, 0o600);
      return false;
    }
  }
  const temporary = join(parent, `.${path.split("/").at(-1) ?? "codex-pad"}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}

async function tailscaleIdentity(
  environment: NodeJS.ProcessEnv,
  command: CommandRunner,
): Promise<TailscaleIdentity> {
  const binary = await findTailscaleBinary(environment);
  if (binary === undefined) {
    throw new Error("Tailscale is not installed. Install it on the Mac and iPad, sign in to the same tailnet, then rerun `npm run setup:mac`.");
  }
  const status = await command(binary, ["status", "--json"], 10_000);
  if (status.exitCode !== 0) {
    throw new Error(`Tailscale status is unavailable: ${status.stderr.trim() || "command failed"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    throw new Error("Tailscale status returned unreadable JSON.");
  }
  if (!isRecord(parsed)) throw new Error("Tailscale status returned an unsupported shape.");
  const self = isRecord(parsed.Self) ? parsed.Self : undefined;
  const online = parsed.BackendState === "Running" && self?.Online === true;
  const dnsName = normalizeTailscaleDnsName(typeof self?.DNSName === "string" ? self.DNSName : undefined);
  if (!online || dnsName === undefined) {
    throw new Error("Tailscale is not fully online or has no valid MagicDNS name. Complete login, then rerun the same command.");
  }
  return { binary, dnsName, publicOrigin: `https://${dnsName}` };
}

function inspectServeStatus(result: CommandResult, dnsName: string): ServeInspection {
  if (result.exitCode !== 0) {
    return { state: "ambiguous", detail: "`tailscale serve status --json` did not complete successfully." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { state: "ambiguous", detail: "Tailscale Serve status JSON is unreadable." };
  }
  if (parsed === null) return { state: "available", detail: "No Serve route is configured." };
  if (!isRecord(parsed)) return { state: "ambiguous", detail: "Tailscale Serve status has an unsupported shape." };

  const web = parsed.Web;
  if (web !== undefined && !isRecord(web)) {
    return { state: "ambiguous", detail: "Tailscale Serve Web configuration has an unsupported shape." };
  }
  const routeKey = `${dnsName}:${SERVE_HTTPS_PORT}`;
  const route = isRecord(web) ? web[routeKey] : undefined;
  const tcp = parsed.TCP;
  if (tcp !== undefined && !isRecord(tcp)) {
    return { state: "ambiguous", detail: "Tailscale Serve TCP configuration has an unsupported shape." };
  }
  if (route !== undefined) {
    if (!isRecord(route) || !isRecord(route.Handlers)) {
      return { state: "ambiguous", detail: "The existing HTTPS route cannot be inspected safely." };
    }
    const handlerEntries = Object.entries(route.Handlers);
    const root = route.Handlers["/"];
    const httpsListener = isRecord(tcp) ? tcp[String(SERVE_HTTPS_PORT)] : undefined;
    if (
      handlerEntries.length === 1
      && isRecord(root)
      && root.Proxy === BRIDGE_TARGET
      && isRecord(httpsListener)
      && httpsListener.HTTPS === true
      && Object.keys(httpsListener).length === 1
    ) {
      return { state: "ready", detail: "The exact Codex Pad Serve route is already configured." };
    }
    return {
      state: "conflict",
      detail: `HTTPS ${routeKey} is already used by another route or path. Codex Pad will not overwrite it.`,
    };
  }

  if (isRecord(tcp) && (tcp[String(SERVE_HTTPS_PORT)] !== undefined || tcp[routeKey] !== undefined)) {
    return { state: "conflict", detail: `TCP/HTTPS port ${SERVE_HTTPS_PORT} is already configured.` };
  }
  if (parsed.Foreground !== undefined && isRecord(parsed.Foreground) && Object.keys(parsed.Foreground).length > 0) {
    return { state: "ambiguous", detail: "Foreground Serve configuration exists and must be reviewed manually." };
  }
  return { state: "available", detail: "The Codex Pad HTTPS route is available." };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function unrelatedServeSnapshot(result: CommandResult, dnsName: string): string {
  if (result.exitCode !== 0) {
    throw new Error("Tailscale Serve state could not be snapshotted safely.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Tailscale Serve state returned unreadable JSON while uninstalling.");
  }
  if (parsed === null) return "{}";
  if (!isRecord(parsed)) throw new Error("Tailscale Serve state has an unsupported shape while uninstalling.");
  const remaining: Record<string, unknown> = { ...parsed };
  if (isRecord(parsed.Web)) {
    const web = { ...parsed.Web };
    delete web[`${dnsName}:${SERVE_HTTPS_PORT}`];
    if (Object.keys(web).length === 0) delete remaining.Web;
    else remaining.Web = web;
  }
  if (isRecord(parsed.TCP)) {
    const tcp = { ...parsed.TCP };
    const httpsListener = tcp[String(SERVE_HTTPS_PORT)];
    if (
      isRecord(httpsListener)
      && httpsListener.HTTPS === true
      && Object.keys(httpsListener).length === 1
    ) {
      delete tcp[String(SERVE_HTTPS_PORT)];
    }
    if (Object.keys(tcp).length === 0) delete remaining.TCP;
    else remaining.TCP = tcp;
  }
  return JSON.stringify(stableJsonValue(remaining));
}

async function readUnrelatedServeSnapshot(
  binary: string,
  dnsName: string,
  command: CommandRunner,
): Promise<string> {
  return unrelatedServeSnapshot(
    await command(binary, ["serve", "status", "--json"], 10_000),
    dnsName,
  );
}

async function ensurePrivateServe(
  identity: TailscaleIdentity,
  command: CommandRunner,
): Promise<boolean> {
  const targetRoute = `${identity.dnsName}:${SERVE_HTTPS_PORT}`;
  const funnel = inspectFunnelStatus(
    await command(identity.binary, ["funnel", "status", "--json"], 10_000),
    targetRoute,
  );
  if (funnel.state !== "disabled") {
    throw new Error(`Codex Pad will not continue because Funnel is not proven disabled for ${targetRoute}: ${funnel.detail}`);
  }

  const before = inspectServeStatus(
    await command(identity.binary, ["serve", "status", "--json"], 10_000),
    identity.dnsName,
  );
  if (before.state === "conflict" || before.state === "ambiguous") {
    throw new Error(before.detail);
  }
  if (before.state === "ready") return false;

  const configured = await command(
    identity.binary,
    ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, BRIDGE_TARGET],
    60_000,
  );
  if (configured.exitCode !== 0) {
    throw new Error(`Tailscale Serve setup failed: ${configured.stderr.trim() || configured.stdout.trim() || "command failed"}`);
  }
  const after = inspectServeStatus(
    await command(identity.binary, ["serve", "status", "--json"], 10_000),
    identity.dnsName,
  );
  if (after.state !== "ready") {
    const rollback = await command(
      identity.binary,
      ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, BRIDGE_TARGET, "off"],
      60_000,
    );
    throw new Error(
      `Tailscale Serve did not report the exact Codex Pad route after setup: ${after.detail} ${rollback.exitCode === 0 ? "The new route was rolled back." : `Rollback failed: ${rollback.stderr.trim() || rollback.stdout.trim() || "command failed"}`}`,
    );
  }
  const funnelAfter = inspectFunnelStatus(
    await command(identity.binary, ["funnel", "status", "--json"], 10_000),
    targetRoute,
  );
  if (funnelAfter.state !== "disabled") {
    const rollback = await command(
      identity.binary,
      ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, BRIDGE_TARGET, "off"],
      60_000,
    );
    throw new Error(
      `Funnel became ambiguous or enabled after Serve setup: ${funnelAfter.detail} ${rollback.exitCode === 0 ? "The new route was rolled back." : `Rollback failed: ${rollback.stderr.trim() || rollback.stdout.trim() || "command failed"}`}`,
    );
  }
  return true;
}

function launchAgentPath(homeDirectory: string): string {
  return join(homeDirectory, "Library", "LaunchAgents", LAUNCH_AGENT_FILE);
}

function legacyAppServerLaunchAgentPath(homeDirectory: string): string {
  return join(homeDirectory, "Library", "LaunchAgents", LEGACY_APP_SERVER_LAUNCH_AGENT_FILE);
}

function managedServeReceiptPath(homeDirectory: string): string {
  return join(codexPadPaths(homeDirectory).security, "tailscale-serve-ownership.json");
}

function parseManagedServeReceipt(value: unknown, dnsName: string): ManagedServeReceipt | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 5) return undefined;
  if (
    value.version !== 1
    || value.dnsName !== dnsName
    || value.httpsPort !== SERVE_HTTPS_PORT
    || value.target !== BRIDGE_TARGET
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return undefined;
  }
  return value as unknown as ManagedServeReceipt;
}

async function inspectManagedServeReceipt(
  homeDirectory: string,
  filesystemUid: number,
  dnsName: string,
): Promise<"owned" | "absent" | "blocked"> {
  const path = managedServeReceiptPath(homeDirectory);
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined) return "absent";
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== filesystemUid
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
  ) {
    return "blocked";
  }
  try {
    return parseManagedServeReceipt(JSON.parse(await readFile(path, "utf8")), dnsName) === undefined
      ? "blocked"
      : "owned";
  } catch {
    return "blocked";
  }
}

async function recordManagedServeOwnership(
  homeDirectory: string,
  filesystemUid: number,
  identity: TailscaleIdentity,
  now: () => Date,
): Promise<void> {
  const security = codexPadPaths(homeDirectory).security;
  const metadata = await lstatIfPresent(security);
  if (
    metadata === undefined
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== filesystemUid
  ) {
    throw new Error(`Refusing unsafe Nerva security directory for Serve ownership: ${security}`);
  }
  const receipt: ManagedServeReceipt = {
    version: 1,
    dnsName: identity.dnsName,
    httpsPort: SERVE_HTTPS_PORT,
    target: BRIDGE_TARGET,
    createdAt: now().toISOString(),
  };
  const path = managedServeReceiptPath(homeDirectory);
  const existing = await lstatIfPresent(path);
  if (
    existing !== undefined
    && (
      !existing.isFile()
      || existing.isSymbolicLink()
      || existing.uid !== filesystemUid
      || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o600
    )
  ) {
    throw new Error(`Refusing unsafe existing Serve ownership receipt: ${path}`);
  }
  await atomicWritePrivate(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function validateManagedLogPath(path: string, uid: number): Promise<Stats | undefined> {
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined) return undefined;
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== uid
  ) {
    throw new Error(`Refusing unsafe managed bridge log path: ${path}`);
  }
  return metadata;
}

async function prepareManagedLogRotations(
  homeDirectory: string,
  uid: number,
): Promise<readonly ManagedLogRotation[]> {
  const runtime = codexPadPaths(homeDirectory).runtime;
  const runtimeMetadata = await lstatIfPresent(runtime);
  if (runtimeMetadata === undefined) return [];
  if (
    !runtimeMetadata.isDirectory()
    || runtimeMetadata.isSymbolicLink()
    || runtimeMetadata.uid !== uid
  ) {
    throw new Error(`Refusing unsafe managed bridge runtime directory: ${runtime}`);
  }
  const candidates: Array<ManagedLogRotation & { readonly size: number }> = [];
  for (const name of ["bridge.stdout.log", "bridge.stderr.log"] as const) {
    const current = join(runtime, name);
    const currentMetadata = await validateManagedLogPath(current, uid);
    const archives = Array.from(
      { length: MANAGED_LOG_ARCHIVE_COUNT },
      (_value, index) => `${current}.${index + 1}`,
    );
    const archivePlans: ManagedLogFile[] = [];
    for (const archive of archives) {
      const metadata = await validateManagedLogPath(archive, uid);
      archivePlans.push(metadata === undefined
        ? { path: archive }
        : { path: archive, device: metadata.dev, inode: metadata.ino });
    }
    if (currentMetadata !== undefined) {
      candidates.push({
        current: { path: current, device: currentMetadata.dev, inode: currentMetadata.ino },
        archives: archivePlans,
        filesystemUid: uid,
        size: currentMetadata.size,
      });
    }
  }
  // Rotate stdout and stderr as one evidence generation. This keeps the two
  // timelines aligned when either stream reaches the bound.
  return candidates.some((candidate) => candidate.size >= MANAGED_LOG_ROTATION_BYTES)
    ? candidates.map(({ current, archives, filesystemUid }) => ({ current, archives, filesystemUid }))
    : [];
}

async function revalidateManagedLogFile(target: ManagedLogFile, filesystemUid: number): Promise<void> {
  const metadata = await validateManagedLogPath(target.path, filesystemUid);
  if (target.device === undefined || target.inode === undefined) {
    if (metadata !== undefined) throw new Error(`Managed bridge log path appeared during rotation: ${target.path}`);
    return;
  }
  if (metadata === undefined || metadata.dev !== target.device || metadata.ino !== target.inode) {
    throw new Error(`Managed bridge log path changed before rotation: ${target.path}`);
  }
}

async function executeManagedLogRotations(
  rotations: readonly ManagedLogRotation[],
): Promise<void> {
  for (const rotation of rotations) {
    await revalidateManagedLogFile(rotation.current, rotation.filesystemUid);
    for (const archive of rotation.archives) {
      await revalidateManagedLogFile(archive, rotation.filesystemUid);
    }
  }
  const nonce = `${process.pid}-${Date.now()}`;
  const staged: Array<{
    readonly source: ManagedLogFile;
    readonly temporary: string;
    readonly destination?: string;
  }> = [];
  for (const [rotationIndex, rotation] of rotations.entries()) {
    const sources = [rotation.current, ...rotation.archives];
    for (const [sourceIndex, source] of sources.entries()) {
      if (source.device === undefined) continue;
      const destination = sourceIndex < rotation.archives.length
        ? rotation.archives[sourceIndex]?.path
        : undefined;
      const temporary = `${rotation.current.path}.rotate-${nonce}-${rotationIndex}-${sourceIndex}`;
      if (await lstatIfPresent(temporary)) {
        throw new Error(`Managed bridge log staging path already exists: ${temporary}`);
      }
      staged.push({
        source,
        temporary,
        ...(destination === undefined ? {} : { destination }),
      });
    }
  }

  const moved: typeof staged = [];
  try {
    for (const entry of staged) {
      await rename(entry.source.path, entry.temporary);
      const metadata = await lstatIfPresent(entry.temporary);
      if (
        metadata === undefined
        || metadata.dev !== entry.source.device
        || metadata.ino !== entry.source.inode
      ) {
        throw new Error(`Managed bridge log identity changed while staging: ${entry.source.path}`);
      }
      await chmod(entry.temporary, 0o600);
      moved.push(entry);
    }
  } catch (error) {
    for (const entry of moved.toReversed()) {
      if (await lstatIfPresent(entry.source.path)) continue;
      await rename(entry.temporary, entry.source.path).catch(() => undefined);
    }
    throw error;
  }

  // Publish each retained generation with a hard link, which fails rather than
  // overwriting a path that appeared after validation. Keep every staged inode
  // until the whole two-stream generation is published successfully.
  for (const entry of staged) {
    if (entry.destination !== undefined) await link(entry.temporary, entry.destination);
  }
  for (const entry of staged) await rm(entry.temporary);
}

async function inspectLaunchAgentForUninstall(
  homeDirectory: string,
  filesystemUid: number,
): Promise<LaunchAgentInspection> {
  const path = launchAgentPath(homeDirectory);
  const parent = dirname(path);
  const parentMetadata = await lstatIfPresent(parent);
  if (parentMetadata === undefined) {
    return { state: "absent", path, detail: "The Nerva LaunchAgent directory does not exist." };
  }
  if (
    !parentMetadata.isDirectory()
    || parentMetadata.isSymbolicLink()
    || parentMetadata.uid !== filesystemUid
  ) {
    return { state: "blocked", path, detail: `Refusing unsafe LaunchAgent directory: ${parent}` };
  }
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined) {
    return { state: "absent", path, detail: "The Nerva LaunchAgent is not installed." };
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== filesystemUid
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
  ) {
    return { state: "blocked", path, detail: `Refusing unsafe Nerva LaunchAgent path: ${path}` };
  }
  const contents = await readFile(path, "utf8");
  if (parseOwnedLaunchAgent(contents, homeDirectory) === undefined) {
    return { state: "blocked", path, detail: `Refusing to remove an unrecognized LaunchAgent: ${path}` };
  }
  return {
    state: "owned",
    path,
    detail: "The exact Nerva LaunchAgent is installed and can be removed.",
    device: metadata.dev,
    inode: metadata.ino,
  };
}

async function tailscaleIdentityForUninstall(
  environment: NodeJS.ProcessEnv,
  command: CommandRunner,
): Promise<TailscaleIdentity> {
  const binary = await findTailscaleBinary(environment);
  if (binary === undefined) throw new Error("Tailscale is not installed, so its exact Serve state cannot be inspected.");
  const status = await command(binary, ["status", "--json"], 10_000);
  if (status.exitCode !== 0) {
    throw new Error(`Tailscale status is unavailable: ${status.stderr.trim() || "command failed"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    throw new Error("Tailscale status returned unreadable JSON.");
  }
  if (!isRecord(parsed)) throw new Error("Tailscale status returned an unsupported shape.");
  const self = isRecord(parsed.Self) ? parsed.Self : undefined;
  const dnsName = normalizeTailscaleDnsName(typeof self?.DNSName === "string" ? self.DNSName : undefined);
  if (dnsName === undefined) {
    throw new Error("Tailscale did not report the Mac's exact MagicDNS name, so Nerva will not change Serve.");
  }
  return { binary, dnsName, publicOrigin: `https://${dnsName}` };
}

async function inspectServeForUninstall(
  environment: NodeJS.ProcessEnv,
  command: CommandRunner,
): Promise<MacUninstallInspection["serve"]> {
  let identity: TailscaleIdentity;
  try {
    identity = await tailscaleIdentityForUninstall(environment, command);
  } catch (error) {
    return {
      state: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const targetRoute = `${identity.dnsName}:${SERVE_HTTPS_PORT}`;
  const funnel = inspectFunnelStatus(
    await command(identity.binary, ["funnel", "status", "--json"], 10_000),
    targetRoute,
  );
  if (funnel.state !== "disabled") {
    return {
      state: "blocked",
      binary: identity.binary,
      dnsName: identity.dnsName,
      path: identity.publicOrigin,
      detail: `Funnel is not proven disabled for ${targetRoute}: ${funnel.detail}`,
    };
  }
  const serve = inspectServeStatus(
    await command(identity.binary, ["serve", "status", "--json"], 10_000),
    identity.dnsName,
  );
  if (serve.state === "ready") {
    return {
      state: "owned",
      binary: identity.binary,
      dnsName: identity.dnsName,
      path: identity.publicOrigin,
      detail: "The exact Nerva root Serve route is configured and can be removed.",
    };
  }
  if (serve.state === "available") {
    return {
      state: "absent",
      binary: identity.binary,
      dnsName: identity.dnsName,
      path: identity.publicOrigin,
      detail: "The exact Nerva Serve route is not configured.",
    };
  }
  return {
    state: "blocked",
    binary: identity.binary,
    dnsName: identity.dnsName,
    path: identity.publicOrigin,
    detail: serve.detail,
  };
}

export async function inspectMacUninstall(
  dependencies: MacSetupDependencies = {},
): Promise<MacUninstallInspection> {
  const input = normalizedDependencies(dependencies);
  const paths = codexPadPaths(input.homeDirectory);
  if (input.platform !== "darwin") {
    const detail = "Nerva's managed background bridge can be uninstalled only on macOS.";
    return {
      state: "blocked",
      launchAgent: { state: "blocked", path: launchAgentPath(input.homeDirectory), detail },
      serve: { state: "blocked", detail },
      retainedDataRoot: paths.root,
      retainedRuntime: paths.runtime,
    };
  }
  const [launchAgentInternal, inspectedServe] = await Promise.all([
    inspectLaunchAgentForUninstall(input.homeDirectory, input.filesystemUid),
    inspectServeForUninstall(input.environment, input.command),
  ]);
  const launchAgent: MacUninstallTarget = {
    state: launchAgentInternal.state,
    detail: launchAgentInternal.detail,
    ...(launchAgentInternal.path ? { path: launchAgentInternal.path } : {}),
  };
  let serve = inspectedServe;
  if (inspectedServe.state === "owned") {
    const receipt = inspectedServe.dnsName === undefined
      ? "blocked"
      : await inspectManagedServeReceipt(
        input.homeDirectory,
        input.filesystemUid,
        inspectedServe.dnsName,
      );
    if (launchAgentInternal.state !== "owned" || receipt !== "owned") {
      serve = {
        ...inspectedServe,
        state: "blocked" as const,
        detail: receipt === "absent"
          ? "The route matches Nerva but predates verifiable Serve ownership. It was retained."
          : "The route matches Nerva, but its ownership receipt or exact LaunchAgent is unsafe. It was retained.",
      };
    }
  }
  return {
    state: launchAgent.state === "blocked" || serve.state === "blocked" ? "blocked" : "ready",
    launchAgent,
    serve,
    retainedDataRoot: paths.root,
    retainedRuntime: paths.runtime,
  };
}

function launchAgentWasNotLoaded(result: CommandResult): boolean {
  return /(?:could not find service|no such process|not loaded)/iu.test(`${result.stderr}\n${result.stdout}`);
}

async function removeExactServeRoute(
  homeDirectory: string,
  filesystemUid: number,
  environment: NodeJS.ProcessEnv,
  command: CommandRunner,
): Promise<boolean> {
  const before = await inspectServeForUninstall(environment, command);
  if (before.state === "absent") return false;
  if (before.state !== "owned" || !before.binary || !before.dnsName) {
    throw new Error(`Nerva Serve removal is blocked: ${before.detail}`);
  }
  const launchAgent = await inspectLaunchAgentForUninstall(homeDirectory, filesystemUid);
  if (launchAgent.state !== "owned") {
    throw new Error("Nerva Serve removal is blocked because the exact owned LaunchAgent is not present.");
  }
  if (await inspectManagedServeReceipt(homeDirectory, filesystemUid, before.dnsName) !== "owned") {
    throw new Error("Nerva Serve removal is blocked because its private ownership receipt is absent or unsafe.");
  }
  const unrelatedBefore = await readUnrelatedServeSnapshot(before.binary, before.dnsName, command);
  const removed = await command(
    before.binary,
    ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, BRIDGE_TARGET, "off"],
    60_000,
  );
  if (removed.exitCode !== 0) {
    throw new Error(`Could not remove the exact Nerva Serve route: ${removed.stderr.trim() || removed.stdout.trim() || "command failed"}`);
  }
  const unrelatedAfter = await readUnrelatedServeSnapshot(before.binary, before.dnsName, command);
  if (unrelatedAfter !== unrelatedBefore) {
    throw new Error("An unrelated Tailscale Serve route changed during Nerva removal. No further uninstall actions were attempted; review Serve status manually.");
  }
  const after = await inspectServeForUninstall(environment, command);
  if (after.state !== "absent") {
    throw new Error(`Tailscale did not confirm removal of the exact Nerva Serve route: ${after.detail}`);
  }
  await rm(managedServeReceiptPath(homeDirectory));
  return true;
}

async function removeExactLaunchAgent(
  homeDirectory: string,
  uid: number,
  filesystemUid: number,
  command: CommandRunner,
): Promise<boolean> {
  const before = await inspectLaunchAgentForUninstall(homeDirectory, filesystemUid);
  if (before.state === "absent") return false;
  if (before.state !== "owned") throw new Error(`Nerva LaunchAgent removal is blocked: ${before.detail}`);
  const domain = `gui/${uid}`;
  const bootout = await command("/bin/launchctl", ["bootout", domain, before.path], 10_000);
  if (bootout.exitCode !== 0 && !launchAgentWasNotLoaded(bootout)) {
    throw new Error(`Could not stop the exact Nerva LaunchAgent: ${bootout.stderr.trim() || bootout.stdout.trim() || "command failed"}`);
  }
  const revalidated = await inspectLaunchAgentForUninstall(homeDirectory, filesystemUid);
  if (
    revalidated.state !== "owned"
    || revalidated.device !== before.device
    || revalidated.inode !== before.inode
  ) {
    throw new Error("The Nerva LaunchAgent changed while uninstalling; the file was retained for manual inspection.");
  }
  const quarantine = `${before.path}.uninstall-${process.pid}-${Date.now()}`;
  if (await lstatIfPresent(quarantine)) {
    throw new Error(`The Nerva LaunchAgent quarantine path already exists; the plist was retained: ${quarantine}`);
  }
  await rename(before.path, quarantine);
  const quarantined = await lstatIfPresent(quarantine);
  if (
    quarantined === undefined
    || quarantined.dev !== before.device
    || quarantined.ino !== before.inode
  ) {
    if (!(await lstatIfPresent(before.path))) {
      await rename(quarantine, before.path).catch(() => undefined);
    }
    throw new Error("The Nerva LaunchAgent changed during quarantine; no plist was deleted.");
  }
  await rm(quarantine);
  return true;
}

export async function uninstallMac(
  dependencies: MacSetupDependencies = {},
): Promise<MacUninstallResult> {
  const input = normalizedDependencies(dependencies);
  if (input.platform !== "darwin") throw new Error("`uninstall:mac` is supported only on macOS.");
  const inspection = await inspectMacUninstall(dependencies);
  if (inspection.state === "blocked") {
    const details = [inspection.launchAgent, inspection.serve]
      .filter((target) => target.state === "blocked")
      .map((target) => target.detail)
      .join(" ");
    throw new Error(`Mac uninstall is blocked: ${details}`);
  }
  let serveRemoved = false;
  try {
    serveRemoved = await removeExactServeRoute(
      input.homeDirectory,
      input.filesystemUid,
      input.environment,
      input.command,
    );
  } catch (error) {
    const after = await inspectServeForUninstall(input.environment, input.command).catch(() => undefined);
    return {
      inspection,
      state: "partial",
      launchAgentRemoved: false,
      serveRemoved: after?.state === "absent",
      dataRetained: true,
      logsRetained: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  let launchAgentRemoved = false;
  try {
    launchAgentRemoved = await removeExactLaunchAgent(
      input.homeDirectory,
      input.uid,
      input.filesystemUid,
      input.command,
    );
  } catch (error) {
    return {
      inspection,
      state: "partial",
      launchAgentRemoved: false,
      serveRemoved,
      dataRetained: true,
      logsRetained: true,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  return {
    inspection,
    state: "complete",
    launchAgentRemoved,
    serveRemoved,
    dataRetained: true,
    logsRetained: true,
    errors: [],
  };
}

async function validateCodexBinary(path: string): Promise<void> {
  if (!(await exists(path, fsConstants.X_OK))) {
    throw new Error(`Desktop-bundled Codex is missing or not executable at ${path}.`);
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Codex binary path: ${path}`);
  }
}

async function removeLegacyAppServerLaunchAgent(input: {
  readonly homeDirectory: string;
  readonly codexBinaryPath: string;
  readonly uid: number;
  readonly command: CommandRunner;
}): Promise<boolean> {
  const path = legacyAppServerLaunchAgentPath(input.homeDirectory);
  const domain = `gui/${input.uid}`;
  const service = `${domain}/${LEGACY_APP_SERVER_LAUNCH_AGENT_LABEL}`;
  await input.command("/bin/launchctl", ["bootout", service], 10_000);
  if (!(await exists(path))) return false;
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing to remove unsafe legacy app-server LaunchAgent path: ${path}`);
  }
  const contents = await readFile(path, "utf8");
  const expectedSocket = join(input.homeDirectory, ".codex", "app-server-control", "app-server-control.sock");
  if (
    !contents.includes(`<string>${LEGACY_APP_SERVER_LAUNCH_AGENT_LABEL}</string>`)
    || !contents.includes(`<string>${xmlEscape(input.codexBinaryPath)}</string>`)
    || !contents.includes("<string>--listen</string>")
    || !contents.includes(`<string>unix://${xmlEscape(expectedSocket)}</string>`)
  ) {
    throw new Error(`Refusing to remove an unrecognized app-server LaunchAgent: ${path}`);
  }
  await rm(path);
  return true;
}

async function configureManagedDaemon(input: {
  readonly codexBinaryPath: string;
  readonly command: CommandRunner;
}): Promise<void> {
  const current = await input.command(
    input.codexBinaryPath,
    ["app-server", "daemon", "version"],
    10_000,
  );
  if (current.exitCode === 0) {
    try {
      const parsed = JSON.parse(current.stdout) as unknown;
      if (isRecord(parsed) && parsed.status === "running") return;
    } catch {
      // A malformed response is not accepted; bootstrap performs the explicit repair.
    }
  }
  const bootstrap = await input.command(
    input.codexBinaryPath,
    ["app-server", "daemon", "bootstrap", "--remote-control"],
    30_000,
  );
  if (bootstrap.exitCode !== 0) {
    throw new Error(`Managed app-server bootstrap failed: ${bootstrap.stderr.trim() || bootstrap.stdout.trim() || "command failed"}`);
  }
  const version = await input.command(
    input.codexBinaryPath,
    ["app-server", "daemon", "version"],
    10_000,
  );
  if (version.exitCode !== 0) {
    throw new Error(`Managed app-server verification failed: ${version.stderr.trim() || version.stdout.trim() || "command failed"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(version.stdout);
  } catch {
    throw new Error("Managed app-server verification returned unreadable JSON.");
  }
  if (!isRecord(parsed) || parsed.status !== "running") {
    throw new Error("Managed app-server verification did not report a running daemon.");
  }
}

async function validateLaunchAgentDestination(homeDirectory: string, repositoryRoot: string): Promise<void> {
  const cliPath = join(resolve(repositoryRoot), "apps", "bridge", "dist", "cli.js");
  if (!(await exists(cliPath, fsConstants.R_OK))) {
    throw new Error(`Built bridge CLI is missing at ${cliPath}. Run the setup from the repository root.`);
  }
  const cliMetadata = await lstat(cliPath);
  if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe built bridge CLI path: ${cliPath}`);
  }
  const parent = dirname(launchAgentPath(homeDirectory));
  if (await exists(parent)) {
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new Error(`Refusing unsafe LaunchAgent directory: ${parent}`);
    }
  }
}

/**
 * launchd can acknowledge bootout before the prior service generation is fully
 * detached. Retry only its documented transient I/O result; permission and
 * malformed-plist failures remain immediate and unchanged.
 */
async function bootstrapLaunchAgent(
  command: CommandRunner,
  domain: string,
  path: string,
): Promise<CommandResult> {
  const maximumAttempts = 20;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = await command("/bin/launchctl", ["bootstrap", domain, path], 10_000);
    if (result.exitCode === 0) return result;
    const transient = result.exitCode === 5 || /input\/output error/iu.test(`${result.stderr}\n${result.stdout}`);
    if (!transient || attempt === maximumAttempts) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Unreachable launchd bootstrap retry state.");
}

async function waitForManagedLogDetachment(
  command: CommandRunner,
  rotations: readonly ManagedLogRotation[],
): Promise<void> {
  if (rotations.length === 0) return;
  const paths = rotations.map((rotation) => rotation.current.path);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await command("/usr/sbin/lsof", ["-Fn", "--", ...paths], 10_000);
    if (result.exitCode === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return;
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`Could not verify managed bridge log detachment: ${result.stderr.trim() || result.stdout.trim() || "lsof failed"}`);
    }
    if (result.exitCode === 0 && result.stdout.trim() === "") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The previous Nerva bridge process still has a managed log open; log rotation was cancelled without deleting evidence.");
}

async function installLaunchAgent(input: {
  readonly homeDirectory: string;
  readonly repositoryRoot: string;
  readonly nodeExecutable: string;
  readonly uid: number;
  readonly filesystemUid: number;
  readonly command: CommandRunner;
}): Promise<{ readonly path: string; readonly changed: boolean }> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const cliPath = join(repositoryRoot, "apps", "bridge", "dist", "cli.js");
  await validateLaunchAgentDestination(input.homeDirectory, repositoryRoot);
  const runtime = codexPadPaths(input.homeDirectory).runtime;
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  const logRotations = await prepareManagedLogRotations(input.homeDirectory, input.filesystemUid);
  const path = launchAgentPath(input.homeDirectory);
  const contents = launchAgentXml({
    nodeExecutable: input.nodeExecutable,
    cliPath,
    workingDirectory: repositoryRoot,
    stdoutPath: join(runtime, "bridge.stdout.log"),
    stderrPath: join(runtime, "bridge.stderr.log"),
  });
  const domain = `gui/${input.uid}`;
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const changed = await atomicWritePrivate(path, contents);
  const bootout = await input.command("/bin/launchctl", ["bootout", service], 10_000);
  if (bootout.exitCode !== 0 && !launchAgentWasNotLoaded(bootout)) {
    throw new Error(`Could not stop the exact Nerva LaunchAgent before log rotation: ${bootout.stderr.trim() || bootout.stdout.trim() || "command failed"}`);
  }
  try {
    await waitForManagedLogDetachment(input.command, logRotations);
    await executeManagedLogRotations(logRotations);
  } catch (error) {
    // Restore the already-installed service when rotation encounters an
    // unexpected filesystem race. The current log was never truncated: it is
    // either still at its original path or retained as the first archive.
    const recovery = await bootstrapLaunchAgent(input.command, domain, path);
    if (recovery.exitCode !== 0) {
      throw new Error(
        `Managed log rotation failed and the exact Nerva LaunchAgent could not be restored: ${recovery.stderr.trim() || recovery.stdout.trim() || "command failed"}`,
        { cause: error },
      );
    }
    throw error;
  }
  const bootstrap = await bootstrapLaunchAgent(input.command, domain, path);
  if (bootstrap.exitCode !== 0) {
    throw new Error(`LaunchAgent bootstrap failed: ${bootstrap.stderr.trim() || bootstrap.stdout.trim() || "command failed"}`);
  }
  return { path, changed };
}

async function validateInstalledLaunchAgent(homeDirectory: string): Promise<string> {
  const path = launchAgentPath(homeDirectory);
  if (!(await exists(path, fsConstants.R_OK))) {
    throw new Error("Codex Pad is not installed as a background bridge. Run `npm run setup:mac` first.");
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe LaunchAgent path: ${path}`);
  }
  return path;
}

async function restartInstalledLaunchAgent(input: {
  readonly path: string;
  readonly uid: number;
  readonly command: CommandRunner;
}): Promise<string> {
  const service = `gui/${input.uid}/${LAUNCH_AGENT_LABEL}`;
  const result = await input.command("/bin/launchctl", ["kickstart", "-k", service], 10_000);
  if (result.exitCode !== 0) {
    throw new Error(`Could not restart the Codex Pad bridge: ${result.stderr.trim() || result.stdout.trim() || "command failed"}`);
  }
  return input.path;
}

async function bridgeHealthy(fetchImplementation: FetchLike, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImplementation(`http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}/api/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json() as { ok?: unknown; data?: { version?: unknown } };
        if (body.ok === true && typeof body.data?.version === "string") return true;
      }
    } catch {
      // launchd and the bridge may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function normalizedDependencies(dependencies: MacSetupDependencies): {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly repositoryRoot: string;
  readonly nodeExecutable: string;
  readonly codexBinaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly uid: number;
  readonly filesystemUid: number;
  readonly command: CommandRunner;
  readonly fetchImplementation: FetchLike;
  readonly now: () => Date;
  readonly nodeVersion: string;
} {
  return {
    platform: dependencies.platform ?? process.platform,
    homeDirectory: dependencies.homeDirectory ?? homedir(),
    repositoryRoot: dependencies.repositoryRoot ?? process.cwd(),
    nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
    codexBinaryPath: dependencies.codexBinaryPath
      ?? dependencies.environment?.CODEX_PAD_CODEX_BINARY
      ?? DEFAULT_CODEX_BINARY,
    environment: dependencies.environment ?? process.env,
    uid: dependencies.uid ?? process.getuid?.() ?? 0,
    filesystemUid: dependencies.filesystemUid ?? process.getuid?.() ?? 0,
    command: dependencies.runCommand ?? runCommand,
    fetchImplementation: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? (() => new Date()),
    nodeVersion: dependencies.nodeVersion ?? process.versions.node,
  };
}

function assertMac(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error("`setup:mac` and `pair` are supported only on macOS.");
  }
}

function normalizedCodexVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^codex-cli\s+/u, "");
  return normalized ? normalized : undefined;
}

function setupIssue(
  code: MacSetupIssueCode,
  detail: string,
  remediation: readonly string[],
): MacSetupIssue {
  return { code, detail, remediation };
}

function issueFromDoctorCheck(
  report: Awaited<ReturnType<typeof doctorCodexPad>>,
  id: string,
  code: MacSetupIssueCode,
): MacSetupIssue | undefined {
  const check = report.checks.find((candidate) => candidate.id === id);
  if (check === undefined || check.status === "green") return undefined;
  return setupIssue(code, check.summary, check.remediation ?? []);
}

function uniqueIssues(issues: readonly MacSetupIssue[]): readonly MacSetupIssue[] {
  const seen = new Set<MacSetupIssueCode>();
  return issues.filter((issue) => {
    if (seen.has(issue.code)) return false;
    seen.add(issue.code);
    return true;
  });
}

export async function preflightMacSetup(
  dependencies: MacSetupDependencies = {},
): Promise<MacSetupPreflight> {
  const input = normalizedDependencies(dependencies);
  const blockers: MacSetupIssue[] = [];
  if (input.platform !== "darwin") {
    blockers.push(setupIssue(
      "unsupported-platform",
      "Nerva's background bridge is supported only on macOS.",
      ["Run setup on the Mac that hosts Codex Desktop."],
    ));
  }
  const nodeMajor = Number.parseInt(input.nodeVersion.split(".")[0] ?? "", 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    blockers.push(setupIssue(
      "unsupported-node",
      `Nerva requires Node.js 22 or newer; found ${input.nodeVersion || "an unknown version"}.`,
      ["Install Node.js 22 or newer, then rerun `npm run setup:check`."],
    ));
  }

  if (blockers.length === 0) {
    try {
      await validateLaunchAgentDestination(input.homeDirectory, input.repositoryRoot);
      await validateCodexBinary(input.codexBinaryPath);
    } catch (error) {
      blockers.push(setupIssue(
        String(error).includes("Desktop-bundled Codex") ? "desktop-unavailable" : "unsafe-installation-path",
        error instanceof Error ? error.message : String(error),
        ["Repair the reported path and rerun `npm run setup:check` from the repository root."],
      ));
    }
  }

  // Installation-path safety is the boundary for all command probes. Once it
  // is established, keep the independent read-only Codex and doctor probes
  // running even when Tailscale itself contributes a blocker. Otherwise one
  // offline network prerequisite makes an installed Desktop/standalone CLI
  // look absent and sends the user toward the wrong repair.
  const canRunReadOnlyProbes = blockers.length === 0;

  let identity: TailscaleIdentity | undefined;
  if (canRunReadOnlyProbes) {
    try {
      identity = await tailscaleIdentity(input.environment, input.command);
      const targetRoute = `${identity.dnsName}:${SERVE_HTTPS_PORT}`;
      const funnel = inspectFunnelStatus(
        await input.command(identity.binary, ["funnel", "status", "--json"], 10_000),
        targetRoute,
      );
      if (funnel.state !== "disabled") {
        blockers.push(setupIssue(
          "funnel-not-disabled",
          `Funnel is not proven disabled for ${targetRoute}: ${funnel.detail}`,
          ["Disable Funnel for the exact route, then rerun `npm run setup:check`."],
        ));
      }
      const serve = inspectServeStatus(
        await input.command(identity.binary, ["serve", "status", "--json"], 10_000),
        identity.dnsName,
      );
      if (serve.state === "conflict" || serve.state === "ambiguous") {
        blockers.push(setupIssue(
          "serve-route-conflict",
          serve.detail,
          ["Review the existing Tailscale Serve configuration; Nerva will not overwrite or reset it."],
        ));
      }
    } catch (error) {
      blockers.push(setupIssue(
        "tailscale-unavailable",
        error instanceof Error ? error.message : String(error),
        ["Install Tailscale on both devices, sign in to the same tailnet, and rerun `npm run setup:check`."],
      ));
    }
  }

  const desktopVersionResult = canRunReadOnlyProbes
    ? await input.command(input.codexBinaryPath, ["--version"], 10_000)
    : undefined;
  const desktopCodexVersion = normalizedCodexVersion(
    desktopVersionResult?.exitCode === 0 ? desktopVersionResult.stdout : undefined,
  );
  if (canRunReadOnlyProbes && desktopCodexVersion === undefined) {
    blockers.push(setupIssue(
      "desktop-unavailable",
      "Codex Desktop's bundled CLI did not return a readable version.",
      ["Install or update Codex Desktop, then rerun `npm run setup:check`."],
    ));
  }
  const codexHome = input.environment.CODEX_HOME?.trim() || join(input.homeDirectory, ".codex");
  const standalonePath = join(codexHome, "packages", "standalone", "current", "codex");
  const standaloneVersionResult = canRunReadOnlyProbes
    ? await input.command(standalonePath, ["--version"], 10_000)
    : undefined;
  const standaloneCodexVersion = normalizedCodexVersion(
    standaloneVersionResult?.exitCode === 0 ? standaloneVersionResult.stdout : undefined,
  );

  const doctor = canRunReadOnlyProbes
    ? await (dependencies.inspectDoctor
        ? dependencies.inspectDoctor(dependencies)
        : doctorCodexPad({
            homeDirectory: input.homeDirectory,
            platform: input.platform,
            environment: input.environment,
            runCommand: input.command,
            fetch: input.fetchImplementation,
          }))
    : undefined;
  const nativeReasons = uniqueIssues([
    ...(standaloneCodexVersion === undefined
      ? [setupIssue(
          "standalone-unavailable",
          `The OpenAI-managed standalone Codex CLI is unavailable at ${standalonePath}.`,
          ["Run the official Codex installer, then rerun `npm run setup:check`."],
        )]
      : []),
    ...(desktopCodexVersion && standaloneCodexVersion && desktopCodexVersion !== standaloneCodexVersion
      && doctor?.compatibility?.state !== "compatible"
      && doctor?.compatibility?.state !== "limited"
      ? [setupIssue(
          "codex-version-mismatch",
          `Codex Desktop uses ${desktopCodexVersion}, while the standalone daemon package uses ${standaloneCodexVersion}.`,
          [
            "Run the official Codex installer to update the standalone package.",
            "Do not restart Codex Desktop onto a version-skewed daemon.",
          ],
        )]
      : []),
    ...(doctor
      ? [
          issueFromDoctorCheck(doctor, "managed-app-server", "managed-app-server-unavailable"),
          issueFromDoctorCheck(doctor, "desktop-shared-ownership", "desktop-ownership-unverified"),
          issueFromDoctorCheck(doctor, "cdp-loopback", "cdp-unavailable"),
          issueFromDoctorCheck(doctor, "micro-six-slots", "micro-adapter-unavailable"),
          issueFromDoctorCheck(doctor, "protocol-schema", "protocol-schema-unavailable"),
        ].filter((issue): issue is MacSetupIssue => issue !== undefined)
      : []),
  ]);
  const nativeIntegration: MacSetupNativeIntegration = {
    state: nativeReasons.length === 0 ? "ready" : "limited",
    ...(desktopCodexVersion ? { desktopCodexVersion } : {}),
    ...(standaloneCodexVersion ? { standaloneCodexVersion } : {}),
    reasons: nativeReasons,
  };

  return {
    installationState: blockers.length > 0 ? "blocked" : nativeIntegration.state,
    nativeIntegration,
    blockers,
  };
}

export async function setupMac(dependencies: MacSetupDependencies = {}): Promise<MacSetupResult> {
  const input = normalizedDependencies(dependencies);
  assertMac(input.platform);
  const preflight = await (dependencies.inspectPreflight ?? preflightMacSetup)(dependencies);
  if (preflight.installationState === "blocked") {
    throw new Error(`Mac setup is blocked: ${preflight.blockers.map((issue) => issue.detail).join(" ")}`);
  }
  const setup = await setupCodexPad({ homeDirectory: input.homeDirectory, platform: input.platform });
  if (!setup.ok) throw new Error("Nerva local storage setup did not complete.");
  const schemaBinaries = [
    { path: input.codexBinaryPath, version: preflight.nativeIntegration.desktopCodexVersion },
    {
      path: join(
        input.environment.CODEX_HOME?.trim() || join(input.homeDirectory, ".codex"),
        "packages",
        "standalone",
        "current",
        "codex",
      ),
      version: preflight.nativeIntegration.standaloneCodexVersion,
    },
  ];
  for (const binary of schemaBinaries) {
    if (!binary.version) continue;
    await generateProtocolSchemas(setup.paths, {
      enabled: true,
      binaryPath: binary.path,
      binaryVersion: `codex-cli ${binary.version}`,
      run: (executable, arguments_) => input.command(executable, arguments_, 30_000),
      now: input.now,
    }).catch(() => undefined);
  }
  await validateLaunchAgentDestination(input.homeDirectory, input.repositoryRoot);
  const identity = await tailscaleIdentity(input.environment, input.command);
  const serveChanged = await ensurePrivateServe(identity, input.command);
  if (serveChanged) {
    try {
      await recordManagedServeOwnership(
        input.homeDirectory,
        input.filesystemUid,
        identity,
        input.now,
      );
    } catch (error) {
      const rollback = await input.command(
        identity.binary,
        ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, BRIDGE_TARGET, "off"],
        60_000,
      );
      const rollbackDetail = rollback.exitCode === 0
        ? "The newly created route was rolled back."
        : `Route rollback also failed: ${rollback.stderr.trim() || rollback.stdout.trim() || "command failed"}`;
      throw new Error(`Could not record private ownership of the new Nerva Serve route. ${rollbackDetail} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let launchAgent: Awaited<ReturnType<typeof installLaunchAgent>>;
  try {
    launchAgent = await installLaunchAgent({
      homeDirectory: input.homeDirectory,
      repositoryRoot: input.repositoryRoot,
      nodeExecutable: input.nodeExecutable,
      uid: input.uid,
      filesystemUid: input.filesystemUid,
      command: input.command,
    });
  } catch (error) {
    if (!serveChanged) throw error;
    const rollback = await input.command(
      identity.binary,
      ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, BRIDGE_TARGET, "off"],
      60_000,
    );
    if (rollback.exitCode === 0) {
      await rm(managedServeReceiptPath(input.homeDirectory)).catch(() => undefined);
    }
    throw new Error(
      `The Nerva LaunchAgent could not be installed. ${rollback.exitCode === 0 ? "The newly created Serve route was rolled back." : `Serve rollback failed: ${rollback.stderr.trim() || rollback.stdout.trim() || "command failed"}`} ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const healthy = await (dependencies.waitForBridgeHealth ?? bridgeHealthy)(input.fetchImplementation);
  if (!healthy) {
    throw new Error(`The background bridge did not become healthy. Inspect ${join(setup.paths.runtime, "bridge.stderr.log")}.`);
  }
  let managedDaemonConfigured = false;
  let legacyAppServerLaunchAgentRemoved = false;
  const nativeReasons = [...preflight.nativeIntegration.reasons];
  if (preflight.nativeIntegration.state === "ready") {
    try {
      legacyAppServerLaunchAgentRemoved = await removeLegacyAppServerLaunchAgent({
        homeDirectory: input.homeDirectory,
        codexBinaryPath: input.codexBinaryPath,
        uid: input.uid,
        command: input.command,
      });
      await configureManagedDaemon({
        codexBinaryPath: input.codexBinaryPath,
        command: input.command,
      });
      const desktopDaemonFlag = await input.command(
        "/bin/launchctl",
        ["setenv", "CODEX_APP_SERVER_USE_LOCAL_DAEMON", "1"],
        10_000,
      );
      if (desktopDaemonFlag.exitCode !== 0) {
        throw new Error(`Could not configure Codex Desktop for the local app-server daemon: ${desktopDaemonFlag.stderr.trim() || desktopDaemonFlag.stdout.trim() || "command failed"}`);
      }
      managedDaemonConfigured = true;
    } catch (error) {
      nativeReasons.push(setupIssue(
        "managed-app-server-unavailable",
        error instanceof Error ? error.message : String(error),
        ["Run `npm run doctor` and resolve the reported native integration issue; the Nerva bridge remains installed."],
      ));
    }
  }
  const pairing = await rotatePairingCode({
    paths: defaultDataPaths(codexPadPaths(input.homeDirectory).root),
    publicOrigin: identity.publicOrigin,
    now: input.now(),
  });
  const nativeIntegration: MacSetupNativeIntegration = {
    ...preflight.nativeIntegration,
    state: nativeReasons.length === 0 && managedDaemonConfigured ? "ready" : "limited",
    reasons: uniqueIssues(nativeReasons),
  };
  return {
    setup,
    installationState: nativeIntegration.state,
    publicOrigin: identity.publicOrigin,
    pairing,
    tailscaleBinary: identity.binary,
    launchAgentPath: launchAgent.path,
    bridgeHealthy: healthy,
    serveChanged,
    launchAgentChanged: launchAgent.changed,
    managedDaemonConfigured,
    legacyAppServerLaunchAgentRemoved,
    nativeIntegration,
  };
}

export async function createMacPairing(dependencies: MacSetupDependencies = {}): Promise<MacPairingResult> {
  const input = normalizedDependencies(dependencies);
  assertMac(input.platform);
  const installedPath = await validateInstalledLaunchAgent(input.homeDirectory);
  const identity = await tailscaleIdentity(input.environment, input.command);
  await ensurePrivateServe(identity, input.command);
  await restartInstalledLaunchAgent({
    path: installedPath,
    uid: input.uid,
    command: input.command,
  });
  const healthy = await bridgeHealthy(input.fetchImplementation);
  if (!healthy) throw new Error("The background bridge did not become healthy after restart.");
  const pairing = await rotatePairingCode({
    paths: defaultDataPaths(codexPadPaths(input.homeDirectory).root),
    publicOrigin: identity.publicOrigin,
    now: input.now(),
  });
  return {
    publicOrigin: identity.publicOrigin,
    pairing,
    tailscaleBinary: identity.binary,
    launchAgentPath: installedPath,
    bridgeHealthy: healthy,
  };
}

export async function waitForPairingConsumption(
  homeDirectory = homedir(),
  pollMs = 250,
): Promise<"consumed" | "expired" | "missing"> {
  const paths = defaultDataPaths(codexPadPaths(homeDirectory).root);
  for (;;) {
    const info = await showPairingInfo({ paths });
    if (info === null) return "missing";
    if (info.consumed) return "consumed";
    if (info.expired) return "expired";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

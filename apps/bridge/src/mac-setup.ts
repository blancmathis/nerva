import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  findTailscaleBinary,
  inspectFunnelStatus,
  normalizeTailscaleDnsName,
  runCommand,
  type CommandResult,
  type CommandRunner,
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

type FetchLike = typeof globalThis.fetch;

export interface MacSetupDependencies {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly repositoryRoot?: string;
  readonly nodeExecutable?: string;
  readonly codexBinaryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly uid?: number;
  readonly runCommand?: CommandRunner;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
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
  readonly serveChanged: boolean;
  readonly launchAgentChanged: boolean;
  readonly managedDaemonConfigured: true;
  readonly legacyAppServerLaunchAgentRemoved: boolean;
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
}): string {
  const value = (text: string): string => `<string>${xmlEscape(text)}</string>`;
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
  <key>StandardOutPath</key>
  ${value(input.stdoutPath)}
  <key>StandardErrorPath</key>
  ${value(input.stderrPath)}
</dict>
</plist>
`;
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
  if (route !== undefined) {
    if (!isRecord(route) || !isRecord(route.Handlers)) {
      return { state: "ambiguous", detail: "The existing HTTPS route cannot be inspected safely." };
    }
    const handlerEntries = Object.entries(route.Handlers);
    const root = route.Handlers["/"];
    if (
      handlerEntries.length === 1
      && isRecord(root)
      && root.Proxy === BRIDGE_TARGET
    ) {
      return { state: "ready", detail: "The exact Codex Pad Serve route is already configured." };
    }
    return {
      state: "conflict",
      detail: `HTTPS ${routeKey} is already used by another route or path. Codex Pad will not overwrite it.`,
    };
  }

  const tcp = parsed.TCP;
  if (tcp !== undefined && !isRecord(tcp)) {
    return { state: "ambiguous", detail: "Tailscale Serve TCP configuration has an unsupported shape." };
  }
  if (isRecord(tcp) && (tcp[String(SERVE_HTTPS_PORT)] !== undefined || tcp[routeKey] !== undefined)) {
    return { state: "conflict", detail: `TCP/HTTPS port ${SERVE_HTTPS_PORT} is already configured.` };
  }
  if (parsed.Foreground !== undefined && isRecord(parsed.Foreground) && Object.keys(parsed.Foreground).length > 0) {
    return { state: "ambiguous", detail: "Foreground Serve configuration exists and must be reviewed manually." };
  }
  return { state: "available", detail: "The Codex Pad HTTPS route is available." };
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
    throw new Error(`Tailscale Serve did not report the exact Codex Pad route after setup: ${after.detail}`);
  }
  const funnelAfter = inspectFunnelStatus(
    await command(identity.binary, ["funnel", "status", "--json"], 10_000),
    targetRoute,
  );
  if (funnelAfter.state !== "disabled") {
    throw new Error(`Funnel became ambiguous or enabled after Serve setup: ${funnelAfter.detail}`);
  }
  return true;
}

function launchAgentPath(homeDirectory: string): string {
  return join(homeDirectory, "Library", "LaunchAgents", LAUNCH_AGENT_FILE);
}

function legacyAppServerLaunchAgentPath(homeDirectory: string): string {
  return join(homeDirectory, "Library", "LaunchAgents", LEGACY_APP_SERVER_LAUNCH_AGENT_FILE);
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

async function installLaunchAgent(input: {
  readonly homeDirectory: string;
  readonly repositoryRoot: string;
  readonly nodeExecutable: string;
  readonly uid: number;
  readonly command: CommandRunner;
}): Promise<{ readonly path: string; readonly changed: boolean }> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const cliPath = join(repositoryRoot, "apps", "bridge", "dist", "cli.js");
  await validateLaunchAgentDestination(input.homeDirectory, repositoryRoot);
  const runtime = codexPadPaths(input.homeDirectory).runtime;
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
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
  await input.command("/bin/launchctl", ["bootout", service], 10_000);
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

async function bridgeHealthy(fetchImplementation: FetchLike, timeoutMs = 10_000): Promise<boolean> {
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
  readonly command: CommandRunner;
  readonly fetchImplementation: FetchLike;
  readonly now: () => Date;
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
    command: dependencies.runCommand ?? runCommand,
    fetchImplementation: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? (() => new Date()),
  };
}

function assertMac(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error("`setup:mac` and `pair` are supported only on macOS.");
  }
}

export async function setupMac(dependencies: MacSetupDependencies = {}): Promise<MacSetupResult> {
  const input = normalizedDependencies(dependencies);
  assertMac(input.platform);
  const setup = await setupCodexPad({ homeDirectory: input.homeDirectory, platform: input.platform });
  if (!setup.ok) throw new Error("Codex Pad local storage setup did not complete.");
  await validateLaunchAgentDestination(input.homeDirectory, input.repositoryRoot);
  // Fail before touching Tailscale or rotating a pairing secret when the
  // installed Codex runtime cannot support the managed local daemon.
  await validateCodexBinary(input.codexBinaryPath);
  const identity = await tailscaleIdentity(input.environment, input.command);
  const serveChanged = await ensurePrivateServe(identity, input.command);
  const legacyAppServerLaunchAgentRemoved = await removeLegacyAppServerLaunchAgent({
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
  const pairing = await rotatePairingCode({
    paths: defaultDataPaths(codexPadPaths(input.homeDirectory).root),
    publicOrigin: identity.publicOrigin,
    now: input.now(),
  });
  const launchAgent = await installLaunchAgent({
    homeDirectory: input.homeDirectory,
    repositoryRoot: input.repositoryRoot,
    nodeExecutable: input.nodeExecutable,
    uid: input.uid,
    command: input.command,
  });
  const healthy = await bridgeHealthy(input.fetchImplementation);
  if (!healthy) {
    throw new Error(`The background bridge did not become healthy. Inspect ${join(setup.paths.runtime, "bridge.stderr.log")}.`);
  }
  return {
    setup,
    publicOrigin: identity.publicOrigin,
    pairing,
    tailscaleBinary: identity.binary,
    launchAgentPath: launchAgent.path,
    bridgeHealthy: healthy,
    serveChanged,
    launchAgentChanged: launchAgent.changed,
    managedDaemonConfigured: true,
    legacyAppServerLaunchAgentRemoved,
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

#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DiagramPublishRequestSchema,
  type DiagramDocument,
  type DiagramPublishRequest,
} from "@codex-pad/protocol";
import {
  canonicalizeBridgeMagicDnsOrigin,
  canonicalizeSitePublicOrigin,
  normalizeExactThreadUuid,
  normalizeProjectCwd,
  normalizeProjectCwdIdentifier,
  siteOriginPort,
} from "@codex-pad/site-review";
import {
  doctorCodexPad,
  formatDoctorReport,
  inspectInstalledProtocolSchema,
  locateDesktopInstallation,
  runCommand,
  type DoctorDependencies,
} from "./doctor.js";
import type { RuntimeSchemaCompatibility } from "@codex-pad/protocol";
import {
  inspectInstalledMultiImageInputCapability,
  type InstalledImageInputCapabilityInspection,
} from "./image-input-capability.js";
import {
  createMacPairing,
  preflightMacSetup,
  setupMac,
  waitForPairingConsumption,
  type MacPairingResult,
  type MacSetupDependencies,
  type MacSetupPreflight,
  type MacSetupResult,
} from "./mac-setup.js";
import { setupCodexPad, type SetupDependencies } from "./setup.js";
import type { VerifiedMultiImageInputCapability } from "./thread-transport.js";

interface BridgeHandle {
  readonly url: string;
  close(): Promise<void>;
}

interface ServerModule {
  startBridge(options?: {
    readonly host?: string;
    readonly port?: number;
    readonly unsafeLan?: boolean;
    readonly allowedOrigins?: readonly string[];
    readonly publicOrigin?: string;
    readonly codexVersion?: string;
    readonly schemaCompatibility?: RuntimeSchemaCompatibility;
    readonly multiImageInputCapability?: VerifiedMultiImageInputCapability;
  }): Promise<BridgeHandle>;
}

interface DeviceRecord {
  readonly id?: string;
  readonly deviceId?: string;
  readonly name?: string;
  readonly createdAt?: string;
  readonly lastSeenAt?: string;
  readonly revokedAt?: string | null;
  readonly [key: string]: unknown;
}

interface AuthModule {
  listDevices(options?: unknown): Promise<readonly DeviceRecord[]>;
  revokeDevice(deviceId: string, options?: unknown): Promise<unknown>;
}

interface PairingModule {
  rotatePairingCode(options: {
    readonly publicOrigin: string;
    readonly deviceNameHint?: string;
    readonly allowInsecureHttp?: boolean;
  }): Promise<PairingInfo>;
  showPairingInfo(options?: unknown): Promise<PairingInfo | null>;
  renderPairingQr(infoOrPayload: PairingInfo | string, options: { readonly type: "terminal" }): Promise<string>;
}

interface PairingInfo {
  readonly qrPayload: string;
  readonly expiresAt: string;
  readonly consumed: boolean;
  readonly expired: boolean;
  readonly insecureDevelopment?: true;
  readonly deviceNameHint?: string;
}

interface SiteRecord {
  readonly id?: string;
  readonly associationId?: string;
  readonly targetKind?: "thread" | "project";
  readonly targetId?: string;
  readonly loopbackUrl?: string;
  readonly publicOrigin?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly [key: string]: unknown;
}

interface SiteRegistryModule {
  listSites(options?: SiteRegistryBindingOptions): Promise<readonly SiteRecord[]>;
  addSite(options: {
    readonly targetKind: "thread" | "project";
    readonly targetId: string;
    readonly loopbackUrl: string;
    readonly publicOrigin: string;
  }, registryOptions?: SiteRegistryBindingOptions): Promise<SiteRecord>;
  removeSite(id: string, options?: SiteRegistryBindingOptions): Promise<unknown>;
}

interface SiteRegistryBindingOptions {
  readonly publicBridgeOrigin?: string;
}

interface UnresolvedCommandMetadata {
  readonly deviceId: string;
  readonly commandId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface CommandLedgerModule {
  listUnresolvedCommands(options?: unknown): Promise<readonly UnresolvedCommandMetadata[]>;
  forgetUnresolvedCommand(deviceId: string, commandId: string, options?: unknown): Promise<boolean>;
}

interface DiagramStoreModule {
  list(threadId: string): Promise<readonly DiagramDocument[]>;
  get(diagramId: string): Promise<DiagramDocument>;
  publish(input: DiagramPublishRequest, actor?: "codex" | "ipad"): Promise<DiagramDocument>;
}

export interface CliDependencies {
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
  readonly doctor?: (dependencies?: DoctorDependencies) => ReturnType<typeof doctorCodexPad>;
  readonly setup?: (dependencies?: SetupDependencies) => ReturnType<typeof setupCodexPad>;
  readonly locateDesktop?: typeof locateDesktopInstallation;
  readonly inspectMultiImageInputCapability?: (
    identity: { readonly codexBinaryPath: string; readonly codexVersion: string },
  ) => Promise<InstalledImageInputCapabilityInspection>;
  readonly loadServer?: () => Promise<ServerModule>;
  readonly loadAuth?: () => Promise<AuthModule>;
  readonly loadPairing?: () => Promise<PairingModule>;
  readonly loadSites?: () => Promise<SiteRegistryModule>;
  readonly loadCommandLedger?: () => Promise<CommandLedgerModule>;
  readonly loadDiagrams?: () => Promise<DiagramStoreModule>;
  readonly waitForShutdown?: (handle: BridgeHandle) => Promise<void>;
  readonly setupMac?: (dependencies?: MacSetupDependencies) => Promise<MacSetupResult>;
  readonly preflightMacSetup?: (dependencies?: MacSetupDependencies) => Promise<MacSetupPreflight>;
  readonly createMacPairing?: (dependencies?: MacSetupDependencies) => Promise<MacPairingResult>;
  readonly waitForPairingConsumption?: (homeDirectory?: string, pollMs?: number) => Promise<"consumed" | "expired" | "missing">;
}

class CliUsageError extends Error {}

function flagValue(arguments_: readonly string[], name: string): string | undefined {
  const inline = arguments_.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`${name} requires a value.`);
  }
  return value;
}

function hasFlag(arguments_: readonly string[], name: string): boolean {
  return arguments_.includes(name);
}

function parsePort(arguments_: readonly string[]): number | undefined {
  const raw = flagValue(arguments_, "--port");
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliUsageError("--port must be an integer from 1 through 65535.");
  }
  return port;
}

function assertConcreteLanAddress(address: string): void {
  if (isIP(address) === 0) {
    throw new CliUsageError("--unsafe-lan requires a concrete IPv4 or IPv6 address, not a hostname.");
  }
  if (["0.0.0.0", "::", "127.0.0.1", "::1"].includes(address) || address.startsWith("127.")) {
    throw new CliUsageError(
      "--unsafe-lan requires a concrete non-loopback address; wildcard and loopback addresses are rejected.",
    );
  }
}

function publicHttpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliUsageError("--origin must be a valid HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliUsageError("--origin must contain only an HTTPS scheme, host, and optional port.");
  }
  return url.origin;
}

function unsafeLanOrigin(raw: string, address: string, port: number): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliUsageError("Unsafe LAN --origin must be a valid HTTP origin.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const effectivePort = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    hostname !== address ||
    effectivePort !== port
  ) {
    throw new CliUsageError(
      `Unsafe LAN --origin must be exactly http://${address.includes(":") ? `[${address}]` : address}:${port}.`,
    );
  }
  return url.origin;
}

function loopbackSiteOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliUsageError("--url must be a valid loopback HTTP URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new CliUsageError(
      "--url must be an origin-only loopback HTTP URL with an explicit non-443, non-8787 port and no credentials.",
    );
  }
  const origin = url.origin;
  siteOriginPort(origin);
  return origin;
}

function normalizedThreadId(raw: string): string {
  try {
    return normalizeExactThreadUuid(raw);
  } catch {
    throw new CliUsageError("--thread must be an exact UUID.");
  }
}

function normalizedProjectTarget(raw: string): string {
  try {
    return raw.startsWith("project:")
      ? normalizeProjectCwdIdentifier(raw)
      : normalizeProjectCwd(raw);
  } catch {
    throw new CliUsageError(
      "--project must be an absolute project cwd or an existing project:<sha256-base64url> identifier.",
    );
  }
}

function exactUuidFlag(raw: string, flag: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw)) {
    throw new CliUsageError(`${flag} must be an exact UUID.`);
  }
  return raw.toLowerCase();
}

function exactDiagramThread(
  arguments_: readonly string[],
  fileThreadId?: unknown,
): string {
  const explicit = flagValue(arguments_, "--thread");
  const ambient = process.env.CODEX_THREAD_ID;
  const embedded = typeof fileThreadId === "string" ? fileThreadId : undefined;
  const candidate = explicit ?? embedded ?? ambient;
  if (!candidate) {
    throw new CliUsageError(
      "A diagram needs an exact task. Run from a Codex task or pass --thread <uuid>.",
    );
  }
  const normalized = normalizedThreadId(candidate);
  if (explicit && embedded && normalizedThreadId(embedded) !== normalized) {
    throw new CliUsageError("The diagram file threadId does not match --thread.");
  }
  return normalized;
}

async function readDiagramPublishFile(
  pathValue: string,
  arguments_: readonly string[],
): Promise<DiagramPublishRequest> {
  const path = resolve(pathValue);
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new CliUsageError("--file must point to one regular JSON file, not a symlink.");
  }
  if (details.size <= 0 || details.size > 512 * 1024) {
    throw new CliUsageError("The diagram JSON file must be between 1 byte and 512 KiB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new CliUsageError("The diagram file must contain valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError("The diagram file must contain one JSON object.");
  }
  const record = value as Record<string, unknown>;
  return DiagramPublishRequestSchema.parse({
    ...record,
    threadId: exactDiagramThread(arguments_, record.threadId),
  });
}

function printJson(write: (message: string) => void, value: unknown): void {
  write(JSON.stringify(value, null, 2));
}

const HELP = `Codex Pad — local macOS bridge and iPad control surface

Usage from a source checkout:
  npm run setup:check [-- --json]
  npm run setup:mac [-- --no-wait]
  npm run pair [-- --no-wait]
  npm run setup -- [--generate-schemas] [--attest-desktop-ownership] [--pair-origin https://mac.tailnet.ts.net] [--device-name "iPad"] [--json]
  npm run doctor -- [--json]
  npm run start -- [--port 8787]
  npm run start -- --unsafe-lan <concrete-address> --origin http://<same-address>:8787
  npm run codex-pad -- device list [--json]
  npm run codex-pad -- device revoke <device-id> [--json]
  npm run codex-pad -- pairing rotate --origin https://mac.tailnet.ts.net [--name "iPad"] [--json]
  npm run codex-pad -- pairing rotate --unsafe-lan <concrete-address> --origin http://<same-address>:8787 [--port 8787]
  npm run codex-pad -- pairing show [--json]
  npm run codex-pad -- site add (--thread <uuid> | --project <absolute-cwd|project:hash>) --url http://127.0.0.1:<port> --public-origin https://<magicdns>.ts.net:<same-port> [--json]
  npm run codex-pad -- site list [--json]
  npm run codex-pad -- site remove <site-id> [--json]
  npm run codex-pad -- diagram publish --file <diagram.json> [--thread <uuid>] [--json]
  npm run codex-pad -- diagram list [--thread <uuid>] [--json]
  npm run codex-pad -- diagram get <diagram-id> [--json]
  npm run codex-pad -- command-ledger list-unresolved [--json]
  npm run codex-pad -- command-ledger forget --device <uuid> --command <uuid> --acknowledge-delivery-unknown [--json]

Safety defaults:
  The bridge binds 127.0.0.1 and is intended for Tailscale Serve HTTPS.
  setup and doctor never restart Codex Desktop, mutate launchctl/global env,
  enable Funnel, reset Tailscale, or bootstrap the managed daemon.
  setup-mac is an explicit opt-in that configures Codex's durable managed
  app-server only after a safe preflight, installs Nerva's bridge LaunchAgent,
  and sets the exact private Serve route; it never resets Serve or Funnel or
  restarts Desktop. A limited native preflight still installs the safe bridge
  and pairing surface while native mutations remain unavailable.
  --unsafe-lan is development-only; authentication and Origin checks remain on.`;

function formatMacSetupPreflight(preflight: MacSetupPreflight): string {
  const heading = preflight.installationState === "ready"
    ? "READY"
    : preflight.installationState === "limited" || preflight.installationState === "degraded"
      ? "READY WITH LIMITED CODEX CONTROLS"
      : "BLOCKED";
  const lines = [`Nerva setup check: ${heading}`];
  if (preflight.nativeIntegration.desktopCodexVersion) {
    lines.push(`Codex Desktop CLI: ${preflight.nativeIntegration.desktopCodexVersion}`);
  }
  if (preflight.nativeIntegration.standaloneCodexVersion) {
    lines.push(`Standalone Codex CLI: ${preflight.nativeIntegration.standaloneCodexVersion}`);
  }
  const issues = preflight.installationState === "blocked"
    ? preflight.blockers
    : preflight.nativeIntegration.reasons;
  for (const issue of issues) {
    lines.push(`- [${issue.code}] ${issue.detail}`);
    for (const remediation of issue.remediation) lines.push(`  Next: ${remediation}`);
  }
  if (preflight.installationState === "limited" || preflight.installationState === "degraded") {
    lines.push("Nerva can install and pair. Only the capabilities listed as unavailable remain disabled; maintainers can use `npm run doctor -- --strict-native` for the full release gate.");
  }
  return lines.join("\n");
}

async function defaultLoadServer(): Promise<ServerModule> {
  const modulePath = "./server.js";
  return (await import(modulePath)) as unknown as ServerModule;
}

async function defaultLoadAuth(): Promise<AuthModule> {
  return (await import("./auth.js")) as unknown as AuthModule;
}

async function defaultLoadPairing(): Promise<PairingModule> {
  return (await import("./pairing.js")) as unknown as PairingModule;
}

async function printPairing(
  write: (message: string) => void,
  pairing: PairingModule,
  info: PairingInfo,
): Promise<void> {
  if (!info.expired && !info.consumed) {
    write(await pairing.renderPairingQr(info, { type: "terminal" }));
  } else {
    write("This pairing code is no longer usable; rotate it before scanning.");
  }
  write(`Pairing URL: ${info.qrPayload}`);
  write(`Expires: ${info.expiresAt}${info.expired ? " (expired)" : ""}${info.consumed ? " (consumed)" : ""}`);
  write("The QR contains only a short-lived nonce URL, never a permanent device credential.");
}

async function defaultLoadSites(): Promise<SiteRegistryModule> {
  const modulePath = "./site-registry.js";
  try {
    const registry = (await import(modulePath)) as unknown as SiteRegistryModule;
    const configuredOrigin = process.env.CODEX_PAD_PUBLIC_ORIGIN;
    const pairingInfo = configuredOrigin === undefined
      ? await (await import("./pairing.js")).showPairingInfo()
      : null;
    const candidate = configuredOrigin ?? (pairingInfo === null
      ? undefined
      : new URL(pairingInfo.qrPayload).origin);
    let publicBridgeOrigin: string | undefined;
    try {
      publicBridgeOrigin = candidate === undefined
        ? undefined
        : canonicalizeBridgeMagicDnsOrigin(candidate);
    } catch {
      // Non-MagicDNS development/LAN bridge origins cannot bind a private
      // MagicDNS review host. The registry retains its normal strict checks.
      publicBridgeOrigin = undefined;
    }
    if (publicBridgeOrigin === undefined) {
      return {
        listSites: () => registry.listSites(),
        addSite: async () => {
          throw new Error(
            "Site registration requires the exact bridge MagicDNS origin from CODEX_PAD_PUBLIC_ORIGIN or the persisted pairing record.",
          );
        },
        removeSite: (id) => registry.removeSite(id),
      };
    }
    const options = { publicBridgeOrigin };
    return {
      listSites: () => registry.listSites(options),
      addSite: (input) => registry.addSite(input, options),
      removeSite: (id) => registry.removeSite(id, options),
    };
  } catch (error) {
    throw new Error(`Site registry is unavailable in this build: ${String(error)}`);
  }
}

async function defaultLoadDiagrams(): Promise<DiagramStoreModule> {
  const modulePath = "./diagram-store.js";
  const { DiagramStore } = await import(modulePath);
  return new DiagramStore();
}

async function defaultLoadCommandLedger(): Promise<CommandLedgerModule> {
  return (await import("./idempotency.js")) as unknown as CommandLedgerModule;
}

async function defaultWaitForShutdown(handle: BridgeHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void handle.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function deviceId(record: DeviceRecord): string {
  return record.deviceId ?? record.id ?? "unknown";
}

function formatDevices(devices: readonly DeviceRecord[]): string {
  if (devices.length === 0) return "No paired devices.";
  return devices
    .map((device) => {
      const details = [device.name, device.lastSeenAt ? `last seen ${device.lastSeenAt}` : undefined]
        .filter(Boolean)
        .join(" — ");
      return `${deviceId(device)}${details ? ` — ${details}` : ""}${device.revokedAt ? " — revoked" : ""}`;
    })
    .join("\n");
}

async function finishMacPairing(
  stdout: (message: string) => void,
  result: MacPairingResult,
  dependencies: CliDependencies,
  noWait: boolean,
): Promise<void> {
  const pairing = await (dependencies.loadPairing ?? defaultLoadPairing)();
  stdout(`Private origin: ${result.publicOrigin}`);
  stdout(`Background bridge: ${result.bridgeHealthy ? "ready" : "unavailable"}`);
  stdout(`LaunchAgent: ${result.launchAgentPath}`);
  stdout("");
  stdout("Scan this QR with the iPad camera:");
  await printPairing(stdout, pairing, result.pairing);
  if (noWait) return;
  stdout("");
  stdout("Waiting for the iPad to connect. Press Ctrl-C to stop waiting; the background bridge will keep running.");
  const outcome = await (
    dependencies.waitForPairingConsumption
    ?? waitForPairingConsumption
  )();
  if (outcome === "consumed") {
    stdout("iPad connected. Pairing is complete and will survive Terminal and Mac restarts.");
    return;
  }
  if (outcome === "expired") throw new Error("Pairing expired. Run `npm run pair` to show a fresh QR.");
  throw new Error("The pairing invitation disappeared before it was consumed. Run `npm run pair` again.");
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));
  const command = arguments_[0] ?? "help";
  const rest = arguments_.slice(1);

  try {
    if (["help", "--help", "-h"].includes(command)) {
      stdout(HELP);
      return 0;
    }

    if (command === "setup-check") {
      const result = await (dependencies.preflightMacSetup ?? preflightMacSetup)();
      if (hasFlag(rest, "--json")) printJson(stdout, result);
      else stdout(formatMacSetupPreflight(result));
      return result.installationState === "blocked" ? 1 : 0;
    }

    if (command === "setup-mac") {
      const result = await (dependencies.setupMac ?? setupMac)();
      if (hasFlag(rest, "--json")) {
        printJson(stdout, result);
        return 0;
      }
      stdout("Nerva is installed as a background Mac user service.");
      stdout(result.serveChanged
        ? "Created the private Codex Pad Tailscale Serve route."
        : "Kept the existing exact Codex Pad Tailscale Serve route.");
      stdout(result.launchAgentChanged
        ? "Installed the Codex Pad LaunchAgent."
        : "The Codex Pad LaunchAgent was already up to date.");
      if (result.managedDaemonConfigured) {
        stdout("Configured the Desktop-bundled managed app-server for remote control.");
      } else {
        stdout("Installed with limited Codex controls. Native app-server configuration was left untouched.");
        for (const issue of result.nativeIntegration.reasons) {
          stdout(`- [${issue.code}] ${issue.detail}`);
        }
        stdout("Run `npm run doctor` for the strict native integration gate.");
      }
      if (result.legacyAppServerLaunchAgentRemoved) {
        stdout("Removed Codex Pad's obsolete raw app-server LaunchAgent.");
      }
      await finishMacPairing(stdout, result, dependencies, hasFlag(rest, "--no-wait"));
      return 0;
    }

    if (command === "pair") {
      const result = await (dependencies.createMacPairing ?? createMacPairing)();
      if (hasFlag(rest, "--json")) {
        printJson(stdout, result);
        return 0;
      }
      await finishMacPairing(stdout, result, dependencies, hasFlag(rest, "--no-wait"));
      return 0;
    }

    if (command === "setup") {
      const generateSchemas = hasFlag(rest, "--generate-schemas");
      const attestDesktopOwnership = hasFlag(rest, "--attest-desktop-ownership");
      const pairOriginRaw = flagValue(rest, "--pair-origin");
      const deviceName = flagValue(rest, "--device-name");
      let protocolSchema: SetupDependencies["protocolSchema"];
      const desktop = generateSchemas || attestDesktopOwnership
        ? await (dependencies.locateDesktop ?? locateDesktopInstallation)()
        : undefined;
      if (generateSchemas) {
        if (!desktop?.binaryVersion) {
          throw new Error(
            "Cannot generate schemas: the installed Codex Desktop bundled binary/version was not found.",
          );
        }
        protocolSchema = {
          enabled: true,
          binaryPath: desktop.binaryPath,
          binaryVersion: desktop.binaryVersion,
          run: (executable, schemaArguments) => runCommand(executable, schemaArguments, 30_000),
        };
      }
      let desktopOwnership: SetupDependencies["desktopOwnership"];
      if (attestDesktopOwnership) {
        if (
          !desktop?.bundleId ||
          !desktop.appVersion ||
          !desktop.buildVersion ||
          !desktop.binaryVersion
        ) {
          throw new Error(
            "Cannot attest Desktop ownership: installed Desktop identity/version metadata is incomplete.",
          );
        }
        const daemonBinaryPath = join(
          process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
          "packages",
          "standalone",
          "current",
          "codex",
        );
        const daemonVersionResult = await runCommand(daemonBinaryPath, ["--version"], 5_000);
        if (daemonVersionResult.exitCode !== 0 || !daemonVersionResult.stdout.trim()) {
          throw new Error("Cannot attest Desktop ownership: the managed daemon binary/version is unavailable.");
        }
        desktopOwnership = {
          installation: {
            appPath: desktop.appPath,
            bundleId: desktop.bundleId,
            appVersion: desktop.appVersion,
            buildVersion: desktop.buildVersion,
            binaryPath: desktop.binaryPath,
            binaryVersion: desktop.binaryVersion,
            daemonBinaryPath,
            daemonBinaryVersion: daemonVersionResult.stdout.trim(),
          },
          runCommand,
        };
      }
      const result = await (dependencies.setup ?? setupCodexPad)({
        ...(protocolSchema ? { protocolSchema } : {}),
        ...(desktopOwnership ? { desktopOwnership } : {}),
      });
      const report = await (dependencies.doctor ?? doctorCodexPad)();
      const pairingModule = pairOriginRaw
        ? await (dependencies.loadPairing ?? defaultLoadPairing)()
        : undefined;
      const pairingInfo = pairOriginRaw && pairingModule
        ? await pairingModule.rotatePairingCode({
            publicOrigin: publicHttpsOrigin(pairOriginRaw),
            ...(deviceName ? { deviceNameHint: deviceName } : {}),
          })
        : undefined;
      if (hasFlag(rest, "--json")) {
        printJson(stdout, { setup: result, doctor: report, ...(pairingInfo ? { pairing: pairingInfo } : {}) });
      } else {
        stdout(result.ok ? "Codex Pad setup is ready." : "Codex Pad setup did not run.");
        for (const path of result.created) stdout(`Created: ${path}`);
        for (const path of result.existing) stdout(`Kept: ${path}`);
        if (result.schema) {
          stdout(`Generated installed-version schemas: ${result.schema.codexVersion}`);
          stdout(`Schema SHA-256: ${result.schema.schemaSha256}`);
        }
        if (result.ownershipAttestation) {
          stdout(`Desktop ownership attested at: ${result.ownershipAttestation.createdAt}`);
          stdout(`Ownership evidence SHA-256: ${result.ownershipAttestation.evidenceSha256}`);
        }
        for (const note of result.notes) stdout(note);
        stdout("");
        stdout(formatDoctorReport(report));
        if (pairingInfo) {
          stdout("");
          stdout("Pairing was explicitly rotated; scan this short-lived, single-use payload:");
          await printPairing(stdout, pairingModule as PairingModule, pairingInfo);
        } else {
          stdout("");
          stdout("Pairing was not changed. To create a QR payload explicitly:");
          stdout("  npm run codex-pad -- pairing rotate --origin https://<mac-name>.<tailnet>.ts.net --name \"My iPad\"");
        }
        stdout("");
        stdout("After Tailscale Serve is green, open the HTTPS URL in iPad Safari, then use Share → Add to Home Screen.");
      }
      return result.ok ? 0 : 1;
    }

    if (command === "doctor") {
      const report = await (dependencies.doctor ?? doctorCodexPad)();
      if (hasFlag(rest, "--json")) printJson(stdout, report);
      else stdout(formatDoctorReport(report));
      const state = report.state ?? (report.overall === "red" ? "blocked" : report.overall === "warn" ? "limited" : "ready");
      return state === "blocked" || (hasFlag(rest, "--strict-native") && state !== "ready") ? 1 : 0;
    }

    if (command === "serve" || command === "start") {
      const unsafeLan = flagValue(rest, "--unsafe-lan");
      const port = parsePort(rest) ?? 8787;
      let lanOrigin: string | undefined;
      if (unsafeLan) {
        assertConcreteLanAddress(unsafeLan);
        const origin = flagValue(rest, "--origin");
        if (!origin) {
          throw new CliUsageError("--unsafe-lan requires an exact --origin for browser Origin checks.");
        }
        lanOrigin = unsafeLanOrigin(origin, unsafeLan, port);
        stderr(
          "WARNING: development-only unsafe LAN bind requested. Traffic may be unencrypted; authentication and Origin checks remain enabled.",
        );
      }
      const desktop = await (dependencies.locateDesktop ?? locateDesktopInstallation)();
      const codexVersion = desktop?.binaryVersion?.trim();
      const nativeDoctor = await (dependencies.doctor ?? doctorCodexPad)().catch(() => undefined);
      let schemaCompatibility: RuntimeSchemaCompatibility = {
        state: "unknown",
        summary: "Installed-version schema compatibility has not been verified.",
        remediation: codexVersion ? "Run: npm run setup -- --generate-schemas" : null,
      };
      try {
        const schemaCheck = await inspectInstalledProtocolSchema(desktop);
        schemaCompatibility = {
          state: schemaCheck.status === "green"
            ? "current"
            : schemaCheck.status === "red"
              ? "invalid"
              : codexVersion
                ? "missing"
                : "unknown",
          summary: schemaCheck.summary,
          remediation: schemaCheck.remediation?.[0] ?? null,
        };
      } catch {
        // Startup remains available with fail-closed mutation gates. The
        // Capability Center exposes the exact safe regeneration command.
      }
      if (nativeDoctor?.compatibility && nativeDoctor.compatibility.state !== "unavailable") {
        const available = nativeDoctor.compatibility.capabilities
          .filter((capability) => capability.state === "available")
          .map((capability) => capability.id);
        schemaCompatibility = {
          state: "current",
          summary: `Live protocol probe ${nativeDoctor.compatibility.state}; attested capabilities: ${available.join(", ") || "none"}.`,
          remediation: nativeDoctor.state === "ready"
            ? null
            : "Open Settings → System Diagnostics for the exact unavailable controls.",
        };
      }
      let multiImageInputCapability: VerifiedMultiImageInputCapability | undefined;
      if (desktop?.binaryPath && codexVersion) {
        try {
          const inspection = await (
            dependencies.inspectMultiImageInputCapability
            ?? inspectInstalledMultiImageInputCapability
          )({
            codexBinaryPath: desktop.binaryPath,
            codexVersion,
          });
          multiImageInputCapability = inspection.capability;
          if (inspection.attestationStatus === "invalid-or-stale") {
            stderr(
              "WARNING: multi-image attestation is invalid or stale; continuing with one-image Review only.",
            );
          }
        } catch {
          stderr(
            "WARNING: multi-image attestation could not be validated; continuing with one-image Review only.",
          );
        }
      }
      const server = await (dependencies.loadServer ?? defaultLoadServer)();
      const handle = await server.startBridge({
        ...(codexVersion ? { codexVersion } : {}),
        schemaCompatibility,
        ...(multiImageInputCapability === undefined ? {} : { multiImageInputCapability }),
        ...(unsafeLan && lanOrigin
          ? {
              host: unsafeLan,
              port,
              unsafeLan: true,
              allowedOrigins: [lanOrigin],
              publicOrigin: lanOrigin,
            }
          : rest.some((argument) => argument === "--port" || argument.startsWith("--port="))
            ? { port }
            : {}),
      });
      stdout(`Codex Pad bridge listening at ${handle.url}`);
      stdout(
        unsafeLan
          ? "Unsafe LAN development mode is active. Do not use it on an untrusted network."
          : "Loopback-only. Publish with Tailscale Serve for iPad HTTPS access.",
      );
      await (dependencies.waitForShutdown ?? defaultWaitForShutdown)(handle);
      return 0;
    }

    if (command === "device") {
      const action = rest[0];
      const auth = await (dependencies.loadAuth ?? defaultLoadAuth)();
      if (action === "list") {
        const devices = await auth.listDevices();
        if (hasFlag(rest, "--json")) printJson(stdout, devices);
        else stdout(formatDevices(devices));
        return 0;
      }
      if (action === "revoke") {
        const id = rest[1];
        if (!id || id.startsWith("--")) throw new CliUsageError("device revoke requires a device ID.");
        const result = await auth.revokeDevice(id);
        if (result === false) throw new Error(`Device ${id} was not found or was already revoked.`);
        if (hasFlag(rest, "--json")) printJson(stdout, result);
        else stdout(`Revoked device ${id}. Active bridge sockets for this credential will be closed.`);
        return 0;
      }
      throw new CliUsageError("device requires `list` or `revoke <device-id>`. ");
    }

    if (command === "pairing") {
      const action = rest[0];
      const pairing = await (dependencies.loadPairing ?? defaultLoadPairing)();
      if (action === "show") {
        const info = await pairing.showPairingInfo();
        if (hasFlag(rest, "--json")) printJson(stdout, info);
        else if (info) await printPairing(stdout, pairing, info);
        else stdout("No active pairing code. Run `npm run codex-pad -- pairing rotate --origin https://…`. ");
        return 0;
      }
      if (action === "rotate") {
        const originRaw = flagValue(rest, "--origin");
        if (!originRaw) throw new CliUsageError("pairing rotate requires --origin <https-origin>.");
        const unsafeLan = flagValue(rest, "--unsafe-lan");
        if (hasFlag(rest, "--unsafe-lan") && unsafeLan === undefined) {
          throw new CliUsageError("pairing rotate --unsafe-lan requires one concrete non-loopback IP address.");
        }
        const port = parsePort(rest) ?? 8787;
        let pairingOrigin: string;
        if (unsafeLan !== undefined) {
          assertConcreteLanAddress(unsafeLan);
          pairingOrigin = unsafeLanOrigin(originRaw, unsafeLan, port);
          stderr(
            "WARNING: generating a development-only HTTP pairing QR. The nonce and subsequent traffic are unencrypted; use only on an isolated trusted network.",
          );
        } else {
          pairingOrigin = publicHttpsOrigin(originRaw);
        }
        const name = flagValue(rest, "--name");
        const info = await pairing.rotatePairingCode({
          publicOrigin: pairingOrigin,
          ...(unsafeLan === undefined ? {} : { allowInsecureHttp: true }),
          ...(name ? { deviceNameHint: name } : {}),
        });
        if (hasFlag(rest, "--json")) printJson(stdout, info);
        else {
          stdout("Rotated the short-lived, single-use pairing code.");
          await printPairing(stdout, pairing, info);
        }
        return 0;
      }
      throw new CliUsageError("pairing requires `show` or `rotate --origin <https-origin>`. ");
    }

    if (command === "site") {
      const action = rest[0];
      const registry = await (dependencies.loadSites ?? defaultLoadSites)();
      if (action === "list") {
        const sites = await registry.listSites();
        if (hasFlag(rest, "--json")) printJson(stdout, sites);
        else if (sites.length === 0) stdout("No local sites are registered.");
        else printJson(stdout, sites);
        return 0;
      }
      if (action === "remove") {
        const id = rest[1];
        if (!id || id.startsWith("--")) throw new CliUsageError("site remove requires a site ID.");
        const result = await registry.removeSite(id);
        if (result === false) throw new Error(`Site ${id} was not found.`);
        if (hasFlag(rest, "--json")) printJson(stdout, result);
        else stdout(`Removed local site context ${id}.`);
        return 0;
      }
      if (action === "add") {
        const thread = flagValue(rest, "--thread");
        const project = flagValue(rest, "--project");
        if ((thread ? 1 : 0) + (project ? 1 : 0) !== 1) {
          throw new CliUsageError("site add requires exactly one of --thread <uuid> or --project <key>.");
        }
        const targetKind = thread ? "thread" : "project";
        const targetId = thread ? normalizedThreadId(thread) : normalizedProjectTarget(project ?? "");
        const urlRaw = flagValue(rest, "--url");
        if (!urlRaw) throw new CliUsageError("site add requires --url <loopback-origin>.");
        const loopbackUrl = loopbackSiteOrigin(urlRaw);
        const localPort = siteOriginPort(loopbackUrl);
        const publicOriginRaw = flagValue(rest, "--public-origin");
        if (!publicOriginRaw) {
          throw new CliUsageError(
            "site add requires --public-origin https://<magicdns>.ts.net:<same-local-port>.",
          );
        }
        const publicOrigin = canonicalizeSitePublicOrigin(publicOriginRaw, localPort);
        const record = await registry.addSite({
          targetKind,
          targetId,
          loopbackUrl,
          publicOrigin,
        });
        const registeredPublic = record.publicOrigin ?? publicOrigin;
        const registeredTargetId = record.targetId ?? targetId;
        const publicSite = {
          ...(record.associationId ? { associationId: record.associationId } : {}),
          targetKind,
          targetId: registeredTargetId,
          ...(record.name ? { name: record.name } : {}),
          publicOrigin: registeredPublic,
          ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
          ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
        };
        if (hasFlag(rest, "--json")) {
          printJson(stdout, {
            site: publicSite,
            liveSitePreview: {
              status: "unavailable",
              reason: "same-host-storage-boundary",
            },
          });
        }
        else {
          stdout(`Registered ${targetKind} site context ${record.name ?? registeredTargetId}.`);
          stdout(
            "Live preview, browser opening, and automatic capture are unavailable because the same-host site is not an independent browser storage boundary.",
          );
          stdout("No Tailscale configuration was changed or recommended.");
        }
        return 0;
      }
      throw new CliUsageError("site requires `add`, `list`, or `remove`. ");
    }

    if (command === "diagram") {
      const action = rest[0];
      const diagrams = await (dependencies.loadDiagrams ?? defaultLoadDiagrams)();
      if (action === "publish") {
        const file = flagValue(rest, "--file");
        if (!file) throw new CliUsageError("diagram publish requires --file <diagram.json>.");
        const document = await diagrams.publish(
          await readDiagramPublishFile(file, rest),
          "codex",
        );
        if (hasFlag(rest, "--json")) {
          printJson(stdout, document);
        } else {
          stdout(`Published “${document.title}” to the exact Nerva task.`);
          stdout(`Diagram ID: ${document.diagramId}`);
          stdout(`Revision: ${document.revision}`);
          stdout("Open Draw in Nerva to edit its structure or annotate it with Apple Pencil.");
        }
        return 0;
      }
      if (action === "list") {
        const threadId = exactDiagramThread(rest);
        const records = await diagrams.list(threadId);
        if (hasFlag(rest, "--json")) {
          printJson(stdout, { diagrams: records });
        } else if (records.length === 0) {
          stdout("No collaborative diagrams are published for this exact task.");
        } else {
          for (const record of records) {
            stdout(
              `${record.diagramId} — r${record.revision} — ${record.title} — ${record.lastEditedBy} — ${new Date(record.updatedAt).toISOString()}`,
            );
          }
        }
        return 0;
      }
      if (action === "get") {
        const id = rest[1];
        if (!id || id.startsWith("--")) {
          throw new CliUsageError("diagram get requires an exact diagram UUID.");
        }
        const document = await diagrams.get(exactUuidFlag(id, "diagram ID"));
        printJson(stdout, document);
        return 0;
      }
      throw new CliUsageError("diagram requires `publish`, `list`, or `get`. ");
    }

    if (command === "command-ledger") {
      const action = rest[0];
      if (action === "list-unresolved") {
        const ledger = await (dependencies.loadCommandLedger ?? defaultLoadCommandLedger)();
        const records = await ledger.listUnresolvedCommands();
        if (hasFlag(rest, "--json")) {
          printJson(stdout, records);
        } else if (records.length === 0) {
          stdout("No unresolved command records.");
        } else {
          for (const record of records) {
            stdout(`${record.commandId} — device ${record.deviceId} — created ${new Date(record.createdAt).toISOString()} — updated ${new Date(record.updatedAt).toISOString()}`);
          }
        }
        return 0;
      }
      if (action === "forget") {
        if (!hasFlag(rest, "--acknowledge-delivery-unknown")) {
          throw new CliUsageError(
            "command-ledger forget requires --acknowledge-delivery-unknown because the prior command may already have executed.",
          );
        }
        const deviceRaw = flagValue(rest, "--device");
        const commandRaw = flagValue(rest, "--command");
        if (!deviceRaw || !commandRaw) {
          throw new CliUsageError("command-ledger forget requires exact --device and --command UUIDs.");
        }
        const deviceId = exactUuidFlag(deviceRaw, "--device");
        const commandId = exactUuidFlag(commandRaw, "--command");
        stderr(
          "WARNING: forgetting DELIVERY_UNKNOWN permits a future new command and can duplicate an operation that already executed. Stop the bridge and verify the effect independently first.",
        );
        const ledger = await (dependencies.loadCommandLedger ?? defaultLoadCommandLedger)();
        const forgotten = await ledger.forgetUnresolvedCommand(deviceId, commandId);
        if (!forgotten) {
          throw new Error("The exact unresolved device/command record was not found; nothing was changed.");
        }
        if (hasFlag(rest, "--json")) {
          printJson(stdout, { forgotten: true, deviceId, commandId });
        } else {
          stdout(`Forgot unresolved command ${commandId} for device ${deviceId}.`);
        }
        return 0;
      }
      throw new CliUsageError("command-ledger requires `list-unresolved` or `forget`. ");
    }

    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    if (error instanceof CliUsageError) stderr("Run `npm run codex-pad -- help` for usage.");
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

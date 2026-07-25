import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWritePrivateJson, assertPrivateRegularFile, withPrivateFileLock } from "./atomic-file.js";
import { type BridgeDataPaths, defaultDataPaths } from "./paths.js";

export const LEGACY_DEVICE_COOKIE_NAME = "__Host-codex_pad_device";
export const LEGACY_UNSAFE_LAN_DEVICE_COOKIE_NAME = "codex_pad_unsafe_device";
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const WEB_SOCKET_PROTOCOL = "codex-pad.v1";
export const WEB_SOCKET_TICKET_PROTOCOL_PREFIX = "codex-pad.ticket.";
export const WEB_SOCKET_TICKET_TTL_MS = 30_000;
const MAX_DEVICE_NAME_LENGTH = 80;
const MAX_DEVICE_RECORDS = 128;
const MAX_WEB_SOCKET_TICKETS = 256;

const storedDeviceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(MAX_DEVICE_NAME_LENGTH),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

const credentialFileV1Schema = z.object({
  version: z.literal(1),
  devices: z.array(storedDeviceSchema).max(MAX_DEVICE_RECORDS),
});

const credentialFileSchema = z.object({
  version: z.literal(2),
  devices: z.array(storedDeviceSchema).max(MAX_DEVICE_RECORDS),
});

type StoredDevice = z.infer<typeof storedDeviceSchema>;
type CredentialFile = z.infer<typeof credentialFileSchema>;

export interface PublicDevice {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface IssuedCredential {
  device: PublicDevice;
  bearerToken: string;
}

export interface CredentialStoreOptions {
  paths?: BridgeDataPaths;
}

export interface AuthenticatedDevice {
  id: string;
  name: string;
}

export class CredentialCapacityError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("The paired-device limit is full; revoke an unused active device and try again");
    this.name = "CredentialCapacityError";
  }
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function publicDevice(device: StoredDevice): PublicDevice {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    revokedAt: device.revokedAt,
  };
}

function authenticatedDevice(device: StoredDevice): AuthenticatedDevice {
  return { id: device.id, name: device.name };
}

function normalizeDeviceName(name: string): string {
  const normalized = name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (normalized.length === 0 || normalized.length > MAX_DEVICE_NAME_LENGTH) {
    throw new Error(`Device name must be between 1 and ${MAX_DEVICE_NAME_LENGTH} characters`);
  }
  return normalized;
}

function emptyCredentialFile(): CredentialFile {
  return { version: 2, devices: [] };
}

function migrateCredentialFile(raw: unknown): CredentialFile {
  const current = credentialFileSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = credentialFileV1Schema.parse(raw);
  const invalidatedAt = new Date().toISOString();
  return credentialFileSchema.parse({
    version: 2,
    devices: legacy.devices.map((device) => ({
      ...device,
      // Version 1 credentials were host-wide cookies. They must never become
      // valid version 2 bearers even if a leaked cookie is later recovered.
      revokedAt: device.revokedAt ?? invalidatedAt,
    })),
  });
}

function reclaimRevokedRecords(file: CredentialFile): void {
  if (file.devices.length < MAX_DEVICE_RECORDS) return;
  const reclaimable = file.devices
    .filter((device) => device.revokedAt !== null)
    .sort((left, right) => {
      const revoked = Date.parse(left.revokedAt!) - Date.parse(right.revokedAt!);
      return revoked !== 0 ? revoked : Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
  for (const device of reclaimable) {
    if (file.devices.length < MAX_DEVICE_RECORDS) break;
    const index = file.devices.findIndex((candidate) => candidate.id === device.id);
    if (index >= 0) file.devices.splice(index, 1);
  }
}

export class CredentialStore extends EventEmitter {
  readonly paths: BridgeDataPaths;
  #mutation = Promise.resolve();

  constructor(options: CredentialStoreOptions = {}) {
    super();
    this.paths = options.paths ?? defaultDataPaths();
  }

  async issue(name: string): Promise<IssuedCredential> {
    const deviceName = normalizeDeviceName(name);
    return this.#mutate(async (file) => {
      reclaimRevokedRecords(file);
      if (file.devices.length >= MAX_DEVICE_RECORDS) throw new CredentialCapacityError();
      const bearerToken = randomBytes(32).toString("base64url");
      const device: StoredDevice = {
        id: randomUUID(),
        name: deviceName,
        tokenHash: tokenHash(bearerToken).toString("hex"),
        createdAt: new Date().toISOString(),
        revokedAt: null,
      };
      file.devices.push(device);
      return {
        result: { device: publicDevice(device), bearerToken },
        file,
      };
    });
  }

  async verify(bearerToken: string | undefined): Promise<AuthenticatedDevice | null> {
    if (bearerToken === undefined || !BEARER_TOKEN_PATTERN.test(bearerToken)) return null;
    const actual = tokenHash(bearerToken);
    const file = await this.#read();
    let matched: StoredDevice | undefined;
    for (const device of file.devices) {
      const expected = Buffer.from(device.tokenHash, "hex");
      if (actual.length === expected.length && timingSafeEqual(actual, expected) && device.revokedAt === null) {
        matched = device;
      }
    }
    return matched === undefined ? null : authenticatedDevice(matched);
  }

  async activeDevice(id: string): Promise<AuthenticatedDevice | null> {
    if (!z.uuid().safeParse(id).success) return null;
    const device = (await this.#read()).devices.find((candidate) => candidate.id === id && candidate.revokedAt === null);
    return device === undefined ? null : authenticatedDevice(device);
  }

  async list(): Promise<PublicDevice[]> {
    const file = await this.#read();
    return file.devices.map(publicDevice);
  }

  async revoke(id: string): Promise<boolean> {
    if (!z.uuid().safeParse(id).success) return false;
    const revoked = await this.#mutate(async (file) => {
      const device = file.devices.find((candidate) => candidate.id === id);
      if (device === undefined || device.revokedAt !== null) return { result: false, file };
      device.revokedAt = new Date().toISOString();
      return { result: true, file };
    });
    if (revoked) this.emit("revoked", id);
    return revoked;
  }

  async #read(): Promise<CredentialFile> {
    try {
      await assertPrivateRegularFile(this.paths.credentials);
      return migrateCredentialFile(JSON.parse(await readFile(this.paths.credentials, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCredentialFile();
      throw error;
    }
  }

  #mutate<T>(operation: (file: CredentialFile) => Promise<{ result: T; file: CredentialFile }>): Promise<T> {
    const run = this.#mutation.then(async () => withPrivateFileLock(this.paths.credentials, async () => {
      const { result, file } = await operation(await this.#read());
      await atomicWritePrivateJson(this.paths.credentials, credentialFileSchema.parse(file));
      return result;
    }));
    this.#mutation = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function readBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string" || header.length > 128) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/iu.exec(header);
  return match?.[1];
}

/** Expire version 1 host-wide cookies. These headers contain no credential. */
export function legacyCookieClearHeaders(secure = true): string[] {
  const headers = [
    `${LEGACY_UNSAFE_LAN_DEVICE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  ];
  if (secure) {
    headers.unshift(`${LEGACY_DEVICE_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  }
  return headers;
}

interface WebSocketTicketRecord {
  readonly device: AuthenticatedDevice;
  readonly origin: string;
  readonly expiresAt: number;
}

export class WebSocketTicketStore {
  readonly #tickets = new Map<string, WebSocketTicketRecord>();

  issue(device: AuthenticatedDevice, origin: string, now = Date.now()): { ticket: string; expiresAt: number } {
    this.#prune(now);
    while (this.#tickets.size >= MAX_WEB_SOCKET_TICKETS) {
      const oldest = this.#tickets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + WEB_SOCKET_TICKET_TTL_MS;
    this.#tickets.set(tokenHash(ticket).toString("hex"), { device, origin, expiresAt });
    return { ticket, expiresAt };
  }

  consume(ticket: string | undefined, origin: string, now = Date.now()): AuthenticatedDevice | null {
    this.#prune(now);
    if (ticket === undefined || !BEARER_TOKEN_PATTERN.test(ticket)) return null;
    const digest = tokenHash(ticket).toString("hex");
    const record = this.#tickets.get(digest);
    if (record === undefined) return null;
    this.#tickets.delete(digest);
    if (record.expiresAt <= now || record.origin !== origin) return null;
    return record.device;
  }

  revokeDevice(deviceId: string): void {
    for (const [digest, record] of this.#tickets) {
      if (record.device.id === deviceId) this.#tickets.delete(digest);
    }
  }

  #prune(now: number): void {
    for (const [digest, record] of this.#tickets) {
      if (record.expiresAt <= now) this.#tickets.delete(digest);
    }
  }
}

export function readWebSocketTicketProtocol(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string" || header.length > 256) return undefined;
  const protocols = header.split(",").map((protocol) => protocol.trim());
  if (protocols.length !== 2 || !protocols.includes(WEB_SOCKET_PROTOCOL)) return undefined;
  const ticketProtocol = protocols.find((protocol) => protocol.startsWith(WEB_SOCKET_TICKET_PROTOCOL_PREFIX));
  if (ticketProtocol === undefined) return undefined;
  const ticket = ticketProtocol.slice(WEB_SOCKET_TICKET_PROTOCOL_PREFIX.length);
  return BEARER_TOKEN_PATTERN.test(ticket) ? ticket : undefined;
}

export function webSocketTicketProtocol(ticket: string): string {
  if (!BEARER_TOKEN_PATTERN.test(ticket)) throw new Error("Invalid WebSocket ticket");
  return `${WEB_SOCKET_TICKET_PROTOCOL_PREFIX}${ticket}`;
}

export async function listDevices(options: CredentialStoreOptions = {}): Promise<PublicDevice[]> {
  return new CredentialStore(options).list();
}

export async function revokeDevice(id: string, options: CredentialStoreOptions = {}): Promise<boolean> {
  return new CredentialStore(options).revoke(id);
}

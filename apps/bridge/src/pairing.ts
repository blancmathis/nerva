import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import QRCode from "qrcode";
import { atomicWritePrivateJson, assertPrivateRegularFile, withPrivateFileLock } from "./atomic-file.js";
import { type BridgeDataPaths, defaultDataPaths } from "./paths.js";

export const PAIRING_TTL_MS = 5 * 60 * 1_000;

const pairingRecordSchema = z.object({
  version: z.literal(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  publicOrigin: z.url(),
  insecureDevelopment: z.literal(true).optional(),
  expiresAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable(),
  deviceNameHint: z.string().min(1).max(80).optional(),
}).strict().superRefine((record, context) => {
  const origin = new URL(record.publicOrigin);
  const validProtocol = origin.protocol === "https:"
    || (record.insecureDevelopment === true && origin.protocol === "http:");
  if (!validProtocol) {
      context.addIssue({ code: "custom", message: "Pairing requires HTTPS unless unsafe development mode was explicit", path: ["publicOrigin"] });
  }
  if (origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    context.addIssue({ code: "custom", message: "Pairing origin cannot contain credentials, a path, query, or fragment", path: ["publicOrigin"] });
  }
  if (record.insecureDevelopment === true) {
    const hostname = origin.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(hostname) === 0 || ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(hostname) || hostname.startsWith("127.")) {
      context.addIssue({ code: "custom", message: "Unsafe development pairing requires one concrete non-loopback IP", path: ["publicOrigin"] });
    }
  }
});

type PairingRecord = z.infer<typeof pairingRecordSchema>;

export interface PairingInfo {
  qrPayload: string;
  expiresAt: string;
  consumed: boolean;
  expired: boolean;
  insecureDevelopment?: true;
  deviceNameHint?: string;
}

export async function renderPairingQr(
  infoOrPayload: PairingInfo | string,
  options: { type?: "terminal" | "svg" } = {},
): Promise<string> {
  const payload = typeof infoOrPayload === "string" ? infoOrPayload : infoOrPayload.qrPayload;
  const insecureDevelopment = typeof infoOrPayload === "string" ? false : infoOrPayload.insecureDevelopment === true;
  const parsed = new URL(payload);
  const validProtocol = parsed.protocol === "https:" || (insecureDevelopment && parsed.protocol === "http:");
  const fragment = new URLSearchParams(parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash);
  if (
    !validProtocol
    || parsed.pathname !== "/pair"
    || parsed.search !== ""
    || fragment.size !== 1
    || !fragment.has("pair")
  ) {
    throw new Error("Refusing to render a pairing QR with unexpected content");
  }
  return QRCode.toString(payload, {
    type: options.type ?? "terminal",
    errorCorrectionLevel: "M",
    margin: 2,
  });
}

export interface PairingOptions {
  paths?: BridgeDataPaths;
}

export interface RotatePairingOptions extends PairingOptions {
  publicOrigin: string;
  deviceNameHint?: string;
  now?: Date;
  allowInsecureHttp?: boolean;
}

function pairingUrl(record: PairingRecord): string {
  const url = new URL("/pair", record.publicOrigin);
  url.hash = new URLSearchParams({ pair: record.nonce }).toString();
  return url.toString();
}

export function pairingNonceFromUrl(value: string): string | null {
  const url = new URL(value);
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  return url.search === "" && fragment.size === 1 ? fragment.get("pair") : null;
}

function publicInfo(record: PairingRecord, now = new Date()): PairingInfo {
  return {
    qrPayload: pairingUrl(record),
    expiresAt: record.expiresAt,
    consumed: record.consumedAt !== null,
    expired: Date.parse(record.expiresAt) <= now.getTime(),
    ...(record.insecureDevelopment === true ? { insecureDevelopment: true as const } : {}),
    ...(record.deviceNameHint === undefined ? {} : { deviceNameHint: record.deviceNameHint }),
  };
}

async function readRecord(paths: BridgeDataPaths): Promise<PairingRecord | null> {
  try {
    await assertPrivateRegularFile(paths.pairing);
    return pairingRecordSchema.parse(JSON.parse(await readFile(paths.pairing, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function rotatePairingCode(options: RotatePairingOptions): Promise<PairingInfo> {
  const now = options.now ?? new Date();
  const origin = new URL(options.publicOrigin);
  const insecureDevelopment = options.allowInsecureHttp === true && origin.protocol === "http:";
  const originHost = origin.hostname.replace(/^\[|\]$/gu, "");
  if (
    (origin.protocol !== "https:" && !insecureDevelopment)
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
  ) {
    throw new Error("publicOrigin must be an HTTPS origin without credentials or a path unless explicit unsafe HTTP development pairing is enabled");
  }
  if (
    insecureDevelopment
    && (isIP(originHost) === 0 || ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(originHost) || originHost.startsWith("127."))
  ) {
    throw new Error("Unsafe HTTP development pairing requires one concrete non-loopback IP address");
  }
  const record: PairingRecord = {
    version: 1,
    nonce: randomBytes(32).toString("base64url"),
    publicOrigin: origin.origin,
    ...(insecureDevelopment ? { insecureDevelopment: true as const } : {}),
    expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    consumedAt: null,
    ...(options.deviceNameHint === undefined ? {} : { deviceNameHint: options.deviceNameHint }),
  };
  const paths = options.paths ?? defaultDataPaths();
  await withPrivateFileLock(paths.pairing, () =>
    atomicWritePrivateJson(paths.pairing, pairingRecordSchema.parse(record)),
  );
  return publicInfo(record, now);
}

export async function showPairingInfo(options: PairingOptions = {}): Promise<PairingInfo | null> {
  const record = await readRecord(options.paths ?? defaultDataPaths());
  return record === null ? null : publicInfo(record);
}

export type PairingConsumeResult =
  | { ok: true; info: PairingInfo }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "mismatch" | "origin" };

export type PairingRedeemResult<T> =
  | { ok: true; info: PairingInfo; value: T }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "mismatch" | "origin" };

function requestOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export class PairingStore {
  readonly paths: BridgeDataPaths;
  #mutation = Promise.resolve();

  constructor(options: PairingOptions = {}) {
    this.paths = options.paths ?? defaultDataPaths();
  }

  rotate(options: Omit<RotatePairingOptions, "paths">): Promise<PairingInfo> {
    return this.#serialized(() => rotatePairingCode({ ...options, paths: this.paths }));
  }

  show(): Promise<PairingInfo | null> {
    return showPairingInfo({ paths: this.paths });
  }

  async consume(nonce: string, origin: string, now = new Date()): Promise<PairingConsumeResult> {
    const result = await this.redeem(nonce, origin, async () => undefined, async () => undefined, now);
    return result.ok ? { ok: true, info: result.info } : result;
  }

  redeem<T>(
    nonce: string,
    origin: string,
    issue: () => Promise<T>,
    rollback: (value: T) => Promise<void>,
    now = new Date(),
  ): Promise<PairingRedeemResult<T>> {
    return this.#serialized(async () => {
      return withPrivateFileLock(this.paths.pairing, async () => {
        const record = await readRecord(this.paths);
        if (record === null) return { ok: false, reason: "missing" };
        if (record.consumedAt !== null) return { ok: false, reason: "consumed" };
        if (Date.parse(record.expiresAt) <= now.getTime()) return { ok: false, reason: "expired" };
        if (requestOrigin(origin) !== record.publicOrigin) return { ok: false, reason: "origin" };
        const supplied = Buffer.from(nonce, "utf8");
        const expected = Buffer.from(record.nonce, "utf8");
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          return { ok: false, reason: "mismatch" };
        }
        // The nonce is committed only after credential issuance succeeds. If
        // the pairing record cannot be committed, revoke the unexposed result.
        const value = await issue();
        record.consumedAt = now.toISOString();
        try {
          await atomicWritePrivateJson(this.paths.pairing, pairingRecordSchema.parse(record));
        } catch (error) {
          await rollback(value).catch(() => undefined);
          throw error;
        }
        return { ok: true, info: publicInfo(record, now), value };
      });
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutation.then(operation);
    this.#mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

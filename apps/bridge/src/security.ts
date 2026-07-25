import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface SecurityOptions {
  host: string;
  port: number;
  publicOrigin?: string;
  allowedOrigins?: readonly string[];
  unsafeLan?: boolean;
}

export interface RequestSecurity {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedHosts: ReadonlySet<string>;
  assertHost(request: FastifyRequest): void;
  /** Returns the normalized allowlisted origin, or null when an origin was optional and absent. */
  assertOrigin(request: FastifyRequest, required?: boolean): string | null;
  /**
   * Opaque identity for pre-authentication abuse controls. Supplying the
   * presented credential isolates a legitimate device from unrelated guesses;
   * the credential itself is never retained.
   */
  authRateKey(request: FastifyRequest, presentedCredential?: string): string;
  pairRateKey(request: FastifyRequest): string;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface DualScopeRateLimiterOptions {
  readonly perKeyLimit: number;
  readonly perKeyWindowMs: number;
  readonly globalLimit: number;
  readonly globalWindowMs: number;
  readonly maxKeys?: number;
}

export interface ConcurrencyLease {
  /** Idempotent: callers should still invoke this exactly once from `finally`. */
  release(): void;
}

export class SecurityError extends Error {
  readonly statusCode = 403;
  constructor(message = "Request rejected by bridge security policy") {
    super(message);
    this.name = "SecurityError";
  }
}

function normalizedOrigin(input: string): string {
  const url = new URL(input);
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`Expected an origin, received ${input}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported origin protocol: ${url.protocol}`);
  }
  return url.origin;
}

function hostWithoutDefaultPort(origin: string): string {
  return new URL(origin).host.toLowerCase();
}

function parseHostHeader(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 255 || /[\s/@\\]/u.test(value)) {
    throw new SecurityError("Invalid Host header");
  }
  return value.toLowerCase();
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function isConcreteNonLoopbackIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return isIP(host) !== 0
    && host !== "0.0.0.0"
    && host !== "::"
    && host !== "::1"
    && host !== "127.0.0.1"
    && !host.startsWith("127.");
}

export function validateListenSecurity(options: SecurityOptions): void {
  if (options.port < 1 || options.port > 65_535 || !Number.isInteger(options.port)) {
    throw new Error("Bridge port must be an integer between 1 and 65535");
  }
  if (options.publicOrigin !== undefined) {
    const origin = new URL(normalizedOrigin(options.publicOrigin));
    if (
      origin.protocol === "http:"
      && (options.unsafeLan !== true || !isConcreteNonLoopbackIp(origin.hostname))
    ) {
      throw new Error("HTTP publicOrigin requires explicit unsafeLan mode and one concrete non-loopback IP address");
    }
  }
  if (isLoopbackHost(options.host)) return;
  if (options.host === "0.0.0.0" || options.host === "::") {
    throw new Error("Refusing wildcard bind; unsafe LAN mode requires one explicit interface address");
  }
  if (options.unsafeLan !== true) {
    throw new Error("Non-loopback binding requires explicit unsafeLan: true opt-in");
  }
  if (options.publicOrigin === undefined && (options.allowedOrigins?.length ?? 0) === 0) {
    throw new Error("Unsafe LAN mode still requires an explicit browser Origin allowlist");
  }
}

export function createRequestSecurity(options: SecurityOptions): RequestSecurity {
  validateListenSecurity(options);
  const origins = new Set<string>();
  origins.add(`http://127.0.0.1:${options.port}`);
  origins.add(`http://localhost:${options.port}`);
  if (options.publicOrigin !== undefined) origins.add(normalizedOrigin(options.publicOrigin));
  for (const origin of options.allowedOrigins ?? []) origins.add(normalizedOrigin(origin));

  const hosts = new Set<string>();
  hosts.add(`127.0.0.1:${options.port}`);
  hosts.add(`localhost:${options.port}`);
  hosts.add(options.host.toLowerCase());
  hosts.add(`${options.host.toLowerCase()}:${options.port}`);
  for (const origin of origins) hosts.add(hostWithoutDefaultPort(origin));

  const authRateKey = (request: FastifyRequest, presentedCredential?: string): string => {
    const tailscaleIdentity = firstHeader(request.headers["tailscale-user-login"]);
    const forwardedFor = firstHeader(request.headers["x-forwarded-for"]).split(",")[0]?.trim() ?? "";
    const userAgent = firstHeader(request.headers["user-agent"]).slice(0, 256);
    const credentialDigest = presentedCredential === undefined
      ? "missing"
      : createHash("sha256").update(presentedCredential, "utf8").digest("base64url");
    const source = `${tailscaleIdentity}\u0000${forwardedFor}\u0000${userAgent}\u0000${credentialDigest}`;
    return createHash("sha256").update(source, "utf8").digest("base64url");
  };

  return {
    allowedOrigins: origins,
    allowedHosts: hosts,
    assertHost(request) {
      const host = parseHostHeader(request.headers.host);
      if (!hosts.has(host)) throw new SecurityError("Host is not allowlisted");
    },
    assertOrigin(request, required = false) {
      const origin = firstHeader(request.headers.origin);
      if (origin === "") {
        if (required) throw new SecurityError("Missing Origin header");
        return null;
      }
      let normalized: string;
      try {
        normalized = normalizedOrigin(origin);
      } catch {
        throw new SecurityError("Invalid Origin header");
      }
      if (!origins.has(normalized)) throw new SecurityError("Origin is not allowlisted");
      return normalized;
    },
    authRateKey,
    pairRateKey(request) {
      return authRateKey(request);
    },
  };
}

export class FixedWindowRateLimiter {
  readonly #attempts = new Map<string, { count: number; resetsAt: number }>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys = 1_024,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Rate limit must be a positive safe integer");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("Rate-limit window must be a positive safe integer");
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error("Rate-limit key bound must be a positive safe integer");
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    this.#prune(now, key);
    const current = this.#attempts.get(key);
    if (current === undefined || current.resetsAt <= now) {
      this.#attempts.set(key, { count: 1, resetsAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetsAt - now) / 1_000)) };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Checks an existing window without incrementing it or allocating a key. */
  check(key: string, now = Date.now()): RateLimitDecision {
    const current = this.#attempts.get(key);
    if (current === undefined || current.resetsAt <= now || current.count < this.limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetsAt - now) / 1_000)),
    };
  }

  #prune(now: number, incomingKey: string): void {
    // Updating an existing key cannot increase cardinality. Avoid evicting its
    // active window merely because the map is exactly at capacity.
    if (this.#attempts.has(incomingKey)) return;
    if (this.#attempts.size < this.maxKeys) return;
    for (const [key, attempt] of this.#attempts) {
      if (attempt.resetsAt <= now) this.#attempts.delete(key);
    }
    while (this.#attempts.size >= this.maxKeys) {
      const oldest = this.#attempts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#attempts.delete(oldest);
    }
  }
}

/**
 * Applies both a per-identity limit and a bridge-wide burst ceiling. The two
 * counters are deliberately independent: one noisy device cannot evade its
 * own limit, while many device identities cannot evade the global ceiling.
 */
export class DualScopeRateLimiter {
  readonly #perKey: FixedWindowRateLimiter;
  readonly #global: FixedWindowRateLimiter;

  constructor(options: DualScopeRateLimiterOptions) {
    this.#perKey = new FixedWindowRateLimiter(
      options.perKeyLimit,
      options.perKeyWindowMs,
      options.maxKeys,
    );
    this.#global = new FixedWindowRateLimiter(options.globalLimit, options.globalWindowMs, 1);
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const global = this.#global.consume("global", now);
    const perKey = this.#perKey.consume(key, now);
    return {
      allowed: global.allowed && perKey.allowed,
      retryAfterSeconds: Math.max(global.retryAfterSeconds, perKey.retryAfterSeconds),
    };
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const global = this.#global.check("global", now);
    const perKey = this.#perKey.check(key, now);
    return {
      allowed: global.allowed && perKey.allowed,
      retryAfterSeconds: Math.max(global.retryAfterSeconds, perKey.retryAfterSeconds),
    };
  }

  /** Checks only the presented identity; valid credentials are not blocked by unrelated global failures. */
  checkKey(key: string, now = Date.now()): RateLimitDecision {
    return this.#perKey.check(key, now);
  }
}

/**
 * Immediate admission control for CPU/process-heavy work. Active identities
 * are removed when their last lease is released, so key cardinality is bounded
 * by the global concurrency ceiling.
 */
export class DualScopeConcurrencyLimiter {
  readonly #perKeyActive = new Map<string, number>();
  #globalActive = 0;

  constructor(
    readonly perKeyLimit: number,
    readonly globalLimit: number,
  ) {
    if (!Number.isSafeInteger(perKeyLimit) || perKeyLimit < 1) {
      throw new Error("Per-key concurrency limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(globalLimit) || globalLimit < perKeyLimit) {
      throw new Error("Global concurrency limit must be a safe integer at least as large as the per-key limit");
    }
  }

  tryAcquire(key: string): ConcurrencyLease | null {
    const perKeyActive = this.#perKeyActive.get(key) ?? 0;
    if (perKeyActive >= this.perKeyLimit || this.#globalActive >= this.globalLimit) return null;
    this.#perKeyActive.set(key, perKeyActive + 1);
    this.#globalActive += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        // Only this lease can execute this branch, so the acquired counters
        // must still exist. Keep cleanup non-throwing so it cannot replace the
        // authoritative result of the protected operation.
        const current = this.#perKeyActive.get(key) ?? 1;
        if (current === 1) this.#perKeyActive.delete(key);
        else this.#perKeyActive.set(key, current - 1);
        this.#globalActive = Math.max(0, this.#globalActive - 1);
      },
    };
  }
}

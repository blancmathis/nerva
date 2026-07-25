declare const EXACT_TARGET_AUTHORITY_BRAND: unique symbol;

/** Opaque, process-local proof of one exact authoritative native target observation. */
export interface ExactTargetAuthorityToken {
  readonly [EXACT_TARGET_AUTHORITY_BRAND]: true;
}

interface ExactTargetAuthorityState {
  readonly assertCurrent: () => void;
  used: boolean;
}

export interface ExactTargetAuthorityIssuer {
  issue(assertCurrent: () => void): ExactTargetAuthorityToken;
}

export type ExactTargetAuthorityConsumer = (token: ExactTargetAuthorityToken) => void;

export interface ExactTargetAuthorityDomain {
  /** Pass only to the authoritative BridgeStateService instance. */
  readonly stateIssuer: ExactTargetAuthorityIssuer;
  /** Pass only to the managed write-authority provider for this same domain. */
  readonly providerConsumer: ExactTargetAuthorityConsumer;
}

export class ExactTargetAuthorityError extends Error {
  readonly code = "APP_SERVER_TARGET_STALE";
  readonly detail = { phase: "pre-write" } as const;

  constructor(message = "The exact native target authority changed before dispatch.", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExactTargetAuthorityError";
  }
}

/**
 * Create one isolated authority domain. A token minted by any other domain is
 * rejected by this domain's consumer, so access to the public factory cannot
 * forge authority for the production provider. The state-owned issuer is not
 * retained by the transport or app-server client.
 */
export function createExactTargetAuthorityDomain(): ExactTargetAuthorityDomain {
  const authorities = new WeakMap<object, ExactTargetAuthorityState>();
  const stateIssuer: ExactTargetAuthorityIssuer = Object.freeze({
    issue(assertCurrent: () => void): ExactTargetAuthorityToken {
      const token = Object.freeze({});
      authorities.set(token, { assertCurrent, used: false });
      return token as ExactTargetAuthorityToken;
    },
  });
  const providerConsumer: ExactTargetAuthorityConsumer = (token) => {
    const state = authorities.get(token);
    if (state === undefined || state.used) throw new ExactTargetAuthorityError();
    // Consume before checking so a failing or re-entrant check cannot reuse it.
    state.used = true;
    authorities.delete(token);
    try {
      const validationResult = state.assertCurrent();
      if (validationResult !== undefined) {
        throw new Error("exact target validation must complete synchronously");
      }
    } catch (error) {
      if (error instanceof ExactTargetAuthorityError) throw error;
      throw new ExactTargetAuthorityError(undefined, error);
    }
  };
  return Object.freeze({ stateIssuer, providerConsumer });
}

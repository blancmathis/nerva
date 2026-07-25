import { withPrivateFileLock, type PrivateFileLockOptions } from "./atomic-file.js";
import type { BridgeDataPaths } from "./paths.js";

export interface BridgeLifetimeLease {
  release(): Promise<void>;
}

export class BridgeLifetimeLeaseError extends Error {
  readonly code = "BRIDGE_ALREADY_RUNNING";
  readonly retryable = true;

  constructor(cause?: unknown) {
    super(
      "Could not acquire the exclusive Codex Pad data-root lease. Stop the running bridge and retry; a recently crashed bridge lock is recovered conservatively.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "BridgeLifetimeLeaseError";
  }
}

export interface AcquireBridgeLifetimeLeaseOptions {
  lockOptions?: PrivateFileLockOptions;
}

/**
 * Acquire one crash-recoverable lease for the entire data root. The returned
 * release handle owns the underlying private file lock until release settles.
 */
export async function acquireBridgeLifetimeLease(
  paths: BridgeDataPaths,
  options: AcquireBridgeLifetimeLeaseOptions = {},
): Promise<BridgeLifetimeLease> {
  let markAcquired!: () => void;
  let markFailed!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    markAcquired = resolve;
    markFailed = reject;
  });
  let releaseOwner!: () => void;
  const held = new Promise<void>((resolve) => { releaseOwner = resolve; });

  const owner = withPrivateFileLock(
    paths.bridgeLifetime,
    async () => {
      markAcquired();
      await held;
    },
    {
      timeoutMs: 0,
      ...(options.lockOptions ?? {}),
    },
  );
  void owner.catch(markFailed);

  try {
    await acquired;
  } catch (error) {
    await owner.catch(() => undefined);
    throw new BridgeLifetimeLeaseError(error);
  }

  let released = false;
  let releasePromise: Promise<void> | null = null;
  return {
    release(): Promise<void> {
      if (released) return releasePromise ?? Promise.resolve();
      released = true;
      releaseOwner();
      releasePromise = owner;
      return releasePromise;
    },
  };
}

export async function withBridgeLifetimeLease<T>(
  paths: BridgeDataPaths,
  operation: () => Promise<T>,
  options: AcquireBridgeLifetimeLeaseOptions = {},
): Promise<T> {
  const lease = await acquireBridgeLifetimeLease(paths, options);
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

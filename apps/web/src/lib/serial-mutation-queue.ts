export interface SerialMutationQueue {
  enqueue<T>(mutation: () => Promise<T>): Promise<T>;
  settled(): Promise<void>;
}

/**
 * Keep persistence mutations in invocation order while allowing a failed write
 * to reject only its own caller. Later writes must still run so the newest
 * in-memory state can recover storage after a transient failure.
 */
export function createSerialMutationQueue(): SerialMutationQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(mutation: () => Promise<T>): Promise<T> {
      const queued = tail.then(mutation, mutation);
      tail = queued.then(() => undefined, () => undefined);
      return queued;
    },
    settled(): Promise<void> {
      return tail;
    },
  };
}

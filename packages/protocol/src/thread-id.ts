import { UUID_PATTERN } from "./primitives.js";

const UUID_SOURCE = UUID_PATTERN.source.slice(1, -1);

/**
 * Native keys are either a UUID or up to three colon-delimited, identifier-like
 * namespaces followed by a UUID. Restricting the entire value prevents a
 * thread key from being interpreted as a path, URL, or arbitrary locator.
 */
export const NATIVE_THREAD_KEY_PATTERN = new RegExp(
  `^(?:(?:[a-z][a-z0-9_-]{0,31}):){0,3}(${UUID_SOURCE})$`,
  "i",
);

export function extractThreadUuid(threadKey: unknown): string | null {
  if (typeof threadKey !== "string") {
    return null;
  }

  return NATIVE_THREAD_KEY_PATTERN.exec(threadKey)?.[1]?.toLowerCase() ?? null;
}

export const extractThreadId = extractThreadUuid;
export const threadIdFromThreadKey = extractThreadUuid;

export function isSafeNativeThreadKey(threadKey: unknown): threadKey is string {
  return extractThreadUuid(threadKey) !== null;
}

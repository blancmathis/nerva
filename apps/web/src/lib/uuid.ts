/**
 * Creates an RFC 4122 version 4 identifier for non-secret, client-side identities.
 *
 * `crypto.randomUUID()` is unavailable in some insecure Safari contexts, while
 * `crypto.getRandomValues()` remains available. Credentials and security tokens
 * must continue to use their dedicated cryptographic generators instead.
 */
export function createUuidV4(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = globalThis.crypto;

  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    fillLastResortBytes(bytes);
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let lastResortCounter = 0;

function fillLastResortBytes(bytes: Uint8Array): void {
  // This branch only keeps non-security UI IDs usable in runtimes without
  // Web Crypto. Mix time, Math.random, and a process-local counter so even a
  // stalled clock or degraded PRNG does not repeat the immediately prior ID.
  lastResortCounter = (lastResortCounter + 0x9e37_79b9) >>> 0;
  let state = (
    Date.now()
    ^ Math.floor(Math.random() * 0x1_0000_0000)
    ^ lastResortCounter
  ) >>> 0;
  if (state === 0) state = 0x6d2b_79f5;

  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = (state ^ Math.floor(Math.random() * 256)) & 0xff;
  }
}

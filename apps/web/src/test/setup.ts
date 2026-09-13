import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

const testCrypto = {
  subtle: webcrypto.subtle,
  getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
} as Crypto;

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: testCrypto,
});

Object.defineProperty(globalThis, "createImageBitmap", {
  configurable: true,
  value: async () => ({
    width: 1_000,
    height: 625,
    close: () => undefined,
  }),
});

// Newer Node versions expose their own Web Storage globals. Browser tests
// must use the per-test JSDOM origin, not Node's optional file-backed store.
// https://vitest.dev/config/environment documents the jsdom instance global.
const browserWindow = (globalThis as typeof globalThis & {
  jsdom: { window: Pick<Window, "localStorage" | "sessionStorage"> };
}).jsdom.window;
for (const key of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: browserWindow[key],
  });
}

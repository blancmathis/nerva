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

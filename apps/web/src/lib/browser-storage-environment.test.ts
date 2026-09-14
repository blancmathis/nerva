import { describe, expect, it } from "vitest";

describe("browser storage environment", () => {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    it(`uses isolated DOM ${name} on supported Node versions`, () => {
      const storage = globalThis[name];
      expect(storage).toBe(window[name]);
      storage.setItem("environment-proof", "retained");
      expect(storage.getItem("environment-proof")).toBe("retained");
      storage.removeItem("environment-proof");
      expect(storage.getItem("environment-proof")).toBeNull();
    });
  }
});

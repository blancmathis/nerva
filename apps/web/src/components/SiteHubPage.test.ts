import { describe, expect, it } from "vitest";
import { normalizeSiteAddress } from "./SiteHubPage";

describe("normalizeSiteAddress", () => {
  it("adds a useful default protocol for public and local addresses", () => {
    expect(normalizeSiteAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeSiteAddress("127.0.0.1:8787")).toBe("http://127.0.0.1:8787/");
    expect(normalizeSiteAddress("localhost:4319/path")).toBe("http://localhost:4319/path");
  });

  it("rejects non-web protocols and embedded credentials", () => {
    expect(() => normalizeSiteAddress("javascript:alert(1)")).toThrow(/HTTP\(S\)/u);
    expect(() => normalizeSiteAddress("https://user:secret@example.com")).toThrow(/credentials/u);
  });
});

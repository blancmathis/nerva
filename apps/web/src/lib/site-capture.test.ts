import { describe, expect, it } from "vitest";
import { associatedSitePath, capturedFrameGeometry, publicCapturedSiteUrl } from "./site-capture";

describe("site capture metadata", () => {
  it("returns only the root-relative path for an exact public HTTPS origin", () => {
    expect(associatedSitePath("https://demo.tailnet.ts.net/review?a=1#note", "https://demo.tailnet.ts.net")).toBe("/review?a=1");
    expect(() => associatedSitePath("http://127.0.0.1:3000/", "http://127.0.0.1:3000")).toThrow(/public HTTPS/);
  });

  it("records the Mac preset's actual DPR rather than the initiating iPad DPR", () => {
    expect(capturedFrameGeometry({ width: 1194, height: 834, scroll: { x: 0, y: 120 } })).toEqual({
      viewport: { width: 1194, height: 834, deviceScaleFactor: 1 },
      scroll: { x: 0, y: 120 },
    });
  });

  it("maps a validated redirected route onto only the approved public origin", () => {
    expect(publicCapturedSiteUrl("/final/dashboard?tab=build", "https://demo.tailnet.ts.net"))
      .toBe("https://demo.tailnet.ts.net/final/dashboard?tab=build");
    expect(() => publicCapturedSiteUrl("//attacker.example/", "https://demo.tailnet.ts.net"))
      .toThrow(/invalid final site route/);
    expect(() => publicCapturedSiteUrl("https://127.0.0.1:3000/private", "https://demo.tailnet.ts.net"))
      .toThrow(/invalid final site route/);
    expect(() => publicCapturedSiteUrl("/final#private-origin", "https://demo.tailnet.ts.net"))
      .toThrow(/invalid final site route/);
    expect(() => publicCapturedSiteUrl("/ok\\private", "https://demo.tailnet.ts.net"))
      .toThrow(/invalid final site route/);
  });
});

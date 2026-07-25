import { describe, expect, it } from "vitest";

import { createExactTargetAuthorityDomain } from "./exact-target-authority.js";

describe("exact target authority domains", () => {
  it("rejects cross-domain tokens and consumes valid tokens exactly once", () => {
    const production = createExactTargetAuthorityDomain();
    const foreign = createExactTargetAuthorityDomain();
    const foreignToken = foreign.stateIssuer.issue(() => undefined);

    expect(() => production.providerConsumer(foreignToken)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_TARGET_STALE" }),
    );

    const token = production.stateIssuer.issue(() => undefined);
    expect(() => production.providerConsumer(token)).not.toThrow();
    expect(() => production.providerConsumer(token)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_TARGET_STALE" }),
    );
  });

  it("consumes before invoking the current-generation check", () => {
    const authority = createExactTargetAuthorityDomain();
    let checks = 0;
    const token = authority.stateIssuer.issue(() => {
      checks += 1;
      throw new Error("stale selection");
    });

    expect(() => authority.providerConsumer(token)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_TARGET_STALE" }),
    );
    expect(() => authority.providerConsumer(token)).toThrowError(
      expect.objectContaining({ code: "APP_SERVER_TARGET_STALE" }),
    );
    expect(checks).toBe(1);
  });
});

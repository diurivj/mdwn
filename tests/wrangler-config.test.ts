import { unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vitest";

/** Wrangler's own resolution of wrangler.jsonc, per environment, without network or remote calls. */
function resolved(env?: "preview" | "production") {
  return unstable_readConfig({ config: "wrangler.jsonc", env });
}

describe("Worker placement (ticket 57)", () => {
  it.each(["preview", "production"] as const)("enables Smart Placement for the %s Worker", (env) => {
    expect(resolved(env).placement).toEqual({ mode: "smart" });
  });

  it("leaves the never-deployed local Worker without a placement", () => {
    expect(resolved().name).toBe("mdwn-local");
    expect(resolved().placement).toBeUndefined();
  });
});

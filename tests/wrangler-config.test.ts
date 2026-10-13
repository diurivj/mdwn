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

describe("Worker CPU ceiling (ticket 63)", () => {
  it.each(["preview", "production"] as const)("caps the %s Worker at 500 ms of CPU per invocation", (env) => {
    expect(resolved(env).limits).toEqual({ cpu_ms: 500 });
  });

  it("leaves the never-deployed local Worker without a CPU limit", () => {
    expect(resolved().limits).toBeUndefined();
  });
});

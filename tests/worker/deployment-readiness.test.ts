import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("deployed Worker identity", () => {
  it("includes the runtime's version ID in the health probe", async () => {
    const response = await SELF.fetch("https://mdwn.test/healthz");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      appEnv: "local",
      db: "connected",
      versionId: expect.any(String),
    });
    if (typeof body !== "object" || body === null || !("versionId" in body)) {
      throw new Error("health probe is missing the Worker version ID");
    }
    expect(body.versionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

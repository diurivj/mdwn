import { describe, expect, it, vi } from "vitest";

import { deployedVersionId, waitForDeployment } from "../scripts/lib/deployment-readiness.mjs";

const NEW_VERSION = "73b39617-4ba4-4c7e-9466-db07190f943d";
const OLD_VERSION = "36d94315-92ef-48e8-8f92-3f5956d5df67";
const CSP = "default-src 'none'; script-src 'self'";
const health = (versionId: string) => Response.json({
  ok: true,
  appEnv: "preview",
  db: "connected",
  versionId,
});
const session = () => Response.json({ authenticated: false });
const shell = () => new Response(null, {
  headers: { "Content-Security-Policy": CSP },
});

function fetchSequence(...responses: Response[]) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  return fetchImpl;
}

const params = {
  target: "preview" as const,
  expectedVersionId: NEW_VERSION,
  token: "a-test-token-not-a-deployment-secret",
  maxAttempts: 3,
  delayMs: 0,
  sleep: async () => {},
};

describe("deployment version identity", () => {
  it("extracts the exact Wrangler version from a successful deploy log", () => {
    expect(deployedVersionId(`Deployed mdwn-preview triggers\n  https://example.test\nCurrent Version ID: ${NEW_VERSION}\n`)).toBe(NEW_VERSION);
    expect(deployedVersionId(`\u001b[32mCurrent Version ID: ${NEW_VERSION}\u001b[0m\n`)).toBe(NEW_VERSION);
    expect(() => deployedVersionId("Uploaded worker but no ID\n")).toThrow(/version ID/i);
    expect(() => deployedVersionId(`Current Version ID: ${OLD_VERSION}\nCurrent Version ID: ${NEW_VERSION}\n`)).toThrow(/version ID/i);
  });
});

describe("bounded readiness", () => {
  it("rejects a healthy OLD Worker, then retries a stale auth route until this deployment answers", async () => {
    const fetchImpl = fetchSequence(
      health(OLD_VERSION),
      health(NEW_VERSION), Response.json({ error: "not found" }, { status: 404 }),
      health(NEW_VERSION), session(), shell(),
    );
    const sleep = vi.fn(async () => {});
    await expect(waitForDeployment({ ...params, sleep, fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : url).pathname)).toEqual([
      "/healthz", "/healthz", "/api/auth/session", "/healthz", "/api/auth/session", "/",
    ]);
    expect(fetchImpl.mock.calls.every(([url]) => new URL(url instanceof Request ? url.url : url).origin === "https://mdwn-preview.diurivj.workers.dev")).toBe(true);
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.method).toBe("HEAD");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: `Bearer ${params.token}`,
    });
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toBeUndefined();
  });

  it("bounds retries and fails closed when the requested version never appears", async () => {
    const fetchImpl = fetchSequence(
      health(OLD_VERSION), health(OLD_VERSION), health(OLD_VERSION),
    );
    await expect(waitForDeployment({ ...params, fetchImpl })).rejects.toThrow(/3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats transient 404/503 as retryable, but rejects bad credentials immediately", async () => {
    const fetchImpl = fetchSequence(
      new Response(null, { status: 404 }),
      new Response(null, { status: 503 }),
      health(NEW_VERSION), session(), shell(),
    );
    await expect(waitForDeployment({ ...params, fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    const unauthorized = fetchSequence(new Response(null, { status: 401 }));
    await expect(waitForDeployment({ ...params, fetchImpl: unauthorized })).rejects.toThrow(/health probe unauthorized/);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("checks CSP on the same rollout and refuses absent version metadata", async () => {
    const missingCsp = fetchSequence(health(NEW_VERSION), session(), new Response());
    await expect(waitForDeployment({ ...params, maxAttempts: 1, fetchImpl: missingCsp })).rejects.toThrow(/CSP/);

    const missingMetadata = fetchSequence(Response.json({ ok: true, appEnv: "preview", db: "connected" }));
    await expect(waitForDeployment({ ...params, maxAttempts: 1, fetchImpl: missingMetadata })).rejects.toThrow(/version/);
  });

  it("rejects a matching version that reports an unhealthy or wrong environment", async () => {
    const wrongEnvironment = fetchSequence(Response.json({
      ok: true, appEnv: "production", db: "connected", versionId: NEW_VERSION,
    }));
    await expect(waitForDeployment({ ...params, maxAttempts: 1, fetchImpl: wrongEnvironment })).rejects.toThrow(/unhealthy Worker/);
    expect(wrongEnvironment).toHaveBeenCalledTimes(1);
  });

  it("uses the production hostname and checks the production environment", async () => {
    const fetchImpl = fetchSequence(Response.json({
      ok: true, appEnv: "production", db: "connected", versionId: NEW_VERSION,
    }), session(), shell());
    await expect(waitForDeployment({ ...params, target: "production", fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.every(([url]) => new URL(url instanceof Request ? url.url : url).origin === "https://mdwn.diurivj.workers.dev")).toBe(true);
  });
});

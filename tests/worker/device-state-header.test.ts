import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { sessionBindingDigest, signDeviceProof } from "../../app/shared/device/proof";
import { recoveryCookie } from "./auth-fixtures";
import { sharingAccount, sharingRequest, type SharingAccount } from "./sharing-fixtures";

const DEVICE_STATE = "X-Mdwn-Device-State";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function deviceState(cookie: string, headers: Record<string, string> = {}) {
  return SELF.fetch("https://mdwn.test/api/device/state", { headers: { cookie, ...headers } });
}

/** A proof-guarded request with a proof that need not verify. */
function withProof(path: string, cookie: string | null, proof: unknown, method = "POST") {
  return SELF.fetch(`https://mdwn.test${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      origin: "https://mdwn.test",
      "CF-Connecting-IP": "203.0.113.7",
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
    },
  });
}

async function signedProof(account: SharingAccount, path: string, registryEpoch = account.registryEpoch) {
  return signDeviceProof(account.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(account.session.id),
    deviceId: account.deviceId,
    registryEpoch,
    method: "POST",
    url: `https://mdwn.test${path}`,
  });
}

describe("X-Mdwn-Device-State on proof-guarded responses", () => {
  it("returns exactly the /api/device/state fields with a proof-guarded private response", async () => {
    const account = await sharingAccount();
    const response = await sharingRequest(account, "/api/private/grant-provisioning/next");
    expect(response.status).toBe(200);
    const header = response.headers.get(DEVICE_STATE);
    expect(header).not.toBeNull();
    const state = (await (await deviceState(account.session.cookie)).json()) as Record<string, unknown>;
    const { candidateActive: _candidateActive, ...fields } = state;
    expect(JSON.parse(header!)).toEqual(fields);
    expect(Object.keys(JSON.parse(header!)).sort()).toEqual([
      "accountId",
      "deviceId",
      "registryEpoch",
      "sessionBinding",
    ]);
    expect(JSON.parse(header!)).toEqual({
      accountId: account.accountId,
      deviceId: account.deviceId,
      registryEpoch: 1,
      sessionBinding: await sessionBindingDigest(account.session.id),
    });
    // The route body is unchanged by the header.
    expect(await response.json()).toEqual({ item: null, pending: false });
  });

  it("carries the current state on a stale-epoch proof denial so the browser can re-sign", async () => {
    const account = await sharingAccount();
    await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 2 WHERE account_id = ?")
      .bind(account.accountId)
      .run();
    const path = "/api/private/grant-provisioning/next";
    const denied = await withProof(path, account.session.cookie, await signedProof(account, path, 1));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "device_proof_required" });
    expect(JSON.parse(denied.headers.get(DEVICE_STATE)!)).toMatchObject({
      registryEpoch: 2,
      deviceId: account.deviceId,
    });
  });

  it("keeps the /api/device/state body byte-for-byte and adds no header to it", async () => {
    const account = await sharingAccount();
    const response = await deviceState(account.session.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(DEVICE_STATE)).toBeNull();
    expect(await response.text()).toBe(
      JSON.stringify({
        accountId: account.accountId,
        sessionBinding: await sessionBindingDigest(account.session.id),
        registryEpoch: 1,
        deviceId: account.deviceId,
        candidateActive: false,
      }),
    );
    const candidate = await SELF.fetch(`https://mdwn.test/api/device/state?candidateDeviceId=${account.deviceId}`, {
      headers: { cookie: account.session.cookie },
    });
    expect(await candidate.json()).toMatchObject({ candidateActive: true });
    const signedOut = await SELF.fetch("https://mdwn.test/api/device/state");
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toBe(JSON.stringify({ error: "authentication_failed" }));
  });

  it("omits the header without a normal Session", async () => {
    const account = await sharingAccount();
    const path = "/api/private/grant-provisioning/next";
    const proof = await signedProof(account, path);
    const anonymous = await withProof(path, null, proof);
    expect(anonymous.headers.get(DEVICE_STATE)).toBeNull();
    const recovery = await withProof(path, await recoveryCookie(account.accountId), proof);
    expect(recovery.status).toBeGreaterThanOrEqual(400);
    expect(recovery.headers.get(DEVICE_STATE)).toBeNull();
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), account.session.id).run();
    const revoked = await withProof(path, account.session.cookie, proof);
    expect(revoked.headers.get(DEVICE_STATE)).toBeNull();
  });

  it("adds nothing to requests without a Device proof, even with a normal Session", async () => {
    const account = await sharingAccount();
    for (const path of ["/", "/files", "/api/auth/session"]) {
      const response = await SELF.fetch(`https://mdwn.test${path}`, { headers: { cookie: account.session.cookie } });
      expect(response.headers.get(DEVICE_STATE)).toBeNull();
    }
    const unproven = await SELF.fetch("https://mdwn.test/api/private/grant-provisioning/next", {
      method: "POST",
      headers: { cookie: account.session.cookie, origin: "https://mdwn.test", "CF-Connecting-IP": "203.0.113.7" },
    });
    expect(unproven.status).toBe(403);
    expect(unproven.headers.get(DEVICE_STATE)).toBeNull();
  });
});

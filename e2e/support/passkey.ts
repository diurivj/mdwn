import { createPublicKey } from "node:crypto";
import type { Page } from "@playwright/test";
import { cose, isoCBOR } from "@simplewebauthn/server/helpers";

/** Encode the virtual authenticator's SPKI key for the production verifier. */
export function coseP256PublicKey(spki: string): Uint8Array {
  const key = createPublicKey({ key: Buffer.from(spki, "base64url"), format: "der", type: "spki" })
    .export({ format: "jwk" });
  if (!key.x || !key.y) throw new Error("expected a P-256 public key");
  const x = Buffer.from(key.x, "base64url"), y = Buffer.from(key.y, "base64url");
  if (x.byteLength !== 32 || y.byteLength !== 32) throw new Error("expected P-256 coordinates");
  return isoCBOR.encode(new Map<number, number | Uint8Array>([
    [cose.COSEKEYS.kty, cose.COSEKTY.EC2], [cose.COSEKEYS.alg, cose.COSEALG.ES256],
    [cose.COSEKEYS.crv, cose.COSECRV.P256], [cose.COSEKEYS.x, x], [cose.COSEKEYS.y, y],
  ]));
}

/** Playwright copies key material but resets the assertion counter to zero.
 * Our source has made exactly one assertion during seeded sign-in. Advance
 * only the copied authenticator, without weakening the server's counter check. */
export async function primeSyncedPasskey(page: Page, credentialId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const credential = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: Uint8Array.from(
        atob(id.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0),
      ) }],
      userVerification: "required",
    } });
    if (!credential) throw new Error("Synced virtual Passkey did not produce an assertion");
  }, credentialId);
}

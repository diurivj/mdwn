import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { encodeBytes, solveProofOfWork, transcriptDigest, type SignupTranscript } from "../../app/signup/protocol";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[]; SESSION_COOKIE_SECRET: string; ABUSE_HMAC_SECRET: string } } }
beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("issues WebAuthn registration options for a valid proof and two real P-256 keys", async () => {
  const request = (path: string, body: unknown) => SELF.fetch(`https://mdwn.test${path}`, {
    method: "POST",
    headers: { origin: "https://mdwn.test", "CF-Connecting-IP": "203.0.113.66", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const first = await request("/api/signup/challenge", {});
  expect(first.status).toBe(200);
  const { challengeId, challenge } = await first.json() as {challengeId:string;challenge:string};
  const nonce = await solveProofOfWork(challenge);
  const [transport, assertion] = await Promise.all([
    crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]),
    crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]),
  ]);
  const b64 = (bytes: Uint8Array) => encodeBytes(bytes);
  const digest = b64(crypto.getRandomValues(new Uint8Array(32)));
  const transcript: SignupTranscript = {
    accountId:"019950d7-98c0-7000-8000-000000000010",
    rootDirectoryId:"019950d7-98c0-7000-8000-000000000011",
    deviceId:"019950d7-98c0-7000-8000-000000000012",
    transportPublicKey:b64(new Uint8Array(await crypto.subtle.exportKey("raw",transport.publicKey))),
    assertionPublicKey:b64(new Uint8Array(await crypto.subtle.exportKey("raw",assertion.publicKey))),
    capsuleGeneration:1,capsuleDigest:digest,recoverySalt:digest,recoveryVerificationPublicKey:b64(new Uint8Array(await crypto.subtle.exportKey("raw",assertion.publicKey))),
    rootRecoveryEnvelopeDigest:digest,enrollmentEnvelopeDigest:digest,profileDigest:digest,
    recoveryCodeHashes:Array.from({length:10},()=>digest),registrationChallenge:challenge,proofNonce:nonce,registryEpoch:1,
  };
  const result = await request("/api/signup/options", { challengeId, nonce, transcript });
  expect(result.status).toBe(200);
  const options = await result.json() as {options:{challenge:string;attestation:string};challengeId:string;transportChallenge:string};
  expect(options.options.challenge).toBe(await transcriptDigest(transcript));
  expect(options.options.attestation).toBe("none");
}, 30_000);

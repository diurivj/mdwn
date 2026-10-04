import { SELF } from "cloudflare:test";
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { cose, isoCBOR } from "@simplewebauthn/server/helpers";

import { prepareRecoveryCodeSet } from "../../app/auth/recovery-codes";
import { sealAccountProfile } from "../../app/crypto/account-profile";
import { digestEnvelope } from "../../app/crypto/enc-v1";
import {
  createRecoveryMaterial, createVaultKeyHierarchy, openDeviceEnrollmentEnvelope,
  sealDeviceEnrollmentEnvelope,
} from "../../app/crypto/vault";
import { newOpaqueId } from "../../app/opaque-id";
import { bindingMessage, decodeBytes, encodeBytes, solveProofOfWork, type SignupTranscript } from "../../app/signup/protocol";

const ORIGIN = "https://mdwn.test";

export function signupRequest(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/signup/${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "CF-Connecting-IP": "203.0.113.36", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function signupPost<T>(path: string, body: unknown): Promise<T> {
  const response = await signupRequest(path, body);
  if (!response.ok) throw new Error(`Signup ${path} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Software authenticator: UP + UV + attested credential data, ES256, none attestation. */
async function registration(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [cose.COSEKEYS.kty, cose.COSEKTY.EC2], [cose.COSEKEYS.alg, cose.COSEALG.ES256],
    [cose.COSEKEYS.crv, cose.COSECRV.P256], [cose.COSEKEYS.x, raw.slice(1, 33)],
    [cose.COSEKEYS.y, raw.slice(33)],
  ]));
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.rp.id)));
  // rpIdHash(32), flags(1), counter(4), AAGUID(16), credential length(2), ID, COSE key.
  const authData = new Uint8Array(55 + credentialId.length + publicKey.length);
  authData.set(rpIdHash);
  authData[32] = 0x45;
  new DataView(authData.buffer).setUint16(53, credentialId.length);
  authData.set(credentialId, 55);
  authData.set(publicKey, 55 + credentialId.length);
  const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, never>>([
    ["fmt", "none"], ["attStmt", new Map<string, never>()], ["authData", authData],
  ]));
  const id = encodeBytes(credentialId);
  return {
    id, rawId: id, type: "public-key", clientExtensionResults: { credProps: { rk: true } },
    response: {
      clientDataJSON: encodeBytes(new TextEncoder().encode(JSON.stringify({
        type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false,
      }))),
      attestationObject: encodeBytes(attestation), transports: ["internal"],
    },
  };
}

/** Mirrors prepareSignup/commitSignup using production crypto, without browser storage or UI. */
export async function validSignupSubmission() {
  const accountId = newOpaqueId();
  const rootDirectoryId = newOpaqueId();
  const deviceId = newOpaqueId();
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId });
  const recovery = await createRecoveryMaterial(accountId, { vaultRootKey: hierarchy.vaultRootKey });
  const enrollment = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, transport.publicKey, {
    purpose: "device-enrollment", vaultId: accountId, objectId: deviceId,
    keyId: deviceId, keyEpoch: 1, revision: 1, recipientId: deviceId,
  });
  const profile = await sealAccountProfile(hierarchy.vaultRootKey,
    { publicPseudonym: "Worker signup fixture" }, { accountId, epoch: 1, revision: 1 });
  const { hashes: recoveryCodeHashes } = await prepareRecoveryCodeSet();
  const material = {
    rootRecoveryEnvelope: encodeBytes(hierarchy.rootDirectoryRecoveryEnvelope),
    enrollmentEnvelope: encodeBytes(enrollment), capsule: encodeBytes(recovery.record.capsule),
    encryptedProfile: encodeBytes(profile.ciphertext),
  };
  const start = await signupPost<{ challengeId: string; challenge: string }>("challenge", {});
  const nonce = await solveProofOfWork(start.challenge);
  const transcript: SignupTranscript = {
    accountId, rootDirectoryId, deviceId, registryEpoch: 1, capsuleGeneration: 1,
    transportPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey))),
    assertionPublicKey: encodeBytes(new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey))),
    capsuleDigest: encodeBytes(await digestEnvelope(recovery.record.capsule)),
    recoverySalt: encodeBytes(recovery.recoverySalt),
    recoveryVerificationPublicKey: encodeBytes(recovery.recoveryVerificationPublicKeyBytes),
    rootRecoveryEnvelopeDigest: encodeBytes(await digestEnvelope(hierarchy.rootDirectoryRecoveryEnvelope)),
    enrollmentEnvelopeDigest: encodeBytes(await digestEnvelope(enrollment)),
    profileDigest: encodeBytes(await digestEnvelope(profile.ciphertext)), recoveryCodeHashes,
    registrationChallenge: start.challenge, proofNonce: nonce,
  };
  const options = await signupPost<{
    challengeId: string; options: PublicKeyCredentialCreationOptionsJSON; transportChallenge: string;
  }>("options", { challengeId: start.challengeId, nonce, transcript });
  const transportProof = encodeBytes(await openDeviceEnrollmentEnvelope(
    decodeBytes(options.transportChallenge), transport, {
      purpose: "device-enrollment", vaultId: accountId, objectId: "signup-transport-challenge",
      keyId: "signup-transport-challenge", keyEpoch: 1, revision: 1, recipientId: deviceId,
    },
  ));
  const bindingSignature = encodeBytes(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, assertion.privateKey, new Uint8Array(await bindingMessage(transcript)),
  )));
  return {
    challengeId: options.challengeId, transcript, material, transportProof, bindingSignature,
    response: await registration(options.options), honeypot: "",
  };
}

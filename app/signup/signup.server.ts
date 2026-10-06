import { generateRegistrationOptions, verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";

import { assertSessionConfiguration, prepareBoundSession, signSessionId } from "~/auth/session.server";
import { inspectEnvelope } from "~/shared/crypto/enc-v1";
import { atomicSqlBatch, createDb, sql } from "~/shared/db/client.server";
import { sealToRecipient } from "~/shared/crypto/enc-v1";
import { sessionBindingDigest } from "~/shared/device/proof";
import { enforceRateLimit, rateLimitResponse } from "~/shared/security/abuse-control.server";
import { honeypotFailureResponse } from "~/shared/security/honeypot";
import { prepareRegistrationSuccess } from "~/shared/security/registration-success.server";
import { AbuseControlUnavailableError } from "~/shared/security/abuse-control.server";

import { bindingMessage, decodeBytes, encodeBytes, transcriptDigest, verifyProofOfWork, type SignupTranscript } from "../shared/signup/protocol";

const CHALLENGE_MS = 5 * 60_000;
const encoder = new TextEncoder();
const TRANSPORT_CONTEXT = (accountId: string, deviceId: string) => ({
  purpose: "device-enrollment" as const,
  vaultId: accountId,
  objectId: "signup-transport-challenge",
  keyId: "signup-transport-challenge",
  keyEpoch: 1,
  revision: 1,
  recipientId: deviceId,
});

type SignupMaterial = {
  rootRecoveryEnvelope: string;
  enrollmentEnvelope: string;
  capsule: string;
  encryptedProfile: string;
};

type ChallengeRow = { challenge: string; origin: string; expires_at: number };
type CeremonyRow = {
  challenge: string;
  origin: string;
  rp_id: string;
  transport_challenge_hash: ArrayBuffer;
  expires_at: number;
};

function originFor(request: Request): string { return new URL(request.url).origin; }
function failed(): Response {
  return Response.json({ error: "request_failed" }, { status: 400, headers: { "Cache-Control": "no-store" } });
}
function randomB64(length: number): string {
  return encodeBytes(crypto.getRandomValues(new Uint8Array(length)));
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
function isV7(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** No server-readable Account material exists before this rate-limited start. */
export async function beginSignupChallenge(request: Request, env: Env): Promise<Response> {
  assertSessionConfiguration(env);
  const limit = await enforceRateLimit({
    db: env.DB, request, action: "registration.challenge", hmacSecret: env.ABUSE_HMAC_SECRET,
  });
  if (!limit.allowed) return rateLimitResponse(limit);
  const id = crypto.randomUUID();
  const challenge = randomB64(32);
  const now = Date.now();
  await createDb(env.DB).run(sql`
    INSERT INTO registration_challenges (id, challenge, origin, expires_at, created_at)
    VALUES (${id}, ${challenge}, ${originFor(request)}, ${now + CHALLENGE_MS}, ${now})
  `);
  return Response.json({ challengeId: id, challenge }, { headers: { "Cache-Control": "no-store" } });
}

/** Consumes a PoW submission (including an invalid nonce) before issuing WebAuthn options. */
export async function beginSignupRegistration(
  request: Request, env: Env, challengeId: string, nonce: string, transcript: unknown,
): Promise<Response> {
  const row = await createDb(env.DB).get<ChallengeRow>(sql`
    DELETE FROM registration_challenges WHERE id = ${challengeId} AND origin = ${originFor(request)}
    RETURNING challenge, origin, expires_at
  `);
  if (!row || row.expires_at <= Date.now() || !await verifyProofOfWork(row.challenge, nonce)) return failed();
  const submitted = record(transcript);
  if (!submitted || submitted.registrationChallenge !== row.challenge || submitted.proofNonce !== nonce ||
      !isV7(submitted.accountId) || !isV7(submitted.rootDirectoryId) || !isV7(submitted.deviceId) ||
      submitted.registryEpoch !== 1 || submitted.capsuleGeneration !== 1) return failed();

  try {
    const canonical = submitted as unknown as SignupTranscript;
    const challenge = await transcriptDigest(canonical);
    const transportPublicKey = await crypto.subtle.importKey(
      "raw", decodeBytes(canonical.transportPublicKey, 65), { name: "ECDH", namedCurve: "P-256" }, true, [],
    );
    await crypto.subtle.importKey(
      "raw", decodeBytes(canonical.assertionPublicKey, 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const encryptedChallenge = await sealToRecipient(secret, transportPublicKey,
      TRANSPORT_CONTEXT(canonical.accountId, canonical.deviceId));
    const challengeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", secret));
    const rpId = new URL(request.url).hostname;
    const options = await generateRegistrationOptions({
      rpName: "mdwn", rpID: rpId,
      userID: encoder.encode(canonical.accountId), userName: "mdwn Account", userDisplayName: "mdwn",
      attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
      challenge: decodeBytes(challenge, 32),
    });
    const id = crypto.randomUUID();
    const now = Date.now();
    await createDb(env.DB).run(sql`
      INSERT INTO webauthn_challenges
        (id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at, created_at, transport_challenge_hash)
      VALUES (${id}, ${challenge}, 'signup', NULL, NULL, ${originFor(request)}, ${rpId},
        ${now + CHALLENGE_MS}, ${now}, ${challengeHash})
    `);
    return Response.json({
      challengeId: id, options, transportChallenge: encodeBytes(encryptedChallenge),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return failed();
  }
}

function checkEnvelope(input: Uint8Array, expected: {
  purpose: string; accountId: string; objectId: string; keyId: string; recipientId?: string;
}): boolean {
  const header = inspectEnvelope(input);
  return header.context.purpose === expected.purpose && header.context.vaultId === expected.accountId &&
    header.context.objectId === expected.objectId && header.context.keyId === expected.keyId &&
    header.context.keyEpoch === 1 && header.context.revision === 1 &&
    header.context.recipientId === expected.recipientId;
}

async function verifiedMaterial(transcript: SignupTranscript, input: unknown): Promise<{
  root: Uint8Array; enrollment: Uint8Array; capsule: Uint8Array; profile: Uint8Array; salt: Uint8Array;
} | null> {
  const value = record(input) as SignupMaterial | null;
  if (!value) return null;
  try {
    const root = decodeBytes(value.rootRecoveryEnvelope);
    const enrollment = decodeBytes(value.enrollmentEnvelope);
    const capsule = decodeBytes(value.capsule);
    const profile = decodeBytes(value.encryptedProfile);
    if ([root, enrollment, capsule, profile].some((bytes) => bytes.length < 48 || bytes.length > 8192)) return null;
    const { accountId, rootDirectoryId, deviceId } = transcript;
    if (!checkEnvelope(root, { purpose: "vault-recovery", accountId, objectId: rootDirectoryId, keyId: rootDirectoryId }) ||
      !checkEnvelope(enrollment, { purpose: "device-enrollment", accountId, objectId: deviceId, keyId: deviceId, recipientId: deviceId }) ||
      !checkEnvelope(capsule, { purpose: "recovery-capsule", accountId, objectId: "vault-recovery-capsule", keyId: "vault-recovery-capsule" }) ||
      !checkEnvelope(profile, { purpose: "account-profile", accountId, objectId: "account-profile", keyId: "vault-root" })) return null;
    const salt = inspectEnvelope(capsule).salt;
    if (!salt || !bytesEqual(salt, decodeBytes(transcript.recoverySalt, 32))) return null;
    const digests = await Promise.all([root, enrollment, capsule, profile].map(async (bytes) =>
      encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))));
    if (digests[0] !== transcript.rootRecoveryEnvelopeDigest || digests[1] !== transcript.enrollmentEnvelopeDigest ||
      digests[2] !== transcript.capsuleDigest || digests[3] !== transcript.profileDigest) return null;
    return { root, enrollment, capsule, profile, salt };
  } catch { return null; }
}

/** Verify both device keys, the same canonical WebAuthn transcript, and the opaque material before insertion. */
export async function completeSignup(request: Request, env: Env, body: unknown): Promise<Response> {
  const payload = record(body);
  const challengeId = payload && typeof payload.challengeId === "string" ? payload.challengeId : "";
  const rpId = new URL(request.url).hostname;
  const row = await createDb(env.DB).get<CeremonyRow>(sql`
    DELETE FROM webauthn_challenges
    WHERE id = ${challengeId} AND purpose = 'signup'
      AND origin = ${originFor(request)} AND rp_id = ${rpId}
    RETURNING challenge, origin, rp_id, transport_challenge_hash, expires_at
  `);
  if (!row || row.expires_at <= Date.now()) return failed();
  if (!payload || typeof payload.honeypot !== "string" || payload.honeypot.length !== 0) return honeypotFailureResponse();
  let successQuota: Awaited<ReturnType<typeof prepareRegistrationSuccess>> | undefined;
  try {
    const transcript = payload.transcript as SignupTranscript;
    if (!isV7(transcript?.accountId) || !isV7(transcript.rootDirectoryId) || !isV7(transcript.deviceId) ||
      transcript.registryEpoch !== 1 || transcript.capsuleGeneration !== 1 ||
      row.challenge !== await transcriptDigest(transcript)) return failed();
    const material = await verifiedMaterial(transcript, payload.material);
    if (!material || !Array.isArray(transcript.recoveryCodeHashes) || transcript.recoveryCodeHashes.length !== 10 ||
      new Set(transcript.recoveryCodeHashes).size !== 10 ||
      transcript.recoveryCodeHashes.some((code) => typeof code !== "string" || decodeBytes(code, 32).length !== 32)) return failed();
    const transportProof = decodeBytes(payload.transportProof as string, 32);
    const transportHash = new Uint8Array(await crypto.subtle.digest("SHA-256", transportProof));
    if (!bytesEqual(transportHash, new Uint8Array(row.transport_challenge_hash))) return failed();
    const assertionPublicKey = decodeBytes(transcript.assertionPublicKey, 65);
    const assertionKey = await crypto.subtle.importKey(
      "raw", assertionPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    if (!await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, assertionKey,
      decodeBytes(payload.bindingSignature as string, 64), new Uint8Array(await bindingMessage(transcript)),
    )) return failed();
    const response = payload.response as RegistrationResponseJSON;
    const verification = await verifyRegistrationResponse({
      response, expectedChallenge: row.challenge, expectedOrigin: row.origin, expectedRPID: row.rp_id,
      requireUserVerification: true,
    });
    if (!verification.verified || verification.registrationInfo.credential.id !== response?.id) return failed();
    const credential = verification.registrationInfo.credential;

    const accountId = transcript.accountId;
    const deviceId = transcript.deviceId;
    const now = Date.now();
    successQuota = await prepareRegistrationSuccess(env.DB, request, env.ABUSE_HMAC_SECRET, now);
    if (!successQuota.initialDecision.allowed) return rateLimitResponse(successQuota.initialDecision);
    if (!successQuota.statements) throw new AbuseControlUnavailableError();
    const cookie = await signSessionId(env, challengeId);
    const shareId = randomB64(32);
    const statements = [
      sql`INSERT INTO accounts (id, share_id, created_at, updated_at)
        SELECT ${accountId}, ${shareId}, ${now}, ${now} WHERE changes()=1`,
      sql`INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at)
        VALUES (${accountId}, ${material.profile}, 1, 1, ${now}, ${now})`,
      sql`INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch)
        VALUES (${accountId}, ${transcript.rootDirectoryId}, 1)`,
      sql`INSERT INTO passkeys
        (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at)
        VALUES (${credential.id}, ${accountId}, ${credential.publicKey}, ${credential.counter},
          ${JSON.stringify(credential.transports ?? [])}, ${verification.registrationInfo.credentialDeviceType},
          ${verification.registrationInfo.credentialBackedUp ? 1 : 0}, ${now}, ${now})`,
      sql`INSERT INTO encryption_devices
        (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at)
        VALUES (${deviceId}, ${accountId}, ${decodeBytes(transcript.transportPublicKey, 65)},
          ${assertionPublicKey}, 'active', 'signup', 1, ${now})`,
      sql`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
        VALUES (${accountId}, 'vault-recovery', ${transcript.rootDirectoryId}, 'vault-root', ${material.root}, 1)`,
      sql`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
        VALUES (${accountId}, 'device-enrollment', ${deviceId}, ${deviceId}, ${material.enrollment}, 1)`,
      sql`INSERT INTO recovery_capsules
        (account_id, generation, recovery_salt, ciphertext, verification_public_key)
        VALUES (${accountId}, 1, ${material.salt}, ${material.capsule},
          ${decodeBytes(transcript.recoveryVerificationPublicKey, 65)})`,
      ...transcript.recoveryCodeHashes.map((hash, ordinal) =>
        sql`INSERT INTO authentication_recovery_codes (account_id, ordinal, code_hash)
          VALUES (${accountId}, ${ordinal}, ${decodeBytes(hash, 32)})`),
      prepareBoundSession(env, challengeId, accountId, credential.id, deviceId, now),
    ];
    const results = await atomicSqlBatch(env.DB, [...successQuota.statements, ...statements]);
    // The identity insert's trigger also inserts the hidden root node and its
    // Directory. D1 meta.changes includes those two trigger writes, while
    // SQLite changes() in later statements counts the direct insert only.
    const identityIndex = successQuota.statements.length + 2;
    if (results.some((result, i) => result.meta.changes !== (i === identityIndex ? 3 : 1))) {
      throw new Error("incomplete signup batch");
    }
    return Response.json({ ok: true, sessionBinding: await sessionBindingDigest(challengeId) }, {
      headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AbuseControlUnavailableError) throw error;
    // A concurrent reservation can exhaust a quota between the read and the
    // batch. The conditional Account insert then fails FK and rolls back.
    if (successQuota) {
      const decision = await successQuota.decision();
      if (!decision.allowed) return rateLimitResponse(decision);
    }
    return failed();
  }
}

import { freshNormalSessionGuard } from "~/auth/fresh-session.server";
import { assertSessionConfiguration, hasFreshAssertion, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, signSessionId, type ActiveSession } from "~/auth/session.server";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { digestEnvelope, inspectEnvelope } from "~/crypto/enc-v1";
import { sealDeviceEnrollmentEnvelope } from "~/crypto/vault";
import { enforceRateLimit, MAX_EVENT_RETENTION_MS, rateLimitResponse } from "~/security/abuse-control.server";
import { reconcileNeedStatements } from "~/sharing/needs.server";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

import { nextRecoveryMetadataDigest, possessionMessage, recoveryIntentMessage, sha256, type NextRecoveryMetadata, type RecoveryIntent } from "./protocol";

const ENROLLMENT_MS = 5 * 60_000;
const noStore = { "Cache-Control": "no-store" };

function failed(): Response {
  return Response.json({ error: "recovery_failed" }, { status: 400, headers: noStore });
}

type EnrollmentRow = {
  id: string;
  generation: number;
  registry_epoch: number;
  nonce: ArrayBuffer;
  state: string;
  candidate_device_id: string | null;
  transport_public_key: ArrayBuffer | null;
  assertion_public_key: ArrayBuffer | null;
  intent_digest: ArrayBuffer | null;
  next_metadata_digest: ArrayBuffer | null;
  challenge_hash: ArrayBuffer | null;
  verification_public_key: ArrayBuffer;
};

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function enrollment(env: Env, session: ActiveSession, id: string, now: number): Promise<EnrollmentRow | null> {
  return (await createDb(env.DB).get<EnrollmentRow>(sql`
    SELECT e.*, c.verification_public_key FROM recovery_enrollments e
    JOIN recovery_capsules c ON c.account_id = e.account_id AND c.generation = e.generation
    JOIN account_encryption_identities i ON i.account_id = e.account_id AND i.registry_epoch = e.registry_epoch
    WHERE e.id = ${id} AND e.account_id = ${session.accountId} AND e.session_id = ${session.id}
      AND e.expires_at > ${now} AND ${freshNormalSessionGuard(session, now)}
  `)) ?? null;
}

async function burn(env: Env, session: ActiveSession, id: string): Promise<void> {
  await createDb(env.DB).run(sql`DELETE FROM recovery_enrollments
    WHERE id = ${id} AND account_id = ${session.accountId} AND session_id = ${session.id}`);
}

async function verifySignature(publicBytes: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicBytes),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
      new Uint8Array(signature), new Uint8Array(message));
  } catch { return false; }
}

async function signedIntent(row: EnrollmentRow, session: ActiveSession, intent: RecoveryIntent, signature: string): Promise<Uint8Array | null> {
  try {
    if (intent.accountId !== session.accountId || intent.generation !== row.generation ||
        intent.registryEpoch !== row.registry_epoch ||
        !equal(decodeBytes(intent.nonce, 32), new Uint8Array(row.nonce))) return null;
    const message = recoveryIntentMessage(intent);
    if (!await verifySignature(new Uint8Array(row.verification_public_key), message, decodeBytes(signature, 64))) return null;
    return sha256(message);
  } catch { return null; }
}

/** Start exposes only the current opaque capsule after a live, recent assertion and quota check. */
export async function startRecoveryEnrollment(request: Request, env: Env, session: ActiveSession): Promise<Response> {
  assertSessionConfiguration(env);
  if (!hasFreshAssertion(session)) return failed();
  const limit = await enforceRateLimit({
    db: env.DB, request, action: "vault_recovery.start",
    scopes: { accountId: session.accountId }, hmacSecret: env.ABUSE_HMAC_SECRET,
  });
  if (!limit.allowed) return rateLimitResponse(limit);
  const now = Date.now();
  const row = await createDb(env.DB).get<{
    generation: number; recovery_salt: ArrayBuffer; ciphertext: ArrayBuffer;
    verification_public_key: ArrayBuffer; registry_epoch: number;
  }>(sql`
    SELECT c.generation, c.recovery_salt, c.ciphertext, c.verification_public_key, i.registry_epoch
    FROM recovery_capsules c JOIN account_encryption_identities i ON i.account_id = c.account_id
    WHERE c.account_id = ${session.accountId} AND ${freshNormalSessionGuard(session, now)}
  `);
  if (!row) return failed();
  const id = crypto.randomUUID();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const inserted = await createDb(env.DB).run(sql`
    INSERT INTO recovery_enrollments
      (id, account_id, session_id, generation, registry_epoch, nonce, state, created_at, expires_at)
    SELECT ${id}, ${session.accountId}, ${session.id}, ${row.generation}, ${row.registry_epoch},
      ${nonce}, 'started', ${now}, ${now + ENROLLMENT_MS}
    WHERE ${freshNormalSessionGuard(session, now)}
      AND EXISTS (SELECT 1 FROM recovery_capsules WHERE account_id = ${session.accountId}
        AND generation = ${row.generation})
      AND EXISTS (SELECT 1 FROM account_encryption_identities WHERE account_id = ${session.accountId}
        AND registry_epoch = ${row.registry_epoch})
  `);
  if (inserted.meta.changes !== 1) return failed();
  return Response.json({
    enrollmentId: id, accountId: session.accountId, generation: row.generation,
    registryEpoch: row.registry_epoch, nonce: encodeBytes(nonce),
    recoverySalt: encodeBytes(new Uint8Array(row.recovery_salt)),
    capsule: encodeBytes(new Uint8Array(row.ciphertext)),
    verificationPublicKey: encodeBytes(new Uint8Array(row.verification_public_key)),
  }, { headers: noStore });
}

/** A valid old recovery signature may issue exactly one challenge to its signed candidate keys. */
export async function challengeRecoveryEnrollment(
  env: Env, session: ActiveSession, id: string, intent: RecoveryIntent, signature: string,
): Promise<Response> {
  const now = Date.now();
  const row = await enrollment(env, session, id, now);
  if (!row || row.state !== "started") return failed();
  const digest = await signedIntent(row, session, intent, signature);
  if (!digest) { await burn(env, session, id); return failed(); }
  try {
    const transport = decodeBytes(intent.transportPublicKey, 65);
    const assertion = decodeBytes(intent.assertionPublicKey, 65);
    const publicKey = await crypto.subtle.importKey("raw", transport,
      { name: "ECDH", namedCurve: "P-256" }, true, []);
    await crypto.subtle.importKey("raw", assertion, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const ciphertext = await sealDeviceEnrollmentEnvelope(secret, publicKey, {
      purpose: "device-enrollment", vaultId: session.accountId,
      objectId: "recovery-transport-challenge", keyId: "recovery-transport-challenge",
      keyEpoch: row.generation, revision: 1, recipientId: intent.deviceId,
    });
    const hash = await sha256(secret);
    const changed = await createDb(env.DB).run(sql`
      UPDATE recovery_enrollments SET state = 'challenged', candidate_device_id = ${intent.deviceId},
        transport_public_key = ${transport}, assertion_public_key = ${assertion},
        intent_digest = ${digest}, next_metadata_digest = ${decodeBytes(intent.nextMetadataDigest, 32)},
        challenge_hash = ${hash}
      WHERE id = ${id} AND account_id = ${session.accountId} AND session_id = ${session.id}
        AND state = 'started' AND expires_at > ${now} AND ${freshNormalSessionGuard(session, now)}
        AND EXISTS (SELECT 1 FROM recovery_capsules WHERE account_id = ${session.accountId}
          AND generation = ${row.generation})
        AND EXISTS (SELECT 1 FROM account_encryption_identities WHERE account_id = ${session.accountId}
          AND registry_epoch = ${row.registry_epoch})
    `);
    if (changed.meta.changes !== 1) return failed();
    return Response.json({ challenge: encodeBytes(ciphertext) }, { headers: noStore });
  } catch { await burn(env, session, id); return failed(); }
}

export type RecoveryCommit = {
  enrollmentId: string;
  intent: RecoveryIntent;
  intentSignature: string;
  challengeSecret: string;
  challengeSignature: string;
  nextMetadata: NextRecoveryMetadata;
  nextCapsule: string;
  enrollmentEnvelope: string;
};

/** The prepared D1 batch is one transaction; only its first guarded delete can authorize the cutover. */
export async function commitRecoveryEnrollment(env: Env, session: ActiveSession, body: RecoveryCommit): Promise<Response> {
  assertSessionConfiguration(env);
  const now = Date.now();
  const row = await enrollment(env, session, body.enrollmentId, now);
  if (!row || row.state !== "challenged" || !row.intent_digest || !row.challenge_hash ||
      !row.assertion_public_key || !row.transport_public_key || !row.next_metadata_digest || !row.candidate_device_id) return failed();
  try {
    const intentDigest = await signedIntent(row, session, body.intent, body.intentSignature);
    const challenge = decodeBytes(body.challengeSecret, 32);
    const nextCapsule = decodeBytes(body.nextCapsule);
    const enrollmentEnvelope = decodeBytes(body.enrollmentEnvelope);
    const metadata = body.nextMetadata;
    if (!intentDigest || !equal(intentDigest, new Uint8Array(row.intent_digest)) ||
        !equal(await sha256(challenge), new Uint8Array(row.challenge_hash)) ||
        !equal(decodeBytes(body.intent.transportPublicKey, 65), new Uint8Array(row.transport_public_key)) ||
        !equal(decodeBytes(body.intent.assertionPublicKey, 65), new Uint8Array(row.assertion_public_key)) ||
        body.intent.deviceId !== row.candidate_device_id ||
        metadata.generation !== row.generation + 1 ||
        !equal(decodeBytes(body.intent.nextMetadataDigest, 32), new Uint8Array(row.next_metadata_digest)) ||
        body.intent.nextMetadataDigest !== await nextRecoveryMetadataDigest(metadata) ||
        !equal(decodeBytes(metadata.capsuleDigest, 32), await digestEnvelope(nextCapsule)) ||
        !equal(decodeBytes(metadata.enrollmentEnvelopeDigest, 32), await digestEnvelope(enrollmentEnvelope)) ||
        !await verifySignature(new Uint8Array(row.assertion_public_key),
          possessionMessage(intentDigest, challenge), decodeBytes(body.challengeSignature, 64))) {
      await burn(env, session, body.enrollmentId); return failed();
    }
    const capsuleHeader = inspectEnvelope(nextCapsule);
    const envelopeHeader = inspectEnvelope(enrollmentEnvelope);
    if (capsuleHeader.suite !== "AES-256-GCM/HKDF-SHA-256" ||
        capsuleHeader.context.purpose !== "recovery-capsule" ||
        capsuleHeader.context.vaultId !== session.accountId ||
        capsuleHeader.context.keyEpoch !== metadata.generation ||
        !capsuleHeader.salt || !equal(capsuleHeader.salt, decodeBytes(metadata.recoverySalt, 32)) ||
        envelopeHeader.suite !== "HPKE-P256/HKDF-SHA-256/AES-256-GCM" ||
        envelopeHeader.context.purpose !== "device-enrollment" ||
        envelopeHeader.context.vaultId !== session.accountId ||
        envelopeHeader.context.objectId !== body.intent.deviceId ||
        envelopeHeader.context.keyId !== body.intent.deviceId ||
        envelopeHeader.context.recipientId !== body.intent.deviceId ||
        envelopeHeader.context.keyEpoch !== 1 || envelopeHeader.context.revision !== 1) {
      await burn(env, session, body.enrollmentId); return failed();
    }
    const newVerificationKey = decodeBytes(metadata.verificationPublicKey, 65);
    await crypto.subtle.importKey("raw", newVerificationKey,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const newSessionId = crypto.randomUUID();
    const cookie = await signSessionId(env, newSessionId);
    const eventId = crypto.randomUUID();
    const activatedDevice = sql`EXISTS (SELECT 1 FROM encryption_devices
      WHERE id = ${body.intent.deviceId} AND account_id = ${session.accountId}
        AND state = 'active' AND approval_provenance = 'recovery')`;
    const results = await atomicSqlBatch(env.DB, [
      sql`DELETE FROM recovery_enrollments WHERE id = ${body.enrollmentId}
        AND account_id = ${session.accountId} AND session_id = ${session.id}
        AND generation = ${row.generation} AND registry_epoch = ${row.registry_epoch}
        AND state = 'challenged' AND expires_at > ${now}
        AND intent_digest = ${intentDigest} AND next_metadata_digest = ${decodeBytes(body.intent.nextMetadataDigest, 32)}
        AND challenge_hash = ${await sha256(challenge)}
        AND candidate_device_id = ${body.intent.deviceId}
        AND transport_public_key = ${decodeBytes(body.intent.transportPublicKey, 65)}
        AND assertion_public_key = ${decodeBytes(body.intent.assertionPublicKey, 65)}
        AND ${freshNormalSessionGuard(session, now)}
        AND EXISTS (SELECT 1 FROM recovery_capsules WHERE account_id = ${session.accountId}
          AND generation = ${row.generation} AND verification_public_key = ${new Uint8Array(row.verification_public_key)})
        AND EXISTS (SELECT 1 FROM account_encryption_identities WHERE account_id = ${session.accountId}
          AND registry_epoch = ${row.registry_epoch})`,
      sql`INSERT INTO encryption_devices
        (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance,
         revocation_reason, registry_epoch, created_at)
        SELECT ${body.intent.deviceId}, ${session.accountId}, ${decodeBytes(body.intent.transportPublicKey, 65)},
          ${decodeBytes(body.intent.assertionPublicKey, 65)}, 'active', 'recovery', NULL,
          ${row.registry_epoch + 1}, ${now} WHERE changes() = 1`,
      sql`UPDATE encryption_devices SET state = 'tombstoned', revocation_reason = 'recovery'
        WHERE account_id = ${session.accountId} AND id != ${body.intent.deviceId} AND state = 'active'
          AND ${activatedDevice}`,
      sql`UPDATE key_envelopes SET superseded_at = ${now}
        WHERE account_id = ${session.accountId} AND purpose = 'device-enrollment'
          AND recipient_id != ${body.intent.deviceId} AND superseded_at IS NULL
          AND ${activatedDevice}`,
      sql`INSERT INTO key_envelopes
        (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch, superseded_at)
        SELECT ${session.accountId}, 'device-enrollment', ${body.intent.deviceId}, ${body.intent.deviceId},
          ${enrollmentEnvelope}, 1, NULL
        WHERE ${activatedDevice}`,
      sql`UPDATE recovery_capsules SET generation = ${metadata.generation},
          recovery_salt = ${decodeBytes(metadata.recoverySalt, 32)}, ciphertext = ${nextCapsule},
          verification_public_key = ${newVerificationKey}
        WHERE account_id = ${session.accountId} AND generation = ${row.generation}
          AND ${activatedDevice}`,
      sql`UPDATE sessions SET revoked_at = ${now}
        WHERE account_id = ${session.accountId} AND revoked_at IS NULL
          AND ${activatedDevice}`,
      sql`INSERT INTO sessions
        (id, account_id, purpose, authenticated_passkey_id, device_id, created_at,
         idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at)
        SELECT ${newSessionId}, ${session.accountId}, 'normal', ${session.authenticatedPasskeyId ?? null},
          ${body.intent.deviceId}, ${now}, ${now + SESSION_IDLE_MS}, ${now + SESSION_ABSOLUTE_MS},
          ${now}, NULL, NULL
        WHERE ${activatedDevice}
          AND EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ${session.authenticatedPasskeyId ?? null}
            AND account_id = ${session.accountId})`,
      sql`INSERT INTO security_events
        (id, created_at, expires_at, action_class, outcome, reason, account_id,
         publication_id, size_class, proof_state, counter_state, retry_at,
         network_bucket, network_bucket_expires_at)
        SELECT ${eventId}, ${now}, ${now + MAX_EVENT_RETENTION_MS}, 'recovery', 'allow', 'allowed',
          ${session.accountId}, NULL, NULL, 'valid', 'allowed', NULL, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ${newSessionId} AND account_id = ${session.accountId})`,
      sql`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, cursor, created_at, updated_at)
        SELECT ${newSessionId}, ${session.accountId}, ${body.intent.deviceId}, 'recovery_owned',
          'pending', NULL, ${now}, ${now}
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ${newSessionId} AND account_id = ${session.accountId}
          AND revoked_at IS NULL AND device_id = ${body.intent.deviceId})`,
      // Recovery tombstones the old devices and advances the epoch more than once; this runs
      // after the LAST device mutation so every recorded need carries the final epoch.
      reconcileNeedStatements({ recipientId: session.accountId }, now, activatedDevice),
    ]);
    if (results[0]?.meta.changes !== 1 || (results[1]?.meta.changes ?? 0) < 1 ||
        results[4]?.meta.changes !== 1 || results[5]?.meta.changes !== 1 ||
        results[7]?.meta.changes !== 1 || results[8]?.meta.changes !== 1 ||
        results[9]?.meta.changes !== 1) return failed();
    const epoch = await createDb(env.DB).get<{ registry_epoch: number }>(sql`
      SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ${session.accountId}`);
    return Response.json({ ok: true, accountId: session.accountId, deviceId: body.intent.deviceId,
      registryEpoch: epoch?.registry_epoch }, { headers: { ...noStore, "Set-Cookie": cookie } });
  } catch {
    await burn(env, session, body.enrollmentId);
    return failed();
  }
}

import { freshNormalSessionGuard } from "~/auth/fresh-session.server";
import { assertSessionConfiguration, hasFreshAssertion,
  SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, signSessionId, type ActiveSession } from "~/auth/session.server";
import { digestEnvelope, inspectEnvelope } from "~/crypto/enc-v1";
import { sealDeviceEnrollmentEnvelope } from "~/crypto/vault";
import { atomicSqlBatch, createDb, sql } from "~/db/client.server";
import { commitPrivateMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { newOpaqueId } from "~/opaque-id";
import { decodeBytes, encodeBytes } from "~/signup/protocol";

import { approvalMessage, candidateTranscriptMessage, possessionMessage, sha256,
  type CandidateTranscript, type EnrollmentApproval } from "./protocol";

const ENROLLMENT_MS = 10 * 60_000;
const noStore = { "Cache-Control": "no-store" };
const failed = () => Response.json({ error: "enrollment_failed" }, { status: 400, headers: noStore });

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
      new Uint8Array(signature), new Uint8Array(message));
  } catch { return false; }
}

type EnrollmentRow = {
  id: string; account_id: string; candidate_session_id: string; candidate_device_id: string;
  transport_public_key: ArrayBuffer; assertion_public_key: ArrayBuffer;
  transcript: ArrayBuffer; transcript_digest: ArrayBuffer; pairing_secret_hash: ArrayBuffer;
  registry_epoch: number; state: string; expires_at: number;
  approving_device_id: string | null; approving_session_id: string | null; approving_proof_id: string | null;
  approval_message: ArrayBuffer | null; approval_signature: ArrayBuffer | null;
  enrollment_envelope: ArrayBuffer | null; envelope_digest: ArrayBuffer | null;
  challenge_ciphertext: ArrayBuffer | null; challenge_hash: ArrayBuffer | null;
};

async function rowForAccount(env: Env, accountId: string, enrollmentId: string): Promise<EnrollmentRow | null> {
  return (await createDb(env.DB).get<EnrollmentRow>(sql`
    SELECT * FROM device_enrollments WHERE id = ${enrollmentId} AND account_id = ${accountId}`)) ?? null;
}

function live(row: EnrollmentRow | null, now: number): row is EnrollmentRow {
  return !!row && row.expires_at > now && row.state !== "consumed";
}

export async function startDeviceEnrollment(env: Env, session: ActiveSession,
  transcript: CandidateTranscript, transcriptDigest: string): Promise<Response> {
  assertSessionConfiguration(env);
  const now = Date.now();
  if (session.deviceId || !hasFreshAssertion(session, now)) return failed();
  try {
    await createDb(env.DB).run(sql`DELETE FROM device_enrollments
      WHERE account_id = ${session.accountId} AND expires_at <= ${now}`);
    const message = candidateTranscriptMessage(transcript);
    const digest = await sha256(message);
    if (transcript.accountId !== session.accountId ||
        !equal(decodeBytes(transcriptDigest, 32), digest)) return failed();
    const transport = decodeBytes(transcript.transportPublicKey, 65);
    const assertion = decodeBytes(transcript.assertionPublicKey, 65);
    await crypto.subtle.importKey("raw", transport, { name: "ECDH", namedCurve: "P-256" }, false, []);
    await crypto.subtle.importKey("raw", assertion, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const enrollmentId = newOpaqueId();
    const expiresAt = now + ENROLLMENT_MS;
    const inserted = await createDb(env.DB).run(sql`
      INSERT INTO device_enrollments (id, account_id, candidate_session_id, candidate_device_id,
        transport_public_key, assertion_public_key, transcript, transcript_digest,
        pairing_secret_hash, registry_epoch, state, created_at, expires_at)
      SELECT ${enrollmentId}, ${session.accountId}, ${session.id}, ${transcript.deviceId},
        ${transport}, ${assertion}, ${message}, ${digest}, ${decodeBytes(transcript.pairingSecretHash, 32)},
        ${transcript.registryEpoch}, 'pending', ${now}, ${expiresAt}
      WHERE ${freshNormalSessionGuard(session, now)}
        AND EXISTS (SELECT 1 FROM sessions WHERE id = ${session.id} AND device_id IS NULL)
        AND EXISTS (SELECT 1 FROM account_encryption_identities WHERE account_id = ${session.accountId}
          AND registry_epoch = ${transcript.registryEpoch})
        AND NOT EXISTS (SELECT 1 FROM encryption_devices WHERE id = ${transcript.deviceId})
        AND (SELECT count(*) FROM device_enrollments WHERE candidate_session_id = ${session.id}
          AND state != 'consumed' AND expires_at > ${now}) < 5`);
    return inserted.meta.changes === 1
      ? Response.json({ enrollmentId, expiresAt }, { headers: noStore }) : failed();
  } catch { return failed(); }
}

/** The approving device reads only public candidate material, guarded by its current proof. */
export async function pendingDeviceEnrollment(env: Env, authorized: AuthorizedDevice,
  enrollmentId: string): Promise<Response> {
  const now = Date.now();
  const row = await createDb(env.DB).get<EnrollmentRow>(sql`
    SELECT * FROM device_enrollments WHERE id = ${enrollmentId}
      AND account_id = ${authorized.accountId} AND state = 'pending' AND expires_at > ${now}
      AND registry_epoch = ${authorized.registryEpoch} AND ${privateReadGuard(authorized)}`);
  if (!row) return failed();
  return Response.json({ enrollmentId: row.id, expiresAt: row.expires_at,
    transcript: {
      accountId: row.account_id, registryEpoch: row.registry_epoch,
      deviceId: row.candidate_device_id,
      transportPublicKey: encodeBytes(new Uint8Array(row.transport_public_key)),
      assertionPublicKey: encodeBytes(new Uint8Array(row.assertion_public_key)),
      pairingSecretHash: encodeBytes(new Uint8Array(row.pairing_secret_hash)),
    }, transcriptDigest: encodeBytes(new Uint8Array(row.transcript_digest)),
    pairingSecretHash: encodeBytes(new Uint8Array(row.pairing_secret_hash)),
  }, { headers: noStore });
}

export async function approveDeviceEnrollment(env: Env, session: ActiveSession,
  authorized: AuthorizedDevice, enrollmentId: string, approval: EnrollmentApproval,
  approvalSignature: string, envelopeValue: string): Promise<Response> {
  const now = Date.now();
  if (!hasFreshAssertion(session, now) || session.id !== authorized.sessionId) return failed();
  const row = await rowForAccount(env, session.accountId, enrollmentId);
  if (!live(row, now) || row.state !== "pending" || row.registry_epoch !== authorized.registryEpoch) return failed();
  try {
    const message = approvalMessage(approval);
    const signature = decodeBytes(approvalSignature, 64);
    const envelope = decodeBytes(envelopeValue);
    const digest = await digestEnvelope(envelope);
    const candidate: CandidateTranscript = {
      accountId: approval.accountId, registryEpoch: approval.registryEpoch,
      deviceId: approval.deviceId, transportPublicKey: approval.transportPublicKey,
      assertionPublicKey: approval.assertionPublicKey, pairingSecretHash: approval.pairingSecretHash,
    };
    if (approval.enrollmentId !== row.id || approval.expiresAt !== row.expires_at ||
        approval.approvingDeviceId !== authorized.deviceId ||
        !equal(candidateTranscriptMessage(candidate), new Uint8Array(row.transcript)) ||
        !equal(decodeBytes(approval.transcriptDigest, 32), new Uint8Array(row.transcript_digest)) ||
        !equal(decodeBytes(approval.envelopeDigest, 32), digest)) return failed();
    const header = inspectEnvelope(envelope);
    if (header.suite !== "HPKE-P256/HKDF-SHA-256/AES-256-GCM" ||
        header.context.purpose !== "device-enrollment" ||
        header.context.vaultId !== row.account_id ||
        header.context.objectId !== row.candidate_device_id ||
        header.context.keyId !== row.candidate_device_id ||
        header.context.recipientId !== row.candidate_device_id ||
        header.context.keyEpoch !== 1 || header.context.revision !== 1) return failed();
    const approver = await createDb(env.DB).get<{ assertion_public_key: ArrayBuffer }>(sql`
      SELECT assertion_public_key FROM encryption_devices WHERE id = ${authorized.deviceId}
        AND account_id = ${session.accountId} AND state = 'active'`);
    if (!approver || !await verifySignature(new Uint8Array(approver.assertion_public_key), message, signature)) return failed();
    const candidateTransport = await crypto.subtle.importKey("raw", new Uint8Array(row.transport_public_key),
      { name: "ECDH", namedCurve: "P-256" }, true, []);
    const challengeSecret = crypto.getRandomValues(new Uint8Array(32));
    const challengeCiphertext = await sealDeviceEnrollmentEnvelope(challengeSecret, candidateTransport, {
      purpose: "device-enrollment", vaultId: session.accountId,
      objectId: "routine-transport-challenge", keyId: "routine-transport-challenge",
      keyEpoch: 1, revision: 1, recipientId: row.candidate_device_id,
    });
    const challengeHash = await sha256(challengeSecret);
    const approved = await commitPrivateMutation(env, authorized, (guard) => sql`
      UPDATE device_enrollments SET state = 'challenged', approving_device_id = ${authorized.deviceId},
        approving_session_id = ${session.id}, approving_proof_id = ${authorized.proofId},
        approval_message = ${message}, approval_signature = ${signature},
        enrollment_envelope = ${envelope}, envelope_digest = ${digest},
        challenge_ciphertext = ${challengeCiphertext}, challenge_hash = ${challengeHash}
      WHERE id = ${row.id} AND account_id = ${session.accountId} AND state = 'pending'
        AND candidate_session_id = ${row.candidate_session_id} AND expires_at > ${now}
        AND registry_epoch = ${authorized.registryEpoch}
        AND transcript = ${new Uint8Array(row.transcript)}
        AND ${freshNormalSessionGuard(session, now)} AND ${guard}
        AND EXISTS (SELECT 1 FROM sessions WHERE id = ${row.candidate_session_id}
          AND account_id = ${session.accountId} AND purpose = 'normal' AND device_id IS NULL
          AND revoked_at IS NULL AND idle_expires_at > ${now} AND absolute_expires_at > ${now})`);
    return approved ? Response.json({ ok: true }, { headers: noStore }) : failed();
  } catch { return failed(); }
}

/** Only the candidate Session can poll the sealed, one-use challenge. */
export async function deviceEnrollmentStatus(env: Env, session: ActiveSession,
  enrollmentId: string): Promise<Response> {
  const now = Date.now();
  const row = await createDb(env.DB).get<EnrollmentRow>(sql`
    SELECT * FROM device_enrollments WHERE id = ${enrollmentId}
      AND account_id = ${session.accountId} AND candidate_session_id = ${session.id}
      AND state IN ('pending', 'challenged') AND expires_at > ${now}
      AND EXISTS (SELECT 1 FROM account_encryption_identities
        WHERE account_id = ${session.accountId} AND registry_epoch = device_enrollments.registry_epoch)
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ${session.id} AND account_id = ${session.accountId}
        AND purpose = 'normal' AND device_id IS NULL AND revoked_at IS NULL
        AND idle_expires_at > ${now} AND absolute_expires_at > ${now})`);
  if (!row) return failed();
  if (row.state === "pending") return Response.json({ state: "pending" }, { headers: noStore });
  if (!row.challenge_ciphertext || !row.enrollment_envelope || !row.approval_signature ||
      !row.approving_device_id || !row.envelope_digest) return failed();
  const approval: EnrollmentApproval = {
    accountId: row.account_id, registryEpoch: row.registry_epoch,
    deviceId: row.candidate_device_id,
    transportPublicKey: encodeBytes(new Uint8Array(row.transport_public_key)),
    assertionPublicKey: encodeBytes(new Uint8Array(row.assertion_public_key)),
    pairingSecretHash: encodeBytes(new Uint8Array(row.pairing_secret_hash)),
    enrollmentId: row.id, transcriptDigest: encodeBytes(new Uint8Array(row.transcript_digest)),
    envelopeDigest: encodeBytes(new Uint8Array(row.envelope_digest)),
    approvingDeviceId: row.approving_device_id, expiresAt: row.expires_at,
  };
  return Response.json({ state: "challenged",
    challenge: encodeBytes(new Uint8Array(row.challenge_ciphertext)),
    enrollmentEnvelope: encodeBytes(new Uint8Array(row.enrollment_envelope)),
    approval, approvalSignature: encodeBytes(new Uint8Array(row.approval_signature)),
  }, { headers: noStore });
}

export type EnrollmentCommit = {
  enrollmentId: string;
  transcript: CandidateTranscript;
  transcriptDigest: string;
  approval: EnrollmentApproval;
  approvalSignature: string;
  enrollmentEnvelope: string;
  challengeSecret: string;
  challengeSignature: string;
  labelCiphertext?: string;
};

/** The first guarded transition is the only authorizing action; following writes are one D1 batch. */
export async function commitDeviceEnrollment(env: Env, session: ActiveSession,
  body: EnrollmentCommit): Promise<Response> {
  assertSessionConfiguration(env);
  const now = Date.now();
  if (session.deviceId || !hasFreshAssertion(session, now)) return failed();
  const row = await rowForAccount(env, session.accountId, body.enrollmentId);
  if (!live(row, now) || row.state !== "challenged" || row.candidate_session_id !== session.id ||
      !row.approving_device_id || !row.approving_session_id || !row.approving_proof_id ||
      !row.approval_message || !row.approval_signature || !row.enrollment_envelope ||
      !row.envelope_digest || !row.challenge_hash) return failed();
  try {
    const transcript = candidateTranscriptMessage(body.transcript);
    const transcriptDigest = decodeBytes(body.transcriptDigest, 32);
    const approval = approvalMessage(body.approval);
    const approvalSignature = decodeBytes(body.approvalSignature, 64);
    const envelope = decodeBytes(body.enrollmentEnvelope);
    const envelopeDigest = await digestEnvelope(envelope);
    const challenge = decodeBytes(body.challengeSecret, 32);
    const challengeHash = await sha256(challenge);
    const candidateSignature = decodeBytes(body.challengeSignature, 64);
    if (!equal(transcript, new Uint8Array(row.transcript)) ||
        !equal(transcriptDigest, new Uint8Array(row.transcript_digest)) ||
        !equal(await sha256(transcript), transcriptDigest) ||
        !equal(approval, new Uint8Array(row.approval_message)) ||
        !equal(approvalSignature, new Uint8Array(row.approval_signature)) ||
        !equal(envelope, new Uint8Array(row.enrollment_envelope)) ||
        !equal(envelopeDigest, new Uint8Array(row.envelope_digest)) ||
        !equal(challengeHash, new Uint8Array(row.challenge_hash)) ||
        !await verifySignature(new Uint8Array(row.assertion_public_key),
          possessionMessage(transcriptDigest, challenge), candidateSignature)) return failed();
    const approver = await createDb(env.DB).get<{ assertion_public_key: ArrayBuffer }>(sql`
      SELECT assertion_public_key FROM encryption_devices WHERE id = ${row.approving_device_id}
        AND account_id = ${row.account_id} AND state = 'active'`);
    if (!approver || !await verifySignature(new Uint8Array(approver.assertion_public_key),
      approval, approvalSignature)) return failed();
    let labelCiphertext: Uint8Array | null = null;
    if (body.labelCiphertext !== undefined) {
      if (typeof body.labelCiphertext !== "string") return failed();
      labelCiphertext = decodeBytes(body.labelCiphertext);
      if (labelCiphertext.length > 2_048) return failed();
      const label = inspectEnvelope(labelCiphertext);
      if (label.suite !== "AES-256-GCM/HKDF-SHA-256" ||
          label.context.purpose !== "device-label" || label.context.vaultId !== row.account_id ||
          label.context.objectId !== row.candidate_device_id || label.context.keyId !== row.candidate_device_id ||
          label.context.keyEpoch !== 1 || label.context.revision !== 1) return failed();
    }
    const newSessionId = newOpaqueId();
    const cookie = await signSessionId(env, newSessionId);
    const results = await atomicSqlBatch(env.DB, [
      sql`UPDATE device_enrollments SET state = 'consumed', challenge_ciphertext = NULL
        WHERE id = ${row.id} AND account_id = ${row.account_id}
          AND candidate_session_id = ${session.id} AND state = 'challenged'
          AND expires_at > ${now} AND registry_epoch = ${row.registry_epoch}
          AND candidate_device_id = ${row.candidate_device_id}
          AND transport_public_key = ${new Uint8Array(row.transport_public_key)}
          AND assertion_public_key = ${new Uint8Array(row.assertion_public_key)}
          AND transcript = ${transcript} AND transcript_digest = ${transcriptDigest}
          AND pairing_secret_hash = ${new Uint8Array(row.pairing_secret_hash)}
          AND approval_message = ${approval} AND approval_signature = ${approvalSignature}
          AND envelope_digest = ${envelopeDigest} AND enrollment_envelope = ${envelope}
          AND challenge_hash = ${challengeHash}
          AND ${freshNormalSessionGuard(session, now)}
          AND EXISTS (SELECT 1 FROM sessions WHERE id = ${session.id} AND device_id IS NULL)
          AND EXISTS (SELECT 1 FROM account_encryption_identities WHERE account_id = ${row.account_id}
            AND registry_epoch = ${row.registry_epoch})
          AND EXISTS (SELECT 1 FROM encryption_devices WHERE id = ${row.approving_device_id}
            AND account_id = ${row.account_id} AND state = 'active')
          AND EXISTS (SELECT 1 FROM sessions WHERE id = ${row.approving_session_id}
            AND account_id = ${row.account_id} AND device_id = ${row.approving_device_id}
            AND purpose = 'normal' AND revoked_at IS NULL AND idle_expires_at > ${now}
            AND absolute_expires_at > ${now})
          AND EXISTS (SELECT 1 FROM device_proof_uses WHERE account_id = ${row.account_id}
            AND proof_id = ${row.approving_proof_id} AND session_id = ${row.approving_session_id})
          AND NOT EXISTS (SELECT 1 FROM encryption_devices WHERE id = ${row.candidate_device_id})`,
      sql`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key,
        state, approval_provenance, label_ciphertext, registry_epoch, created_at)
        SELECT ${row.candidate_device_id}, ${row.account_id}, ${new Uint8Array(row.transport_public_key)},
          ${new Uint8Array(row.assertion_public_key)}, 'active', ${row.id}, ${labelCiphertext},
          ${row.registry_epoch + 1}, ${now} WHERE changes() = 1`,
      sql`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id,
        ciphertext, key_epoch, superseded_at)
        SELECT ${row.account_id}, 'device-enrollment', ${row.candidate_device_id},
          ${row.candidate_device_id}, ${envelope}, 1, NULL
        WHERE EXISTS (SELECT 1 FROM encryption_devices WHERE id = ${row.candidate_device_id}
          AND account_id = ${row.account_id} AND state = 'active' AND approval_provenance = ${row.id})`,
      sql`UPDATE sessions SET revoked_at = ${now} WHERE id = ${session.id}
        AND account_id = ${row.account_id} AND purpose = 'normal' AND device_id IS NULL
        AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM encryption_devices
          WHERE id = ${row.candidate_device_id} AND account_id = ${row.account_id}
            AND state = 'active' AND approval_provenance = ${row.id})`,
      sql`INSERT INTO sessions (id, account_id, purpose, authenticated_passkey_id, device_id,
        created_at, idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at)
        SELECT ${newSessionId}, ${row.account_id}, 'normal', ${session.authenticatedPasskeyId ?? null},
          ${row.candidate_device_id}, ${now}, ${now + SESSION_IDLE_MS}, ${now + SESSION_ABSOLUTE_MS},
          ${now}, NULL, NULL
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ${session.id}
          AND account_id = ${row.account_id} AND revoked_at = ${now})
          AND EXISTS (SELECT 1 FROM key_envelopes WHERE account_id = ${row.account_id}
            AND purpose = 'device-enrollment' AND recipient_id = ${row.candidate_device_id}
            AND object_id = ${row.candidate_device_id} AND ciphertext = ${envelope})`,
      sql`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, cursor, created_at, updated_at)
        SELECT ${newSessionId}, ${row.account_id}, ${row.candidate_device_id}, 'enrollment_owned',
          'pending', NULL, ${now}, ${now}
        WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ${newSessionId}
          AND account_id = ${row.account_id} AND device_id = ${row.candidate_device_id}
          AND revoked_at IS NULL)`,
    ]);
    if (results[0]?.meta.changes !== 1 || (results[1]?.meta.changes ?? 0) < 1 ||
        !results.slice(2).every((result) => result.meta.changes === 1)) return failed();
    return Response.json({ ok: true, accountId: row.account_id,
      deviceId: row.candidate_device_id, registryEpoch: row.registry_epoch + 1 },
    { headers: { ...noStore, "Set-Cookie": cookie } });
  } catch { return failed(); }
}

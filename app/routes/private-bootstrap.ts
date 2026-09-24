import { requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest } from "~/device/proof.server";
import { encodeBytes } from "~/signup/protocol";

import type { Route } from "./+types/private-bootstrap";

/**
 * Read-only resource action: private ciphertext cannot enter a document loader
 * or its SSR hydration payload. POST here does not consume a proof or write D1.
 */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "device_proof_required" }, { status: 405 });
  try { requireSameOrigin(request); }
  catch { return Response.json({ error: "device_proof_required" }, { status: 403 }); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return Response.json({ error: "device_proof_required" }, { status: 403 }); }
  const env = getEnv(context);
  const authorized = await authorizePrivateRequest(request, env, proof);
  if (!authorized) return Response.json({ error: "device_proof_required" }, { status: 403 });
  const rows = await createDb(env.DB).get<{
    root_directory_id: string; root_envelope: ArrayBuffer; enrollment_envelope: ArrayBuffer;
    capsule: ArrayBuffer; recovery_salt: ArrayBuffer; verification_public_key: ArrayBuffer;
    profile: ArrayBuffer;
  }>(sql`
    SELECT i.root_directory_id, root.ciphertext AS root_envelope,
      enrollment.ciphertext AS enrollment_envelope,
      c.ciphertext AS capsule, c.recovery_salt, c.verification_public_key,
      p.ciphertext AS profile
    FROM account_encryption_identities i
    JOIN key_envelopes root ON root.account_id = i.account_id
      AND root.purpose = 'vault-recovery' AND root.object_id = i.root_directory_id
    JOIN key_envelopes enrollment ON enrollment.account_id = i.account_id
      AND enrollment.purpose = 'device-enrollment' AND enrollment.recipient_id = ${authorized.deviceId}
    JOIN recovery_capsules c ON c.account_id = i.account_id
    JOIN account_profiles p ON p.account_id = i.account_id
    WHERE i.account_id = ${authorized.accountId}
      AND i.registry_epoch = ${authorized.registryEpoch}
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ${authorized.sessionId}
        AND account_id = i.account_id AND device_id = ${authorized.deviceId}
        AND revoked_at IS NULL AND idle_expires_at > ${Date.now()}
        AND absolute_expires_at > ${Date.now()})
  `);
  if (!rows) return Response.json({ error: "device_proof_required" }, { status: 403 });
  return Response.json({
    rootDirectoryId: rows.root_directory_id,
    rootRecoveryEnvelope: encodeBytes(new Uint8Array(rows.root_envelope)),
    enrollmentEnvelope: encodeBytes(new Uint8Array(rows.enrollment_envelope)),
    capsule: encodeBytes(new Uint8Array(rows.capsule)),
    recoverySalt: encodeBytes(new Uint8Array(rows.recovery_salt)),
    recoveryVerificationPublicKey: encodeBytes(new Uint8Array(rows.verification_public_key)),
    encryptedProfile: encodeBytes(new Uint8Array(rows.profile)),
  }, { headers: { "Cache-Control": "no-store" } });
}

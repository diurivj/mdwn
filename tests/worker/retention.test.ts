import { applyD1Migrations, createScheduledController, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../workers/app";
import { seedAccount, seedNormalSession } from "./auth-fixtures";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// D1 is the agreed operational seam: observe physical retention, not just denial
// of expired authority. The event runs the real Worker maintenance entry point.
async function scheduled(): Promise<void> {
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
}

async function ids(table: string, accountId: string): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT id FROM ${table} WHERE account_id = ? ORDER BY id`)
    .bind(accountId)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

describe("scheduled security-material retention", () => {
  it("enforces the ten-minute one-use challenge ceiling in deployed D1 schema", async () => {
    const account = await seedAccount();
    const session = await seedNormalSession(account);
    const now = Date.now();
    for (const lifetime of [600_000, 600_001]) {
      const statements = [
        env.DB.prepare(`INSERT INTO registration_challenges (id, challenge, origin, created_at, expires_at)
          VALUES (?, ?, 'https://mdwn.test', ?, ?)`).bind(
          `registration-${lifetime}`,
          `registration-${lifetime}`,
          now,
          now + lifetime,
        ),
        env.DB.prepare(`INSERT INTO webauthn_challenges (id, challenge, purpose, origin, rp_id, created_at, expires_at)
          VALUES (?, ?, 'sign_in', 'https://mdwn.test', 'mdwn.test', ?, ?)`).bind(
          `webauthn-${lifetime}`,
          `webauthn-${lifetime}`,
          now,
          now + lifetime,
        ),
        env.DB.prepare(`INSERT INTO recovery_enrollments
          (id, account_id, session_id, generation, registry_epoch, nonce, state, created_at, expires_at)
          VALUES (?, ?, ?, 1, 1, zeroblob(32), 'started', ?, ?)`).bind(
          `recovery-${lifetime}`,
          account.accountId,
          session.id,
          now,
          now + lifetime,
        ),
      ];
      for (const statement of statements) {
        if (lifetime === 600_000) await expect(statement.run()).resolves.toMatchObject({ success: true });
        else await expect(statement.run()).rejects.toThrow();
      }
    }
  });

  it("deletes expired Sessions and every expired WebAuthn purpose before its Session, preserving live authority", async () => {
    const account = await seedAccount();
    const expired = await seedNormalSession(account);
    const live = await seedNormalSession(account);
    const now = Date.now();
    await env.DB.prepare("UPDATE sessions SET idle_expires_at = ? WHERE id = ?")
      .bind(now - 1, expired.id)
      .run();
    await env.DB.batch([
      ...["sign_in", "fresh_assertion", "passkey_registration", "signup"].map((purpose) =>
        env.DB.prepare(
          `INSERT INTO webauthn_challenges (id, challenge, purpose, account_id, session_id, origin, rp_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'https://mdwn.test', 'mdwn.test', ?, ?)`,
        ).bind(
          `expired-${purpose}`,
          `challenge-${purpose}`,
          purpose,
          account.accountId,
          expired.id,
          now - 300_001,
          now - 1,
        ),
      ),
      env.DB.prepare(
        `INSERT INTO webauthn_challenges (id, challenge, purpose, account_id, session_id, origin, rp_id, created_at, expires_at)
         VALUES ('live-challenge', 'live-challenge', 'fresh_assertion', ?, ?, 'https://mdwn.test', 'mdwn.test', ?, ?)`,
      ).bind(account.accountId, live.id, now, now + 300_000),
    ]);

    await scheduled();
    expect(await ids("sessions", account.accountId)).toEqual([live.id]);
    expect(await ids("webauthn_challenges", account.accountId)).toEqual(["live-challenge"]);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await scheduled();
    expect(await ids("sessions", account.accountId)).toEqual([live.id]);
  });

  it("purges expired routine and Recovery enrollments, including unusable Session dependents, without activating or removing devices", async () => {
    const account = await seedAccount();
    const expiredSession = await seedNormalSession(account);
    const liveSession = await seedNormalSession(account);
    const now = Date.now();
    await env.DB.prepare("UPDATE sessions SET idle_expires_at = ? WHERE id = ?")
      .bind(now - 1, expiredSession.id)
      .run();
    for (const [id, sessionId, createdAt, expiresAt] of [
      ["expired", liveSession.id, now - 600_001, now - 1],
      ["unusable", expiredSession.id, now, now + 300_000],
      ["live", liveSession.id, now, now + 300_000],
    ] as const) {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO recovery_enrollments
          (id, account_id, session_id, generation, registry_epoch, nonce, state, created_at, expires_at)
          VALUES (?, ?, ?, 1, 1, zeroblob(32), 'started', ?, ?)`).bind(
          id,
          account.accountId,
          sessionId,
          createdAt,
          expiresAt,
        ),
        env.DB.prepare(`INSERT INTO device_enrollments
          (id, account_id, candidate_session_id, candidate_device_id, transport_public_key, assertion_public_key,
           transcript, transcript_digest, pairing_secret_hash, registry_epoch, state, created_at, expires_at)
          VALUES (?, ?, ?, ?, X'01', X'01', X'01', zeroblob(32), zeroblob(32), 1, 'pending', ?, ?)`).bind(
          id,
          account.accountId,
          sessionId,
          crypto.randomUUID(),
          createdAt,
          expiresAt,
        ),
      ]);
    }

    await scheduled();
    expect(await ids("recovery_enrollments", account.accountId)).toEqual(["live"]);
    expect(await ids("device_enrollments", account.accountId)).toEqual(["live"]);
    expect(await ids("sessions", account.accountId)).toEqual([liveSession.id]);
    expect(await ids("encryption_devices", account.accountId)).toEqual([]);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("removes expired Import staging and its Session but retains committed content, its marker, and current cryptographic authority", async () => {
    const account = await seedAccount();
    const liveSession = await seedNormalSession(account);
    const expiredSession = await seedNormalSession(account);
    const rootId = crypto.randomUUID(),
      deviceId = crypto.randomUUID(),
      fileId = crypto.randomUUID();
    const representationId = crypto.randomUUID();
    const now = Date.now();
    const committedId = "C".repeat(43),
      liveId = "L".repeat(43),
      expiredId = "E".repeat(43),
      unusableId = "U".repeat(43);
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET idle_expires_at = ? WHERE id = ?").bind(now - 1, expiredSession.id),
      env.DB.prepare(
        "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
      ).bind(account.accountId, rootId),
      env.DB.prepare(`INSERT INTO encryption_devices
        (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at)
        VALUES (?, ?, X'01', X'01', 'active', 'signup', 1, ?)`).bind(deviceId, account.accountId, now),
      env.DB.prepare(
        "INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, X'01', X'02', X'03')",
      ).bind(account.accountId),
      env.DB.prepare(
        "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'owned-device', ?, ?, X'04', 1)",
      ).bind(account.accountId, rootId, deviceId),
    ]);
    for (const importId of [committedId, liveId, expiredId, unusableId]) {
      const isExpired = importId === committedId || importId === expiredId;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO import_sessions
          (id, account_id, session_id, device_id, target_directory_id, target_owner_id, reviewed_entry_revision,
           manifest_ciphertext, manifest_digest, expected_record_count, expected_chunk_count, expected_payload_bytes,
           expected_comment_count, aggregate_digest, state, created_at, expires_at, committed_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, X'01', zeroblob(32), 1, 1, 1, 0, zeroblob(32), ?, ?, ?, ?)`).bind(
          importId,
          account.accountId,
          importId === unusableId ? expiredSession.id : liveSession.id,
          deviceId,
          rootId,
          account.accountId,
          importId === committedId ? "committed" : "open",
          isExpired ? now - 86_400_001 : now,
          isExpired ? now - 1 : now + 60_000,
          importId === committedId ? now - 1000 : null,
        ),
        env.DB.prepare(
          "INSERT INTO import_session_kinds (import_id, kind, expected_count) VALUES (?, 'node-file', 1)",
        ).bind(importId),
        env.DB.prepare(
          "INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at) VALUES (?, 0, X'01', zeroblob(32), 1, ?)",
        ).bind(importId, now),
        env.DB.prepare(`INSERT INTO import_records (import_id, chunk_sequence, ordinal, kind, ref1, ref2, offset, length, digest)
          VALUES (?, 0, 0, 'node-file', ?, ?, 0, 0, zeroblob(32))`).bind(importId, fileId, rootId),
      ]);
    }
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      env.DB.prepare(
        "INSERT INTO import_commits (import_id, account_id, target_directory_id, committed_at) VALUES (?, ?, ?, ?)",
      ).bind(committedId, account.accountId, rootId, now),
      env.DB.prepare(
        "INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, import_id, created_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?, ?)",
      ).bind(fileId, account.accountId, rootId, committedId, now, now),
      env.DB.prepare(
        "INSERT INTO files (node_id, owner_id, current_representation_id, current_revision) VALUES (?, ?, ?, 1)",
      ).bind(fileId, account.accountId, representationId),
      env.DB.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at)
        VALUES (?, ?, ?, 1, ?, 1, X'05', 1, ?)`).bind(
        representationId,
        fileId,
        account.accountId,
        crypto.randomUUID(),
        now,
      ),
      env.DB.prepare(
        "INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope) VALUES (?, ?, ?, X'01', X'02', X'03')",
      ).bind(fileId, account.accountId, rootId),
    ]);

    await scheduled();
    expect(await ids("import_sessions", account.accountId)).toEqual([liveId]);
    for (const table of ["import_records", "import_chunks", "import_session_kinds"]) {
      const rows = await env.DB.prepare(`SELECT DISTINCT import_id FROM ${table} WHERE import_id IN (?, ?, ?, ?)`)
        .bind(committedId, liveId, expiredId, unusableId)
        .all<{ import_id: string }>();
      expect(rows.results).toEqual([{ import_id: liveId }]);
    }
    expect(await ids("sessions", account.accountId)).toEqual([liveSession.id]);
    expect(await ids("encryption_devices", account.accountId)).toEqual([deviceId]);
    expect(
      await env.DB.prepare("SELECT import_id FROM import_commits WHERE import_id = ?").bind(committedId).first(),
    ).toEqual({ import_id: committedId });
    expect(
      await env.DB.prepare("SELECT current_representation_id FROM files WHERE node_id = ?").bind(fileId).first(),
    ).toEqual({ current_representation_id: representationId });
    expect(
      await env.DB.prepare("SELECT hex(ciphertext) AS ciphertext FROM key_envelopes WHERE account_id = ?")
        .bind(account.accountId)
        .first(),
    ).toEqual({ ciphertext: "04" });
    expect(
      await env.DB.prepare(
        "SELECT generation, hex(ciphertext) AS ciphertext FROM recovery_capsules WHERE account_id = ?",
      )
        .bind(account.accountId)
        .first(),
    ).toEqual({ generation: 1, ciphertext: "02" });
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await scheduled();
    expect(await ids("import_sessions", account.accountId)).toEqual([liveId]);
  });

  it("removes revoked, absolute-expired, and restricted-recovery Sessions plus expired one-use proofs, without removing live Sessions or proofs", async () => {
    const account = await seedAccount();
    const live = await seedNormalSession(account);
    const revoked = await seedNormalSession(account);
    const absolute = await seedNormalSession(account);
    const recovery = await seedNormalSession(account);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(now, revoked.id),
      env.DB.prepare(
        "UPDATE sessions SET created_at = ?, idle_expires_at = ?, absolute_expires_at = ? WHERE id = ?",
      ).bind(now - 1000, now - 1, now - 1, absolute.id),
      env.DB.prepare("UPDATE sessions SET purpose = 'recovery', created_at = ? WHERE id = ?").bind(
        now - 300_001,
        recovery.id,
      ),
      ...[
        ["expired-proof", now - 1],
        ["live-proof", now + 300_000],
      ].map(([proofId, expiresAt]) =>
        env.DB.prepare(
          "INSERT INTO device_proof_uses (account_id, proof_id, session_id, expires_at) VALUES (?, ?, ?, ?)",
        ).bind(account.accountId, proofId, live.id, expiresAt),
      ),
      ...[
        ["expired-registration", now - 300_001, now - 1],
        ["live-registration", now, now + 300_000],
      ].map(([id, createdAt, expiresAt]) =>
        env.DB.prepare(
          "INSERT INTO registration_challenges (id, challenge, origin, created_at, expires_at) VALUES (?, ?, 'https://mdwn.test', ?, ?)",
        ).bind(id, id, createdAt, expiresAt),
      ),
    ]);
    await scheduled();
    expect(await ids("sessions", account.accountId)).toEqual([live.id]);
    expect(
      (
        await env.DB.prepare("SELECT proof_id FROM device_proof_uses WHERE account_id = ?")
          .bind(account.accountId)
          .all()
      ).results,
    ).toEqual([{ proof_id: "live-proof" }]);
    expect(
      (
        await env.DB.prepare(
          "SELECT id FROM registration_challenges WHERE id IN ('expired-registration', 'live-registration')",
        ).all()
      ).results,
    ).toEqual([{ id: "live-registration" }]);
  });

  it("drains a bounded Import backlog across scheduled events before deleting its expired parent Session", async () => {
    const account = await seedAccount();
    const session = await seedNormalSession(account);
    const rootId = crypto.randomUUID(),
      deviceId = crypto.randomUUID(),
      now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
      ).bind(account.accountId, rootId),
      env.DB.prepare(`INSERT INTO encryption_devices
        (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at)
        VALUES (?, ?, X'01', X'01', 'active', 'signup', 1, ?)`).bind(deviceId, account.accountId, now),
      env.DB.prepare("UPDATE sessions SET idle_expires_at = ? WHERE id = ?").bind(now - 1, session.id),
      ...Array.from({ length: 5 }, (_, index) =>
        env.DB.prepare(`INSERT INTO import_sessions
        (id, account_id, session_id, device_id, target_directory_id, target_owner_id, reviewed_entry_revision,
         manifest_ciphertext, manifest_digest, expected_record_count, expected_chunk_count, expected_payload_bytes,
         expected_comment_count, aggregate_digest, state, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, X'01', zeroblob(32), 1, 1, 1, 0, zeroblob(32), 'open', ?, ?)`).bind(
          `${index}${"B".repeat(42)}`,
          account.accountId,
          session.id,
          deviceId,
          rootId,
          account.accountId,
          now - 1000,
          now - 1,
        ),
      ),
    ]);
    await scheduled();
    expect(await ids("import_sessions", account.accountId)).toHaveLength(2);
    expect(await ids("sessions", account.accountId)).toEqual([session.id]);
    await scheduled();
    expect(await ids("import_sessions", account.accountId)).toEqual([]);
    expect(await ids("sessions", account.accountId)).toEqual([]);
  });
});

/**
 * Deterministic, production-representative synthetic dataset for D1
 * export-restoration rehearsals. It is opaque test data only: no real
 * Account, key, ciphertext, or payload is used, and no value is decrypted.
 *
 * Coverage beyond `scripts/fixtures/retention-rehearsal.sql`:
 *   - materialized roots created by the real root-materialization trigger
 *   - circular vault_nodes <-> directory_entries and files <->
 *     file_representations pointers, plus a Grant authority pointer
 *   - Recovery capsule and current key/Grant envelopes
 *   - a committed Import marker whose staging (chunks/records/session) has
 *     expired and been deleted, while the File it materialized remains
 *   - two max-size (512 KiB) ciphertext BLOBs, whose hexadecimal SQL
 *     representation exceeds D1's 100 KB statement limit
 */
/** The application's maximum permitted ciphertext/BLOB size (512 KiB). */
export const APP_MAX_CIPHERTEXT_BYTES = 512 * 1024;

/** Deterministic pseudo-random bytes (xorshift32); test data, not cryptography.
 * @param {number} length @param {number} [seed] @returns {Buffer}
 */
function deterministicBytes(length, seed = 0x9e3779b9) {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

/** @param {Buffer} bytes */
function hexLiteral(bytes) {
  return `X'${bytes.toString("hex")}'`;
}

export const REHEARSAL_IDS = Object.freeze({
  ownerAccount: "018f0000-0000-7000-8000-00000000a001",
  recipientAccount: "018f0000-0000-7000-8000-00000000a002",
  ownerShare: "018f0000-0000-7000-8000-00000000b001",
  recipientShare: "018f0000-0000-7000-8000-00000000b002",
  ownerPasskey: "018f0000-0000-7000-8000-00000000c001",
  recipientPasskey: "018f0000-0000-7000-8000-00000000c002",
  ownerSession: "018f0000-0000-7000-8000-00000000d001",
  recipientSession: "018f0000-0000-7000-8000-00000000d002",
  ownerRoot: "018f0000-0000-7000-8000-00000000e001",
  recipientRoot: "018f0000-0000-7000-8000-00000000e002",
  ownerDevice: "018f0000-0000-7000-8000-00000000f001",
  recipientDevice: "018f0000-0000-7000-8000-00000000f002",
  fileA: "018f0000-0000-7000-8000-000000010001",
  fileB: "018f0000-0000-7000-8000-000000010002",
  representationA: "018f0000-0000-7000-8000-000000011001",
  representationB: "018f0000-0000-7000-8000-000000011002",
  contentKeyA: "018f0000-0000-7000-8000-000000012001",
  contentKeyB: "018f0000-0000-7000-8000-000000012002",
  grant: "018f0000-0000-7000-8000-000000013001",
  capability: "018f0000-0000-7000-8000-000000014001",
  importId: "R".repeat(43),
  expiredImportId: "E".repeat(43),
});

/** Fixed synthetic epoch (2023-11-14T22:13:20Z) so the dataset is reproducible. */
export const REHEARSAL_NOW = 1_700_000_000_000;

/**
 * @param {{ now?: number, maxCiphertextBytes?: number }} [options]
 * @returns {{ ids: typeof REHEARSAL_IDS, statements: string[], stagingImportId: string }}
 */
export function restoreRehearsalStatements({ now = REHEARSAL_NOW, maxCiphertextBytes = APP_MAX_CIPHERTEXT_BYTES } = {}) {
  if (maxCiphertextBytes < 1 || maxCiphertextBytes > APP_MAX_CIPHERTEXT_BYTES) {
    throw new Error(`maxCiphertextBytes must be between 1 and ${APP_MAX_CIPHERTEXT_BYTES}`);
  }
  const ids = REHEARSAL_IDS;
  const ciphertextA = hexLiteral(deterministicBytes(maxCiphertextBytes, 0x5eed0001));
  const ciphertextB = hexLiteral(deterministicBytes(maxCiphertextBytes, 0x5eed0002));
  const nameCiphertext = hexLiteral(deterministicBytes(4096, 0x5eed0003));
  const orderCiphertext = hexLiteral(deterministicBytes(4096, 0x5eed0004));
  const directoryKeyEnvelope = hexLiteral(deterministicBytes(16_384, 0x5eed0005));
  const statements = [
    `INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES
      ('${ids.ownerAccount}', '${ids.ownerShare}', ${now}, ${now}),
      ('${ids.recipientAccount}', '${ids.recipientShare}', ${now}, ${now});`,
    `INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES
      ('${ids.ownerPasskey}', '${ids.ownerAccount}', X'01', 0, '[]', 'singleDevice', 0, ${now}, ${now}),
      ('${ids.recipientPasskey}', '${ids.recipientAccount}', X'02', 0, '[]', 'singleDevice', 0, ${now}, ${now});`,
    `INSERT INTO sessions (id, account_id, purpose, authenticated_passkey_id, created_at, idle_expires_at, absolute_expires_at, device_id) VALUES
      ('${ids.ownerSession}', '${ids.ownerAccount}', 'normal', '${ids.ownerPasskey}', ${now}, ${now + 3_600_000}, ${now + 86_400_000}, '${ids.ownerDevice}'),
      ('${ids.recipientSession}', '${ids.recipientAccount}', 'normal', '${ids.recipientPasskey}', ${now}, ${now + 3_600_000}, ${now + 86_400_000}, '${ids.recipientDevice}');`,
    // The real root-materialization trigger creates each root vault_node and
    // directories row; the export therefore contains trigger-created rows.
    `INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES
      ('${ids.ownerAccount}', '${ids.ownerRoot}', 1),
      ('${ids.recipientAccount}', '${ids.recipientRoot}', 1);`,
    `INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES
      ('${ids.ownerDevice}', '${ids.ownerAccount}', X'01', X'02', 'active', 'signup', 1, ${now}),
      ('${ids.recipientDevice}', '${ids.recipientAccount}', X'03', X'04', 'active', 'signup', 1, ${now});`,
    `INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES
      ('${ids.ownerAccount}', 1, ${hexLiteral(deterministicBytes(32, 0x5eed0006))}, ${hexLiteral(deterministicBytes(512, 0x5eed0007))}, X'05');`,
    `INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES
      ('${ids.ownerAccount}', 'owned-device', '${ids.ownerRoot}', '${ids.ownerDevice}', ${hexLiteral(deterministicBytes(256, 0x5eed0008))}, 1),
      ('${ids.ownerAccount}', 'vault-recovery', '${ids.ownerAccount}', '${ids.ownerAccount}', ${hexLiteral(deterministicBytes(256, 0x5eed0009))}, 1);`,
    // A committed Import whose staging expires and is deleted below; the
    // durable marker and the File it materialized survive.
    `INSERT INTO import_sessions (id, account_id, session_id, device_id, target_directory_id, target_owner_id,
       reviewed_entry_revision, manifest_ciphertext, manifest_digest, expected_record_count, expected_chunk_count,
       expected_payload_bytes, expected_comment_count, aggregate_digest, state, created_at, expires_at, committed_at)
     VALUES ('${ids.importId}', '${ids.ownerAccount}', '${ids.ownerSession}', '${ids.ownerDevice}',
       '${ids.ownerRoot}', '${ids.ownerAccount}', 1, X'01', zeroblob(32), 1, 1, ${maxCiphertextBytes}, 0, zeroblob(32),
       'committed', ${now - 86_400_000}, ${now - 1}, ${now - 1000});`,
    `INSERT INTO import_session_kinds (import_id, kind, expected_count) VALUES ('${ids.importId}', 'node-file', 1);`,
    `INSERT INTO import_chunks (import_id, sequence, payload, digest, descriptor_count, received_at)
     VALUES ('${ids.importId}', 0, ${hexLiteral(deterministicBytes(1024, 0x5eed000a))}, zeroblob(32), 1, ${now});`,
    `INSERT INTO import_records (import_id, chunk_sequence, ordinal, kind, ref1, ref2, offset, length, digest)
     VALUES ('${ids.importId}', 0, 0, 'node-file', '${ids.fileA}', '${ids.ownerRoot}', 0, 0, zeroblob(32));`,
    `INSERT INTO import_commits (import_id, account_id, target_directory_id, committed_at)
     VALUES ('${ids.importId}', '${ids.ownerAccount}', '${ids.ownerRoot}', ${now - 1000});`,
    `INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, import_id, created_at, updated_at) VALUES
      ('${ids.fileA}', 'file', '${ids.ownerAccount}', '${ids.ownerRoot}', '${ids.importId}', ${now}, ${now}),
      ('${ids.fileB}', 'file', '${ids.ownerAccount}', '${ids.ownerRoot}', NULL, ${now}, ${now});`,
    `INSERT INTO files (node_id, owner_id, current_representation_id, current_revision) VALUES
      ('${ids.fileA}', '${ids.ownerAccount}', '${ids.representationA}', 1),
      ('${ids.fileB}', '${ids.ownerAccount}', '${ids.representationB}', 1);`,
    `INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at) VALUES
      ('${ids.representationA}', '${ids.fileA}', '${ids.ownerAccount}', 1, '${ids.contentKeyA}', 1, ${ciphertextA}, ${maxCiphertextBytes}, ${now}),
      ('${ids.representationB}', '${ids.fileB}', '${ids.ownerAccount}', 1, '${ids.contentKeyB}', 1, ${ciphertextB}, ${maxCiphertextBytes}, ${now});`,
    `INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope) VALUES
      ('${ids.fileA}', '${ids.ownerAccount}', '${ids.ownerRoot}', ${nameCiphertext}, ${orderCiphertext}, ${directoryKeyEnvelope}),
      ('${ids.fileB}', '${ids.ownerAccount}', '${ids.ownerRoot}', X'01', X'02', X'03');`,
    `INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at)
     VALUES ('${ids.grant}', '${ids.ownerAccount}', '${ids.recipientAccount}', '${ids.fileA}', 'file', 'read_only', 1, 1, ${now}, ${now});`,
    `INSERT INTO grant_key_envelopes (relationship_id, device_id, capability_id, capability_epoch, grant_key_epoch,
       owner_registry_epoch, recipient_registry_epoch, ciphertext, signature, signer_device_id)
     VALUES ('${ids.grant}', '${ids.recipientDevice}', '${ids.capability}', 1, 1, 1, 1,
       ${hexLiteral(deterministicBytes(512, 0x5eed000b))}, ${hexLiteral(deterministicBytes(64, 0x5eed000c))}, '${ids.ownerDevice}');`,
    // Staging expiry: delete chunks, records, kinds, and the session, while the
    // immutable marker, the File, and the current representation remain.
    `DELETE FROM import_records WHERE import_id = '${ids.importId}';`,
    `DELETE FROM import_chunks WHERE import_id = '${ids.importId}';`,
    `DELETE FROM import_session_kinds WHERE import_id = '${ids.importId}';`,
    `DELETE FROM import_sessions WHERE id = '${ids.importId}';`,
  ];
  return { ids, statements, stagingImportId: ids.importId };
}

-- Synthetic non-production data ONLY. Opaque binary sentinels test SQL
-- preservation, not cryptographic validity; no production export is used.
PRAGMA defer_foreign_keys = ON;
INSERT INTO accounts (id, share_id, created_at, updated_at)
VALUES ('018f0000-0000-7000-8000-000000000001', '018f0000-0000-7000-8000-000000000002', 1700000000000, 1700000000000);
INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at)
VALUES ('credential', '018f0000-0000-7000-8000-000000000001', X'01', 0, '[]', 'singleDevice', 0, 1700000000000, 1700000000000);
INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch)
VALUES ('018f0000-0000-7000-8000-000000000001', '018f0000-0000-7000-8000-000000000003', 1);
INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at)
VALUES ('018f0000-0000-7000-8000-000000000004', '018f0000-0000-7000-8000-000000000001', X'01', X'02', 'active', 'signup', 1, 1700000000000);
INSERT INTO sessions (id, account_id, purpose, authenticated_passkey_id, device_id, created_at, idle_expires_at, absolute_expires_at)
VALUES ('session', '018f0000-0000-7000-8000-000000000001', 'normal', 'credential', '018f0000-0000-7000-8000-000000000004', 1700000000000, 1700000001000, 1700000002000);
INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key)
VALUES ('018f0000-0000-7000-8000-000000000001', 1, X'01', X'CAFE', X'02');
INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
VALUES ('018f0000-0000-7000-8000-000000000001', 'owned-device', '018f0000-0000-7000-8000-000000000003', '018f0000-0000-7000-8000-000000000004', X'BEEF', 1);
INSERT INTO import_sessions (id, account_id, session_id, device_id, target_directory_id, target_owner_id,
  reviewed_entry_revision, manifest_ciphertext, manifest_digest, expected_record_count, expected_chunk_count,
  expected_payload_bytes, expected_comment_count, aggregate_digest, state, created_at, expires_at, committed_at)
VALUES (printf('%043d', 1), '018f0000-0000-7000-8000-000000000001', 'session', '018f0000-0000-7000-8000-000000000004',
  '018f0000-0000-7000-8000-000000000003', '018f0000-0000-7000-8000-000000000001',
  1, X'01', zeroblob(32), 1, 1, 1, 0, zeroblob(32), 'committed', 1700000000000, 1700000001000, 1700000000500);
INSERT INTO import_commits (import_id, account_id, target_directory_id, committed_at)
VALUES (printf('%043d', 1), '018f0000-0000-7000-8000-000000000001', '018f0000-0000-7000-8000-000000000003', 1700000000500);
INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, import_id, created_at, updated_at)
VALUES ('018f0000-0000-7000-8000-000000000005', 'file', '018f0000-0000-7000-8000-000000000001',
  '018f0000-0000-7000-8000-000000000003', printf('%043d', 1), 1700000000000, 1700000000000);
INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
VALUES ('018f0000-0000-7000-8000-000000000005', '018f0000-0000-7000-8000-000000000001', 'representation', 1);
INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at)
VALUES ('representation', '018f0000-0000-7000-8000-000000000005', '018f0000-0000-7000-8000-000000000001',
  1, 'content-key', 1, X'FEED', 2, 1700000000000);
INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope)
VALUES ('018f0000-0000-7000-8000-000000000005', '018f0000-0000-7000-8000-000000000001',
  '018f0000-0000-7000-8000-000000000003', X'01', X'02', X'03');
-- Legacy overlong challenge is shortened by migration 0027, then restored by
-- Time Travel. This distinguishes rollback from simply retaining the fixture.
INSERT INTO webauthn_challenges (id, challenge, purpose, origin, rp_id, created_at, expires_at)
VALUES ('legacy-challenge', 'synthetic-challenge', 'sign_in', 'https://mdwn.test', 'mdwn.test', 1700000000000, 1700000900000);

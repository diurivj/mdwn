import { sql } from "drizzle-orm";
import { blob, check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * mdwn foundation schema.
 *
 * The TypeScript schema is the single source of truth; reviewed, generated
 * SQL migrations live in ./drizzle and are applied to D1 through Wrangler
 * (npm run db:migrate:*). Each build ticket adds only its decided tables as a
 * new migration. Abuse-control records are bounded metadata, never content.
 */

/** An Account's authenticated identity; see CONTEXT.md. */
export const accounts = sqliteTable("accounts", {
  /** Application-visible opaque Account ID, canonical UUIDv7 TEXT. */
  id: text("id").primaryKey(),
  /** Opaque, unique share identifier used for direct sharing. */
  shareId: text("share_id").notNull().unique(),
  /** Optional unique normalized lookup token for a share handle. */
  shareHandleLookupToken: text("share_handle_lookup_token").unique(),
  /** Server lifecycle timestamps, INTEGER epoch ms. */
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * The encrypted, current Account-facing profile. Public pseudonyms are inside
 * this ciphertext; Account lookup and authentication never use profile data.
 */
export const accountProfiles = sqliteTable(
  "account_profiles",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "restrict" }),
    ciphertext: blob("ciphertext").notNull(),
    revision: integer("revision").notNull(),
    epoch: integer("epoch").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("account_profiles_revision_positive", sql`${table.revision} >= 1`),
    check("account_profiles_epoch_positive", sql`${table.epoch} >= 1`),
  ],
);

/** Public-key material for an Account's WebAuthn Passkeys. */
export const passkeys = sqliteTable(
  "passkeys",
  {
    credentialId: text("credential_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    publicKey: blob("public_key").notNull(),
    counter: integer("counter").notNull(),
    transports: text("transports").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("passkeys_account_id_idx").on(table.accountId),
    check("passkeys_counter_nonnegative", sql`${table.counter} >= 0`),
    check(
      "passkeys_device_type_valid",
      sql`${table.deviceType} IN ('singleDevice', 'multiDevice')`,
    ),
  ],
);

/**
 * D1-authoritative authentication grants. The cookie contains only the
 * signed opaque `id`; it never contains the Account identity or expiry state.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    /** Credential ID is retained after Passkey removal so its sessions stay revocable. */
    authenticatedPasskeyId: text("authenticated_passkey_id"),
    createdAt: integer("created_at").notNull(),
    idleExpiresAt: integer("idle_expires_at").notNull(),
    absoluteExpiresAt: integer("absolute_expires_at").notNull(),
    freshAssertedAt: integer("fresh_asserted_at"),
    refreshedAt: integer("refreshed_at"),
    revokedAt: integer("revoked_at"),
    /** Null means unprovisioned; a private-capable Session names one exact device. */
    deviceId: text("device_id"),
  },
  (table) => [
    index("sessions_account_live_idx").on(
      table.accountId,
      table.revokedAt,
      table.idleExpiresAt,
      table.absoluteExpiresAt,
    ),
    index("sessions_authenticated_passkey_idx").on(table.authenticatedPasskeyId),
    check("sessions_purpose_valid", sql`${table.purpose} IN ('normal', 'recovery')`),
    check("sessions_absolute_after_created", sql`${table.absoluteExpiresAt} > ${table.createdAt}`),
    check(
      "sessions_idle_within_absolute",
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
  ],
);

/**
 * One-use WebAuthn ceremony state. A verified or failed completion removes
 * the row atomically before it can create a Session or Passkey.
 */
export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    id: text("id").primaryKey(),
    challenge: text("challenge").notNull().unique(),
    purpose: text("purpose").notNull(),
    accountId: text("account_id").references(() => accounts.id, {
      onDelete: "restrict",
    }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    origin: text("origin").notNull(),
    rpId: text("rp_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Only signup stores an HPKE possession challenge hash here. */
    transportChallengeHash: blob("transport_challenge_hash"),
  },
  (table) => [
    index("webauthn_challenges_expiry_idx").on(table.expiresAt),
    index("webauthn_challenges_session_idx").on(table.sessionId),
    check(
      "webauthn_challenges_purpose_valid",
      sql`${table.purpose} IN ('sign_in', 'fresh_assertion', 'passkey_registration', 'signup')`,
    ),
    check(
      "webauthn_challenges_expiry_after_created",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type AccountProfile = typeof accountProfiles.$inferSelect;
export type Passkey = typeof passkeys.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;

/** Exact rolling-window attempts; HMAC-backed scopes never contain raw tokens or IPs. */
export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    purpose: text("purpose").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    windowMs: integer("window_ms").notNull(),
    /** Millisecond time epoch of the request; equal-millisecond attempts aggregate. */
    timeEpoch: integer("time_epoch").notNull(),
    count: integer("count").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "rate_limit_counters_pk",
      columns: [table.purpose, table.scopeType, table.scopeId, table.windowMs, table.timeEpoch],
    }),
    index("rate_limit_counters_expiry_idx").on(table.expiresAt),
    check(
      "rate_limit_counters_purpose_valid",
      sql`${table.purpose} IN ('registration.challenge', 'registration.success', 'webauthn.sign_in', 'recovery.attempt', 'vault_recovery.start', 'session.refresh', 'public_comment.mutate', 'public_comment.report', 'publication.mutate')`,
    ),
    check(
      "rate_limit_counters_scope_valid",
      sql`${table.scopeType} IN ('global', 'account', 'publication', 'account_publication', 'session', 'recovery_identifier', 'network')`,
    ),
    check(
      "rate_limit_counters_purpose_scope_valid",
      sql`(${table.purpose} IN ('registration.challenge', 'registration.success') AND ${table.scopeType} IN ('global', 'network'))
        OR (${table.purpose} = 'webauthn.sign_in' AND ${table.scopeType} IN ('global', 'network', 'account'))
        OR (${table.purpose} = 'recovery.attempt' AND ${table.scopeType} IN ('global', 'network', 'recovery_identifier'))
        OR (${table.purpose} = 'vault_recovery.start' AND ${table.scopeType} IN ('global', 'network', 'account'))
        OR (${table.purpose} = 'session.refresh' AND ${table.scopeType} = 'session')
        OR (${table.purpose} = 'public_comment.mutate' AND ${table.scopeType} IN ('global', 'network', 'account', 'publication', 'account_publication'))
        OR (${table.purpose} = 'public_comment.report' AND ${table.scopeType} = 'account')
        OR (${table.purpose} = 'publication.mutate' AND ${table.scopeType} = 'account')`,
    ),
    check(
      "rate_limit_counters_scope_id_valid",
      sql`(${table.scopeType} = 'global' AND ${table.scopeId} = '*')
        OR (${table.scopeType} = 'network' AND length(${table.scopeId}) = 72
          AND substr(${table.scopeId}, 1, 8) = 'network:'
          AND substr(${table.scopeId}, 9) NOT GLOB '*[^a-f0-9]*')
        OR (${table.scopeType} = 'session' AND length(${table.scopeId}) = 72
          AND substr(${table.scopeId}, 1, 8) = 'session:'
          AND substr(${table.scopeId}, 9) NOT GLOB '*[^a-f0-9]*')
        OR (${table.scopeType} = 'recovery_identifier' AND length(${table.scopeId}) = 84
          AND substr(${table.scopeId}, 1, 20) = 'recovery_identifier:'
          AND substr(${table.scopeId}, 21) NOT GLOB '*[^a-f0-9]*')
        OR (${table.scopeType} = 'account_publication' AND length(${table.scopeId}) = 84
          AND substr(${table.scopeId}, 1, 20) = 'account_publication:'
          AND substr(${table.scopeId}, 21) NOT GLOB '*[^a-f0-9]*')
        OR (${table.scopeType} = 'account' AND length(${table.scopeId}) = 36
          AND substr(${table.scopeId}, 9, 1) = '-' AND substr(${table.scopeId}, 14, 1) = '-'
          AND substr(${table.scopeId}, 15, 1) = '7' AND substr(${table.scopeId}, 19, 1) = '-'
          AND substr(${table.scopeId}, 20, 1) IN ('8', '9', 'a', 'b')
          AND substr(${table.scopeId}, 24, 1) = '-'
          AND ${table.scopeId} NOT GLOB '*[^0-9a-f-]*')
        OR (${table.scopeType} = 'publication' AND length(${table.scopeId}) = 43
          AND ${table.scopeId} NOT GLOB '*[^A-Za-z0-9_-]*')`,
    ),
    check(
      "rate_limit_counters_window_valid",
      sql`${table.windowMs} BETWEEN 1 AND 86400000`,
    ),
    check("rate_limit_counters_epoch_nonnegative", sql`${table.timeEpoch} >= 0`),
    check("rate_limit_counters_count_positive", sql`${table.count} >= 1`),
    check(
      "rate_limit_counters_expiry_matches_window",
      sql`${table.expiresAt} = ${table.timeEpoch} + ${table.windowMs}`,
    ),
  ],
);

/** Allowlisted, operator-only abuse/security decisions; never request logs. */
export const securityEvents = sqliteTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    actionClass: text("action_class").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason").notNull(),
    accountId: text("account_id"),
    publicationId: text("publication_id"),
    sizeClass: text("size_class"),
    proofState: text("proof_state").notNull(),
    counterState: text("counter_state").notNull(),
    retryAt: integer("retry_at"),
    networkBucket: text("network_bucket"),
    networkBucketExpiresAt: integer("network_bucket_expires_at"),
  },
  (table) => [
    index("security_events_expiry_idx").on(table.expiresAt),
    index("security_events_network_expiry_idx").on(table.networkBucketExpiresAt),
    index("security_events_account_created_idx").on(table.accountId, table.createdAt),
    index("security_events_publication_created_idx").on(table.publicationId, table.createdAt),
    check("security_events_expiry_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "security_events_retention_bounded",
      sql`${table.expiresAt} <= ${table.createdAt} + 2592000000`,
    ),
    check(
      "security_events_action_valid",
      sql`${table.actionClass} IN ('registration_challenge', 'registration', 'sign_in', 'recovery', 'session_refresh', 'device_removal', 'public_comment', 'public_comment_report', 'publication')`,
    ),
    check("security_events_outcome_valid", sql`${table.outcome} IN ('allow', 'deny')`),
    check(
      "security_events_reason_valid",
      sql`${table.reason} IN ('allowed', 'rate_limited', 'honeypot-filled', 'proof_invalid', 'proof_spent', 'policy_denied', 'capacity_exhausted')`,
    ),
    check(
      "security_events_size_class_valid",
      sql`${table.sizeClass} IS NULL OR ${table.sizeClass} IN ('unknown', 'zero', 'under_1_kib', '1_to_4_kib', '4_to_16_kib', 'over_16_kib')`,
    ),
    check(
      "security_events_proof_state_valid",
      sql`${table.proofState} IN ('not_applicable', 'issued', 'valid', 'invalid', 'spent')`,
    ),
    check(
      "security_events_counter_state_valid",
      sql`${table.counterState} IN ('not_checked', 'allowed', 'denied')`,
    ),
    check(
      "security_events_account_id_opaque",
      sql`${table.accountId} IS NULL OR (length(${table.accountId}) = 36
        AND substr(${table.accountId}, 9, 1) = '-' AND substr(${table.accountId}, 14, 1) = '-'
        AND substr(${table.accountId}, 15, 1) = '7' AND substr(${table.accountId}, 19, 1) = '-'
        AND substr(${table.accountId}, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(${table.accountId}, 24, 1) = '-'
        AND ${table.accountId} NOT GLOB '*[^0-9a-f-]*')`,
    ),
    check(
      "security_events_publication_id_opaque",
      sql`${table.publicationId} IS NULL OR (length(${table.publicationId}) = 43
        AND ${table.publicationId} NOT GLOB '*[^A-Za-z0-9_-]*')`,
    ),
    check(
      "security_events_network_bucket_bounded",
      sql`(${table.networkBucket} IS NULL AND ${table.networkBucketExpiresAt} IS NULL)
        OR (${table.networkBucket} IS NOT NULL AND length(${table.networkBucket}) = 72
          AND substr(${table.networkBucket}, 1, 8) = 'network:'
          AND substr(${table.networkBucket}, 9) NOT GLOB '*[^a-f0-9]*'
          AND ${table.networkBucketExpiresAt} >= ${table.createdAt}
          AND ${table.networkBucketExpiresAt} <= ${table.createdAt} + 86400000
          AND ${table.networkBucketExpiresAt} <= ${table.expiresAt})`,
    ),
  ],
);

export type RateLimitCounter = typeof rateLimitCounters.$inferSelect;
export type SecurityEvent = typeof securityEvents.$inferSelect;

/** Signup's five-minute, one-use, random registration/PoW challenge. */
export const registrationChallenges = sqliteTable("registration_challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull().unique(),
  origin: text("origin").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("registration_challenges_expiry_idx").on(table.expiresAt)]);

/**
 * One encryption identity, hidden root Directory and current registry epoch per Account.
 * The custom 0004 migration enforces monotonic epochs and advances the epoch
 * in the same statement as active-device insert/deactivation. Callers must not
 * bump the epoch separately; bulk replacement can advance it several times.
 */
export const accountEncryptionIdentities = sqliteTable("account_encryption_identities", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "restrict" }),
  rootDirectoryId: text("root_directory_id").notNull().unique(),
  registryEpoch: integer("registry_epoch").notNull(),
}, (table) => [check("account_encryption_epoch_positive", sql`${table.registryEpoch} >= 1`)]);

/** Public device keys only; private CryptoKeys never cross the browser boundary. */
export const encryptionDevices = sqliteTable("encryption_devices", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  transportPublicKey: blob("transport_public_key").notNull(),
  assertionPublicKey: blob("assertion_public_key").notNull(),
  state: text("state").notNull(),
  approvalProvenance: text("approval_provenance").notNull(),
  labelCiphertext: blob("label_ciphertext"),
  revocationReason: text("revocation_reason"),
  registryEpoch: integer("registry_epoch").notNull(),
  createdAt: integer("created_at").notNull(),
  lastProofAt: integer("last_proof_at"),
}, (table) => [
  index("encryption_devices_account_idx").on(table.accountId, table.state),
  check("encryption_devices_state_valid", sql`${table.state} IN ('active', 'revoked', 'tombstoned')`),
  check("encryption_devices_epoch_positive", sql`${table.registryEpoch} >= 1`),
]);

/** Both required opaque initial envelopes, explicitly addressable by purpose. */
export const keyEnvelopes = sqliteTable("key_envelopes", {
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  purpose: text("purpose").notNull(),
  objectId: text("object_id").notNull(),
  recipientId: text("recipient_id").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  keyEpoch: integer("key_epoch").notNull(),
  supersededAt: integer("superseded_at"),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.purpose, table.objectId, table.recipientId] }),
  check("key_envelopes_purpose_valid", sql`${table.purpose} IN ('vault-recovery', 'device-enrollment', 'owned-device')`),
  check("key_envelopes_epoch_positive", sql`${table.keyEpoch} >= 1`),
]);

/** Current opaque capsule; no Vault recovery secret or phrase reaches D1. */
export const recoveryCapsules = sqliteTable("recovery_capsules", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull(),
  recoverySalt: blob("recovery_salt").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  verificationPublicKey: blob("verification_public_key").notNull(),
}, (table) => [check("recovery_capsules_generation_positive", sql`${table.generation} >= 1`)]);

/** One-use recovery enrollment. Candidate public keys remain invisible to the registry until commit. */
export const recoveryEnrollments = sqliteTable("recovery_enrollments", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull(),
  registryEpoch: integer("registry_epoch").notNull(),
  nonce: blob("nonce").notNull(),
  state: text("state").notNull(),
  candidateDeviceId: text("candidate_device_id"),
  transportPublicKey: blob("transport_public_key"),
  assertionPublicKey: blob("assertion_public_key"),
  intentDigest: blob("intent_digest"),
  nextMetadataDigest: blob("next_metadata_digest"),
  challengeHash: blob("challenge_hash"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("recovery_enrollments_account_idx").on(table.accountId, table.expiresAt),
  check("recovery_enrollments_state_valid", sql`${table.state} IN ('started', 'challenged')`),
  check("recovery_enrollments_expiry_valid", sql`${table.expiresAt} > ${table.createdAt}`),
  check("recovery_enrollments_generation_positive", sql`${table.generation} >= 1`),
  check("recovery_enrollments_epoch_positive", sql`${table.registryEpoch} >= 1`),
]);

/** Exact candidate keys and one-use approval state; pairing secrets and private keys never enter D1. */
export const deviceEnrollments = sqliteTable("device_enrollments", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  candidateSessionId: text("candidate_session_id").notNull().references(() => sessions.id, { onDelete: "restrict" }),
  candidateDeviceId: text("candidate_device_id").notNull(),
  transportPublicKey: blob("transport_public_key").notNull(),
  assertionPublicKey: blob("assertion_public_key").notNull(),
  transcript: blob("transcript").notNull(),
  transcriptDigest: blob("transcript_digest").notNull(),
  pairingSecretHash: blob("pairing_secret_hash").notNull(),
  registryEpoch: integer("registry_epoch").notNull(),
  state: text("state").notNull(),
  approvingDeviceId: text("approving_device_id"),
  approvingSessionId: text("approving_session_id"),
  approvingProofId: text("approving_proof_id"),
  approvalMessage: blob("approval_message"),
  approvalSignature: blob("approval_signature"),
  enrollmentEnvelope: blob("enrollment_envelope"),
  envelopeDigest: blob("envelope_digest"),
  challengeCiphertext: blob("challenge_ciphertext"),
  challengeHash: blob("challenge_hash"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("device_enrollments_candidate_idx").on(table.candidateSessionId, table.expiresAt),
  index("device_enrollments_account_idx").on(table.accountId, table.expiresAt),
  check("device_enrollments_state_valid", sql`${table.state} IN ('pending', 'challenged', 'consumed')`),
  check("device_enrollments_expiry_valid", sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + 600000`),
  check("device_enrollments_epoch_positive", sql`${table.registryEpoch} >= 1`),
]);

/** Browser-driven, bounded owned-key provisioning after recovery; never carries a capability. */
export const cryptoJobs = sqliteTable("crypto_jobs", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  cursor: text("cursor"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("crypto_jobs_device_idx").on(table.accountId, table.deviceId, table.state),
  check("crypto_jobs_kind_valid", sql`${table.kind} IN ('recovery_owned', 'enrollment_owned')`),
  check("crypto_jobs_state_valid", sql`${table.state} IN ('pending', 'complete')`),
]);

/** High-entropy authentication recovery codes: only SHA-256 hashes are retained. */
export const authenticationRecoveryCodes = sqliteTable("authentication_recovery_codes", {
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  codeHash: blob("code_hash").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.ordinal] }),
  check("authentication_recovery_ordinal_valid", sql`${table.ordinal} BETWEEN 0 AND 9`),
]);

/** Spent mutation/security proofs only: never write a row for a private read. */
export const deviceProofUses = sqliteTable("device_proof_uses", {
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  proofId: text("proof_id").notNull(),
  sessionId: text("session_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.proofId] }),
  index("device_proof_uses_expiry_idx").on(table.expiresAt),
]);

/** Opaque owned tree. Non-root nodes must have exactly one agreeing encrypted edge. */
export const vaultNodes = sqliteTable("vault_nodes", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  parentNodeId: text("parent_node_id"),
  importId: text("import_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  check("vault_nodes_kind_valid", sql`${table.kind} IN ('directory', 'file')`),
  check("vault_nodes_root_directory", sql`${table.parentNodeId} IS NOT NULL OR ${table.kind} = 'directory'`),
  check("vault_nodes_no_self_parent", sql`${table.parentNodeId} IS NULL OR ${table.parentNodeId} != ${table.id}`),
  uniqueIndex("vault_nodes_one_root_idx").on(table.ownerId).where(sql`${table.parentNodeId} IS NULL`),
  uniqueIndex("vault_nodes_owner_edge_idx").on(table.ownerId, table.id, table.parentNodeId),
  uniqueIndex("vault_nodes_owner_id_idx").on(table.ownerId, table.id),
  // Composite Share/Grant FK also verifies that the target kind and Owner agree.
  uniqueIndex("vault_nodes_owner_target_kind_idx").on(table.ownerId, table.id, table.kind),
  index("vault_nodes_parent_idx").on(table.parentNodeId),
  // The reciprocal, deferred FKs to directories and directory_entries are in
  // the reviewed migration: Drizzle cannot express this circular relationship.
]);

/** Current revision of one Directory namespace; no plaintext name index exists. */
export const directories = sqliteTable("directories", {
  nodeId: text("node_id").primaryKey().references(() => vaultNodes.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull(),
  entriesRevision: integer("entries_revision").notNull(),
  listingVersion: integer("listing_version").notNull().default(1),
  capabilityKeyId: text("capability_key_id").notNull().default('legacy'),
  capabilityEpoch: integer("capability_epoch").notNull().default(1),
  /** Device-signed, encrypted commitment to the current entry ciphertexts (migration 0009). */
  listingCiphertext: blob("listing_ciphertext"),
  listingDigest: blob("listing_digest"),
  listingSignature: blob("listing_signature"),
  listingDeviceId: text("listing_device_id").references(() => encryptionDevices.id, { onDelete: "restrict" }),
}, (table) => [
  uniqueIndex("directories_owner_node_idx").on(table.ownerId, table.nodeId),
  index("directories_listing_device_idx").on(table.listingDeviceId),
  check("directories_revision_positive", sql`${table.entriesRevision} >= 1`),
  check("directories_listing_version_valid", sql`${table.listingVersion} IN (1, 2)`),
  check("directories_capability_epoch_positive", sql`${table.capabilityEpoch} BETWEEN 1 AND 9007199254740991`),
]);

/** One File has exactly one current encrypted representation, not a version history. */
export const files = sqliteTable("files", {
  nodeId: text("node_id").primaryKey().references(() => vaultNodes.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull(),
  currentRepresentationId: text("current_representation_id").notNull(),
  currentRevision: integer("current_revision").notNull(),
}, (table) => [
  uniqueIndex("files_owner_node_idx").on(table.ownerId, table.nodeId),
  check("files_revision_positive", sql`${table.currentRevision} >= 1`),
  // The current-pointer composite deferred FK is in the reviewed migration.
]);

/** Each current edge carries opaque, separately encrypted name/order and key envelope. */
export const directoryEntries = sqliteTable("directory_entries", {
  childNodeId: text("child_node_id").primaryKey().references(() => vaultNodes.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull(),
  parentNodeId: text("parent_node_id").notNull(),
  nameCiphertext: blob("name_ciphertext").notNull(),
  orderCiphertext: blob("order_ciphertext").notNull(),
  keyEnvelope: blob("key_envelope").notNull(),
  encoding: text("encoding").notNull().default('legacy-file'),
  receivingKeyId: text("receiving_key_id"),
  receivingEpoch: integer("receiving_epoch"),
  wrapRevision: integer("wrap_revision"),
}, (table) => [
  check("directory_entries_encoding_valid", sql`(${table.encoding} = 'receiving-file'
    AND ${table.receivingKeyId} IS NOT NULL AND length(${table.receivingKeyId}) BETWEEN 1 AND 256
    AND ${table.receivingEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.wrapRevision} BETWEEN 1 AND 9007199254740991)
    OR (${table.encoding} IN ('directory', 'legacy-file') AND ${table.receivingKeyId} IS NULL
    AND ${table.receivingEpoch} IS NULL AND ${table.wrapRevision} IS NULL)`),
  uniqueIndex("directory_entries_owner_edge_idx").on(table.ownerId, table.childNodeId, table.parentNodeId),
  index("directory_entries_parent_idx").on(table.ownerId, table.parentNodeId),
  check("directory_entries_ciphertext_bounded", sql`length(${table.nameCiphertext}) BETWEEN 1 AND 4096
    AND length(${table.orderCiphertext}) BETWEEN 1 AND 4096
    AND length(${table.keyEnvelope}) BETWEEN 1 AND 16384`),
  foreignKey({ columns: [table.ownerId, table.parentNodeId],
    foreignColumns: [directories.ownerId, directories.nodeId] }).onDelete("restrict"),
  foreignKey({ columns: [table.ownerId, table.childNodeId, table.parentNodeId],
    foreignColumns: [vaultNodes.ownerId, vaultNodes.id, vaultNodes.parentNodeId] }).onDelete("restrict"),
]);

/** Bounded single-blob private Markdown and File-metadata ciphertext. */
export const fileRepresentations = sqliteTable("file_representations", {
  id: text("id").primaryKey(),
  fileNodeId: text("file_node_id").notNull(),
  ownerId: text("owner_id").notNull(),
  revision: integer("revision").notNull(),
  contentKeyId: text("content_key_id").notNull(),
  keyEpoch: integer("key_epoch").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  ciphertextSize: integer("ciphertext_size").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("file_representations_owner_pointer_idx").on(table.ownerId, table.fileNodeId, table.id, table.revision),
  uniqueIndex("file_representations_file_revision_idx").on(table.fileNodeId, table.revision),
  check("file_representations_revision_positive", sql`${table.revision} >= 1`),
  check("file_representations_epoch_positive", sql`${table.keyEpoch} >= 1`),
  check("file_representations_ciphertext_bounded", sql`length(${table.ciphertext}) <= 524288 AND ${table.ciphertextSize} = length(${table.ciphertext})`),
  foreignKey({ columns: [table.ownerId, table.fileNodeId],
    foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
]);

/** Pending invitations only. Cancellation/decline deletes the row, never an audit tombstone. */
export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  recipientId: text("recipient_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  targetNodeId: text("target_node_id").notNull(),
  targetKind: text("target_kind").notNull(),
  permission: text("permission").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("shares_pending_target_recipient_idx").on(table.ownerId, table.targetNodeId, table.recipientId),
  index("shares_recipient_idx").on(table.recipientId, table.createdAt),
  check("shares_target_kind_valid", sql`${table.targetKind} IN ('file', 'directory')`),
  check("shares_permission_valid", sql`${table.permission} IN ('read_only', 'read_write')`),
  check("shares_not_self", sql`${table.ownerId} != ${table.recipientId}`),
  check("shares_created_nonnegative", sql`${table.createdAt} >= 0`),
  foreignKey({ columns: [table.ownerId, table.targetNodeId, table.targetKind],
    foreignColumns: [vaultNodes.ownerId, vaultNodes.id, vaultNodes.kind] }).onDelete("restrict"),
]);

/** Active authorization only. Its generation advances with any permission/recipient-set change. */
export const grants = sqliteTable("grants", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  recipientId: text("recipient_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  targetNodeId: text("target_node_id").notNull(),
  targetKind: text("target_kind").notNull(),
  permission: text("permission").notNull(),
  /** CAS for current-recipient descriptors and later rotation, never a cached access decision. */
  generation: integer("generation").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("grants_active_target_recipient_idx").on(table.ownerId, table.targetNodeId, table.recipientId),
  uniqueIndex("grants_id_owner_recipient_idx").on(table.id, table.ownerId, table.recipientId),
  index("grants_recipient_idx").on(table.recipientId, table.ownerId, table.targetNodeId),
  check("grants_target_kind_valid", sql`${table.targetKind} IN ('file', 'directory')`),
  check("grants_permission_valid", sql`${table.permission} IN ('read_only', 'read_write')`),
  check("grants_not_self", sql`${table.ownerId} != ${table.recipientId}`),
  check("grants_generation_positive", sql`${table.generation} >= 1`),
  check("grants_timestamps_valid", sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}`),
  foreignKey({ columns: [table.ownerId, table.targetNodeId, table.targetKind],
    foreignColumns: [vaultNodes.ownerId, vaultNodes.id, vaultNodes.kind] }).onDelete("restrict"),
]);

/** Current authenticated File statement and dynamic parent envelope; old signers remain in the registry. */
export const fileHeads = sqliteTable("file_heads", {
  fileNodeId: text("file_node_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  bytes: blob("bytes").notNull(),
  digest: blob("digest").notNull(),
  signature: blob("signature").notNull(),
  signerDeviceId: text("signer_device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  receivingPublicKey: blob("receiving_public_key").notNull(),
  receivingKeyId: text("receiving_key_id").notNull(),
  receivingEpoch: integer("receiving_epoch").notNull(),
  recipientSetVersion: integer("recipient_set_version").notNull(),
  revision: integer("revision").notNull(),
  representationId: text("representation_id").notNull(),
  contentKeyId: text("content_key_id").notNull(),
  contentEpoch: integer("content_epoch").notNull(),
  parentEnvelope: blob("parent_envelope").notNull(),
}, (table) => [
  check("file_heads_bounded", sql`length(${table.bytes}) BETWEEN 1 AND 131072
    AND length(${table.digest}) = 32 AND length(${table.signature}) = 64
    AND length(${table.receivingPublicKey}) = 65 AND length(${table.parentEnvelope}) BETWEEN 1 AND 16384
    AND length(${table.receivingKeyId}) BETWEEN 1 AND 256
    AND length(${table.contentKeyId}) BETWEEN 1 AND 256
    AND length(${table.representationId}) BETWEEN 1 AND 256
    AND ${table.revision} BETWEEN 1 AND 9007199254740991
    AND ${table.receivingEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.contentEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.recipientSetVersion} BETWEEN 1 AND 9007199254740991`),
  foreignKey({ columns: [table.ownerId, table.fileNodeId], foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
  foreignKey({ columns: [table.ownerId, table.fileNodeId, table.representationId, table.revision],
    foreignColumns: [fileRepresentations.ownerId, fileRepresentations.fileNodeId,
      fileRepresentations.id, fileRepresentations.revision] }).onDelete("restrict"),
]);

/** Exactly one direct envelope per File/device; no Grant-derived root/recovery envelope. */
export const fileDeviceEnvelopes = sqliteTable("file_device_envelopes", {
  fileNodeId: text("file_node_id").notNull(),
  ownerId: text("owner_id").notNull(),
  recipientId: text("recipient_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  contentKeyId: text("content_key_id").notNull(),
  contentEpoch: integer("content_epoch").notNull(),
  registryEpoch: integer("registry_epoch").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  digest: blob("digest").notNull(),
}, (table) => [
  primaryKey({ columns: [table.fileNodeId, table.deviceId] }),
  index("file_device_envelopes_recipient_idx").on(table.recipientId, table.deviceId),
  check("file_device_envelopes_bounded", sql`${table.revision} BETWEEN 1 AND 9007199254740991
    AND ${table.contentEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.registryEpoch} BETWEEN 1 AND 9007199254740991
    AND length(${table.contentKeyId}) BETWEEN 1 AND 256
    AND length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.digest}) = 32`),
  foreignKey({ columns: [table.ownerId, table.fileNodeId], foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
]);

/** Directory Grant's device-scoped current capability. */
export const grantDeviceEnvelopes = sqliteTable("grant_device_envelopes", {
  grantId: text("grant_id").notNull().references(() => grants.id, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull(),
  registryEpoch: integer("registry_epoch").notNull(),
  targetKeyId: text("target_key_id").notNull(),
  targetEpoch: integer("target_epoch").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  digest: blob("digest").notNull(),
}, (table) => [
  primaryKey({ columns: [table.grantId, table.deviceId] }),
  index("grant_device_envelopes_device_idx").on(table.deviceId),
  check("grant_device_envelopes_bounded", sql`${table.generation} BETWEEN 1 AND 9007199254740991
    AND ${table.registryEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.targetEpoch} BETWEEN 1 AND 9007199254740991
    AND length(${table.targetKeyId}) BETWEEN 1 AND 256
    AND length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.digest}) = 32`),
]);

/** Presealed pending offer material cannot confer access until a current acceptance. */
export const shareMaterial = sqliteTable("share_material", {
  shareId: text("share_id").primaryKey().references(() => shares.id, { onDelete: "restrict" }),
  materialRevision: integer("material_revision").notNull(),
  anticipatedGrantId: text("anticipated_grant_id").notNull(),
  targetKeyId: text("target_key_id").notNull(),
  targetEpoch: integer("target_epoch").notNull(),
  headDigest: blob("head_digest").notNull(),
  registryEpoch: integer("registry_epoch").notNull(),
  candidateHead: blob("candidate_head"),
  candidateDigest: blob("candidate_digest"),
  candidateSignature: blob("candidate_signature"),
  candidateSignerDeviceId: text("candidate_signer_device_id").references(() => encryptionDevices.id, { onDelete: "restrict" }),
}, (table) => [
  uniqueIndex("share_material_revision_idx").on(table.shareId, table.materialRevision),
  check("share_material_bounded", sql`${table.materialRevision} BETWEEN 1 AND 9007199254740991
  AND ${table.targetEpoch} BETWEEN 1 AND 9007199254740991
  AND ${table.registryEpoch} BETWEEN 1 AND 9007199254740991 AND length(${table.headDigest}) = 32
  AND length(${table.targetKeyId}) BETWEEN 1 AND 256 AND length(${table.anticipatedGrantId}) BETWEEN 1 AND 256
  AND ((${table.candidateHead} IS NULL AND ${table.candidateDigest} IS NULL AND
    ${table.candidateSignature} IS NULL AND ${table.candidateSignerDeviceId} IS NULL)
    OR (length(${table.candidateHead}) BETWEEN 1 AND 131072 AND length(${table.candidateDigest}) = 32
    AND length(${table.candidateSignature}) = 64 AND ${table.candidateSignerDeviceId} IS NOT NULL))`)]);
export const shareDeviceMaterial = sqliteTable("share_device_material", {
  shareId: text("share_id").notNull().references(() => shareMaterial.shareId, { onDelete: "restrict" }),
  materialRevision: integer("material_revision").notNull(),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  registryEpoch: integer("registry_epoch").notNull(),
  publicKeyDigest: blob("public_key_digest").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  digest: blob("digest").notNull(),
}, (table) => [primaryKey({ columns: [table.shareId, table.deviceId] }),
  foreignKey({ columns: [table.shareId, table.materialRevision],
    foreignColumns: [shareMaterial.shareId, shareMaterial.materialRevision] }).onDelete("restrict"),
  check("share_device_material_bounded", sql`${table.materialRevision} BETWEEN 1 AND 9007199254740991
    AND ${table.registryEpoch} BETWEEN 1 AND 9007199254740991
    AND length(${table.publicKeyDigest}) = 32
    AND length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.digest}) = 32`)]);

/** Detached signed offer: pending Share remains ciphertext-free to its recipient. */
export const shareOffers = sqliteTable("share_offers", {
  shareId: text("share_id").primaryKey().references(() => shareMaterial.shareId, { onDelete: "restrict" }),
  labelId: text("label_id").notNull(),
  ownerCopy: blob("owner_copy").notNull(),
  bytes: blob("bytes").notNull(),
  digest: blob("digest").notNull(),
  signature: blob("signature").notNull(),
  signerDeviceId: text("signer_device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
}, (table) => [check("share_offers_bounded", sql`length(${table.labelId}) BETWEEN 1 AND 256
  AND length(${table.ownerCopy}) BETWEEN 1 AND 4096 AND length(${table.bytes}) BETWEEN 1 AND 131072
  AND length(${table.digest}) = 32 AND length(${table.signature}) = 64`)]);

export const shareOfferLabels = sqliteTable("share_offer_labels", {
  shareId: text("share_id").notNull().references(() => shareOffers.shareId, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  ciphertext: blob("ciphertext").notNull(),
  digest: blob("digest").notNull(),
}, (table) => [primaryKey({ columns: [table.shareId, table.deviceId] }),
  check("share_offer_labels_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 4096
    AND length(${table.digest}) = 32`)]);

/** Immutable per-Grant Shared-as identity and Owner-owned recovery copy. */
export const grantLabels = sqliteTable("grant_labels", {
  grantId: text("grant_id").primaryKey().references(() => grants.id, { onDelete: "restrict" }),
  labelId: text("label_id").notNull(),
  ownerCopy: blob("owner_copy").notNull(),
  offerBytes: blob("offer_bytes").notNull(),
  offerDigest: blob("offer_digest").notNull(),
  offerSignature: blob("offer_signature").notNull(),
  signerDeviceId: text("signer_device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
}, (table) => [check("grant_labels_bounded", sql`length(${table.labelId}) BETWEEN 1 AND 256
  AND length(${table.ownerCopy}) BETWEEN 1 AND 4096 AND length(${table.offerBytes}) BETWEEN 1 AND 131072
  AND length(${table.offerDigest}) = 32 AND length(${table.offerSignature}) = 64`)]);

/** Only actual eligible devices receive encrypted names; no plaintext or name hashes. */
export const grantLabelDeliveries = sqliteTable("grant_label_deliveries", {
  grantId: text("grant_id").notNull().references(() => grants.id, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  registryEpoch: integer("registry_epoch").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  digest: blob("digest").notNull(),
}, (table) => [primaryKey({ columns: [table.grantId, table.deviceId] }),
  index("grant_label_deliveries_device_idx").on(table.deviceId),
  check("grant_label_deliveries_bounded", sql`${table.registryEpoch} BETWEEN 1 AND 9007199254740991
    AND length(${table.ciphertext}) BETWEEN 1 AND 4096 AND length(${table.digest}) = 32`)]);

/** Current presealed File-key material survives consumption of the pending Share.
 * Not a committed recipient envelope until a current signed File head includes it.
 */
export const grantRetainedMaterial = sqliteTable("grant_retained_material", {
  grantId: text("grant_id").notNull().references(() => grants.id, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  registryEpoch: integer("registry_epoch").notNull(),
  contentKeyId: text("content_key_id").notNull(),
  contentEpoch: integer("content_epoch").notNull(),
  revision: integer("revision").notNull(),
  /** Nullable only for pre-migration rows; those cannot bootstrap until reprovisioned. */
  publicKeyDigest: blob("public_key_digest"),
  ciphertext: blob("ciphertext").notNull(),
  digest: blob("digest").notNull(),
}, (table) => [primaryKey({ columns: [table.grantId, table.deviceId] }),
  index("grant_retained_material_device_idx").on(table.deviceId),
  check("grant_retained_material_bounded", sql`${table.registryEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.contentEpoch} BETWEEN 1 AND 9007199254740991 AND ${table.revision} BETWEEN 1 AND 9007199254740991
    AND length(${table.contentKeyId}) BETWEEN 1 AND 256
    AND (${table.publicKeyDigest} IS NULL OR length(${table.publicKeyDigest}) = 32)
    AND length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.digest}) = 32`)]);

/** Opaque outstanding Grant/device pair: NEVER a ciphertext, capability or name. */
export const provisioningNeeds = sqliteTable("provisioning_needs", {
  grantId: text("grant_id").notNull().references(() => grants.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull(),
  recipientId: text("recipient_id").notNull(),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  generation: integer("generation").notNull(),
  registryEpoch: integer("registry_epoch").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.grantId, table.deviceId] }),
  index("provisioning_needs_device_idx").on(table.deviceId),
  index("provisioning_needs_recipient_idx").on(table.recipientId, table.deviceId),
  index("provisioning_needs_owner_idx").on(table.ownerId, table.grantId),
  check("provisioning_needs_bounded", sql`${table.generation} BETWEEN 1 AND 9007199254740991
    AND ${table.registryEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.createdAt} BETWEEN 0 AND 9007199254740991
    AND ${table.updatedAt} BETWEEN ${table.createdAt} AND 9007199254740991`),
  foreignKey({ columns: [table.grantId, table.ownerId, table.recipientId],
    foreignColumns: [grants.id, grants.ownerId, grants.recipientId] }).onDelete("restrict")]);

/** Ticket 19 removes authority and installs this barrier before starting rekeying. */
export const rotationBarriers = sqliteTable("rotation_barriers", {
  ownerId: text("owner_id").notNull(),
  targetNodeId: text("target_node_id").notNull(),
  epoch: integer("epoch").notNull(),
}, (table) => [primaryKey({ columns: [table.ownerId, table.targetNodeId] }),
  foreignKey({ columns: [table.ownerId, table.targetNodeId], foreignColumns: [vaultNodes.ownerId, vaultNodes.id] }).onDelete("restrict"),
  check("rotation_barriers_epoch_positive", sql`${table.epoch} BETWEEN 1 AND 9007199254740991`)]);

/** Durable, cursor-ready ticket-19 work item; no executor or fake rekey here.
 * The barrier must remain until a future verified rotation completes. */
export const sharingRotationJobs = sqliteTable("sharing_rotation_jobs", {
  ownerId: text("owner_id").notNull(),
  targetNodeId: text("target_node_id").notNull(),
  barrierEpoch: integer("barrier_epoch").notNull(),
  state: text("state").notNull(),
  cursor: text("cursor"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.ownerId, table.targetNodeId] }),
  foreignKey({ columns: [table.ownerId, table.targetNodeId],
    foreignColumns: [rotationBarriers.ownerId, rotationBarriers.targetNodeId] }).onDelete("restrict"),
  check("sharing_rotation_jobs_pending", sql`${table.state} = 'pending'
    AND ${table.barrierEpoch} BETWEEN 1 AND 9007199254740991
    AND ${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}`)]);

/** One fresh, unguessable invocation ID per sharing transaction. Deleted in the same
 * batch; a previously spent proof cannot stand in for this transaction's witness. */
export const sharingWriteWitnesses = sqliteTable("sharing_write_witnesses", {
  invocationId: text("invocation_id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  proofId: text("proof_id").notNull(),
}, (table) => [check("sharing_write_witnesses_ids_bounded", sql`length(${table.invocationId}) = 36
  AND length(${table.proofId}) BETWEEN 1 AND 256`)]);

/** Unique transaction witness, consumed at the end of a successful v2 write batch. */
export const fileWriteWitnesses = sqliteTable("file_write_witnesses", {
  fileNodeId: text("file_node_id").primaryKey().references(() => files.nodeId, { onDelete: "restrict" }),
  proofId: text("proof_id").notNull(),
}, (table) => [check("file_write_witnesses_proof_id_bounded", sql`length(${table.proofId}) BETWEEN 1 AND 256`)]);

export type Share = typeof shares.$inferSelect;
export type Grant = typeof grants.$inferSelect;

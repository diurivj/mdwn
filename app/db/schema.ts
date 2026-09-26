import { sql } from "drizzle-orm";
import { blob, check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
      sql`${table.actionClass} IN ('registration_challenge', 'registration', 'sign_in', 'recovery', 'session_refresh', 'public_comment', 'public_comment_report', 'publication')`,
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

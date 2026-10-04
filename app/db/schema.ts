import { sql } from "drizzle-orm";
import { blob, check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
    /** Set only when a Pseudonym update commits; the next change waits 30 days. */
    pseudonymChangedAt: integer("pseudonym_changed_at"),
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

/**
 * Category-only Public Comment reports (ticket 26). One row names the
 * reporter Account, the opaque Public Comment ID and one fixed category; it
 * carries no content, capability, request identifier, network data or
 * plaintext of any kind. Reports are bounded operator metadata and expire
 * after 30 days; every Comment-removal path deletes a Comment's reports in
 * the same explicit step, so this table declares no database cascade.
 */
export const publicCommentReports = sqliteTable(
  "public_comment_reports",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "restrict" }),
    category: text("category").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("public_comment_reports_reporter_comment_idx").on(table.reporterId, table.commentId),
    index("public_comment_reports_expiry_idx").on(table.expiresAt),
    index("public_comment_reports_comment_idx").on(table.commentId, table.createdAt),
    check(
      "public_comment_reports_category_valid",
      sql`${table.category} IN ('spam', 'abuse', 'other')`,
    ),
    check(
      "public_comment_reports_retention_bounded",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + 2592000000`,
    ),
  ],
);

/**
 * One Public-participation suspension per Account, applied by the operator for
 * repeated technical abuse or a metadata-supported report pattern. It carries
 * only the strike count, fixed reason, start and expiry. It is not a content
 * moderation record, an account deletion, or a private-vault lockout: every
 * private operation, hard deletion, unpublishing, recovery and session
 * revocation stays available. Expiry is evaluated against `expires_at`, so a
 * suspension automatically stops applying at its end time; the row is retained
 * (and may be cleared by the operator) so a later offense is a 30-day repeat.
 */
export const publicParticipationSuspensions = sqliteTable(
  "public_participation_suspensions",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "restrict" }),
    strikeCount: integer("strike_count").notNull(),
    reason: text("reason").notNull(),
    startedAt: integer("started_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("public_participation_suspensions_strike_positive", sql`${table.strikeCount} >= 1`),
    check(
      "public_participation_suspensions_reason_valid",
      sql`${table.reason} IN ('repeated_technical_abuse', 'report_pattern')`,
    ),
    check(
      "public_participation_suspensions_bounded",
      sql`${table.expiresAt} > ${table.startedAt} AND ${table.expiresAt} <= ${table.startedAt} + 2592000000`,
    ),
  ],
);

export type PublicCommentReport = typeof publicCommentReports.$inferSelect;
export type PublicParticipationSuspensionRow = typeof publicParticipationSuspensions.$inferSelect;

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

/** Browser-driven work metadata only; keys and content live exclusively in envelopes. */
export const cryptoJobs = sqliteTable("crypto_jobs", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  cursor: text("cursor"),
  initiatingAccountId: text("initiating_account_id").references(() => accounts.id, { onDelete: "restrict" }),
  targetId: text("target_id").references(() => vaultNodes.id, { onDelete: "restrict" }),
  keyEpoch: integer("key_epoch"),
  progress: integer("progress").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("crypto_jobs_device_idx").on(table.accountId, table.deviceId, table.state),
  index("crypto_jobs_account_kind_idx").on(table.accountId, table.kind, table.state, table.id),
  uniqueIndex("crypto_jobs_rotation_target_idx").on(table.targetId).where(sql`${table.kind} = 'key_rotation' AND ${table.state} = 'pending'`),
  uniqueIndex("crypto_jobs_pseudonym_pending_idx").on(table.accountId)
    .where(sql`${table.kind} = 'pseudonym_update' AND ${table.state} = 'pending'`),
  check("crypto_jobs_kind_valid", sql`${table.kind} IN ('recovery_owned', 'enrollment_owned', 'key_rotation', 'pseudonym_update')`),
  check("crypto_jobs_state_valid", sql`${table.state} IN ('pending', 'complete', 'cancelled')`),
  check("crypto_jobs_rotation_metadata", sql`${table.progress} >= 0 AND (${table.kind} != 'key_rotation' OR
    (${table.targetId} IS NOT NULL AND ${table.keyEpoch} IS NOT NULL AND ${table.keyEpoch} >= 1 AND ${table.initiatingAccountId} IS NOT NULL))`),
]);

/** The staged replacement Account profile for one Pseudonym-update job. The
 * service keeps only this opaque envelope until every attribution context is
 * staged; commit copies it into `account_profiles` in the same transaction.
 */
export const pseudonymUpdateProfiles = sqliteTable("pseudonym_update_profiles", {
  jobId: text("job_id").primaryKey().references(() => cryptoJobs.id, { onDelete: "restrict" }),
  ciphertext: blob("ciphertext").notNull(),
  epoch: integer("epoch").notNull(),
  revision: integer("revision").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  check("pseudonym_update_profiles_epoch_positive", sql`${table.epoch} >= 1`),
  check("pseudonym_update_profiles_revision_positive", sql`${table.revision} >= 1`),
  check("pseudonym_update_profiles_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 4096`),
]);

/** One staged, re-encrypted attribution context for a Pseudonym-update job:
 * `thread` names a `thread_attributions` row, `publication` a declaration row.
 * A thread item carries the thread-capability-wrapped content key; a
 * publication declaration is a single HPKE envelope to the Publication link.
 */
export const pseudonymUpdateItems = sqliteTable("pseudonym_update_items", {
  jobId: text("job_id").notNull().references(() => cryptoJobs.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  recordId: text("record_id").notNull(),
  revision: integer("revision").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  contentKeyEnvelope: blob("content_key_envelope"),
  contentKeyEpoch: integer("content_key_epoch"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.kind, table.recordId] }),
  check("pseudonym_update_items_kind_valid", sql`${table.kind} IN ('thread', 'publication')`),
  check("pseudonym_update_items_revision_positive", sql`${table.revision} >= 1`),
  check("pseudonym_update_items_shape", sql`(${table.kind} = 'thread' AND ${table.contentKeyEnvelope} IS NOT NULL
      AND ${table.contentKeyEpoch} IS NOT NULL AND ${table.contentKeyEpoch} >= 1)
    OR (${table.kind} = 'publication' AND ${table.contentKeyEnvelope} IS NULL AND ${table.contentKeyEpoch} IS NULL)`),
  check("pseudonym_update_items_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 4096
    AND (${table.contentKeyEnvelope} IS NULL OR length(${table.contentKeyEnvelope}) BETWEEN 1 AND 16384)`),
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
  /** Fresh server invocation marker gates multi-row writes, never a client capability. */
  commitToken: text("commit_token"),
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
  index("vault_nodes_parent_idx").on(table.parentNodeId),
  uniqueIndex("vault_nodes_owner_target_idx").on(table.ownerId, table.id, table.kind),
  // The reciprocal, deferred FKs to directories and directory_entries are in
  // the reviewed migration: Drizzle cannot express this circular relationship.
]);

/** Current revision of one Directory namespace; no plaintext name index exists. */
export const directories = sqliteTable("directories", {
  nodeId: text("node_id").primaryKey().references(() => vaultNodes.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull(),
  entriesRevision: integer("entries_revision").notNull(),
  /** Installed ciphertext epoch; a rotation seal fences the next capability epoch. */
  keyEpoch: integer("key_epoch").notNull().default(1),
  /** Device-signed, encrypted commitment to the current entry ciphertexts (migration 0009). */
  listingCiphertext: blob("listing_ciphertext"),
  listingDigest: blob("listing_digest"),
  listingSignature: blob("listing_signature"),
  listingDeviceId: text("listing_device_id").references(() => encryptionDevices.id, { onDelete: "restrict" }),
}, (table) => [
  uniqueIndex("directories_owner_node_idx").on(table.ownerId, table.nodeId),
  index("directories_listing_device_idx").on(table.listingDeviceId),
  check("directories_revision_positive", sql`${table.entriesRevision} >= 1`),
  check("directories_epoch_positive", sql`${table.keyEpoch} >= 1`),
]);

/** One File has exactly one current encrypted representation, not a version history. */
export const files = sqliteTable("files", {
  nodeId: text("node_id").primaryKey().references(() => vaultNodes.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull(),
  currentRepresentationId: text("current_representation_id").notNull(),
  currentRevision: integer("current_revision").notNull(),
  /** Both null identifies the legacy parent-wrapped format. */
  capabilityId: text("capability_id"),
  capabilityEpoch: integer("capability_epoch"),
}, (table) => [
  uniqueIndex("files_owner_node_idx").on(table.ownerId, table.nodeId),
  check("files_revision_positive", sql`${table.currentRevision} >= 1`),
  check("files_capability_pair", sql`(${table.capabilityId} IS NULL AND ${table.capabilityEpoch} IS NULL)
    OR (${table.capabilityId} IS NOT NULL AND ${table.capabilityEpoch} IS NOT NULL AND ${table.capabilityEpoch} >= 1)`),
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
}, (table) => [
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
  keyEnvelope: blob("key_envelope"),
  headDigest: blob("head_digest"),
  headSignature: blob("head_signature"),
  headDeviceId: text("head_device_id").references(() => encryptionDevices.id, { onDelete: "restrict" }),
}, (table) => [
  uniqueIndex("file_representations_owner_pointer_idx").on(table.ownerId, table.fileNodeId, table.id, table.revision),
  uniqueIndex("file_representations_file_revision_idx").on(table.fileNodeId, table.revision),
  check("file_representations_revision_positive", sql`${table.revision} >= 1`),
  check("file_representations_epoch_positive", sql`${table.keyEpoch} >= 1`),
  check("file_representations_head_complete", sql`(${table.keyEnvelope} IS NULL AND ${table.headDigest} IS NULL
    AND ${table.headSignature} IS NULL AND ${table.headDeviceId} IS NULL) OR
    (${table.keyEnvelope} IS NOT NULL AND length(${table.keyEnvelope}) BETWEEN 1 AND 16384
      AND ${table.headDigest} IS NOT NULL AND length(${table.headDigest}) = 32
      AND ${table.headSignature} IS NOT NULL AND length(${table.headSignature}) = 64 AND ${table.headDeviceId} IS NOT NULL)`),
  check("file_representations_ciphertext_bounded", sql`length(${table.ciphertext}) <= 524288 AND ${table.ciphertextSize} = length(${table.ciphertext})`),
  foreignKey({ columns: [table.ownerId, table.fileNodeId],
    foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
]);

/** Only pending invitations are retained; cancellation/decline deletes the row. */
export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  recipientId: text("recipient_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  targetId: text("target_id").notNull(),
  targetKind: text("target_kind").notNull(),
  permission: text("permission").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("shares_relationship_idx").on(table.ownerId, table.recipientId, table.targetId),
  index("shares_recipient_idx").on(table.recipientId, table.id),
  index("shares_owner_idx").on(table.ownerId, table.id),
  index("shares_target_idx").on(table.targetId),
  foreignKey({ columns: [table.ownerId, table.targetId, table.targetKind],
    foreignColumns: [vaultNodes.ownerId, vaultNodes.id, vaultNodes.kind] }).onDelete("restrict"),
  check("shares_permission_valid", sql`${table.permission} IN ('read_only', 'read_write')`),
  check("shares_target_kind_valid", sql`${table.targetKind} IN ('directory', 'file')`),
  check("shares_no_self", sql`${table.ownerId} != ${table.recipientId}`),
]);

/** Expired Grants retain a write seal until bounded cleanup hands off to rotation. */
export const grants = sqliteTable("grants", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  recipientId: text("recipient_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  targetId: text("target_id").notNull(),
  targetKind: text("target_kind").notNull(),
  permission: text("permission").notNull(),
  revision: integer("revision").notNull(),
  keyEpoch: integer("key_epoch").notNull(),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("grants_relationship_idx").on(table.ownerId, table.recipientId, table.targetId),
  index("grants_recipient_target_idx").on(table.recipientId, table.targetId, table.ownerId, table.targetKind, table.permission, table.expiresAt),
  index("grants_expiry_idx").on(table.expiresAt, table.id),
  index("grants_owner_expiry_idx").on(table.ownerId, table.expiresAt, table.id),
  index("grants_recipient_idx").on(table.recipientId, table.id),
  index("grants_owner_idx").on(table.ownerId, table.id),
  index("grants_target_idx").on(table.targetId),
  foreignKey({ columns: [table.ownerId, table.targetId, table.targetKind],
    foreignColumns: [vaultNodes.ownerId, vaultNodes.id, vaultNodes.kind] }).onDelete("restrict"),
  check("grants_permission_valid", sql`${table.permission} IN ('read_only', 'read_write')`),
  check("grants_target_kind_valid", sql`${table.targetKind} IN ('directory', 'file')`),
  check("grants_no_self", sql`${table.ownerId} != ${table.recipientId}`),
  check("grants_revision_positive", sql`${table.revision} >= 1`),
  check("grants_epoch_positive", sql`${table.keyEpoch} >= 1`),
]);

/** Pending and active delivery have separate RESTRICT lifecycles: acceptance
 * copies current material and deletes pending material in one proof-gated batch.
 */
function sharingEnvelopeColumns(relationship: () => AnySQLiteColumn) {
  return {
    relationshipId: text("relationship_id").notNull().references(relationship, { onDelete: "restrict" }),
    deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
    capabilityId: text("capability_id").notNull(),
    capabilityEpoch: integer("capability_epoch").notNull(),
    grantKeyEpoch: integer("grant_key_epoch").notNull(),
    ownerRegistryEpoch: integer("owner_registry_epoch").notNull(),
    recipientRegistryEpoch: integer("recipient_registry_epoch").notNull(),
    ciphertext: blob("ciphertext").notNull(),
    signature: blob("signature").notNull(),
    signerDeviceId: text("signer_device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  };
}
export const shareKeyEnvelopes = sqliteTable("share_key_envelopes", sharingEnvelopeColumns(() => shares.id), (table) => [
  primaryKey({ columns: [table.relationshipId, table.deviceId] }),
  check("share_key_envelopes_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.signature}) = 64`),
  check("share_key_envelopes_epochs", sql`${table.capabilityEpoch} >= 1 AND ${table.grantKeyEpoch} >= 1
    AND ${table.ownerRegistryEpoch} >= 1 AND ${table.recipientRegistryEpoch} >= 1`),
]);
export const grantKeyEnvelopes = sqliteTable("grant_key_envelopes", sharingEnvelopeColumns(() => grants.id), (table) => [
  primaryKey({ columns: [table.relationshipId, table.deviceId] }),
  check("grant_key_envelopes_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.signature}) = 64`),
  check("grant_key_envelopes_epochs", sql`${table.capabilityEpoch} >= 1 AND ${table.grantKeyEpoch} >= 1
    AND ${table.ownerRegistryEpoch} >= 1 AND ${table.recipientRegistryEpoch} >= 1`),
]);

/** Opaque current/retained Comment capability requirements. Comment producers
 * register/remove these in their own lifecycle transaction (tickets 21/23/25).
 * No Comment body, name, key, or Publication-link capability is stored here.
 */
export const sharingCommentCapabilities = sqliteTable("sharing_comment_capabilities", {
  objectId: text("object_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  fileId: text("file_id").notNull(),
  threadId: text("thread_id").notNull(),
  purpose: text("purpose").notNull(),
  publicationId: text("publication_id"),
  capabilityId: text("capability_id").notNull(),
  capabilityEpoch: integer("capability_epoch").notNull(),
}, (table) => [
  foreignKey({ columns: [table.ownerId, table.fileId], foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
  index("sharing_comment_capabilities_file_idx").on(table.fileId, table.objectId),
  uniqueIndex("sharing_comment_capabilities_private_idx").on(table.fileId).where(sql`${table.purpose} = 'private-comment-thread'`),
  check("sharing_comment_capabilities_context", sql`(${table.purpose} = 'private-comment-thread'
    AND ${table.publicationId} IS NULL AND ${table.objectId} = ${table.threadId}) OR
    (${table.purpose} = 'public-comment-audience-epoch' AND ${table.publicationId} IS NOT NULL)`),
  check("sharing_comment_capabilities_epoch", sql`${table.capabilityEpoch} >= 1`),
]);

function commentEnvelopeColumns(relationship: () => AnySQLiteColumn) {
  return { ...sharingEnvelopeColumns(relationship),
    objectId: text("object_id").notNull().references(() => sharingCommentCapabilities.objectId, { onDelete: "restrict" }) };
}
export const shareCommentKeyEnvelopes = sqliteTable("share_comment_key_envelopes", commentEnvelopeColumns(() => shares.id), (table) => [
  primaryKey({ columns: [table.relationshipId, table.objectId, table.deviceId] }),
  index("share_comment_key_envelopes_device_idx").on(table.deviceId),
  index("share_comment_key_envelopes_object_idx").on(table.objectId),
  check("share_comment_key_envelopes_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.signature}) = 64`),
  check("share_comment_key_envelopes_epochs", sql`${table.capabilityEpoch} >= 1 AND ${table.grantKeyEpoch} >= 1
    AND ${table.ownerRegistryEpoch} >= 1 AND ${table.recipientRegistryEpoch} >= 1`),
]);
export const grantCommentKeyEnvelopes = sqliteTable("grant_comment_key_envelopes", commentEnvelopeColumns(() => grants.id), (table) => [
  primaryKey({ columns: [table.relationshipId, table.objectId, table.deviceId] }),
  index("grant_comment_key_envelopes_device_idx").on(table.deviceId),
  index("grant_comment_key_envelopes_object_idx").on(table.objectId),
  check("grant_comment_key_envelopes_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 16384 AND length(${table.signature}) = 64`),
  check("grant_comment_key_envelopes_epochs", sql`${table.capabilityEpoch} >= 1 AND ${table.grantKeyEpoch} >= 1
    AND ${table.ownerRegistryEpoch} >= 1 AND ${table.recipientRegistryEpoch} >= 1`),
]);

/** Only an opaque active-Grant/device need, never a capability or content job. */
export const provisioningNeeds = sqliteTable("provisioning_needs", {
  grantId: text("grant_id").notNull().references(() => grants.id, { onDelete: "restrict" }),
  deviceId: text("device_id").notNull().references(() => encryptionDevices.id, { onDelete: "restrict" }),
  grantKeyEpoch: integer("grant_key_epoch").notNull(),
}, (table) => [
  primaryKey({ columns: [table.grantId, table.deviceId] }),
  index("provisioning_needs_device_idx").on(table.deviceId),
  check("provisioning_needs_epoch", sql`${table.grantKeyEpoch} >= 1`),
]);

/** Current next-epoch safety fence, not sharing history. Only completed rotation removes it. */
export const sharingWriteBlocks = sqliteTable("sharing_write_blocks", {
  targetId: text("target_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  targetKind: text("target_kind").notNull(),
  keyEpoch: integer("key_epoch").notNull().default(2),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  foreignKey({ columns: [table.ownerId, table.targetId, table.targetKind],
    foreignColumns: [vaultNodes.ownerId, vaultNodes.id, vaultNodes.kind] }).onDelete("restrict"),
]);

/** Bounded traversal and ciphertext-only staging, separate from job metadata. */
export const keyRotationItems = sqliteTable("key_rotation_items", {
  jobId: text("job_id").notNull().references(() => cryptoJobs.id, { onDelete: "restrict" }),
  objectId: text("object_id").notNull(),
  kind: text("kind").notNull(),
  fileId: text("file_id"),
  depth: integer("depth").notNull(),
  state: text("state").notNull().default("ready"),
  sourceEpoch: integer("source_epoch"),
  targetEpoch: integer("target_epoch"),
  capabilityId: text("capability_id"),
  sourceRevision: integer("source_revision"),
  sourceRepresentationId: text("source_representation_id"),
  resumeEnvelope: blob("resume_envelope"),
  cursor: text("cursor"),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.objectId] }),
  index("key_rotation_items_next_idx").on(table.jobId, table.state, table.depth, table.objectId),
  check("key_rotation_items_kind", sql`${table.kind} IN ('directory', 'file', 'private_comment', 'public_history')`),
  check("key_rotation_items_state", sql`${table.state} IN ('ready', 'staging', 'complete')`),
  check("key_rotation_items_depth", sql`${table.depth} BETWEEN 0 AND 101`),
  check("key_rotation_items_envelope", sql`${table.resumeEnvelope} IS NULL OR length(${table.resumeEnvelope}) BETWEEN 1 AND 16384`),
]);

export const keyRotationEntries = sqliteTable("key_rotation_entries", {
  jobId: text("job_id").notNull(),
  directoryId: text("directory_id").notNull(),
  childId: text("child_id").notNull().references(() => vaultNodes.id, { onDelete: "restrict" }),
  nameCiphertext: blob("name_ciphertext").notNull(),
  orderCiphertext: blob("order_ciphertext").notNull(),
  keyEnvelope: blob("key_envelope").notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.directoryId, table.childId] }),
  foreignKey({ columns: [table.jobId, table.directoryId], foreignColumns: [keyRotationItems.jobId, keyRotationItems.objectId] }).onDelete("restrict"),
  check("key_rotation_entries_bounded", sql`length(${table.nameCiphertext}) BETWEEN 1 AND 4096
    AND length(${table.orderCiphertext}) BETWEEN 1 AND 4096 AND length(${table.keyEnvelope}) BETWEEN 1 AND 16384`),
]);

/** Immutable request-byte receipts make lost-response retries observable and harmless. */
export const keyRotationReceipts = sqliteTable("key_rotation_receipts", {
  jobId: text("job_id").notNull().references(() => cryptoJobs.id, { onDelete: "restrict" }),
  operationId: text("operation_id").notNull(),
  digest: blob("digest").notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.operationId] }),
  check("key_rotation_receipts_digest", sql`length(${table.digest}) = 32`),
]);

/** Rewrapped per-record content-key envelopes staged for one Private Comment
 * thread rotation. Comments and attributions preserve body/history ciphertext;
 * only the wrapper beneath the replacement thread capability changes.
 */
export const keyRotationCommentItems = sqliteTable("key_rotation_comment_items", {
  jobId: text("job_id").notNull(),
  threadId: text("thread_id").notNull(),
  kind: text("kind").notNull(),
  recordId: text("record_id").notNull(),
  revision: integer("revision").notNull(),
  contentKeyEnvelope: blob("content_key_envelope").notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.kind, table.recordId] }),
  index("key_rotation_comment_items_page_idx").on(table.jobId, table.threadId, table.kind, table.recordId),
  foreignKey({ columns: [table.jobId, table.threadId],
    foreignColumns: [keyRotationItems.jobId, keyRotationItems.objectId] }).onDelete("restrict"),
  check("key_rotation_comment_items_kind", sql`${table.kind} IN ('comment', 'attribution')`),
  check("key_rotation_comment_items_revision_positive", sql`${table.revision} >= 1`),
  check("key_rotation_comment_items_bounded", sql`length(${table.contentKeyEnvelope}) BETWEEN 1 AND 16384`),
]);

/** One key epoch per Comment thread. A Private thread keeps exactly one active
 * row whose `key_epoch` is its current thread capability epoch; Public threads
 * retain prior audience epochs. The thread's current epoch pointer below is the
 * constrained representation of that current Private key epoch.
 */
export const commentThreadEpochs = sqliteTable("comment_thread_epochs", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => commentThreads.id, { onDelete: "restrict" }),
  /** Null for a Private thread; immutable audience for a Public audience epoch. */
  audience: text("audience"),
  keyEpoch: integer("key_epoch").notNull(),
  ordinal: integer("ordinal").notNull(),
  state: text("state").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("comment_thread_epochs_current_idx").on(table.threadId).where(sql`${table.state} = 'active'`),
  uniqueIndex("comment_thread_epochs_ordinal_idx").on(table.threadId, table.ordinal),
  uniqueIndex("comment_thread_epochs_identity_idx").on(table.id, table.threadId),
  check("comment_thread_epochs_audience_valid",
    sql`${table.audience} IS NULL OR ${table.audience} IN ('public', 'collaborators_only')`),
  check("comment_thread_epochs_epoch_positive", sql`${table.keyEpoch} >= 1`),
  check("comment_thread_epochs_ordinal_positive", sql`${table.ordinal} >= 1`),
  check("comment_thread_epochs_state_valid", sql`${table.state} IN ('active', 'retained')`),
]);

/** Exactly one Private thread per File; one Public thread per logical
 * Publication. No Comment body, pseudonym, or capability is stored here.
 */
export const commentThreads = sqliteTable("comment_threads", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  fileId: text("file_id").notNull(),
  purpose: text("purpose").notNull(),
  publicationId: text("publication_id"),
  currentEpochId: text("current_epoch_id").notNull(),
  nextSequence: integer("next_sequence").notNull().default(1),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("comment_threads_private_file_idx").on(table.fileId).where(sql`${table.purpose} = 'private'`),
  uniqueIndex("comment_threads_public_publication_idx").on(table.publicationId).where(sql`${table.purpose} = 'public'`),
  index("comment_threads_owner_idx").on(table.ownerId, table.id),
  foreignKey({ columns: [table.ownerId, table.fileId], foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
  // The reciprocal current-epoch constraint is a reviewed migration FK:
  // (current_epoch_id, id) -> comment_thread_epochs(id, thread_id).
  check("comment_threads_purpose_context", sql`(${table.purpose} = 'private' AND ${table.publicationId} IS NULL)
    OR (${table.purpose} = 'public' AND ${table.publicationId} IS NOT NULL)`),
  check("comment_threads_sequence_positive", sql`${table.nextSequence} >= 1`),
]);

/** One current displayed-pseudonym declaration per author and thread scope.
 * The pseudonym is an `attribution` envelope whose per-record content key is
 * wrapped beneath the thread capability; the matching device access is the
 * thread capability envelope relationship (share/grant/owned-device rows).
 */
export const threadAttributions = sqliteTable("thread_attributions", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  authorId: text("author_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  epochId: text("epoch_id").notNull(),
  revision: integer("revision").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  contentKeyEnvelope: blob("content_key_envelope").notNull(),
  contentKeyEpoch: integer("content_key_epoch").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("thread_attributions_author_idx").on(table.threadId, table.authorId),
  foreignKey({ columns: [table.threadId, table.epochId],
    foreignColumns: [commentThreadEpochs.threadId, commentThreadEpochs.id] }).onDelete("restrict"),
  check("thread_attributions_revision_positive", sql`${table.revision} >= 1`),
  check("thread_attributions_epoch_positive", sql`${table.contentKeyEpoch} >= 1`),
  check("thread_attributions_bounded",
    sql`length(${table.ciphertext}) BETWEEN 1 AND 4096 AND length(${table.contentKeyEnvelope}) BETWEEN 1 AND 16384`),
]);

/** The one symmetric wrapper that lets a reader holding the Publication
 * fragment decrypt a `public` audience epoch. A Collaborators-only epoch has
 * no row here. The wrapper is bound to its link, epoch and capability identity;
 * ticket 25 replaces it in place when the Publication link rotates.
 */
export const publicCommentEpochLinks = sqliteTable("public_comment_epoch_links", {
  epochId: text("epoch_id").primaryKey().references(() => commentThreadEpochs.id, { onDelete: "restrict" }),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "restrict" }),
  linkId: text("link_id").notNull().references(() => publicationLinks.id, { onDelete: "restrict" }),
  keyEpoch: integer("key_epoch").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("public_comment_epoch_links_link_idx").on(table.linkId, table.epochId),
  index("public_comment_epoch_links_publication_idx").on(table.publicationId),
  check("public_comment_epoch_links_epoch_positive", sql`${table.keyEpoch} >= 1`),
  check("public_comment_epoch_links_bounded", sql`length(${table.ciphertext}) BETWEEN 1 AND 16384`),
]);

/** One flat ordered Comment. Plain text only: the body is a `comment-content`
 * envelope whose fresh content key is wrapped beneath the thread capability.
 */
export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => commentThreads.id, { onDelete: "restrict" }),
  epochId: text("epoch_id").notNull(),
  authorId: text("author_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  revision: integer("revision").notNull(),
  bodyCiphertext: blob("body_ciphertext").notNull(),
  bodySize: integer("body_size").notNull(),
  contentKeyEnvelope: blob("content_key_envelope").notNull(),
  contentKeyEpoch: integer("content_key_epoch").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("comments_thread_sequence_idx").on(table.threadId, table.sequence),
  index("comments_author_idx").on(table.authorId, table.threadId),
  foreignKey({ columns: [table.threadId, table.epochId],
    foreignColumns: [commentThreadEpochs.threadId, commentThreadEpochs.id] }).onDelete("restrict"),
  check("comments_sequence_positive", sql`${table.sequence} >= 1`),
  check("comments_revision_positive", sql`${table.revision} >= 1`),
  check("comments_epoch_positive", sql`${table.contentKeyEpoch} >= 1`),
  check("comments_body_bounded",
    sql`length(${table.bodyCiphertext}) BETWEEN 1 AND 16384 AND ${table.bodySize} = length(${table.bodyCiphertext})`),
  check("comments_key_envelope_bounded", sql`length(${table.contentKeyEnvelope}) BETWEEN 1 AND 16384`),
]);

export type CommentThread = typeof commentThreads.$inferSelect;
export type CommentThreadEpoch = typeof commentThreadEpochs.$inferSelect;
export type PublicCommentEpochLink = typeof publicCommentEpochLinks.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type ThreadAttribution = typeof threadAttributions.$inferSelect;

/** Opaque 256-bit base64url identifier: no timestamp, Owner, File, or name. */
function opaquePublicationIdentifier(column: AnySQLiteColumn) {
  return sql`length(${column}) = 43 AND ${column} NOT GLOB '*[^A-Za-z0-9_-]*'`;
}

/** One logical Publication per File while active or sealed for teardown. While
 * active it points at exactly one current link and Public representation; the
 * reciprocal deferred pointer FKs, insert/state triggers and the File-capability
 * requirement are in the reviewed 0020 migration (Drizzle cannot express them).
 */
export const publications = sqliteTable("publications", {
  /** The logical Publication; it survives link rotation and is never routable. */
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull(),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  state: text("state").notNull(),
  currentLinkId: text("current_link_id"),
  currentRepresentationId: text("current_representation_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("publications_file_idx").on(table.fileId).where(sql`${table.state} IN ('active', 'deleting')`),
  foreignKey({ columns: [table.ownerId, table.fileId], foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
  check("publications_id_opaque", opaquePublicationIdentifier(table.id)),
  check("publications_state_valid", sql`${table.state} IN ('active', 'deleting')`),
  check("publications_state_pointers", sql`(${table.state} = 'active' AND ${table.currentLinkId} IS NOT NULL
      AND ${table.currentRepresentationId} IS NOT NULL)
    OR (${table.state} = 'deleting' AND ${table.currentLinkId} IS NULL AND ${table.currentRepresentationId} IS NULL)`),
]);

/** The active opaque path ID and the link's public encryption key. The read
 * capability stays in the URL fragment and has no column anywhere.
 */
export const publicationLinks = sqliteTable("publication_links", {
  /** Path ID: an independent 256-bit random value, unique among live links. */
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "restrict" }),
  /** Raw SEC1 uncompressed P-256 point. */
  publicKey: blob("public_key").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("publication_links_publication_idx").on(table.publicationId),
  uniqueIndex("publication_links_identity_idx").on(table.id, table.publicationId),
  check("publication_links_id_opaque", opaquePublicationIdentifier(table.id)),
  check("publication_links_public_key", sql`typeof(${table.publicKey}) = 'blob' AND length(${table.publicKey}) = 65
    AND substr(${table.publicKey}, 1, 1) = X'04'`),
]);

/** One current encrypted presentation payload, separate from the private
 * representation and bounded by the same 524,288-byte BLOB constraint.
 */
export const publicRepresentations = sqliteTable("public_representations", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "restrict" }),
  /** The link whose public key this ciphertext was encrypted to. */
  linkId: text("link_id").notNull(),
  /** Publication-scoped presentation revision; never the File's revision count. */
  revision: integer("revision").notNull(),
  /** Server-only pairing: the File revision whose saved source this presents. */
  fileRevision: integer("file_revision").notNull(),
  ciphertext: blob("ciphertext").notNull(),
  ciphertextSize: integer("ciphertext_size").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("public_representations_revision_idx").on(table.publicationId, table.revision),
  // Target of the Publication's current-pointer FK: the current representation
  // is always one encrypted for the current link. Superseded rows are removed.
  uniqueIndex("public_representations_pointer_idx").on(table.id, table.publicationId, table.linkId),
  check("public_representations_revision_positive", sql`${table.revision} >= 1 AND ${table.fileRevision} >= 1`),
  check("public_representations_ciphertext_bounded", sql`length(${table.ciphertext}) <= 524288 AND ${table.ciphertextSize} = length(${table.ciphertext})`),
]);

/** A Collaborator's pending request; it grants no public access. Approval
 * (the Owner publishing), denial and cancellation remove it.
 */
export const publicationRequests = sqliteTable("publication_requests", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull(),
  ownerId: text("owner_id").notNull(),
  requesterId: text("requester_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("publication_requests_requester_idx").on(table.fileId, table.requesterId),
  foreignKey({ columns: [table.ownerId, table.fileId], foreignColumns: [files.ownerId, files.nodeId] }).onDelete("restrict"),
  check("publication_requests_not_owner", sql`${table.requesterId} != ${table.ownerId}`),
]);

/** Owner-selected pseudonymous authors. Each encrypted declaration is written by
 * the author's own device to the current link key; a pending row has none.
 */
export const publicationAuthors = sqliteTable("publication_authors", {
  /** Declaration ID: random and bound in the envelope a Public reader sees. */
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "restrict" }),
  authorId: text("author_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  /** The link the declaration is encrypted to; only the current link's are served. */
  linkId: text("link_id"),
  revision: integer("revision").notNull(),
  ciphertext: blob("ciphertext"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("publication_authors_author_idx").on(table.publicationId, table.authorId),
  uniqueIndex("publication_authors_ordinal_idx").on(table.publicationId, table.ordinal),
  check("publication_authors_id_opaque", opaquePublicationIdentifier(table.id)),
  check("publication_authors_ordinal_positive", sql`${table.ordinal} >= 1`),
  check("publication_authors_declaration", sql`(${table.ciphertext} IS NULL AND ${table.linkId} IS NULL AND ${table.revision} >= 0)
    OR (${table.ciphertext} IS NOT NULL AND ${table.linkId} IS NOT NULL AND ${table.revision} >= 1
      AND length(${table.ciphertext}) BETWEEN 1 AND 4096)`),
]);

/** The sealed teardown marker for one `deleting` Publication. Its presence is
 * what makes the irreversible state recoverable (Owner-resumable bounded
 * deletion batches); the count is the progress denominator the seal computed.
 * Immutable: only deleting the whole Publication removes it. No ciphertext,
 * Comment text, capability, or other Public material is stored here.
 */
export const publicationTeardowns = sqliteTable("publication_teardowns", {
  publicationId: text("publication_id").primaryKey().references(() => publications.id, { onDelete: "restrict" }),
  ownerId: text("owner_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  /** Public Comments counted in the seal transaction; the confirmation total. */
  commentTotal: integer("comment_total").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  check("publication_teardowns_comment_total", sql`${table.commentTotal} >= 0`),
]);

export type Publication = typeof publications.$inferSelect;
export type PublicationLink = typeof publicationLinks.$inferSelect;
export type PublicRepresentation = typeof publicRepresentations.$inferSelect;
export type PublicationTeardown = typeof publicationTeardowns.$inferSelect;

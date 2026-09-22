import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * mdwn foundation schema.
 *
 * The TypeScript schema is the single source of truth; reviewed, generated
 * SQL migrations live in ./drizzle and are applied to D1 through Wrangler
 * (npm run db:migrate:*). Later build tickets add their tables here as new
 * migrations — ticket 06 owns accounts/auth columns beyond this locked base.
 *
 * This first migration intentionally carries only `accounts`, whose columns
 * are fixed by the data-model decision (wayfinder 09) and the buildable spec
 * §8.2, so the migration pipeline has a real, committed target to prove
 * against. It creates nothing speculative, and never stores plaintext.
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
  },
  (table) => [
    index("webauthn_challenges_expiry_idx").on(table.expiresAt),
    index("webauthn_challenges_session_idx").on(table.sessionId),
    check(
      "webauthn_challenges_purpose_valid",
      sql`${table.purpose} IN ('sign_in', 'fresh_assertion', 'passkey_registration')`,
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

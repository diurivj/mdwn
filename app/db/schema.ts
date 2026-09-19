import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
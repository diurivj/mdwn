import type { SQL } from "drizzle-orm";
import { sql } from "~/shared/db/client.server";

/**
 * Staged Pseudonym-update items whose attribution context is being removed.
 * This module owns the `pseudonym_update_items` delete shape so the Comment
 * and Publication deletion paths share it instead of inlining the table name.
 *
 * A staged item names one `thread_attributions` row (`thread`) or one
 * `publication_authors` row (`publication`) with its opaque record ID. The
 * caller passes a SQL selector over the live rows and supplies the same
 * committed/marker predicate as its deletion transaction.
 */
export function deletedPseudonymItems(kind: "thread" | "publication", recordIds: SQL, marker: SQL): SQL {
  return sql`DELETE FROM pseudonym_update_items WHERE kind = ${kind} AND record_id IN (${recordIds}) AND ${marker}`;
}

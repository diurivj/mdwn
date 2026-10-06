import { sql, type SQL } from "drizzle-orm";

/** Normal reads require the durable Import marker, independent of staging TTL.
 * Canonical rows materialize in the marker transaction; this is defense in
 * depth for the visible-atomic invariant, shared by access and traversal.
 */
export function committedNodeVisible(alias: SQL): SQL {
  return sql`(${alias}.import_id IS NULL OR EXISTS (SELECT 1 FROM import_commits c WHERE c.import_id = ${alias}.import_id))`;
}

import { sql, type SQL } from "drizzle-orm";
import { committedNodeVisible } from "../import/visibility.server.ts";

export const MAX_DELETE_NODES = 500;

/** Bounded depth-first cursor, not a breadth-first recursive work queue.
 * Each recursive step probes ONE successor child via (parent_node_id, id).
 * A visible child pushes one return cursor; exhaustion pops one. Hidden Import
 * nodes advance the sibling cursor without descending. Every candidate counts
 * toward the safety budget, so even malformed hidden/cyclic trees fail closed.
 * At most 501 candidates and 1,001 cursor states; the recursive queue has one
 * successor, independent of a Directory's width. Ciphertext is never loaded.
 *
 * Returns visible IDs plus an overflow flag (repeated per ID). Callers must
 * refuse overflow before deleting and repeat this query in their snapshot CAS.
 */
export function boundedSubtreeQuery(nodeId: string | SQL): SQL {
  const visible = committedNodeVisible(sql`n`);
  return sql`WITH RECURSIVE walk(parent_id, cursor_id, stack, id, visited, steps) AS (
    SELECT ${nodeId}, NULL, json_array(), ${nodeId}, 1, 1
    UNION ALL
    SELECT
      CASE WHEN n.id IS NULL THEN json_extract(w.stack, '$[#-1][0]')
        WHEN ${visible} THEN n.id ELSE w.parent_id END,
      CASE WHEN n.id IS NULL THEN json_extract(w.stack, '$[#-1][1]')
        WHEN ${visible} THEN NULL ELSE n.id END,
      CASE WHEN n.id IS NULL THEN json_remove(w.stack, '$[#-1]')
        WHEN ${visible} THEN json_insert(w.stack, '$[#]', json_array(w.parent_id, n.id)) ELSE w.stack END,
      CASE WHEN n.id IS NOT NULL AND ${visible} THEN n.id ELSE NULL END,
      w.visited + (n.id IS NOT NULL), w.steps + 1
    FROM walk w LEFT JOIN vault_nodes n ON n.id = (
      SELECT child.id FROM vault_nodes child INDEXED BY vault_nodes_parent_idx
      WHERE child.parent_node_id = w.parent_id AND child.id > coalesce(w.cursor_id, '')
      ORDER BY child.id LIMIT 1)
    WHERE w.visited <= ${MAX_DELETE_NODES} AND w.steps < ${2 * MAX_DELETE_NODES + 1}
      AND (n.id IS NOT NULL OR json_array_length(w.stack) > 0)
  ), budget AS MATERIALIZED (SELECT max(visited) AS visited, max(steps) AS steps FROM walk)
  SELECT w.id, budget.visited, budget.steps,
    (budget.visited > ${MAX_DELETE_NODES} OR budget.steps >= ${2 * MAX_DELETE_NODES + 1}) AS overflow
  FROM walk w CROSS JOIN budget WHERE w.id IS NOT NULL`;
}

import { spawnWrangler } from "./wrangler-targets.mjs";
import { QUERY_PLANS, assertQueryPlan, coveringProbeSql } from "./d1-query-plans.mjs";

/** Execute read-only, source-controlled operational SQL. No request inputs.
 * @param {string[]} bindArgs @param {string} sql
 * @returns {Array<{results?: Array<Record<string, unknown>>}>}
 */
function execute(bindArgs, sql) {
  const result = spawnWrangler(["d1", "execute", "DB", ...bindArgs, "--json", "--command", sql]);
  if (result.status !== 0) throw new Error(`D1 operational query failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Check effective enforcement, not just REFERENCES declarations.
 * @param {string[]} bindArgs
 */
export function verifyForeignKeys(bindArgs) {
  const [enabled, integrity] = execute(bindArgs, "PRAGMA foreign_keys; PRAGMA foreign_key_check;");
  if (enabled?.results?.[0]?.foreign_keys !== 1) throw new Error("D1 foreign-key enforcement is not enabled");
  if (!integrity || integrity.results?.length !== 0) throw new Error("D1 foreign-key integrity check failed");
  console.log("✓ D1 foreign_keys = 1; foreign_key_check returned zero violations");
}

/** @param {Array<{results?: Array<Record<string, unknown>>}>} rows @param {number} index @param {string} name */
function planDetails(rows, index, name) {
  const values = rows[index]?.results;
  if (!values || !values.length || values.some((row) => typeof row.detail !== "string")) {
    throw new Error(`No query plan returned for ${name}`);
  }
  return values.map((row) => ({ detail: String(row.detail) }));
}

/** Capture the planner-selected paths separately from labelled covering probes.
 * @param {string[]} bindArgs @returns {string}
 */
export function reviewedQueryPlans(bindArgs) {
  const statements = QUERY_PLANS.flatMap((query) => [
    `EXPLAIN QUERY PLAN ${query.sql};`,
    ...(query.probeFrom ? [`EXPLAIN QUERY PLAN ${coveringProbeSql(query)};`] : []),
  ]).join("\n");
  const results = execute(bindArgs, statements);
  let position = 0;
  const sections = QUERY_PLANS.map((query) => {
    const selected = planDetails(results, position++, query.name);
    assertQueryPlan(query, selected, false);
    const probe = query.probeFrom ? planDetails(results, position++, query.name) : selected;
    assertQueryPlan(query, probe);
    return `## ${query.name}\n\nSource: \`${query.source}\`\n\n\`\`\`sql\n${query.sql}\n\`\`\`\n\nSelected plan:\n\n\`\`\`text\n${selected.map((row) => row.detail).join("\n")}\n\`\`\`${
      query.probeFrom
        ? `\n\nCovering companion probe (explicit INDEXED BY; not the selected plan):\n\n\`\`\`sql\n${coveringProbeSql(query)}\n\`\`\`\n\n\`\`\`text\n${probe.map((row) => row.detail).join("\n")}\n\`\`\``
        : ""
    }`;
  });
  if (position !== results.length) throw new Error("Unexpected query-plan result count");
  return `# D1 operational query plans\n\nAll ${QUERY_PLANS.length} representative queries use persistent indexed base-table searches.\nCTE/worklist scans are bounded; payload ciphertext is not duplicated in indexes.\nSelected unique-point lookups are reported honestly, with separate covering probes where needed.\n\n${sections.join("\n\n")}\n`;
}

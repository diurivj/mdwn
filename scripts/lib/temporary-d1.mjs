/** Confirmed-creation ledger and UUID-bound deletion for disposable D1 only. */
import { join } from "node:path";
import { COMPATIBILITY_DATE, runWranglerOrThrow, writeSensitive } from "./restore-cli-support.mjs";

/** Only a successful, unambiguous creation snippet confirms ownership.
 * See docs/operations/d1-scripting.md#resource-identities-and-command-output.
 * @param {string} output
 */
function createdDatabaseId(output) {
  const ids = [
    ...output.matchAll(/"database_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi),
  ];
  if (ids.length !== 1)
    throw new Error("Database creation returned no unambiguous identifier; creation outcome is unresolved");
  return ids[0][1];
}

/**
 * @param {{ name: string, directory: string, lifecycle: ReturnType<typeof import("./script-lifecycle.mjs").createScriptLifecycle>, createArgs?: string[] }} options
 */
export function createTemporaryDatabase({ name, directory, lifecycle, createArgs = [] }) {
  let uuid = "";
  const configPath = join(directory, `${name}.cleanup.jsonc`);
  const pending = lifecycle.pendingResource({
    kind: "D1",
    name,
    remove() {
      // Bind deletion to the confirmed UUID, not a fresh name lookup; see
      // docs/operations/d1-scripting.md#resource-identities-and-command-output.
      writeSensitive(
        configPath,
        JSON.stringify({
          name: "mdwn-disposable-cleanup",
          compatibility_date: COMPATIBILITY_DATE,
          d1_databases: [{ binding: "DB", database_name: name, database_id: uuid }],
        }),
      );
      runWranglerOrThrow(["d1", "delete", "DB", "--config", configPath, "-y"], `delete ${name} (${uuid})`);
    },
  });
  const result = runWranglerOrThrow(["d1", "create", name, "--update-config=false", ...createArgs], `create ${name}`);
  uuid = createdDatabaseId(result.stdout);
  pending.created(uuid);
  console.log(`✓ Created D1 ${name} (${uuid})`);
  return { name, uuid };
}

#!/usr/bin/env node
/**
 * Smoke test: prove a FRESH EMPTY D1 reaches the committed schema.
 *
 * Default (local): applies every migration in ./drizzle through Wrangler into
 * a throwaway local D1 state directory (fresh = empty), asserts the resulting
 * schema (tables, columns, unique indexes), asserts re-applying is a no-op,
 * then cleans up. No Cloudflare auth required; runs in every pull request.
 *
 *   node scripts/smoke-db.mjs
 *
 * Remote verification (used by the deploy workflow against real databases):
 *   node scripts/smoke-db.mjs --remote preview
 *   node scripts/smoke-db.mjs --remote production
 * Applies any pending migrations with the wrangler environment of that
 * target, then asserts the remote schema matches the committed migration set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isEnvironment,
  spawnWrangler,
  WRANGLER_TARGETS,
} from "./lib/wrangler-targets.mjs";

const isRemoteCli = process.argv.includes("--remote");
const remoteTarget = isRemoteCli
  ? process.argv[process.argv.indexOf("--remote") + 1]
  : "";
if (isRemoteCli && !(typeof remoteTarget === "string" && isEnvironment(remoteTarget))) {
  console.error("--remote must be one of: preview | production");
  process.exit(2);
}

// The D1 binding name in wrangler.jsonc (single binding per environment).
const BINDING = "DB";

/** @type {Record<string, Record<string, string>>} */
const EXPECTED_COLUMNS = {
  accounts: { id: "TEXT", share_id: "TEXT", share_handle_lookup_token: "TEXT", created_at: "INTEGER", updated_at: "INTEGER" },
  account_profiles: { account_id: "TEXT", ciphertext: "BLOB", revision: "INTEGER", epoch: "INTEGER", created_at: "INTEGER", updated_at: "INTEGER" },
  passkeys: { credential_id: "TEXT", account_id: "TEXT", public_key: "BLOB", counter: "INTEGER", transports: "TEXT", device_type: "TEXT", backed_up: "INTEGER", created_at: "INTEGER", updated_at: "INTEGER" },
  sessions: { id: "TEXT", account_id: "TEXT", purpose: "TEXT", authenticated_passkey_id: "TEXT", created_at: "INTEGER", idle_expires_at: "INTEGER", absolute_expires_at: "INTEGER", fresh_asserted_at: "INTEGER", refreshed_at: "INTEGER", revoked_at: "INTEGER", device_id: "TEXT" },
  webauthn_challenges: { id: "TEXT", challenge: "TEXT", purpose: "TEXT", account_id: "TEXT", session_id: "TEXT", origin: "TEXT", rp_id: "TEXT", expires_at: "INTEGER", created_at: "INTEGER", transport_challenge_hash: "BLOB" },
  registration_challenges: { id: "TEXT", challenge: "TEXT", origin: "TEXT", expires_at: "INTEGER", created_at: "INTEGER" },
  account_encryption_identities: { account_id: "TEXT", root_directory_id: "TEXT", registry_epoch: "INTEGER" },
  encryption_devices: { id: "TEXT", account_id: "TEXT", transport_public_key: "BLOB", assertion_public_key: "BLOB", state: "TEXT", approval_provenance: "TEXT", registry_epoch: "INTEGER", created_at: "INTEGER", last_proof_at: "INTEGER" },
  key_envelopes: { account_id: "TEXT", purpose: "TEXT", object_id: "TEXT", recipient_id: "TEXT", ciphertext: "BLOB", key_epoch: "INTEGER" },
  recovery_capsules: { account_id: "TEXT", generation: "INTEGER", recovery_salt: "BLOB", ciphertext: "BLOB", verification_public_key: "BLOB" },
  authentication_recovery_codes: { account_id: "TEXT", ordinal: "INTEGER", code_hash: "BLOB" },
  device_proof_uses: { account_id: "TEXT", proof_id: "TEXT", session_id: "TEXT", expires_at: "INTEGER" },
  vault_nodes: { id: "TEXT", kind: "TEXT", owner_id: "TEXT", parent_node_id: "TEXT", import_id: "TEXT", created_at: "INTEGER", updated_at: "INTEGER" },
  directories: { node_id: "TEXT", owner_id: "TEXT", entries_revision: "INTEGER", listing_version: "INTEGER",
    capability_key_id: "TEXT", capability_epoch: "INTEGER", listing_ciphertext: "BLOB",
    listing_digest: "BLOB", listing_signature: "BLOB", listing_device_id: "TEXT" },
  files: { node_id: "TEXT", owner_id: "TEXT", current_representation_id: "TEXT", current_revision: "INTEGER" },
  directory_entries: { child_node_id: "TEXT", owner_id: "TEXT", parent_node_id: "TEXT", name_ciphertext: "BLOB", order_ciphertext: "BLOB", key_envelope: "BLOB",
    encoding: "TEXT", receiving_key_id: "TEXT", receiving_epoch: "INTEGER", wrap_revision: "INTEGER" },
  file_heads: { file_node_id: "TEXT", owner_id: "TEXT", bytes: "BLOB", digest: "BLOB", signature: "BLOB",
    signer_device_id: "TEXT", receiving_public_key: "BLOB", receiving_key_id: "TEXT", receiving_epoch: "INTEGER",
    recipient_set_version: "INTEGER", revision: "INTEGER", representation_id: "TEXT", content_key_id: "TEXT",
    content_epoch: "INTEGER", parent_envelope: "BLOB" },
  file_device_envelopes: { file_node_id: "TEXT", owner_id: "TEXT", recipient_id: "TEXT", device_id: "TEXT",
    revision: "INTEGER", content_key_id: "TEXT", content_epoch: "INTEGER", registry_epoch: "INTEGER",
    ciphertext: "BLOB", digest: "BLOB" },
  grant_device_envelopes: { grant_id: "TEXT", device_id: "TEXT", generation: "INTEGER", registry_epoch: "INTEGER",
    target_key_id: "TEXT", target_epoch: "INTEGER", ciphertext: "BLOB", digest: "BLOB" },
  share_material: { share_id: "TEXT", material_revision: "INTEGER", anticipated_grant_id: "TEXT", target_key_id: "TEXT",
    target_epoch: "INTEGER", head_digest: "BLOB", registry_epoch: "INTEGER", candidate_head: "BLOB",
    candidate_digest: "BLOB", candidate_signature: "BLOB", candidate_signer_device_id: "TEXT" },
  share_device_material: { share_id: "TEXT", material_revision: "INTEGER", device_id: "TEXT",
    registry_epoch: "INTEGER", public_key_digest: "BLOB",
    ciphertext: "BLOB", digest: "BLOB" },
  provisioning_needs: { grant_id: "TEXT", owner_id: "TEXT", recipient_id: "TEXT", device_id: "TEXT",
    generation: "INTEGER", registry_epoch: "INTEGER", created_at: "INTEGER", updated_at: "INTEGER" },
  rotation_barriers: { owner_id: "TEXT", target_node_id: "TEXT", epoch: "INTEGER" },
  file_write_witnesses: { file_node_id: "TEXT", proof_id: "TEXT" },
  file_representations: { id: "TEXT", file_node_id: "TEXT", owner_id: "TEXT", revision: "INTEGER", content_key_id: "TEXT", key_epoch: "INTEGER", ciphertext: "BLOB", ciphertext_size: "INTEGER", created_at: "INTEGER" },
  shares: { id: "TEXT", owner_id: "TEXT", recipient_id: "TEXT", target_node_id: "TEXT", target_kind: "TEXT", permission: "TEXT", created_at: "INTEGER" },
  grants: { id: "TEXT", owner_id: "TEXT", recipient_id: "TEXT", target_node_id: "TEXT", target_kind: "TEXT", permission: "TEXT", generation: "INTEGER", created_at: "INTEGER", updated_at: "INTEGER" },
  rate_limit_counters: { purpose: "TEXT", scope_type: "TEXT", scope_id: "TEXT", window_ms: "INTEGER", time_epoch: "INTEGER", count: "INTEGER", expires_at: "INTEGER" },
  security_events: { id: "TEXT", created_at: "INTEGER", expires_at: "INTEGER", action_class: "TEXT", outcome: "TEXT", reason: "TEXT", account_id: "TEXT", publication_id: "TEXT", size_class: "TEXT", proof_state: "TEXT", counter_state: "TEXT", retry_at: "INTEGER", network_bucket: "TEXT", network_bucket_expires_at: "INTEGER" },
};
const EXPECTED_INDEXES = [
  ["accounts", "accounts_share_id_unique", 1],
  ["accounts", "accounts_share_handle_lookup_token_unique", 1],
  ["passkeys", "passkeys_account_id_idx", 0],
  ["sessions", "sessions_account_live_idx", 0],
  ["sessions", "sessions_authenticated_passkey_idx", 0],
  ["webauthn_challenges", "webauthn_challenges_challenge_unique", 1],
  ["webauthn_challenges", "webauthn_challenges_expiry_idx", 0],
  ["webauthn_challenges", "webauthn_challenges_session_idx", 0],
  ["rate_limit_counters", "rate_limit_counters_expiry_idx", 0],
  ["security_events", "security_events_expiry_idx", 0],
  ["security_events", "security_events_network_expiry_idx", 0],
  ["security_events", "security_events_account_created_idx", 0],
  ["security_events", "security_events_publication_created_idx", 0],
  ["registration_challenges", "registration_challenges_challenge_unique", 1],
  ["registration_challenges", "registration_challenges_expiry_idx", 0],
  ["account_encryption_identities", "account_encryption_identities_root_directory_id_unique", 1],
  ["encryption_devices", "encryption_devices_account_idx", 0],
  ["device_proof_uses", "device_proof_uses_expiry_idx", 0],
  ["vault_nodes", "vault_nodes_one_root_idx", 1],
  ["vault_nodes", "vault_nodes_owner_edge_idx", 1],
  ["vault_nodes", "vault_nodes_owner_id_idx", 1],
  ["file_device_envelopes", "file_device_envelopes_recipient_idx", 0],
  ["grant_device_envelopes", "grant_device_envelopes_device_idx", 0],
  ["provisioning_needs", "provisioning_needs_device_idx", 0],
  ["provisioning_needs", "provisioning_needs_recipient_idx", 0],
  ["provisioning_needs", "provisioning_needs_owner_idx", 0],
  ["grants", "grants_id_owner_recipient_idx", 1],
  ["share_material", "share_material_revision_idx", 1],
  ["vault_nodes", "vault_nodes_owner_target_kind_idx", 1],
  ["shares", "shares_pending_target_recipient_idx", 1],
  ["shares", "shares_recipient_idx", 0],
  ["grants", "grants_active_target_recipient_idx", 1],
  ["grants", "grants_recipient_idx", 0],
  ["directories", "directories_owner_node_idx", 1],
  ["directories", "directories_listing_device_idx", 0],
  ["directory_entries", "directory_entries_owner_edge_idx", 1],
  ["directory_entries", "directory_entries_parent_idx", 0],
  ["files", "files_owner_node_idx", 1],
  ["file_representations", "file_representations_owner_pointer_idx", 1],
  ["file_representations", "file_representations_file_revision_idx", 1],
];
const EXPECTED_FOREIGN_KEYS = [
  "account_profiles:account_id:accounts:id:RESTRICT",
  "passkeys:account_id:accounts:id:RESTRICT",
  "sessions:account_id:accounts:id:RESTRICT",
  "webauthn_challenges:account_id:accounts:id:RESTRICT",
  "webauthn_challenges:session_id:sessions:id:RESTRICT",
  "account_encryption_identities:account_id:accounts:id:RESTRICT",
  "encryption_devices:account_id:accounts:id:RESTRICT",
  "key_envelopes:account_id:accounts:id:RESTRICT",
  "recovery_capsules:account_id:accounts:id:RESTRICT",
  "authentication_recovery_codes:account_id:accounts:id:RESTRICT",
  "device_proof_uses:account_id:accounts:id:RESTRICT",
  "vault_nodes:owner_id:accounts:id:RESTRICT",
  "shares:owner_id:accounts:id:RESTRICT",
  "shares:recipient_id:accounts:id:RESTRICT",
  "shares:target_node_id:vault_nodes:id:RESTRICT",
  "grants:owner_id:accounts:id:RESTRICT",
  "grants:recipient_id:accounts:id:RESTRICT",
  "grants:target_node_id:vault_nodes:id:RESTRICT",
  "vault_nodes:parent_node_id:directories:node_id:RESTRICT",
  "vault_nodes:id:directory_entries:child_node_id:RESTRICT",
  "directories:node_id:vault_nodes:id:RESTRICT",
  "directories:listing_device_id:encryption_devices:id:RESTRICT",
  "file_heads:file_node_id:files:node_id:RESTRICT",
  "file_heads:representation_id:file_representations:id:RESTRICT",
  "file_heads:signer_device_id:encryption_devices:id:RESTRICT",
  "file_device_envelopes:file_node_id:files:node_id:RESTRICT",
  "grant_device_envelopes:grant_id:grants:id:RESTRICT",
  "provisioning_needs:grant_id:grants:id:CASCADE",
  "share_material:share_id:shares:id:CASCADE",
  "share_material:candidate_signer_device_id:encryption_devices:id:RESTRICT",
  "share_device_material:share_id:share_material:share_id:CASCADE",
  "rotation_barriers:target_node_id:vault_nodes:id:RESTRICT",
  "file_write_witnesses:file_node_id:files:node_id:RESTRICT",
  "directory_entries:child_node_id:vault_nodes:id:RESTRICT",
  "directory_entries:parent_node_id:directories:node_id:RESTRICT",
  "file_representations:file_node_id:files:node_id:RESTRICT",
  "files:current_representation_id:file_representations:id:RESTRICT",
];

/**
 * Run a wrangler command; on failure print its output and exit non-zero.
 * @param {string[]} args
 * @param {string} label
 */
function runCmd(args, label) {
  const r = spawnWrangler(args);
  if (r.status !== 0) {
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    console.error(`✘ ${label} failed`);
    process.exit(1);
  }
  return r;
}

/**
 * Fetch one column (`name`) of query results as strings.
 * @param {string[]} bindArgs
 * @param {string} sql
 * @returns {string[]}
 */
function queryResults(bindArgs, sql) {
  const r = runCmd(
    ["d1", "execute", BINDING, ...bindArgs, "--json", "--command", sql],
    "d1 query",
  );
  /** @type {Array<{ results?: Array<{ name: string }> }>} */
  const parsed = JSON.parse(r.stdout);
  return parsed.flatMap((row) => row.results ?? []).map((row) => row.name);
}

/**
 * Assert the schema matches the committed migration set.
 * @param {string[]} bindArgs
 * @param {string} label
 */
function verifySchema(bindArgs, label) {
  // One schema snapshot keeps local and remote verification inexpensive.
  // Table names below are source-controlled constants, never request input.
  const names = Object.keys(EXPECTED_COLUMNS).map((name) => `'${name}'`).join(", ");
  const facts = new Set(queryResults(bindArgs, `
    SELECT 'table:' || name AS name FROM sqlite_master
      WHERE type = 'table' AND name IN (${names}, 'd1_migrations')
    UNION ALL
    SELECT 'column:' || m.name || ':' || p.name || ':' || upper(p.type)
      FROM sqlite_master AS m, pragma_table_info(m.name) AS p
      WHERE m.type = 'table' AND m.name IN (${names})
    UNION ALL
    SELECT 'index:' || m.name || ':' || i.name || ':' || i."unique"
      FROM sqlite_master AS m, pragma_index_list(m.name) AS i
      WHERE m.type = 'table' AND m.name IN (${names})
    UNION ALL
    SELECT 'fk:' || m.name || ':' || f."from" || ':' || f."table" || ':' || f."to" || ':' || f.on_delete
      FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
      WHERE m.type = 'table' AND m.name IN (${names});
  `));
  const required = [
    "table:d1_migrations",
    ...Object.entries(EXPECTED_COLUMNS).flatMap(([table, columns]) => [
      `table:${table}`,
      ...Object.entries(columns).map(([column, type]) => `column:${table}:${column}:${type}`),
    ]),
    ...EXPECTED_INDEXES.map(([table, name, unique]) => `index:${table}:${name}:${unique}`),
    ...EXPECTED_FOREIGN_KEYS.map((key) => `fk:${key}`),
  ];
  for (const fact of required) {
    if (!facts.has(fact)) failNow(`${label}: missing schema fact ${fact}`);
  }
  console.log(`✓ ${label}: schema matches the committed migration set`);
}

/** @param {string} message */
function failNow(message) {
  console.error(`✘ smoke test failed: ${message}`);
  process.exit(1);
}

function localSmoke() {
  const persistDir = mkdtempSync(join(tmpdir(), "mdwn-dm-smoke-"));
  try {
    // A brand-new persist directory means the local D1 starts empty.
    const localArgs = ["--local", "--persist-to", persistDir];
    runCmd(["d1", "migrations", "apply", BINDING, ...localArgs], "local migration apply");
    console.log("✓ migrations applied to a fresh empty local D1");
    verifySchema(localArgs, "local");

    runCmd(["d1", "migrations", "apply", BINDING, ...localArgs], "local re-apply");
    console.log("✓ re-applying migrations is a no-op (idempotent)");
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
}

if (isRemoteCli) {
  const { envFlag, extra } = WRANGLER_TARGETS[remoteTarget];
  runCmd(
    ["d1", "migrations", "apply", BINDING, ...envFlag, ...extra],
    `${remoteTarget} migration apply`,
  );
  verifySchema([...envFlag, ...extra], remoteTarget);
} else {
  localSmoke();
}

console.log("✓ D1 smoke test passed");
process.exit(0);
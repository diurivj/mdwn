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
import { mkdtempSync } from "node:fs";
import { createScriptLifecycle } from "./lib/script-lifecycle.mjs";
import { verifyForeignKeys } from "./lib/d1-operations.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnvironment, runWranglerJson, WRANGLER_TARGETS } from "./lib/wrangler-targets.mjs";
import { runWranglerOrThrow } from "./lib/restore-cli-support.mjs";
import { PublicOperationalError } from "./lib/script-errors.mjs";

const isRemoteCli = process.argv.includes("--remote");
const remoteTarget = isRemoteCli ? process.argv[process.argv.indexOf("--remote") + 1] : "";
if (isRemoteCli && !(typeof remoteTarget === "string" && isEnvironment(remoteTarget))) {
  console.error("--remote must be one of: preview | production");
  process.exit(2);
}

// The D1 binding name in wrangler.jsonc (single binding per environment).
const BINDING = "DB";
const COMMENT_ENVELOPE_COLUMNS = {
  relationship_id: "TEXT",
  device_id: "TEXT",
  capability_id: "TEXT",
  capability_epoch: "INTEGER",
  grant_key_epoch: "INTEGER",
  owner_registry_epoch: "INTEGER",
  recipient_registry_epoch: "INTEGER",
  ciphertext: "BLOB",
  signature: "BLOB",
  signer_device_id: "TEXT",
  object_id: "TEXT",
};

/** @type {Record<string, Record<string, string>>} */
const EXPECTED_COLUMNS = {
  accounts: {
    id: "TEXT",
    share_id: "TEXT",
    share_handle_lookup_token: "TEXT",
    created_at: "INTEGER",
    updated_at: "INTEGER",
  },
  account_profiles: {
    account_id: "TEXT",
    ciphertext: "BLOB",
    revision: "INTEGER",
    epoch: "INTEGER",
    pseudonym_changed_at: "INTEGER",
    created_at: "INTEGER",
    updated_at: "INTEGER",
  },
  passkeys: {
    credential_id: "TEXT",
    account_id: "TEXT",
    public_key: "BLOB",
    counter: "INTEGER",
    transports: "TEXT",
    device_type: "TEXT",
    backed_up: "INTEGER",
    created_at: "INTEGER",
    updated_at: "INTEGER",
  },
  sessions: {
    id: "TEXT",
    account_id: "TEXT",
    purpose: "TEXT",
    authenticated_passkey_id: "TEXT",
    created_at: "INTEGER",
    idle_expires_at: "INTEGER",
    absolute_expires_at: "INTEGER",
    fresh_asserted_at: "INTEGER",
    refreshed_at: "INTEGER",
    revoked_at: "INTEGER",
    device_id: "TEXT",
  },
  webauthn_challenges: {
    id: "TEXT",
    challenge: "TEXT",
    purpose: "TEXT",
    account_id: "TEXT",
    session_id: "TEXT",
    origin: "TEXT",
    rp_id: "TEXT",
    expires_at: "INTEGER",
    created_at: "INTEGER",
    transport_challenge_hash: "BLOB",
  },
  registration_challenges: {
    id: "TEXT",
    challenge: "TEXT",
    origin: "TEXT",
    expires_at: "INTEGER",
    created_at: "INTEGER",
  },
  account_encryption_identities: { account_id: "TEXT", root_directory_id: "TEXT", registry_epoch: "INTEGER" },
  encryption_devices: {
    id: "TEXT",
    account_id: "TEXT",
    transport_public_key: "BLOB",
    assertion_public_key: "BLOB",
    state: "TEXT",
    approval_provenance: "TEXT",
    registry_epoch: "INTEGER",
    created_at: "INTEGER",
    last_proof_at: "INTEGER",
  },
  key_envelopes: {
    account_id: "TEXT",
    purpose: "TEXT",
    object_id: "TEXT",
    recipient_id: "TEXT",
    ciphertext: "BLOB",
    key_epoch: "INTEGER",
  },
  recovery_capsules: {
    account_id: "TEXT",
    generation: "INTEGER",
    recovery_salt: "BLOB",
    ciphertext: "BLOB",
    verification_public_key: "BLOB",
  },
  authentication_recovery_codes: { account_id: "TEXT", ordinal: "INTEGER", code_hash: "BLOB" },
  device_proof_uses: {
    account_id: "TEXT",
    proof_id: "TEXT",
    session_id: "TEXT",
    expires_at: "INTEGER",
    commit_token: "TEXT",
  },
  device_enrollments: {
    id: "TEXT",
    account_id: "TEXT",
    candidate_session_id: "TEXT",
    state: "TEXT",
    created_at: "INTEGER",
    expires_at: "INTEGER",
  },
  recovery_enrollments: {
    id: "TEXT",
    account_id: "TEXT",
    session_id: "TEXT",
    generation: "INTEGER",
    state: "TEXT",
    created_at: "INTEGER",
    expires_at: "INTEGER",
  },
  import_sessions: {
    id: "TEXT",
    account_id: "TEXT",
    session_id: "TEXT",
    manifest_ciphertext: "BLOB",
    state: "TEXT",
    expires_at: "INTEGER",
    committed_at: "INTEGER",
  },
  import_records: {
    import_id: "TEXT",
    chunk_sequence: "INTEGER",
    ordinal: "INTEGER",
    kind: "TEXT",
    offset: "INTEGER",
    length: "INTEGER",
  },
  import_chunks: { import_id: "TEXT", sequence: "INTEGER", payload: "BLOB", digest: "BLOB" },
  import_session_kinds: { import_id: "TEXT", kind: "TEXT", expected_count: "INTEGER" },
  import_commits: { import_id: "TEXT", account_id: "TEXT", target_directory_id: "TEXT", committed_at: "INTEGER" },
  vault_nodes: {
    id: "TEXT",
    kind: "TEXT",
    owner_id: "TEXT",
    parent_node_id: "TEXT",
    import_id: "TEXT",
    created_at: "INTEGER",
    updated_at: "INTEGER",
  },
  directories: {
    node_id: "TEXT",
    owner_id: "TEXT",
    entries_revision: "INTEGER",
    listing_ciphertext: "BLOB",
    listing_digest: "BLOB",
    listing_signature: "BLOB",
    listing_device_id: "TEXT",
  },
  files: {
    node_id: "TEXT",
    owner_id: "TEXT",
    current_representation_id: "TEXT",
    current_revision: "INTEGER",
    capability_id: "TEXT",
    capability_epoch: "INTEGER",
  },
  directory_entries: {
    child_node_id: "TEXT",
    owner_id: "TEXT",
    parent_node_id: "TEXT",
    name_ciphertext: "BLOB",
    order_ciphertext: "BLOB",
    key_envelope: "BLOB",
  },
  file_representations: {
    id: "TEXT",
    file_node_id: "TEXT",
    owner_id: "TEXT",
    revision: "INTEGER",
    content_key_id: "TEXT",
    key_epoch: "INTEGER",
    ciphertext: "BLOB",
    ciphertext_size: "INTEGER",
    created_at: "INTEGER",
    key_envelope: "BLOB",
    head_digest: "BLOB",
    head_signature: "BLOB",
    head_device_id: "TEXT",
  },
  share_key_envelopes: {
    relationship_id: "TEXT",
    device_id: "TEXT",
    capability_id: "TEXT",
    capability_epoch: "INTEGER",
    grant_key_epoch: "INTEGER",
    owner_registry_epoch: "INTEGER",
    recipient_registry_epoch: "INTEGER",
    ciphertext: "BLOB",
    signature: "BLOB",
    signer_device_id: "TEXT",
  },
  grant_key_envelopes: {
    relationship_id: "TEXT",
    device_id: "TEXT",
    capability_id: "TEXT",
    capability_epoch: "INTEGER",
    grant_key_epoch: "INTEGER",
    owner_registry_epoch: "INTEGER",
    recipient_registry_epoch: "INTEGER",
    ciphertext: "BLOB",
    signature: "BLOB",
    signer_device_id: "TEXT",
  },
  shares: {
    id: "TEXT",
    owner_id: "TEXT",
    recipient_id: "TEXT",
    target_id: "TEXT",
    target_kind: "TEXT",
    permission: "TEXT",
    created_at: "INTEGER",
  },
  grants: {
    id: "TEXT",
    owner_id: "TEXT",
    recipient_id: "TEXT",
    target_id: "TEXT",
    target_kind: "TEXT",
    permission: "TEXT",
    revision: "INTEGER",
    key_epoch: "INTEGER",
    expires_at: "INTEGER",
    created_at: "INTEGER",
    updated_at: "INTEGER",
  },
  sharing_write_blocks: { target_id: "TEXT", owner_id: "TEXT", target_kind: "TEXT", created_at: "INTEGER" },
  sharing_comment_capabilities: {
    object_id: "TEXT",
    owner_id: "TEXT",
    file_id: "TEXT",
    thread_id: "TEXT",
    purpose: "TEXT",
    publication_id: "TEXT",
    capability_id: "TEXT",
    capability_epoch: "INTEGER",
  },
  share_comment_key_envelopes: COMMENT_ENVELOPE_COLUMNS,
  grant_comment_key_envelopes: COMMENT_ENVELOPE_COLUMNS,
  provisioning_needs: { grant_id: "TEXT", device_id: "TEXT", grant_key_epoch: "INTEGER" },
  rate_limit_counters: {
    purpose: "TEXT",
    scope_type: "TEXT",
    scope_id: "TEXT",
    window_ms: "INTEGER",
    time_epoch: "INTEGER",
    count: "INTEGER",
    expires_at: "INTEGER",
  },
  security_events: {
    id: "TEXT",
    created_at: "INTEGER",
    expires_at: "INTEGER",
    action_class: "TEXT",
    outcome: "TEXT",
    reason: "TEXT",
    account_id: "TEXT",
    publication_id: "TEXT",
    size_class: "TEXT",
    proof_state: "TEXT",
    counter_state: "TEXT",
    retry_at: "INTEGER",
    network_bucket: "TEXT",
    network_bucket_expires_at: "INTEGER",
  },
  publications: {
    id: "TEXT",
    file_id: "TEXT",
    owner_id: "TEXT",
    state: "TEXT",
    current_link_id: "TEXT",
    current_representation_id: "TEXT",
    created_at: "INTEGER",
    updated_at: "INTEGER",
  },
  publication_links: { id: "TEXT", publication_id: "TEXT", public_key: "BLOB", created_at: "INTEGER" },
  public_representations: {
    id: "TEXT",
    publication_id: "TEXT",
    link_id: "TEXT",
    revision: "INTEGER",
    file_revision: "INTEGER",
    ciphertext: "BLOB",
    ciphertext_size: "INTEGER",
    created_at: "INTEGER",
  },
  publication_requests: { id: "TEXT", file_id: "TEXT", owner_id: "TEXT", requester_id: "TEXT", created_at: "INTEGER" },
  publication_authors: {
    id: "TEXT",
    publication_id: "TEXT",
    author_id: "TEXT",
    ordinal: "INTEGER",
    link_id: "TEXT",
    revision: "INTEGER",
    ciphertext: "BLOB",
    created_at: "INTEGER",
    updated_at: "INTEGER",
  },
  publication_teardowns: { publication_id: "TEXT", owner_id: "TEXT", comment_total: "INTEGER", created_at: "INTEGER" },
  public_comment_reports: {
    id: "TEXT",
    reporter_id: "TEXT",
    comment_id: "TEXT",
    category: "TEXT",
    created_at: "INTEGER",
    expires_at: "INTEGER",
  },
  public_participation_suspensions: {
    account_id: "TEXT",
    strike_count: "INTEGER",
    reason: "TEXT",
    started_at: "INTEGER",
    expires_at: "INTEGER",
    updated_at: "INTEGER",
  },
};
const EXPECTED_INDEXES = [
  ["accounts", "accounts_share_id_unique", 1],
  ["accounts", "accounts_share_handle_lookup_token_unique", 1],
  ["passkeys", "passkeys_account_id_idx", 0],
  ["sessions", "sessions_account_live_idx", 0],
  ["sessions", "sessions_authenticated_passkey_idx", 0],
  ["sessions", "sessions_authority_idx", 0],
  ["sessions", "sessions_expiry_idx", 0],
  ["sessions", "sessions_revoked_idx", 0],
  ["sessions", "sessions_recovery_idx", 0],
  ["webauthn_challenges", "webauthn_challenges_challenge_unique", 1],
  ["webauthn_challenges", "webauthn_challenges_expiry_idx", 0],
  ["webauthn_challenges", "webauthn_challenges_session_idx", 0],
  ["webauthn_challenges", "webauthn_challenges_live_idx", 0],
  ["rate_limit_counters", "rate_limit_counters_expiry_idx", 0],
  ["rate_limit_counters", "rate_limit_counters_window_idx", 0],
  ["security_events", "security_events_expiry_idx", 0],
  ["security_events", "security_events_network_expiry_idx", 0],
  ["security_events", "security_events_account_created_idx", 0],
  ["security_events", "security_events_publication_created_idx", 0],
  ["public_comment_reports", "public_comment_reports_reporter_comment_idx", 1],
  ["public_comment_reports", "public_comment_reports_expiry_idx", 0],
  ["public_comment_reports", "public_comment_reports_comment_idx", 0],
  ["registration_challenges", "registration_challenges_challenge_unique", 1],
  ["registration_challenges", "registration_challenges_expiry_idx", 0],
  ["registration_challenges", "registration_challenges_live_idx", 0],
  ["account_encryption_identities", "account_encryption_identities_root_directory_id_unique", 1],
  ["account_encryption_identities", "account_encryption_identities_epoch_idx", 0],
  ["encryption_devices", "encryption_devices_account_idx", 0],
  ["device_proof_uses", "device_proof_uses_expiry_idx", 0],
  ["device_proof_uses", "device_proof_uses_commit_idx", 0],
  ["recovery_capsules", "recovery_capsules_generation_idx", 0],
  ["recovery_enrollments", "recovery_enrollments_account_idx", 0],
  ["recovery_enrollments", "recovery_enrollments_live_idx", 0],
  ["recovery_enrollments", "recovery_enrollments_expiry_idx", 0],
  ["recovery_enrollments", "recovery_enrollments_session_idx", 0],
  ["device_enrollments", "device_enrollments_candidate_idx", 0],
  ["device_enrollments", "device_enrollments_account_idx", 0],
  ["device_enrollments", "device_enrollments_live_idx", 0],
  ["device_enrollments", "device_enrollments_expiry_idx", 0],
  ["vault_nodes", "vault_nodes_one_root_idx", 1],
  ["vault_nodes", "vault_nodes_owner_edge_idx", 1],
  ["vault_nodes", "vault_nodes_owner_target_idx", 1],
  ["vault_nodes", "vault_nodes_parent_idx", 0],
  ["shares", "shares_relationship_idx", 1],
  ["shares", "shares_recipient_idx", 0],
  ["shares", "shares_owner_idx", 0],
  ["shares", "shares_target_idx", 0],
  ["grants", "grants_relationship_idx", 1],
  ["grants", "grants_recipient_target_idx", 0],
  ["grants", "grants_recipient_idx", 0],
  ["grants", "grants_owner_idx", 0],
  ["grants", "grants_target_idx", 0],
  ["grants", "grants_expiry_idx", 0],
  ["grants", "grants_owner_expiry_idx", 0],
  ["sharing_comment_capabilities", "sharing_comment_capabilities_file_idx", 0],
  ["sharing_comment_capabilities", "sharing_comment_capabilities_private_idx", 1],
  ["share_comment_key_envelopes", "share_comment_key_envelopes_device_idx", 0],
  ["share_comment_key_envelopes", "share_comment_key_envelopes_object_idx", 0],
  ["grant_comment_key_envelopes", "grant_comment_key_envelopes_device_idx", 0],
  ["grant_comment_key_envelopes", "grant_comment_key_envelopes_object_idx", 0],
  ["provisioning_needs", "provisioning_needs_device_idx", 0],
  ["directories", "directories_owner_node_idx", 1],
  ["directories", "directories_current_idx", 0],
  ["directories", "directories_listing_device_idx", 0],
  ["directory_entries", "directory_entries_owner_edge_idx", 1],
  ["directory_entries", "directory_entries_parent_idx", 0],
  ["files", "files_owner_node_idx", 1],
  ["files", "files_current_idx", 0],
  ["file_representations", "file_representations_owner_pointer_idx", 1],
  ["file_representations", "file_representations_file_revision_idx", 1],
  ["publications", "publications_file_idx", 1],
  ["publications", "publications_current_idx", 0],
  ["publication_links", "publication_links_publication_idx", 1],
  ["publication_links", "publication_links_identity_idx", 1],
  ["public_representations", "public_representations_revision_idx", 1],
  ["public_representations", "public_representations_pointer_idx", 1],
  ["publication_requests", "publication_requests_requester_idx", 1],
  ["publication_requests", "publication_requests_file_idx", 0],
  ["import_sessions", "import_sessions_account_state_idx", 0],
  ["import_sessions", "import_sessions_expiry_idx", 0],
  ["import_sessions", "import_sessions_live_idx", 0],
  ["import_sessions", "import_sessions_session_idx", 0],
  ["import_records", "import_records_kind_idx", 0],
  ["import_commits", "import_commits_account_idx", 0],
  ["publication_authors", "publication_authors_author_idx", 1],
  ["publication_authors", "publication_authors_ordinal_idx", 1],
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
  "vault_nodes:parent_node_id:directories:node_id:RESTRICT",
  "vault_nodes:id:directory_entries:child_node_id:RESTRICT",
  "directories:node_id:vault_nodes:id:RESTRICT",
  "directories:listing_device_id:encryption_devices:id:RESTRICT",
  "directory_entries:child_node_id:vault_nodes:id:RESTRICT",
  "directory_entries:parent_node_id:directories:node_id:RESTRICT",
  "file_representations:file_node_id:files:node_id:RESTRICT",
  "files:current_representation_id:file_representations:id:RESTRICT",
  "file_representations:head_device_id:encryption_devices:id:RESTRICT",
  "share_key_envelopes:relationship_id:shares:id:RESTRICT",
  "share_key_envelopes:device_id:encryption_devices:id:RESTRICT",
  "share_key_envelopes:signer_device_id:encryption_devices:id:RESTRICT",
  "grant_key_envelopes:relationship_id:grants:id:RESTRICT",
  "grant_key_envelopes:device_id:encryption_devices:id:RESTRICT",
  "grant_key_envelopes:signer_device_id:encryption_devices:id:RESTRICT",
  "shares:owner_id:accounts:id:RESTRICT",
  "shares:recipient_id:accounts:id:RESTRICT",
  "shares:owner_id:vault_nodes:owner_id:RESTRICT",
  "shares:target_id:vault_nodes:id:RESTRICT",
  "shares:target_kind:vault_nodes:kind:RESTRICT",
  "grants:owner_id:accounts:id:RESTRICT",
  "grants:recipient_id:accounts:id:RESTRICT",
  "grants:owner_id:vault_nodes:owner_id:RESTRICT",
  "grants:target_id:vault_nodes:id:RESTRICT",
  "grants:target_kind:vault_nodes:kind:RESTRICT",
  "sharing_write_blocks:owner_id:vault_nodes:owner_id:RESTRICT",
  "sharing_write_blocks:target_id:vault_nodes:id:RESTRICT",
  "sharing_write_blocks:target_kind:vault_nodes:kind:RESTRICT",
  "sharing_comment_capabilities:owner_id:files:owner_id:RESTRICT",
  "sharing_comment_capabilities:file_id:files:node_id:RESTRICT",
  "share_comment_key_envelopes:relationship_id:shares:id:RESTRICT",
  "share_comment_key_envelopes:device_id:encryption_devices:id:RESTRICT",
  "share_comment_key_envelopes:signer_device_id:encryption_devices:id:RESTRICT",
  "share_comment_key_envelopes:object_id:sharing_comment_capabilities:object_id:RESTRICT",
  "grant_comment_key_envelopes:relationship_id:grants:id:RESTRICT",
  "grant_comment_key_envelopes:device_id:encryption_devices:id:RESTRICT",
  "grant_comment_key_envelopes:signer_device_id:encryption_devices:id:RESTRICT",
  "grant_comment_key_envelopes:object_id:sharing_comment_capabilities:object_id:RESTRICT",
  "provisioning_needs:grant_id:grants:id:RESTRICT",
  "provisioning_needs:device_id:encryption_devices:id:RESTRICT",
  "publications:owner_id:accounts:id:RESTRICT",
  "publications:owner_id:files:owner_id:RESTRICT",
  "publications:file_id:files:node_id:RESTRICT",
  "publications:current_link_id:publication_links:id:RESTRICT",
  "publications:id:publication_links:publication_id:RESTRICT",
  "publications:current_representation_id:public_representations:id:RESTRICT",
  "publications:id:public_representations:publication_id:RESTRICT",
  "publications:current_link_id:public_representations:link_id:RESTRICT",
  "publication_links:publication_id:publications:id:RESTRICT",
  "public_representations:publication_id:publications:id:RESTRICT",
  "publication_requests:requester_id:accounts:id:RESTRICT",
  "publication_requests:owner_id:files:owner_id:RESTRICT",
  "publication_requests:file_id:files:node_id:RESTRICT",
  "publication_authors:publication_id:publications:id:RESTRICT",
  "publication_authors:author_id:accounts:id:RESTRICT",
  "publication_teardowns:publication_id:publications:id:RESTRICT",
  "publication_teardowns:owner_id:accounts:id:RESTRICT",
  "public_comment_reports:reporter_id:accounts:id:RESTRICT",
  "public_comment_reports:comment_id:comments:id:RESTRICT",
  "public_participation_suspensions:account_id:accounts:id:RESTRICT",
];
const EXPECTED_TRIGGERS = [
  "sharing_new_device_need",
  "sharing_new_comment_need",
  "sharing_comment_context_immutable",
  "sharing_rotated_comment_need",
  "publication_created_active",
  "publication_identity_immutable",
  "publication_seal_irreversible",
  "publication_link_rotation_guard",
  "publication_sealed_link_guard",
  "publication_sealed_representation_guard",
  "comment_thread_public_sealed_guard",
  "publication_teardown_guard",
  "publication_teardown_immutable",
  "public_representation_immutable",
  "publication_author_identity_immutable",
  "publication_request_immutable",
  "import_commits_immutable",
  "import_commits_session_guard",
  "webauthn_challenges_lifetime_insert",
  "webauthn_challenges_lifetime_update",
  "registration_challenges_lifetime_insert",
  "registration_challenges_lifetime_update",
  "recovery_enrollments_lifetime_insert",
  "recovery_enrollments_lifetime_update",
];

/**
 * Fetch one column (`name`) of query results as strings.
 * @param {string[]} bindArgs
 * @param {string} sql
 * @returns {string[]}
 */
function queryResults(bindArgs, sql) {
  /** @type {Array<{ results?: Array<{ name: string }> }>} */
  const parsed = runWranglerJson(["d1", "execute", BINDING, ...bindArgs, "--command", sql], "d1 query");
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
  const names = Object.keys(EXPECTED_COLUMNS)
    .map((name) => `'${name}'`)
    .join(", ");
  const facts = new Set(
    queryResults(
      bindArgs,
      `
    SELECT 'table:' || name AS name FROM sqlite_master
      WHERE type = 'table' AND name IN (${names}, 'd1_migrations')
    UNION ALL
    SELECT 'trigger:' || name FROM sqlite_master WHERE type = 'trigger'
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
  `,
    ),
  );
  const required = [
    "table:d1_migrations",
    ...Object.entries(EXPECTED_COLUMNS).flatMap(([table, columns]) => [
      `table:${table}`,
      ...Object.entries(columns).map(([column, type]) => `column:${table}:${column}:${type}`),
    ]),
    ...EXPECTED_INDEXES.map(([table, name, unique]) => `index:${table}:${name}:${unique}`),
    ...EXPECTED_FOREIGN_KEYS.map((key) => `fk:${key}`),
    ...EXPECTED_TRIGGERS.map((name) => `trigger:${name}`),
  ];
  for (const fact of required) {
    if (!facts.has(fact)) throw new PublicOperationalError(`${label}: missing schema fact ${fact}`);
  }
  if (facts.has("fk:import_commits:import_id:import_sessions:id:RESTRICT")) {
    throw new PublicOperationalError(`${label}: durable Import marker still depends on ephemeral staging`);
  }
  verifyForeignKeys(bindArgs);
  console.log(`✓ ${label}: schema matches the committed migration set`);
}

function localSmoke() {
  const lifecycle = createScriptLifecycle({ label: "smoke test" });
  const persistDir = mkdtempSync(join(tmpdir(), "mdwn-dm-smoke-"));
  lifecycle.artifact(persistDir, { retainOnFailure: false });
  let failure = null;
  try {
    // A brand-new persist directory means the local D1 starts empty.
    const localArgs = ["--local", "--persist-to", persistDir];
    runWranglerOrThrow(["d1", "migrations", "apply", BINDING, ...localArgs], "local migration apply");
    console.log("✓ migrations applied to a fresh empty local D1");
    verifySchema(localArgs, "local");

    runWranglerOrThrow(["d1", "migrations", "apply", BINDING, ...localArgs], "local re-apply");
    console.log("✓ re-applying migrations is a no-op (idempotent)");
  } catch (error) {
    failure = error;
  } finally {
    if (!lifecycle.finish(failure).ok) process.exitCode = 1;
  }
}

try {
  if (isRemoteCli) {
    const { envFlag, extra } = WRANGLER_TARGETS[remoteTarget];
    runWranglerOrThrow(["d1", "migrations", "apply", BINDING, ...envFlag, ...extra], `${remoteTarget} migration apply`);
    verifySchema([...envFlag, ...extra], remoteTarget);
  } else {
    localSmoke();
  }
  if (!process.exitCode) console.log("✓ D1 smoke test passed");
} catch (error) {
  createScriptLifecycle({ label: "smoke test" }).finish(error);
  process.exitCode = 1;
}

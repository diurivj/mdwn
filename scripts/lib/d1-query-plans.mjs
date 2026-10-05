/** Reviewed representative metadata hot paths. Payload BLOBs are deliberately
 * fetched by their current primary-key pointer, never copied into indexes.
 * Static synthetic identifiers keep verification read-only and content-free.
 * Run identical SQL in local workerd and remote D1. SQLite can prefer a unique
 * point lookup over a covering index on unanalyzed/small tables; review that
 * selected plan AND an explicitly labelled covering companion probe. Only the
 * recursive Grant query retains its production INDEXED BY contract.
 */
export const QUERY_PLANS = [
  {
    name: "children",
    source: "app/tree/tree.server.ts: Directory listing",
    sql: "SELECT id, owner_id, kind, import_id FROM vault_nodes WHERE parent_node_id = 'root'",
    covering: ["vault_nodes_parent_idx"],
  },
  {
    name: "current File representation pointer and capability epoch",
    source: "app/tree/tree.server.ts: current File head",
    sql: "SELECT current_representation_id, current_revision, capability_id, capability_epoch FROM files WHERE node_id = 'file' AND owner_id = 'owner'",
    covering: ["files_current_idx"], probeFrom: "FROM files",
  },
  {
    name: "current Directory epoch",
    source: "app/tree/tree.server.ts: Directory revision/epoch CAS",
    sql: "SELECT entries_revision, key_epoch FROM directories WHERE node_id = 'directory' AND owner_id = 'owner'",
    covering: ["directories_current_idx"], probeFrom: "FROM directories",
  },
  {
    name: "current Comment audience epoch",
    source: "app/comments/comments.server.ts: current epoch",
    sql: "SELECT id, key_epoch, audience FROM comment_thread_epochs WHERE thread_id = 'thread' AND state = 'active'",
    covering: ["comment_thread_epochs_head_idx"], probeFrom: "FROM comment_thread_epochs",
  },
  {
    name: "active exact-target Grant",
    source: "app/sharing/access.server.ts: matching",
    sql: "SELECT owner_id, target_kind, permission, expires_at FROM grants WHERE recipient_id = 'recipient' AND target_id = 'target' AND (expires_at IS NULL OR expires_at > 1700000000000)",
    covering: ["grants_recipient_target_idx"],
  },
  {
    name: "pending Share inbox",
    source: "app/sharing/sharing.server.ts: pending Shares",
    sql: "SELECT id, owner_id, target_id, target_kind, permission, created_at FROM shares WHERE recipient_id = 'recipient' ORDER BY id",
    covering: ["shares_recipient_idx"],
  },
  {
    name: "pending Publication requests",
    source: "app/publications/publications.server.ts: request list",
    sql: "SELECT id, requester_id, created_at FROM publication_requests WHERE file_id = 'file' AND owner_id = 'owner'",
    covering: ["publication_requests_file_idx"],
  },
  {
    name: "active-or-deleting Publication",
    source: "app/publications/publications.server.ts: filePublication",
    sql: "SELECT id, state, current_link_id, current_representation_id FROM publications WHERE file_id = 'file' AND state IN ('active', 'deleting')",
    covering: ["publications_current_idx"],
  },
  {
    name: "unique Public path",
    source: "app/publications/publications.server.ts: anonymous current link lookup",
    sql: "SELECT l.publication_id FROM publication_links l JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id WHERE l.id = 'path' AND p.state = 'active'",
    covering: ["publication_links_identity_idx"], probeFrom: "FROM publication_links l",
  },
  {
    name: "current Recovery generation",
    source: "app/recovery/enrollment.server.ts: generation CAS",
    sql: "SELECT generation FROM recovery_capsules WHERE account_id = 'account'",
    covering: ["recovery_capsules_generation_idx"], probeFrom: "FROM recovery_capsules",
  },
  {
    name: "current Device registry epoch",
    source: "app/device/proof.server.ts: activeDevice",
    sql: "SELECT registry_epoch FROM account_encryption_identities WHERE account_id = 'account'",
    covering: ["account_encryption_identities_epoch_idx"], probeFrom: "FROM account_encryption_identities",
  },
  {
    name: "live Session authority",
    source: "app/auth/session.server.ts: readData",
    sql: `SELECT id, account_id, purpose, authenticated_passkey_id, fresh_asserted_at, device_id FROM sessions
      WHERE id = 'session' AND revoked_at IS NULL AND idle_expires_at > 1700000000000
        AND absolute_expires_at > 1700000000000 AND (purpose = 'normal' OR created_at > 1699999700000)`,
    covering: ["sessions_authority_idx"], probeFrom: "FROM sessions",
  },
  {
    name: "unexpired WebAuthn challenge",
    source: "app/auth/webauthn.server.ts: one-use ceremony lookup",
    sql: "SELECT id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at FROM webauthn_challenges WHERE id = 'challenge' AND expires_at > 1700000000000",
    covering: ["webauthn_challenges_live_idx"], probeFrom: "FROM webauthn_challenges",
  },
  {
    name: "unexpired registration challenge",
    source: "app/signup/signup.server.ts: registration challenge lookup",
    sql: "SELECT challenge, origin, expires_at FROM registration_challenges WHERE id = 'challenge' AND expires_at > 1700000000000",
    covering: ["registration_challenges_live_idx"], probeFrom: "FROM registration_challenges",
  },
  {
    name: "unexpired routine enrollment authority",
    source: "app/enrollment/enrollment.server.ts: candidate checks",
    sql: "SELECT state, registry_epoch, candidate_device_id FROM device_enrollments WHERE id = 'enrollment' AND account_id = 'account' AND candidate_session_id = 'session' AND expires_at > 1700000000000",
    covering: ["device_enrollments_live_idx"], probeFrom: "FROM device_enrollments",
  },
  {
    name: "unexpired Recovery enrollment authority",
    source: "app/recovery/enrollment.server.ts: recovery start checks",
    sql: "SELECT state, generation, registry_epoch FROM recovery_enrollments WHERE id = 'enrollment' AND account_id = 'account' AND session_id = 'session' AND expires_at > 1700000000000",
    covering: ["recovery_enrollments_live_idx"], probeFrom: "FROM recovery_enrollments",
  },
  {
    name: "unexpired Import authority",
    source: "app/import/staging.server.ts: commit anchor",
    sql: "SELECT state, target_directory_id, target_owner_id FROM import_sessions WHERE id = 'import' AND account_id = 'account' AND session_id = 'session' AND expires_at > 1700000000000",
    covering: ["import_sessions_live_idx"], probeFrom: "FROM import_sessions",
  },
  {
    name: "consumed mutation-proof marker",
    source: "app/device/proof.server.ts: mutationProofStatements",
    sql: "SELECT 1 FROM device_proof_uses WHERE account_id = 'account' AND proof_id = 'proof' AND commit_token = 'token'",
    covering: ["device_proof_uses_commit_idx"], probeFrom: "FROM device_proof_uses",
  },
  {
    name: "outstanding provisioning need",
    source: "app/sharing/provisioning.server.ts: current need",
    sql: "SELECT grant_id, grant_key_epoch FROM provisioning_needs WHERE device_id = 'device'",
    covering: ["provisioning_needs_device_idx"],
  },
  {
    name: "rolling counter window",
    source: "app/security/abuse-control.server.ts: activePredicate",
    sql: `SELECT SUM(count), MIN(expires_at) FROM rate_limit_counters WHERE purpose = 'session.refresh'
      AND scope_type = 'session' AND scope_id = 'session:synthetic' AND window_ms = 3600000
      AND time_epoch > 1699996400000 AND expires_at > 1700000000000`,
    covering: ["rate_limit_counters_window_idx"],
  },
  {
    name: "bounded ancestor-recursive Grant access",
    source: "app/sharing/access.server.ts: lineage/matching (100 edges)",
    sql: `WITH RECURSIVE lineage(id, parent_node_id, owner_id, kind, depth) AS (
      SELECT id, parent_node_id, owner_id, kind, 0 FROM vault_nodes WHERE id = 'file'
      UNION ALL SELECT p.id, p.parent_node_id, p.owner_id, p.kind, c.depth + 1
      FROM lineage c JOIN vault_nodes p ON p.id = c.parent_node_id
      WHERE p.owner_id = c.owner_id AND c.depth < 100)
      SELECT g.target_kind, g.permission FROM lineage a CROSS JOIN grants g INDEXED BY grants_recipient_target_idx
      WHERE g.recipient_id = 'recipient' AND g.target_id = a.id AND g.owner_id = a.owner_id
        AND (g.expires_at IS NULL OR g.expires_at > 1700000000000)
        AND (a.kind = 'directory' AND g.target_kind = 'directory'
          OR a.depth = 0 AND a.kind = 'file' AND g.target_kind = 'file')`,
    covering: ["grants_recipient_target_idx"],
  },
  {
    name: "bounded subtree deletion enumeration",
    source: "app/tree/tree.server.ts: deletionIds (500 + overflow sentinel)",
    sql: `WITH RECURSIVE subtree(id) AS (SELECT 'root' UNION
      SELECT n.id FROM vault_nodes n JOIN subtree p ON n.parent_node_id = p.id
      WHERE n.import_id IS NULL OR EXISTS (SELECT 1 FROM import_commits c WHERE c.import_id = n.import_id)
      LIMIT 501) SELECT id FROM subtree`,
    covering: ["vault_nodes_parent_idx"],
  },
];

/** @param {{sql: string, covering: string[], probeFrom?: string}} query */
export function coveringProbeSql(query) {
  return query.probeFrom
    ? query.sql.replace(query.probeFrom, `${query.probeFrom} INDEXED BY ${query.covering[0]}`)
    : query.sql;
}

/** @param {{name: string, covering: string[]}} query @param {{detail: string}[]} rows @param {boolean} [requireCovering] */
export function assertQueryPlan(query, rows, requireCovering = true) {
  for (const index of requireCovering ? query.covering : []) {
    if (!rows.some((row) => row.detail.includes(`USING COVERING INDEX ${index}`))) {
      throw new Error(`${query.name}: missing covering index ${index}: ${rows.map((row) => row.detail).join("; ")}`);
    }
  }
  // CTE/worklist scans are intentional and bounded. Base-table scans or
  // automatic indexes conceal a missing persistent hot-path index.
  if (rows.some((row) => /AUTOMATIC|SCAN (vault_nodes|grants|files|directories|sessions|shares|publication_requests|rate_limit_counters)\b/.test(row.detail))) {
    throw new Error(`${query.name}: unindexed base-table access`);
  }
}

Target: local

# D1 operational query plans

All 22 representative queries use persistent indexed base-table searches.
CTE/worklist scans are bounded; payload ciphertext is not duplicated in indexes.
Selected unique-point lookups are reported honestly, with separate covering probes where needed.

## children

Source: `app/tree/tree.server.ts: Directory listing`

```sql
SELECT id, owner_id, kind, import_id FROM vault_nodes WHERE parent_node_id = 'root'
```

Selected plan:

```text
SEARCH vault_nodes USING COVERING INDEX vault_nodes_parent_idx (parent_node_id=?)
```

## current File representation pointer and capability epoch

Source: `app/tree/tree.server.ts: current File head`

```sql
SELECT current_representation_id, current_revision, capability_id, capability_epoch FROM files WHERE node_id = 'file' AND owner_id = 'owner'
```

Selected plan:

```text
SEARCH files USING INDEX files_owner_node_idx (owner_id=? AND node_id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT current_representation_id, current_revision, capability_id, capability_epoch FROM files INDEXED BY files_current_idx WHERE node_id = 'file' AND owner_id = 'owner'
```

```text
SEARCH files USING COVERING INDEX files_current_idx (node_id=? AND owner_id=?)
```

## current Directory epoch

Source: `app/tree/tree.server.ts: Directory revision/epoch CAS`

```sql
SELECT entries_revision, key_epoch FROM directories WHERE node_id = 'directory' AND owner_id = 'owner'
```

Selected plan:

```text
SEARCH directories USING INDEX directories_owner_node_idx (owner_id=? AND node_id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT entries_revision, key_epoch FROM directories INDEXED BY directories_current_idx WHERE node_id = 'directory' AND owner_id = 'owner'
```

```text
SEARCH directories USING COVERING INDEX directories_current_idx (node_id=? AND owner_id=?)
```

## current Comment audience epoch

Source: `app/comments/comments.server.ts: current epoch`

```sql
SELECT id, key_epoch, audience FROM comment_thread_epochs WHERE thread_id = 'thread' AND state = 'active'
```

Selected plan:

```text
SEARCH comment_thread_epochs USING INDEX comment_thread_epochs_current_idx (thread_id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT id, key_epoch, audience FROM comment_thread_epochs INDEXED BY comment_thread_epochs_head_idx WHERE thread_id = 'thread' AND state = 'active'
```

```text
SEARCH comment_thread_epochs USING COVERING INDEX comment_thread_epochs_head_idx (thread_id=?)
```

## active exact-target Grant

Source: `app/sharing/access.server.ts: matching`

```sql
SELECT owner_id, target_kind, permission, expires_at FROM grants WHERE recipient_id = 'recipient' AND target_id = 'target' AND (expires_at IS NULL OR expires_at > 1700000000000)
```

Selected plan:

```text
SEARCH grants USING COVERING INDEX grants_recipient_target_idx (recipient_id=? AND target_id=?)
```

## pending Share inbox

Source: `app/sharing/sharing.server.ts: pending Shares`

```sql
SELECT id, owner_id, target_id, target_kind, permission, created_at FROM shares WHERE recipient_id = 'recipient' ORDER BY id
```

Selected plan:

```text
SEARCH shares USING COVERING INDEX shares_recipient_idx (recipient_id=?)
```

## pending Publication requests

Source: `app/publications/publications.server.ts: request list`

```sql
SELECT id, requester_id, created_at FROM publication_requests WHERE file_id = 'file' AND owner_id = 'owner'
```

Selected plan:

```text
SEARCH publication_requests USING COVERING INDEX publication_requests_file_idx (file_id=? AND owner_id=?)
```

## active-or-deleting Publication

Source: `app/publications/publications.server.ts: filePublication`

```sql
SELECT id, state, current_link_id, current_representation_id FROM publications WHERE file_id = 'file' AND state IN ('active', 'deleting')
```

Selected plan:

```text
SEARCH publications USING COVERING INDEX publications_current_idx (file_id=? AND state=?)
```

## unique Public path

Source: `app/publications/publications.server.ts: anonymous current link lookup`

```sql
SELECT l.publication_id FROM publication_links l JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id WHERE l.id = 'path' AND p.state = 'active'
```

Selected plan:

```text
SEARCH l USING INDEX sqlite_autoindex_publication_links_1 (id=?)
SEARCH p USING INDEX sqlite_autoindex_publications_1 (id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT l.publication_id FROM publication_links l INDEXED BY publication_links_identity_idx JOIN publications p ON p.id = l.publication_id AND p.current_link_id = l.id WHERE l.id = 'path' AND p.state = 'active'
```

```text
SEARCH l USING COVERING INDEX publication_links_identity_idx (id=?)
SEARCH p USING INDEX sqlite_autoindex_publications_1 (id=?)
```

## current Recovery generation

Source: `app/recovery/enrollment.server.ts: generation CAS`

```sql
SELECT generation FROM recovery_capsules WHERE account_id = 'account'
```

Selected plan:

```text
SEARCH recovery_capsules USING INDEX sqlite_autoindex_recovery_capsules_1 (account_id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT generation FROM recovery_capsules INDEXED BY recovery_capsules_generation_idx WHERE account_id = 'account'
```

```text
SEARCH recovery_capsules USING COVERING INDEX recovery_capsules_generation_idx (account_id=?)
```

## current Device registry epoch

Source: `app/device/proof.server.ts: activeDevice`

```sql
SELECT registry_epoch FROM account_encryption_identities WHERE account_id = 'account'
```

Selected plan:

```text
SEARCH account_encryption_identities USING INDEX sqlite_autoindex_account_encryption_identities_1 (account_id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT registry_epoch FROM account_encryption_identities INDEXED BY account_encryption_identities_epoch_idx WHERE account_id = 'account'
```

```text
SEARCH account_encryption_identities USING COVERING INDEX account_encryption_identities_epoch_idx (account_id=?)
```

## live Session authority

Source: `app/auth/session.server.ts: readData`

```sql
SELECT id, account_id, purpose, authenticated_passkey_id, fresh_asserted_at, device_id FROM sessions
      WHERE id = 'session' AND revoked_at IS NULL AND idle_expires_at > 1700000000000
        AND absolute_expires_at > 1700000000000 AND (purpose = 'normal' OR created_at > 1699999700000)
```

Selected plan:

```text
SEARCH sessions USING INDEX sqlite_autoindex_sessions_1 (id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT id, account_id, purpose, authenticated_passkey_id, fresh_asserted_at, device_id FROM sessions INDEXED BY sessions_authority_idx
      WHERE id = 'session' AND revoked_at IS NULL AND idle_expires_at > 1700000000000
        AND absolute_expires_at > 1700000000000 AND (purpose = 'normal' OR created_at > 1699999700000)
```

```text
SEARCH sessions USING COVERING INDEX sessions_authority_idx (id=?)
```

## unexpired WebAuthn challenge

Source: `app/auth/webauthn.server.ts: one-use ceremony lookup`

```sql
SELECT id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at FROM webauthn_challenges WHERE id = 'challenge' AND expires_at > 1700000000000
```

Selected plan:

```text
SEARCH webauthn_challenges USING INDEX sqlite_autoindex_webauthn_challenges_1 (id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT id, challenge, purpose, account_id, session_id, origin, rp_id, expires_at FROM webauthn_challenges INDEXED BY webauthn_challenges_live_idx WHERE id = 'challenge' AND expires_at > 1700000000000
```

```text
SEARCH webauthn_challenges USING COVERING INDEX webauthn_challenges_live_idx (id=? AND expires_at>?)
```

## unexpired registration challenge

Source: `app/signup/signup.server.ts: registration challenge lookup`

```sql
SELECT challenge, origin, expires_at FROM registration_challenges WHERE id = 'challenge' AND expires_at > 1700000000000
```

Selected plan:

```text
SEARCH registration_challenges USING INDEX sqlite_autoindex_registration_challenges_1 (id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT challenge, origin, expires_at FROM registration_challenges INDEXED BY registration_challenges_live_idx WHERE id = 'challenge' AND expires_at > 1700000000000
```

```text
SEARCH registration_challenges USING COVERING INDEX registration_challenges_live_idx (id=? AND expires_at>?)
```

## unexpired routine enrollment authority

Source: `app/enrollment/enrollment.server.ts: candidate checks`

```sql
SELECT state, registry_epoch, candidate_device_id FROM device_enrollments WHERE id = 'enrollment' AND account_id = 'account' AND candidate_session_id = 'session' AND expires_at > 1700000000000
```

Selected plan:

```text
SEARCH device_enrollments USING INDEX sqlite_autoindex_device_enrollments_1 (id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT state, registry_epoch, candidate_device_id FROM device_enrollments INDEXED BY device_enrollments_live_idx WHERE id = 'enrollment' AND account_id = 'account' AND candidate_session_id = 'session' AND expires_at > 1700000000000
```

```text
SEARCH device_enrollments USING COVERING INDEX device_enrollments_live_idx (id=? AND account_id=? AND candidate_session_id=? AND expires_at>?)
```

## unexpired Recovery enrollment authority

Source: `app/recovery/enrollment.server.ts: recovery start checks`

```sql
SELECT state, generation, registry_epoch FROM recovery_enrollments WHERE id = 'enrollment' AND account_id = 'account' AND session_id = 'session' AND expires_at > 1700000000000
```

Selected plan:

```text
SEARCH recovery_enrollments USING INDEX sqlite_autoindex_recovery_enrollments_1 (id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT state, generation, registry_epoch FROM recovery_enrollments INDEXED BY recovery_enrollments_live_idx WHERE id = 'enrollment' AND account_id = 'account' AND session_id = 'session' AND expires_at > 1700000000000
```

```text
SEARCH recovery_enrollments USING COVERING INDEX recovery_enrollments_live_idx (id=? AND account_id=? AND session_id=? AND expires_at>?)
```

## unexpired Import authority

Source: `app/import/staging.server.ts: commit anchor`

```sql
SELECT state, target_directory_id, target_owner_id FROM import_sessions WHERE id = 'import' AND account_id = 'account' AND session_id = 'session' AND expires_at > 1700000000000
```

Selected plan:

```text
SEARCH import_sessions USING INDEX sqlite_autoindex_import_sessions_1 (id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT state, target_directory_id, target_owner_id FROM import_sessions INDEXED BY import_sessions_live_idx WHERE id = 'import' AND account_id = 'account' AND session_id = 'session' AND expires_at > 1700000000000
```

```text
SEARCH import_sessions USING COVERING INDEX import_sessions_live_idx (id=? AND account_id=? AND session_id=? AND expires_at>?)
```

## consumed mutation-proof marker

Source: `app/device/proof.server.ts: mutationProofStatements`

```sql
SELECT 1 FROM device_proof_uses WHERE account_id = 'account' AND proof_id = 'proof' AND commit_token = 'token'
```

Selected plan:

```text
SEARCH device_proof_uses USING INDEX sqlite_autoindex_device_proof_uses_1 (account_id=? AND proof_id=?)
```

Covering companion probe (explicit INDEXED BY; not the selected plan):

```sql
SELECT 1 FROM device_proof_uses INDEXED BY device_proof_uses_commit_idx WHERE account_id = 'account' AND proof_id = 'proof' AND commit_token = 'token'
```

```text
SEARCH device_proof_uses USING COVERING INDEX device_proof_uses_commit_idx (account_id=? AND proof_id=? AND commit_token=?)
```

## outstanding provisioning need

Source: `app/sharing/provisioning.server.ts: current need`

```sql
SELECT grant_id, grant_key_epoch FROM provisioning_needs WHERE device_id = 'device'
```

Selected plan:

```text
SEARCH provisioning_needs USING COVERING INDEX provisioning_needs_device_idx (device_id=?)
```

## rolling counter window

Source: `app/security/abuse-control.server.ts: activePredicate`

```sql
SELECT SUM(count), MIN(expires_at) FROM rate_limit_counters WHERE purpose = 'session.refresh'
      AND scope_type = 'session' AND scope_id = 'session:synthetic' AND window_ms = 3600000
      AND time_epoch > 1699996400000 AND expires_at > 1700000000000
```

Selected plan:

```text
SEARCH rate_limit_counters USING COVERING INDEX rate_limit_counters_window_idx (purpose=? AND scope_type=? AND scope_id=? AND window_ms=? AND time_epoch>?)
```

## bounded ancestor-recursive Grant access

Source: `app/sharing/access.server.ts: lineage/matching (100 edges)`

```sql
WITH RECURSIVE lineage(id, parent_node_id, owner_id, kind, depth) AS (
      SELECT id, parent_node_id, owner_id, kind, 0 FROM vault_nodes WHERE id = 'file'
      UNION ALL SELECT p.id, p.parent_node_id, p.owner_id, p.kind, c.depth + 1
      FROM lineage c JOIN vault_nodes p ON p.id = c.parent_node_id
      WHERE p.owner_id = c.owner_id AND c.depth < 100)
      SELECT g.target_kind, g.permission FROM lineage a CROSS JOIN grants g INDEXED BY grants_recipient_target_idx
      WHERE g.recipient_id = 'recipient' AND g.target_id = a.id AND g.owner_id = a.owner_id
        AND (g.expires_at IS NULL OR g.expires_at > 1700000000000)
        AND (a.kind = 'directory' AND g.target_kind = 'directory'
          OR a.depth = 0 AND a.kind = 'file' AND g.target_kind = 'file')
```

Selected plan:

```text
CO-ROUTINE lineage
SETUP
SEARCH vault_nodes USING INDEX sqlite_autoindex_vault_nodes_1 (id=?)
RECURSIVE STEP
SCAN c
SEARCH p USING INDEX vault_nodes_owner_target_idx (owner_id=? AND id=?)
SCAN a
SEARCH g USING COVERING INDEX grants_recipient_target_idx (recipient_id=? AND target_id=? AND owner_id=?)
```

## bounded subtree deletion enumeration

Source: `app/tree/tree.server.ts: deletionIds (500 + overflow sentinel)`

```sql
WITH RECURSIVE subtree(id) AS (SELECT 'root' UNION
      SELECT n.id FROM vault_nodes n JOIN subtree p ON n.parent_node_id = p.id
      WHERE n.import_id IS NULL OR EXISTS (SELECT 1 FROM import_commits c WHERE c.import_id = n.import_id)
      LIMIT 501) SELECT id FROM subtree
```

Selected plan:

```text
CO-ROUTINE subtree
SETUP
SCAN CONSTANT ROW
RECURSIVE STEP
SCAN p
SEARCH n USING COVERING INDEX vault_nodes_parent_idx (parent_node_id=?)
CORRELATED SCALAR SUBQUERY 2
SEARCH c USING COVERING INDEX sqlite_autoindex_import_commits_1 (import_id=?)
SCAN subtree
```

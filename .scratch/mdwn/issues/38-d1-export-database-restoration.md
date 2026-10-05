# 38: Make D1 SQL exports a proven database-restoration path

**What to build:** A reviewed, operator-runnable way to restore a pre-change D1 export into a fresh disposable D1, preserving the complete schema, ciphertext, metadata, and authority relationships despite circular foreign keys, trigger side effects, and large records. Replace ticket 31's synthetic-only ordering workaround with a generally applicable, verified procedure/tool. This is operational database recovery, not authentication recovery, Vault recovery, or the browser's owned-Files Archive export.

**Type:** bug / operations

**Status:** ready-for-agent

**Blocked by:** 31 (Retention and operations; supplies the failed export-restoration rehearsal and current schema).

**Related:** [33: MVP acceptance suite](33-mvp-acceptance-suite.md); `docs/operations.md`; ADR-0002 (Time Travel plus pre-change exports for MVP rollback). Durable off-site backup infrastructure remains future work.

## Diagnosis and current evidence

Ticket 31 successfully restored its disposable remote database through **D1 Time Travel**, including pre-change data, foreign keys, migration head, and schema. Time Travel itself did not fail.

Direct re-import of the saved SQL export failed on circular/forward foreign-key/table ordering. Installing root-materialization triggers before restoring data also risks duplicate roots. The workaround restored the export offline in SQLite, then emitted tables/indexes before fixture data and triggers afterward; the reordered **small synthetic fixture** restored to fresh local D1 with FK enforcement and zero violations.

That preparation assumes single-line INSERTs and tiny BLOBs. It is not a general production dump transformer, does not address large hexadecimal BLOB statements or general import/transaction limits, and has not proven production-scale export recovery. FK disabling in the offline SQLite inspection step is not a D1 workaround: D1 keeps enforcement on and only permits transaction-local deferral.

Evidence and exact disposable targets/bookmarks are recorded in `docs/operations.md`. No real production restore was attempted, and no generalized fix was implemented in ticket 31.

## Acceptance criteria

- [ ] Reproduce the raw-export failure against the committed schema in disposable storage and identify the distinct table-definition, cyclic-row, and trigger-order hazards. Capture a sanitized failing regression before implementing the general restore path.
- [ ] Provide a supported, repeatable export-restoration tool/procedure, with explicit source export/schema version and target database name/UUID. Default to fresh disposable/local storage; reject an unknown or nonempty target without an explicit reviewed replacement plan. Tests and rehearsals must never target production or an existing preview database.
- [ ] Handle all table definitions before dependent data, cyclic references within valid D1 transaction/batch semantics, and root-materialization/Import-marker trigger side effects. Restore all original constraints, indexes, views and triggers and migration records. Do not disable D1 foreign-key enforcement, rely on deferral surviving transaction boundaries, or silently omit records/constraints/triggers.
- [ ] Parse/transform exports without assuming one INSERT per line or splitting SQL naively on semicolons. Support the application's maximum permitted ciphertext/BLOB records even when their hexadecimal SQL representation exceeds D1 statement/import limits, using a verified supported transport/batching strategy. Respect Workers Free/D1 limits; do not silently require paid infrastructure.
- [ ] Round-trip a production-representative **synthetic** dataset through an actual Wrangler D1 export and restore to a fresh disposable **remote D1**. Include circular node/File/representation relationships, materialized roots, Recovery capsules/current envelopes, durable Import markers whose staging has expired, and max-size ciphertext fields. Verify source/target table counts, byte/digest equality, authority/current pointers, migration head, `foreign_keys = 1`, and zero `foreign_key_check` violations.
- [ ] Verify restored trigger/constraint behavior and representative application reads, not just the existence of tables. Interrupted/failed restoration must remain visibly incomplete and unavailable for application traffic; provide safe cleanup or a verified restart strategy, never a silent partial success.
- [ ] Update `docs/operations.md` with tested commands, validated limits, failure handling, and evidence. Keep Time Travel and export restore separate; identify the rollback window/write-loss and compatible-Worker requirements, and require sealed traffic/stopped maintenance before any future live replacement. Store exports as sensitive local artifacts; never commit/upload real exports or print credentials, plaintext keys, or payload data.
- [ ] Record and delete only the disposable remote target created for rehearsal; use reversible cleanup for local artifacts. Run focused restore regressions and typecheck, complete Standards/Spec and the separate RR8/stack review gate, and pass `npm run verify` at the final clean head.

## Scope and pointers

- `docs/operations.md`: existing Time Travel/export runbook and explicitly limited preparation code.
- `scripts/fixtures/retention-rehearsal.sql`: small baseline only; extend coverage beyond its tiny sentinels.
- `scripts/lib/wrangler-targets.mjs`: existing explicit target-selection conventions.
- `drizzle/`, `app/db/schema.ts`: full dependency graph, cyclic storage references, root-materialization and immutable-marker triggers.
- Current Cloudflare D1 foreign-key, import/export, and limits documentation: verify supported transport semantics before choosing the implementation.

Do not change user-facing recovery, encrypted-Archive import/export, retention semantics, or the application schema merely to make the restore fixture easier. Do not add production debug endpoints or automatic paid spend. Backup scheduling, off-site retention and disaster-recovery hosting are not part of this fix.

## Comments

- Raised by the maintainer after ticket 31's PR #41. General export-based database recovery remains unresolved despite successful Time Travel and the small synthetic export rehearsal. This follow-up must not treat a sorted fixture alone as the fix.

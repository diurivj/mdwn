# 27: Hard-deletion completeness across Shares, Publications, and Comments

**What to build:** Deleting a File or a Directory removes every dependent record the Account owns — Grants, Publication data, both Comment threads, envelopes — so nothing survives that could still authorize, expose, or resurrect content.

**Blocked by:** 16 (Move, reorder, delete, and bounded Directory hard deletion), 19 (Key rotation), 23 (Public Comment threads and audience epochs), 25 (Public-link rotation and unpublish teardown).

**Status:** ready-for-agent

- [x] File hard deletion explicitly removes, in dependency order: its Directory entry, private representations, Key envelopes, Shares and Grants, Publication requests, links, Public representations, and teardown state, and both Comment threads with their Comments and attributions — before the node itself.
- [x] Deleting the File revokes and deletes its Publication as part of File hard deletion, without requiring a separate unpublish step.
- [x] Directory hard deletion enumerates and authorizes the full subtree, removes every dependent record beneath it (including Publications and Comment threads), proceeds only at or below 500 nodes, and leaves everything unchanged when over the cap.
- [x] No privacy-sensitive operation relies on a generic database cascade: foreign keys use `ON DELETE RESTRICT` and each dependent is removed by an explicit, authorized step.
- [x] Hard deletion leaves no application-visible trash, archive, soft-delete state, or restore path; a transient sealed teardown marker cannot restore access.
- [x] Security actions — hard deletion, unpublishing, session revocation, and browser export — are never blocked by Public-participation limits.
- [x] Hard deletion cannot recall client downloads and does not claim immediate erasure from provider-managed backups; the UI states that limit.
- [x] Tests delete a File and a Directory that each have an active Publication, Comments, and Grants, then assert no orphan rows in any dependent table and that the over-cap Directory case changes nothing.

## Comments

- 2026-10-04: Implemented on `issue/27-hard-deletion-completeness`. `public_comment_reports.comment_id` is now `ON DELETE RESTRICT`; migration `0025_furry_moonstone.sql` rebuilds the table in place, preserving its rows, indexes and checks, and `scripts/smoke-db.mjs` plus `tests/migrations.test.ts` pin the new foreign key. Every Comment-removal path removes reports explicitly in its own transaction: File/Directory hard deletion, the bounded unpublish teardown batches, the final teardown transaction, and author/Owner Public Comment deletion (which defers FK checks to commit). Staged `pseudonym_update_items` go with their deleted `thread_attributions` and `publication_authors` rows in File/Directory deletion, the teardown transaction, and `deletedFilePublications`; the two delete shapes live behind `deletedCommentReports` (`app/comments/public.server.ts`) and `deletedPseudonymItems` (`app/account/pseudonym-items.server.ts`). `tests/worker/hard-deletion-completeness.test.ts` deletes a File and a Directory that each have an active Publication, both Comment threads (Comments with attributions, a reported Public Comment), a Grant (and a Directory Grant), a pending Publication request and staged pseudonym items, asserting zero rows in every dependent table; it also proves the over-cap Directory leaves nodes, Publications, Comments, reports, Grants, items and proof records unchanged, that a deleted Comment's report goes with it, that unpublish teardown removes reports and staged items, and that hard deletion works while the Owner is suspended. An FK inventory sweep asserts no table in the schema uses `ON DELETE CASCADE`. Docs updated: `docs/tree-structure.md`, `docs/comments.md`, `docs/publications.md`.

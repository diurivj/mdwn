# 27: Hard-deletion completeness across Shares, Publications, and Comments

**What to build:** Deleting a File or a Directory removes every dependent record the Account owns — Grants, Publication data, both Comment threads, envelopes — so nothing survives that could still authorize, expose, or resurrect content.

**Blocked by:** 16 (Move, reorder, delete, and bounded Directory hard deletion), 19 (Key rotation), 23 (Public Comment threads and audience epochs), 25 (Public-link rotation and unpublish teardown).

**Status:** ready-for-agent

- [ ] File hard deletion explicitly removes, in dependency order: its Directory entry, private representations, Key envelopes, Shares and Grants, Publication requests, links, Public representations, and teardown state, and both Comment threads with their Comments and attributions — before the node itself.
- [ ] Deleting the File revokes and deletes its Publication as part of File hard deletion, without requiring a separate unpublish step.
- [ ] Directory hard deletion enumerates and authorizes the full subtree, removes every dependent record beneath it (including Publications and Comment threads), proceeds only at or below 500 nodes, and leaves everything unchanged when over the cap.
- [ ] No privacy-sensitive operation relies on a generic database cascade: foreign keys use `ON DELETE RESTRICT` and each dependent is removed by an explicit, authorized step.
- [ ] Hard deletion leaves no application-visible trash, archive, soft-delete state, or restore path; a transient sealed teardown marker cannot restore access.
- [ ] Security actions — hard deletion, unpublishing, session revocation, and browser export — are never blocked by Public-participation limits.
- [ ] Hard deletion cannot recall client downloads and does not claim immediate erasure from provider-managed backups; the UI states that limit.
- [ ] Tests delete a File and a Directory that each have an active Publication, Comments, and Grants, then assert no orphan rows in any dependent table and that the over-cap Directory case changes nothing.

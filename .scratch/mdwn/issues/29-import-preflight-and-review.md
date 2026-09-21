# 29: Import preflight and review

**What to build:** Before anything leaves the browser, a person dropping a folder, loose Markdown files, or an mdwn archive sees a complete review — what will be created, replaced, or skipped, where it lands, who will own it, and every generated Keep-both name — and an unsafe or oversized input creates nothing at all.

**Blocked by:** 05 (`mdwn/namespace-v1` canonical names), 14 (Private tree), 28 (Export owned Files).

**Status:** ready-for-agent

- [ ] Accepted input is a recognized mdwn ZIP archive, or one or more UTF-8 `.md`/`.markdown` files and folders; a selected folder becomes a child Directory and preserves hierarchy; unsupported inputs fail before upload.
- [ ] Local bounds are enforced: at most 100 normalized source File/Directory nodes (skipped and replaced collision candidates still count), at most 32 normalized Directory segments in a source path, at most 262,144 UTF-8 bytes per Markdown source, at most 8,388,608 bytes compressed for a recognized archive, at most 16,777,216 bytes expanded for every selection (manifests and Private-Comment sidecars count), loose input sharing the same expanded limit, and at most 1,000 Historical Comments.
- [ ] Preflight validates format and manifest, UTF-8, safe source paths, the exact `mdwn/namespace-v1` segment profile, duplicate normalized paths, node/depth/source/archive/expanded-input limits, Historical-Comment count, and every collision choice — before opening an Import session and before uploading anything.
- [ ] The review displays source count, create/replace/skip counts, maximum depth, compressed and expanded sizes, target, and every generated Keep-both name.
- [ ] Collisions never overwrite silently: **Keep both** uses the deterministic reservation, sort, suffix, and availability algorithm and never repairs a duplicate source path; **Skip** omits the candidate; **Replace** updates an existing File's current representation while preserving its existing Private and Public threads and active Publication; Directories never silently merge; a generated name that exceeds the segment profile requires Rename, Skip, or an authorized File Replace and is never truncated.
- [ ] An Import target is an owned Directory or a Directory reached by a current read/write Directory Grant; a direct File Grant or a read-only Directory Grant is never eligible; a direct File Grant never reveals or infers a parent Directory as a target; a drop in any other context is rejected before review and prompts the Account to choose an eligible Directory.
- [ ] The review explicitly states when new nodes will belong to another Account and will not appear in **Export my Files**.
- [ ] **Import** and **Export** live in the Files chrome; drag-and-drop targets eligible Directories; both the Import command and a valid drop open this preflight/review flow rather than inserting content into the editor.
- [ ] A conforming plan constructs the complete encrypted record and chunk plan and measures every canonical field, descriptor count, chunk, staging manifest, and aggregate payload and digest; a nonconforming plan creates no session and uploads nothing, identifies the safe local item or problem and the configured limit, and suggests remove/fix, re-export, or split-and-retry. No valid subset is automatically imported.
- [ ] Tests cover each bound at its limit and one over, Unicode profile rejection, traversal/absolute/empty component rejection, duplicate source path rejection, deterministic Keep-both names including literal suffixes and folded collisions, and an over-limit generated name.

## Comments

- 2026-09-21: Dependency note from ticket 03: the staging manifest built here is an `import-staging-manifest` envelope in `app/crypto/enc-v1` (`docs/enc-v1.md`), and staged records use `import-chunk`. Sizes are measured on the canonical envelope bytes, whose digest is `digestEnvelope`.

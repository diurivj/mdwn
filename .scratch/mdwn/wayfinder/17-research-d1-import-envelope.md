# Research: D1-backed encrypted import envelope

Type: research
Status: resolved
Assignee: diurivj
Blocked by: 11

## Question

[Import/export format & flow](11-import-export.md) settles that mdwn imports are browser-preflighted and all-or-nothing: unsupported or over-limit input creates no Files. Establish the factual implementation envelope needed to turn that policy into concrete MVP limits on the selected Cloudflare Workers + D1 stack.

Research against current Cloudflare primary documentation and, where useful, a small reproducible local capability test:

- Which Workers and D1 request, CPU, SQL statement, transaction/batch, row/payload, and storage constraints materially bound one browser-encrypted import?
- Given the settled `vault_nodes`, `directory_entries`, `file_representations`, and Key-envelope model, can a useful import of Files and Directories be created atomically in one D1 transaction? Quantify a defensible range or explain which values require a local benchmark.
- What should later decision-making use for maximum new nodes, Directory depth, source bytes per File, and archive bytes? Distinguish documented facts, measured results, and recommendations.
- If a single transaction cannot safely cover a practical import, identify the minimum privacy-safe staging/commit design that still exposes no partially imported tree to the Account.

Write cited findings to `.scratch/mdwn/research/d1-import-envelope.md`. This ticket establishes facts and options; it does not choose the product limits.

## Answer

**Resolution — D1 makes bounded atomic imports viable, not arbitrary-size imports.** Full cited findings: [D1 envelope for browser-preflighted, all-or-nothing imports](../research/d1-import-envelope.md).

- `D1Database.batch()` is an atomic SQL transaction: a failing statement rolls back the batch. A small imported hierarchy can therefore meet the no-partial-File contract in one request.
- The relevant current limits are 50 D1 queries per Worker invocation on Free and 1,000 on Paid, a 30-second whole-batch SQL duration, 2 MB maximum row/string/BLOB size, 100 bound parameters per query, and 128 MB Worker-isolate memory. Cloudflare publishes no usable maximum batch length or total batch payload.
- Under the settled schema, a File needs at least five logical insert records and a Directory at least three. A naive 10-File/two-Directory import already takes 56 statements, so a one-row-per-statement implementation cannot promise useful Free-tier atomic imports.
- The research proposes only provisional, explicitly non-final values (100 nodes, depth 32, 256 KiB/File, 8 MiB compressed or 16 MiB expanded input) and identifies a private staging plus one commit-marker visibility design if a later MVP needs larger imports.

[Lock import operational bounds](18-lock-import-operational-bounds.md) must now choose the Free-versus-Paid posture and exact tested caps; it must not mistake the provisional research recommendations for a settled product decision.

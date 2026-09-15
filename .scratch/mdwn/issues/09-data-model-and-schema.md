# Data model & schema

Type: grilling
Status: open
Blocked by: 04, 05, 06, 07, 08

## Question

Design the relational schema that everything else writes through:

- `users` (identity, credentials).
- `folders` — the tree. Adjacency list (`parent_id`) vs materialised path; decide based on how moves and permission checks will be written.
- `files` — `content` column, title, slug, timestamps; where does markdown source live if the privacy model chooses encryption?
- `shares` and `public_links` — two separate tables, matching the two mechanisms (`05`, `06`).
- `comments` (`07`).
- Uniqueness/constraints: can two files in one folder share a name? Two folders?
- Deletion semantics: soft vs hard delete, cascade on folder delete.
- Own the canonical domain glossary: write it into `CONTEXT.md` here.

## Answer

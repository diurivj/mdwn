# Coding standards

These are judgment calls for review. Mechanical safeguards belong in tooling
and tests; review procedure lives in [AGENTS.md](AGENTS.md#review-gate).

## Boundaries follow reasons to change

Split a module when concerns change independently and separation clarifies
ownership or hides complexity. Keep cohesive work together: line count alone
is not a reason to split, and distributing the same complexity across files
is not an improvement.

## Share behavior, not resemblance

Extract shared logic when callers must preserve the same behavior or safety
invariant. Similar-looking code alone is insufficient; there is no fixed
number of copies that requires extraction. Prefer duplication over a generic
helper whose caller-specific switches merely disguise unrelated behavior.

## Keep operational facts authoritative

Keep shared, verified D1 and Wrangler behavior in
[the scripting reference](docs/operations/d1-scripting.md). Comments should
explain local reasoning and link to that reference when relying on platform
behavior, rather than maintain competing copies of those facts.

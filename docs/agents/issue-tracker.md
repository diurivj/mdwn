# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files under `.scratch/`. The GitHub remote is for code only — issues are not tracked there.

## Conventions

- One effort per directory: `.scratch/<effort-slug>/`. The current effort is `mdwn` (`.scratch/mdwn/`).
- Tickets are one file per ticket at `.scratch/<effort-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file. Numbers are allocated sequentially and never reused.
- Triage state is a `Status:` line near the top of each ticket file (see `triage-labels.md` for the role strings).
- Comments and conversation history append to the bottom of the file under a `## Comments` heading.
- Research tickets write their findings to `.scratch/<effort-slug>/research/<slug>.md`.
- An assembled spec that belongs with the repo's other docs is written as `docs/<slug>.md` (this repo's is `docs/buildable-spec.md`) rather than into `.scratch/`.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<effort-slug>/issues/`, numbered from the next free `NN` (the next free number in `mdwn` is `28`).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body). This repo's map is `.scratch/mdwn/map.md`.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

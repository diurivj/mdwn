# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files under `.scratch/`. The GitHub remote is for code only — issues are not tracked there.

## Conventions

- One effort per directory: `.scratch/<effort-slug>/`. The current effort is `mdwn` (`.scratch/mdwn/`).
- **Wayfinder tickets** (resolved decision tickets) live at `.scratch/<effort-slug>/wayfinder/<NN>-<slug>.md`, numbered from `01`. `mdwn`'s are `01`–`27`.
- **Build tickets** live at `.scratch/<effort-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order — one file per ticket, never a single combined tickets file. Inspect the directory for the current highest number.
- Numbers are allocated sequentially within each directory and never reused.
- The wayfinder **map** stays at `.scratch/<effort-slug>/map.md` and links to its child tickets under `wayfinder/`.
- Triage state is a `Status:` line near the top of each ticket file (see `triage-labels.md` for the role strings). Build tickets are published `ready-for-agent`.
- Comments and conversation history append to the bottom of the file under a `## Comments` heading.
- Research tickets write their findings to `.scratch/<effort-slug>/research/<slug>.md`.
- An assembled spec that belongs with the repo's other docs is written as `docs/<slug>.md` (this repo's is `docs/buildable-spec.md`) rather than into `.scratch/`.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<effort-slug>/issues/`, numbered one higher than the current highest `NN` in that directory.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly. Because `mdwn` has two numbered sets — build tickets under `issues/` and wayfinder tickets under `wayfinder/` — treat a bare number as a build ticket unless the user says wayfinder.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body). This repo's map is `.scratch/mdwn/map.md`.
- **Child ticket**: `.scratch/<effort>/wayfinder/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/wayfinder/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

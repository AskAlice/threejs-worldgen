# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`, committed with the code. There is no external
tracker.

## Layout

Where a ticket lives is decided by what it is about, nothing else:

- **A published package** — `.scratch/<package>/<milestone>/issues/<NN>-<slug>.md`, where `<package>` is one of the
  packages this repo publishes (`heightfield`, `biomes`, `scatter`, `trees`, `water`, `particles`, `weathering`,
  `fauna`, `city`, `props`, `vehicles`, `sky`, `grass`, `worldgen`) and `<milestone>` is one of `m1-worlds`,
  `m2-docs-landing-pages-and-releases`, `m3-characters`, `m4-simulation-and-style`, `m5-living-world`, `no-milestone`.
- **Anything else** — `.scratch/common/issues/<NN>-<slug>.md`, flat. Cross-package work, repo tooling, docs, code
  review follow-ups and errata all live here. `common/` has no milestone or feature subdirectories.

Never invent a feature directory. If a ticket does not belong to exactly one published package, it goes in `common/`.

## Ticket format

- One ticket per file, numbered from `01` inside its own directory, never a single combined file.
- `**Status:**` near the top: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, or
  `resolved` (see `triage-labels.md`).
- `**Blocked by:**` the numbers and titles that must land first, or "None (can start immediately)".
- Acceptance criteria as checkboxes.
- New detail appends under `## Comments` with a date; the body stays the current summary.
- Each directory may have an `INDEX.md` linking its tickets. Keep links valid when a ticket moves.
- `.scratch/` is committed: no tokens, secrets, personal data or private URLs in a ticket.

## When a skill says "publish to the issue tracker"

Create the next numbered file in the directory that matches the layout above.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the ticket number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/common/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/common/issues/<NN>-<slug>.md`, numbered from `01`, with the question in the body. A
  `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records
  `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is
  `resolved`.
- **Frontier**: scan the relevant `issues/` directory for files that are open, unblocked, and unclaimed; first by
  number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer
  (gist + link) to the map's Decisions-so-far in `map.md`.

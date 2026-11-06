# Issue tracking for agents

Work is tracked in `.scratch/`, in this repository. There is no external tracker. The procedure lives in
`docs/agents/issue-tracker.md`; the role names live in `docs/agents/triage-labels.md`.

## Conversation tracking

Nothing the user raises lives only in the conversation.

**What gets a ticket:** every bug the user reports, every feature or design proposal, every rule or invariant they
state, and every bug you discover while working. A decision that changes a spec is appended to the ticket it belongs
to, not filed as a new ticket. A question becomes a ticket only once the user wants the work done.

**When:** in the same reply the thing comes up, including work you are fixing right now. Before ending a reply, check
whether anything new was raised and file or update it.

**Keeping it current:** the body is always the current summary. New detail is appended under `## Comments` with a date,
and the body is revised to match. Search `.scratch/` first and update rather than duplicate.

**No confirmation before filing.** End every reply that touches the tracker with
`Tracked: <path> (new|updated)` so the user never has to look it up.

**Tracked in git:** `.scratch/` is committed, so no tokens, secrets, personal data or private URLs in tickets.

## Layout

```
.scratch/<feature-slug>/
├── spec.md                 (optional, when the feature has a written spec)
└── issues/
    └── NN-<slug>.md        one ticket per file, numbered from 01
```

Each ticket carries:

- `**Status:**` one of `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, or `resolved`;
- `**Blocked by:**` the tickets that must land first, by number and title, or "None (can start immediately)";
- acceptance criteria as checkboxes.

A ticket's number is its filename prefix. Dependency order is the numbering order: blockers first.

## Working a feature

When several tickets are independent (no open blockers, disjoint files), hand them to parallel subagents, one ticket
each. Keep coupled tickets, and anything touching the same files, sequential. Shared monorepo files (root
`package.json`, `tsconfig.json`, `typedoc.json`, `example/vite.config.ts`) are edited by the coordinating agent only.

When a ticket is done, tick its acceptance criteria, set `**Status:** resolved`, and delete the file only when the user
asks for completed tickets to be cleared.

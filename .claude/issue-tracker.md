# Issue tracking for agents

Work is tracked in the issue tracker described in `docs/agents/issue-tracker.md`. Follow that doc for every tracker
operation: creating, searching, commenting, labelling, sub-issues, blocking and closing. Label strings come from
`docs/agents/triage-labels.md`. A `UserPromptSubmit` hook (`.claude/hooks/issue-tracking-reminder.sh`) points the agent
here on every prompt.

## Conversation tracking

Nothing the user raises lives only in the conversation.

**What gets an issue:** every bug the user reports, every feature or design proposal, every rule or invariant they
state, and every bug you discover while working. A decision that changes a spec is a comment on the issue it belongs to
(plus the spec edit), not a new issue. A question becomes an issue only once the user wants the work done.

**When:** in the same reply the thing comes up, including work you are fixing right now. Before ending a reply, check
whether anything new was raised and file or update it.

**Keeping it current:** the body is always the current summary: the user's request under **Request**, then cause,
decisions, repro and acceptance criteria. Each new detail is a dated comment, and the body is revised to match. Search
the tracker first and update rather than duplicate.

**No confirmation before filing.** End every reply that touches the tracker with
`Tracked: #n (few-word description, new), #m (…, updated)`, so the user never has to look a number up.

**Issues are public.** Paraphrase the user's request as a neutral requirement rather than quoting chat verbatim. Never
put tokens, secrets, personal data, private URLs, local paths or private conversation details in issues or comments.

## Hierarchy

| Level | Representation |
|---|---|
| Milestone | a tracker milestone (`threejs-worldgen · M1 — Worlds`, `… · M2 — Docs, landing pages and releases`, `… · M3 — Characters`, `… · M4 — Simulation and style`, `… · M5 — Living world`) |
| Epic | issue labelled `epic` in a milestone: one outcome |
| Story | issue labelled `story`, "As a … I want … so that …" plus acceptance criteria; a sub-issue of an epic |
| Task | issue labelled `task`: non-user-facing work (investigation, docs, harness); a sub-issue of a story or epic |
| Bug | category `bug`, a sub-issue of the story or epic whose behaviour it breaks |

Each issue carries:
- one category role and one state role from `docs/agents/triage-labels.md` (`ready-for-agent` when fully specified,
  `needs-info` when the cause or design is open);
- the `project:threejs-worldgen` label;
- one `package:<name>` label per package it touches, or an `area:<name>` label for work outside the packages.

Record ordering constraints as blocking dependencies, the way `docs/agents/issue-tracker.md` describes.

## Working a milestone

When several tickets in the current milestone are independent (no open blockers, disjoint packages or files), hand them
to parallel subagents, one ticket each. Keep coupled tickets, and anything touching the same files, sequential. Shared
monorepo files (root `package.json`, `tsconfig.json`, `typedoc.json`, `example/vite.config.ts`) are edited by the
coordinating agent only.

## If the tracker is unreachable

Note the item in `.scratch/tracker-backlog.md` (gitignored) and file it once the tracker is back.

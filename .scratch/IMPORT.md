# Imported GitHub issues

These tickets were imported from the public GitHub backlog of `AskAlice/threejs-worldgen` for provenance. **`.scratch/`
is the source of truth**; the GitHub issues are history, not a tracker.

## Layout

Tickets follow `docs/agents/issue-tracker.md`:

- a ticket about one published package lives at `.scratch/<package>/<milestone>/issues/NN-slug.md`;
- everything else lives at `.scratch/common/issues/NN-slug.md`, flat.

Each ticket keeps an `Imported from:` line naming its original issue. Completed tickets were deleted rather than kept
as history; `git log` has the record.

## What was not imported

- comments and conversation history (the original links still resolve);
- native blocking edges beyond what a ticket states;
- assignees, projects and reactions.

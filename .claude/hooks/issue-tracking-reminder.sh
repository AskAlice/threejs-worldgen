#!/bin/sh
# UserPromptSubmit hook: reminds the agent to keep .scratch/ current.
# Never blocks; prints the reminder as additionalContext. Procedure: .claude/issue-tracker.md.
# The tracker lives in .scratch/; this hook never names an external one.
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"threejs-worldgen tracking rule: if this prompt reports a bug, proposes a feature or design idea, states a rule/invariant, or you discover a bug while working, file it or update its existing ticket IN THIS SAME REPLY under .scratch/<feature-slug>/issues/NN-slug.md (procedure: .claude/issue-tracker.md, roles: docs/agents/triage-labels.md). One ticket per file, numbered from 01, with **Status:**, **Blocked by:** and acceptance checkboxes. Search .scratch/ first and update instead of duplicating; append new detail under ## Comments with a date and keep the body current. .scratch/ is committed, so never put tokens, secrets, personal data or private URLs in a ticket. End the reply with `Tracked: <path> (new|updated)`. When several tickets are independent (no open blockers, disjoint files), work them with parallel subagents; keep coupled ones sequential."}}
JSON

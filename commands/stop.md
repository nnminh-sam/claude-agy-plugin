---
description: Cancel a running Antigravity agent
argument-hint: "<run-id | last>"
allowed-tools: Bash(claude-agy:*)
---

Arguments: $ARGUMENTS

If no run was named, run `claude-agy list --status running` and ask the user which run to stop. Otherwise run `claude-agy stop <run>` and report the result. Changes the agent already made stay in the workspace, so suggest checking `git status`.

If `claude-agy` is not on PATH, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-agy.mjs"` instead.

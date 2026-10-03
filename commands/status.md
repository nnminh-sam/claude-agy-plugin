---
description: List delegated Antigravity runs, or show one run in detail
argument-hint: "[run-id | last]"
allowed-tools: Bash(claude-agy:*)
---

Arguments: $ARGUMENTS

- **With no argument:** run `claude-agy list`. Summarize what is running, what finished, and what failed, newest first. Mention that the orchestrator dashboard shows the same runs live.
- **With a run id or `last`:** run `claude-agy show <arg> --events 20` and summarize:
  - the status, duration and tokens
  - what the agent did, from its recent events
  - its final report
  - any error

  If the run is still active, say so and offer `claude-agy wait <id>`.

If `claude-agy` is not on PATH, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-agy.mjs"` instead.

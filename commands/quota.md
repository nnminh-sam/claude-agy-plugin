---
description: Show Antigravity quota and token usage of delegated runs
allowed-tools: Bash(claude-agy:*)
---

Run `claude-agy quota --credits` and `claude-agy usage --since 7d`, then report:
- **Remaining quota:** what is left in each model group (5-hour and weekly windows) and when each resets.
- **Recent spend:** tokens spent by delegated runs this week, per model.
- **Recommendation:** which model group has headroom for the next delegation. The Gemini group and the "Claude and GPT" group are separate quotas.

If `claude-agy` is not on PATH, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-agy.mjs"` instead.

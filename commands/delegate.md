---
description: Delegate a task to an Antigravity (agy) agent and report the result
argument-hint: "[--model ID] [--plan] [--effort LEVEL] [--bg] [--yolo] <task>"
allowed-tools: Bash(claude-agy:*), Bash(git status:*), Bash(git diff:*), Read, Grep, Glob
---

Delegate this task to an Antigravity agent: $ARGUMENTS

If no task was given, ask the user what to delegate and stop.

1. **Separate flags from the task.** `--model`, `--plan`, `--effort`, `--yolo`, `--sandbox` and `--cwd` pass straight through to `claude-agy run`. `--bg` means `--background`.
2. **Write a self-contained brief.** The Antigravity agent cannot see this conversation, so include:
   - the goal
   - the relevant file paths and context you already know
   - constraints (style, files not to touch)
   - acceptance criteria and how to verify them (the test or build command)

   Keep the user's wording where it is precise.
3. **Run it** with the Bash tool, passing the brief on stdin:
   ```
   claude-agy run --label "<3-6 word label>" [flags] - <<'BRIEF'
   <brief>
   BRIEF
   ```
   - Normally run this with `run_in_background: true`. Delegated runs often take several minutes, and you are notified when the run exits.
   - With `--bg`, pass `--background` instead. The command returns a run id immediately: report it and point the user to `/agy:status <id>`. Stop there.
4. **Handle the outcome** once the run has finished:
   - Read the output. It shows the status, the tokens, the agent's report, any blockers with suggested next steps, and the command that resumes the run. `claude-agy show <run-id> --json` has the same as JSON, including `resumeCommand`.
   - If the run is `blocked` (exit code 3) or `failed` (exit code 1), handle each blocker as the `delegate-to-antigravity` skill describes, then resume with the resume command and a message on stdin.
   - Ask the user before you grant a permission (`--yolo`, an allow-rule), widen the scope, install anything or supply credentials.
   - Send at most two follow-ups.
5. **Verify and report:**
   - Check what actually changed with `git status --short` and `git diff --stat` in the workspace, and compare it with the report's `changes`.
   - Tell the user the outcome, the files changed, the token count, any blockers and what you did about them, and your assessment against the acceptance criteria.
   - Do not quietly redo the work yourself. If a blocker needs the user's decision, show it with the resume command to use afterwards.

If `claude-agy` is not on PATH, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-agy.mjs"` instead.

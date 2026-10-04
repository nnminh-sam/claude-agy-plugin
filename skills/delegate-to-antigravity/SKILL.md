---
name: delegate-to-antigravity
description: How and when to delegate work from Claude Code to Google Antigravity (agy) agents with the claude-agy CLI. Covers choosing tasks and models, writing the brief, running agents in the foreground, background or in parallel, checking quota and tokens, and reviewing results. Use when the user mentions Antigravity, agy or Gemini agents, asks to offload, parallelize or delegate work, or asks about Antigravity quota or usage.
---

# Delegating to Antigravity

`claude-agy` wraps the Antigravity CLI (`agy --print --output-format stream-json`). It records every run under `~/.claude-agy/runs/<id>/`, where the Claude-AGY orchestrator dashboard picks it up.

## When to delegate

Good candidates:
- Self-contained tasks with clear acceptance criteria, such as writing tests for a module, a mechanical refactor across files, a dependency bump with fixes, or drafting docs from code.
- Work that can run in parallel with what the main session is doing.
- Tasks where a second model's perspective helps, such as an independent review or investigation.

Keep it in Claude Code instead when:
- The task needs this conversation's context or back-and-forth with the user.
- The task is a quick edit that would take less time than writing a brief.
- The quota for the model group you need is nearly exhausted. Check with `claude-agy quota`.

## Models and quota

`claude-agy models` lists the IDs and marks the default. Runs without `--model` use `$CLAUDE_AGY_MODEL`, then `defaultModel` in `~/.claude-agy/profile.json`; `claude-agy model <id>` changes it. Quota is shared within each group and has a 5-hour window and a weekly window:

| Group | Models | Use for |
| --- | --- | --- |
| Gemini Models | Gemini Flash (high/medium/low), Gemini Pro | Default. Flash for mechanical work, Pro for harder reasoning |
| Claude and GPT models | Claude Sonnet/Opus, GPT-OSS | When the Gemini group is low, or for a different model's view |

Quota is consumed in proportion to token cost, so shorter tasks and cheaper models last longer. `claude-agy usage --since 7d` shows what delegated runs spent.

## Writing the brief

The agent sees only the brief. A preamble added automatically tells it that it is running headless and must end with a report. Include:
1. The goal.
2. Context: paths, interfaces, and decisions already made.
3. Constraints: what not to touch and which conventions to follow.
4. Acceptance criteria as runnable commands.
5. What to report back.

Pass long briefs on stdin so quoting never breaks:

```bash
claude-agy run --label "tests for parser" --model gemini-3.1-pro-high - <<'BRIEF'
...brief...
BRIEF
```

## Running

| Pattern | Command |
| --- | --- |
| Foreground (blocks until done) | `claude-agy run [opts] <task>`. Run it as a background Bash task in Claude Code, because runs often take minutes |
| Detached | `claude-agy run --background ...` prints a run id, then `claude-agy wait <id> --timeout 540` |
| Continue a conversation | `claude-agy run --resume <conversation-id> "<follow-up>"` |
| Proposal only, no edits | `--plan` |
| Status / details / cancel | `claude-agy list`, `claude-agy show <id>`, `claude-agy stop <id>` |

`wait` exits with 0 when the run succeeded, 1 when it failed, 130 when it was cancelled, and 124 when the run is still going.

Permissions: runs use agy's `accept-edits` mode, so file edits are allowed. Terminal commands that would need approval are denied, because nobody can approve them headless. Pass `--yolo`, which maps to `--dangerously-skip-permissions`, only when the user explicitly wants that. Combine it with `--sandbox` where possible.

**Parallel runs:** never let two agents edit the same working tree. Give each one its own git worktree (`git worktree add ../wt-<name> -b agy/<name>`) and pass `--cwd ../wt-<name>`.

## Reviewing results

Treat a delegated result like a colleague's pull request:
- Check `git diff`.
- Run the acceptance commands.
- Read the agent's report critically.

Send focused corrections with `--resume` rather than starting over. Report to the user what changed, how it was verified, and the tokens used.

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

The agent sees only the brief. A preamble added automatically makes it an executor: it does exactly the task, stops at anything it cannot resolve instead of working around it, and ends with a JSON report that agy checks against a schema. Include:
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
| Continue a conversation | The run's `resumeCommand` plus the follow-up, or `claude-agy run --resume <conversation-id> --cwd <workspace> "<follow-up>"` |
| Proposal only, no edits | `--plan` |
| Status / details / cancel | `claude-agy list`, `claude-agy show <id>`, `claude-agy stop <id>` |

`run` and `wait` exit with 0 when the run succeeded, 1 when it failed, 3 when it is blocked, and 130 when it was cancelled; `wait` exits with 124 while the run is still going.

Permissions: runs use agy's `accept-edits` mode, so file edits are allowed. Terminal commands that would need approval are denied, because nobody can approve them headless, and the run ends there as `blocked`. Pass `--yolo`, which maps to `--dangerously-skip-permissions`, only when the user explicitly wants that. Combine it with `--sandbox` where possible.

**Parallel runs:** never let two agents edit the same working tree. Give each one its own git worktree (`git worktree add ../wt-<name> -b agy/<name>`) and pass `--cwd ../wt-<name>`.

## Handling the outcome

`claude-agy wait <id>` and `claude-agy show <id>` print the outcome when the run ends. With `--json`, it comes as these fields:
- `status`: `succeeded`, `blocked`, `failed` or `cancelled`.
- `report`: the agent's own report, with `summary`, `details`, `changes`, `verification`, `assumptions`, `remaining` and `blockers`. It is null when the run ended before the agent could write it, for example at a denied command.
- `blockers`: everything that stopped the run. Each one has a `kind`, the `source` that found it (`agent`, `agy` or `claude-agy`), a `detail`, a `target`, what it `needs`, and suggested `next` steps.
- `resumeCommand`: continues the same conversation in the same workspace with the same model and flags. Append your message on stdin:

```bash
<resumeCommand> - <<'MSG'
The spec is in docs/billing.md. Continue from where you stopped.
MSG
```

What to do for each kind of blocker:

| Kind | What to do |
| --- | --- |
| `permission` | agy denied an action, usually the command in `target`. If the command is safe and within the task, run it yourself and resume with its output. Resuming with `--yolo --sandbox`, or adding the blocker's `rule` to agy's allow-list, needs the user's approval first |
| `missing_tool` | Install or enable it only if that is clearly part of what the user asked; otherwise ask the user. Or resume and tell the agent what to use instead |
| `needs_input` | Answer from this conversation or the codebase if you can; otherwise ask the user. Resume with the answer |
| `out_of_scope` | Widening the scope is the user's decision unless they already made it. Resume with the decision, or do that part yourself |
| `environment` | Fix it if that is simple and safe, otherwise report it to the user |
| `task_failed` | Check the diff and the report. Resume with concrete guidance, try a stronger model, or finish it yourself |
| `agy_error` | If it is `retryable`, run again. For quota errors, check `claude-agy quota` and use the other model group. Otherwise report it |
| `timeout` | Resume to let the agent finish, or run again with a longer `--timeout` |
| `no_report` | Check `git status` and `git diff` in the workspace, then resume and ask the agent for its report |
| `other` | Read the report and decide |

Never grant permissions or widen the scope on your own. After two follow-ups on the same task, stop and report what is left.

## Reviewing results

Treat a delegated result like a colleague's pull request:
- Check `git diff`.
- Run the acceptance commands.
- Read the agent's report critically: compare `changes` with the diff, and `verification` with your own test run.

Send focused corrections with `--resume` rather than starting over. Report to the user what changed, how it was verified, and the tokens used.

# claude-agy plugin

A Claude Code plugin for delegating work to [Google Antigravity](https://antigravity.google) agents through the `agy` CLI. Every run is recorded on disk, and the [Claude-AGY orchestrator](../claude-agy-agent-orchestrator-server) shows these runs live.

> Claude Code reserves plugin names that start with `claude-`. The plugin therefore installs as **`agy`**, and its commands are `/agy:…`. The repository, the CLI and the state directory keep the `claude-agy` name.

## What's inside

| Component | Name | Purpose |
| --- | --- | --- |
| Slash command | `/agy:delegate <task>` | Writes a self-contained brief, runs it on Antigravity, then verifies the result and reports back. Flags: `--model`, `--plan`, `--effort`, `--bg`, `--yolo` |
| Slash command | `/agy:status [run]` | Lists runs, or shows one run's events and report |
| Slash command | `/agy:quota` | Shows the Antigravity quota per model group and the tokens spent by delegated runs |
| Slash command | `/agy:stop <run>` | Cancels a running agent |
| Subagent | `agy-delegate` | Prepares a brief, runs and supervises the agent, verifies its work, and sends at most two follow-ups |
| Skill | `delegate-to-antigravity` | When to delegate, model and quota choice, brief writing, parallel runs in worktrees, and reviewing results |
| Hook | SessionStart | Puts `bin/claude-agy` on PATH for the session's Bash tool |
| CLI | `claude-agy` | The engine behind all of the above. See below |

## Requirements

- Claude Code
- Node.js 22.5 or later. No npm dependencies.
- The Antigravity CLI, `agy`, signed in. Run `agy` once interactively to sign in.

## Install

```bash
# inside Claude Code
/plugin marketplace add /Users/nnminh/workspaces/claude-agy/claude-agy-plugin
/plugin install agy@agy-plugins
```

For a one-off session, run `claude --plugin-dir /Users/nnminh/workspaces/claude-agy/claude-agy-plugin`.

## The `claude-agy` CLI

```text
claude-agy run [options] <task...>     Run a task ("-" reads the task from stdin)
claude-agy list [--all] [--status S]   List runs
claude-agy show <run> [--events N]     Metadata, recent events, final report
claude-agy wait <run> [--timeout SEC]  Block until done. Exit 0 ok, 1 failed, 130 cancelled, 124 still running
claude-agy stop <run>                  Cancel
claude-agy quota [--credits]           Quota per model group (read-only, spends nothing)
claude-agy usage [--since 7d]          Token usage per model
claude-agy models                      Models available to agy
```

`<run>` can be a full id, a unique prefix or suffix, or `last`. Every command accepts `--json`.

Main options for `run`:

| Option | Effect |
| --- | --- |
| `-m/--model` | Model ID; `claude-agy models` lists them. Defaults to `$CLAUDE_AGY_MODEL` |
| `--plan` | Plan mode: the agent proposes changes instead of editing |
| `--effort` | Reasoning effort |
| `--cwd` | Workspace for the agent |
| `--add-dir` | Extra workspace directory |
| `--resume CONV` | Continue an earlier agy conversation |
| `--agent` | agy custom agent |
| `--project` | agy project |
| `--timeout 20m` | Passed to agy as `--print-timeout` |
| `--sandbox` | Run agy terminal commands in its sandbox |
| `--yolo` | Pass `--dangerously-skip-permissions` |
| `--label` | Short name shown in listings and the dashboard |
| `-b/--background` | Detach and print the run id immediately |
| `--no-preamble` | Send the task verbatim |
| `-v` | Stream event summaries to stderr |

### How a run works

`claude-agy run` creates the run directory and then spawns:

```
agy --print <preamble + task> --output-format stream-json --mode accept-edits [...]
```

It tees the NDJSON event stream (`init`, `step_update`, then `result`) to disk. When agy exits, it records the outcome, token usage, conversation id and any `AGY_ERROR` payload. If the supervisor receives SIGINT, SIGTERM or SIGHUP (from `stop`, Ctrl-C or the dashboard), it cancels agy and marks the run `cancelled`. A run whose supervisor died without recording an outcome is reported as `lost`.

The preamble tells the agent that it is running headless, that nobody can answer its questions, and that it must finish with a report.

### Permissions

Runs use agy's `accept-edits` mode, so the agent can edit files. Commands that would need approval are denied, because nobody is there to approve them. `--yolo`, or `CLAUDE_AGY_SKIP_PERMISSIONS=1`, opts in to `--dangerously-skip-permissions`; add `--sandbox` when you use it. Your shell alias `agy --dangerously-skip-permissions` does **not** apply, because the CLI spawns the binary directly.

## State contract

This contract is shared with the orchestrator server:

```
$CLAUDE_AGY_HOME (default ~/.claude-agy)/runs/<id>/
  meta.json      id, status (starting|running|succeeded|failed|cancelled), prompt, label, cwd, model, mode, effort,
                 source (claude-code|cli|dashboard), pid (supervisor), agyPid, conversationId, createdAt, startedAt,
                 endedAt, durationSeconds, numTurns, usage{input,output,thinking,cache_read,total}_tokens, error
  events.ndjson  raw agy stream-json lines
  stderr.log     agy stderr
  result.json    the terminal `result` event (holds the full `response`)
```

`meta.json` is always replaced atomically (write to a temp file, then rename). Readers derive `lost` themselves, from a `running` status whose `pid` is dead.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the Antigravity CLI |
| `CLAUDE_AGY_HOME` | `~/.claude-agy` | Where runs are stored |
| `CLAUDE_AGY_MODEL` | (agy default) | Default model |
| `CLAUDE_AGY_SKIP_PERMISSIONS` | unset | `1` means always pass `--dangerously-skip-permissions` |

## Development

```bash
npm test                                    # runs the CLI against test/fixtures/fake-agy.mjs, so no real agents start
claude plugin validate .                    # validates the plugin and marketplace manifests
claude --plugin-dir .                       # tries the plugin in a session
```

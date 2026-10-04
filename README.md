# claude-agy plugin

A Claude Code plugin for delegating work to [Google Antigravity](https://antigravity.google) agents through the `agy` CLI. Every run is recorded on disk, and the [Claude-AGY orchestrator](../claude-agy-agent-orchestrator-server) shows these runs live.

> Claude Code reserves plugin names that start with `claude-`. The plugin therefore installs as **`agy`**, and its commands are `/agy:…`. The repository, the CLI and the state directory keep the `claude-agy` name.

## What's inside

| Component | Name | Purpose |
| --- | --- | --- |
| Slash command | `/agy:delegate <task>` | Writes a self-contained brief, runs it on Antigravity, handles any blockers, verifies the result and reports back. Flags: `--model`, `--plan`, `--effort`, `--bg`, `--yolo` |
| Slash command | `/agy:status [run]` | Lists runs, or shows one run's events and report |
| Slash command | `/agy:quota` | Shows the Antigravity quota per model group and the tokens spent by delegated runs |
| Slash command | `/agy:stop <run>` | Cancels a running agent |
| Subagent | `agy-delegate` | Prepares a brief, runs and supervises the agent, resolves blockers it can, verifies the work, and sends at most two follow-ups |
| Skill | `delegate-to-antigravity` | When to delegate, model and quota choice, brief writing, parallel runs in worktrees, handling blockers, and reviewing results |
| Hook | SessionStart | Puts `bin/claude-agy` on PATH for the session's Bash tool |
| CLI | `claude-agy` | The engine behind all of the above. See below |

## Requirements

- Claude Code
- Node.js 22.5 or later. No npm dependencies.
- The Antigravity CLI, `agy`, signed in. Run `agy` once interactively to sign in.

## Install

```bash
# inside Claude Code
/plugin marketplace add nnminh-sam/claude-agy-plugin
/plugin install agy@agy-plugins
```

To pick up a new release later, run `/plugin marketplace update agy-plugins`.

For a one-off session from a local clone, run `claude --plugin-dir /path/to/claude-agy-plugin`.

## The `claude-agy` CLI

```text
claude-agy run [options] <task...>     Run a task ("-" reads the task from stdin)
claude-agy list [--all] [--status S]   List runs
claude-agy show <run> [--events N]     Metadata, recent events, final report
claude-agy wait <run> [--timeout SEC]  Block until done. Exit 0 ok, 1 failed, 3 blocked, 130 cancelled, 124 still running
claude-agy stop <run>                  Cancel
claude-agy quota [--credits]           Quota per model group (read-only, spends nothing)
claude-agy usage [--since 7d]          Token usage per model
claude-agy models                      Models available to agy (* marks the default)
claude-agy model [ID | --pick]         Show or set the default model in ~/.claude-agy/profile.json
```

`<run>` can be a full id, a unique prefix or suffix, or `last`. Every command accepts `--json`.

Main options for `run`:

| Option | Effect |
| --- | --- |
| `-m/--model` | Model ID; `claude-agy models` lists them. Defaults to `$CLAUDE_AGY_MODEL`, then `defaultModel` in `profile.json` |
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
| `--no-preamble` | Send the task verbatim: no executor preamble and no JSON report |
| `-v` | Stream event summaries to stderr |

### How a run works

`claude-agy run` creates the run directory and then spawns:

```
agy --print <preamble + task> --output-format stream-json --mode accept-edits [...] --json-schema <executor-report.schema.json>
```

It tees the NDJSON event stream (`init`, `step_update`, then `result`) to disk. When agy exits, it works out the run's outcome (below) and records it with the token usage and the conversation id. If the supervisor receives SIGINT, SIGTERM or SIGHUP (from `stop`, Ctrl-C or the dashboard), it cancels agy and marks the run `cancelled`. A run whose supervisor died without recording an outcome is reported as `lost`.

The preamble makes the agent an executor: it does exactly the task, stops at anything it cannot resolve instead of working around it, and ends with a JSON report. `--json-schema` makes agy enforce [that report](scripts/lib/executor-report.schema.json), which arrives as the result's `structured_output`: `status` (`done`, `blocked` or `failed`), `summary`, `details`, `changes`, `verification`, `assumptions`, `remaining` and `blockers`.

### Outcome: status, blockers and exit codes

claude-agy combines the agent's report with what agy's output shows into the run's `status` and a list of `blockers`:

| Status | Exit code of `run` and `wait` | When |
| --- | --- | --- |
| `succeeded` | 0 | The agent reported `done` |
| `blocked` | 3 | agy denied an action, or the agent reported `blocked` |
| `failed` | 1 | agy or the model failed, the turn timed out, the agent reported `failed`, or it ended without its report |
| `cancelled` | 130 | `stop`, Ctrl-C or the dashboard cancelled it |

`wait` exits with 124 while the run is still going.

Each blocker has a `kind`, the `source` that found it (`agent`, `agy` or `claude-agy`), a `detail`, the `target` it is about (a command, file, tool or URL, or empty), what it `needs`, and `next`: suggested next steps for Claude Code.

| Kind | Source | Meaning |
| --- | --- | --- |
| `permission` | agy, agent | An action needed approval. `tool` names the tool and, for a command, `rule` is the agy allow-rule that would permit it |
| `missing_tool` | agent, claude-agy | A command, program, package, service or tool is not available |
| `needs_input` | agent | The task is ambiguous or contradictory, or lacks a file, credential or decision |
| `out_of_scope` | agent | Finishing needs changes the task rules out |
| `environment` | agent | The network, sandbox, disk or a service is broken |
| `task_failed` | agent | The agent tried, but cannot meet the acceptance criteria |
| `agy_error` | agy, claude-agy | agy or the model failed, as its `AGY_ERROR` line says; `retryable` tells whether a retry may help |
| `timeout` | agy | `--timeout` expired with the turn still in progress |
| `no_report` | claude-agy | The agent ended without its JSON report |
| `other` | agent | A blocker of any other kind |

The `--json` output of `run`, `wait` and `show` adds `resumeCommand`: a `claude-agy run --resume <conversation> --cwd <workspace> ...` prefix that continues the agent's conversation with the same settings. Append extra flags and the message, or `-` to read it from stdin. `show` prints the report, the blockers and that command.

### Permissions

Runs use agy's `accept-edits` mode, so the agent can edit files. Commands that would need approval are denied, because nobody is there to approve them, and agy ends the turn at the first denial, before the agent can report it. claude-agy reads the denied command from the event stream instead and marks the run `blocked` with a `permission` blocker. `--yolo`, or `CLAUDE_AGY_SKIP_PERMISSIONS=1`, opts in to `--dangerously-skip-permissions`; add `--sandbox` when you use it. Your shell alias `agy --dangerously-skip-permissions` does **not** apply, because the CLI spawns the binary directly.

## State contract

This contract is shared with the orchestrator server:

```
$CLAUDE_AGY_HOME (default ~/.claude-agy)/runs/<id>/
  meta.json      id, status (starting|running|succeeded|blocked|failed|cancelled), prompt, label, cwd, model,
                 modelSource (flag|env|profile), mode, effort, preamble, deniedActions,
                 source (claude-code|cli|dashboard), pid (supervisor), agyPid, conversationId, createdAt, startedAt,
                 endedAt, durationSeconds, numTurns, usage{input,output,thinking,cache_read,total}_tokens,
                 responsePreview, report (the agent's executor report, or null), blockers[], error
  events.ndjson  raw agy stream-json lines
  stderr.log     agy stderr
  result.json    the terminal `result` event, flattened (holds the full `response`)
$CLAUDE_AGY_HOME/profile.json
                 {"defaultModel": "<model id>"}; other keys are kept
```

### Model selection

Every run passes an explicit `--model` to agy, so agy never picks a model on its own. The model comes from `--model`, then `$CLAUDE_AGY_MODEL`, then `defaultModel` in `profile.json`. If the profile has no default model, claude-agy writes `gemini-3.1-pro-high` into it and says so on stderr. Change it with `claude-agy model <id>` (checked against `agy models`) or `claude-agy model --pick`, or edit the file.

`report` and `blockers` are described under [Outcome](#outcome-status-blockers-and-exit-codes). `error` keeps its earlier meaning: the `AGY_ERROR` payload or stderr of a run agy failed, otherwise a one-line description of the first blocker.

`meta.json` is always replaced atomically (write to a temp file, then rename). Readers derive `lost` themselves, from a `running` status whose `pid` is dead.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the Antigravity CLI |
| `CLAUDE_AGY_HOME` | `~/.claude-agy` | Where runs are stored |
| `CLAUDE_AGY_MODEL` | unset | Overrides `defaultModel` in `profile.json` |
| `CLAUDE_AGY_SKIP_PERMISSIONS` | unset | `1` means always pass `--dangerously-skip-permissions` |

## Development

```bash
npm test                                    # runs the CLI against test/fixtures/fake-agy.mjs, so no real agents start
claude plugin validate .                    # validates the plugin and marketplace manifests
claude --plugin-dir .                       # tries the plugin in a session
```

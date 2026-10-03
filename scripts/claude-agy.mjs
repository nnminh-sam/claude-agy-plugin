#!/usr/bin/env node
// claude-agy: delegate tasks from Claude Code to Antigravity (`agy`) agents and track them.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatTokens, getCredits, getModels, getQuota, summarizeEvent } from './lib/agy.mjs';
import { supervise } from './lib/runner.mjs';
import {
  ACTIVE, HOME, createRun, isAlive, listRuns, newRunId, readMeta, readResult, resolveRunId, runPath, updateMeta,
  withEffectiveStatus,
} from './lib/store.mjs';

const SELF = fileURLToPath(import.meta.url);

const HELP = `claude-agy — delegate tasks to Antigravity agents

Usage:
  claude-agy run [options] <task...>     Run a task (use "-" to read the task from stdin)
  claude-agy list [--all] [--status S]   List delegated runs (newest first)
  claude-agy show <run> [--events N]     Show a run: metadata, recent events, response
  claude-agy wait <run> [--timeout SEC]  Wait for a run to finish (default 540s), then show it
  claude-agy stop <run>                  Cancel a running agent
  claude-agy quota [--credits]           Antigravity quota per model group
  claude-agy usage [--since 7d]          Token usage of delegated runs, per model
  claude-agy models                      Models available to agy

<run> is a run id, a unique prefix/suffix of one, or "last". Add --json for machine output.

run options:
  -m, --model ID        agy model (default $CLAUDE_AGY_MODEL or agy's default); see "claude-agy models"
      --plan            Plan mode: the agent proposes changes instead of editing (default: accept-edits)
      --effort LEVEL    low | medium | high | xhigh | max
      --cwd DIR         Workspace for the agent (default: current directory)
      --add-dir DIR     Extra workspace directory (repeatable)
      --resume CONV     Continue an earlier agy conversation
      --agent NAME      agy custom agent;  --project NAME  agy project
      --timeout DUR     agy --print-timeout, e.g. 20m (default: none)
      --sandbox         Run agy terminal commands in its sandbox
      --yolo            Pass --dangerously-skip-permissions (or set CLAUDE_AGY_SKIP_PERMISSIONS=1)
      --label TEXT      Short name shown in listings and the dashboard
  -b, --background      Detach and print the run id immediately
      --no-preamble     Send the task verbatim (no headless-delegation preamble)
  -v, --verbose         Stream event summaries to stderr while running

State: ${HOME}`;

function fail(message, code = 1) {
  console.error(`claude-agy: ${message}`);
  process.exit(code);
}

function args(argv, options, { positionals = true } = {}) {
  try {
    return parseArgs({ args: argv, options: { json: { type: 'boolean' }, ...options }, allowPositionals: positionals });
  } catch (err) {
    fail(`${err.message}\n\n${HELP}`, 2);
  }
}

function requireRun(ref) {
  let id;
  try {
    id = resolveRunId(ref);
  } catch (err) {
    fail(err.message);
  }
  if (!id) fail(ref ? `no run matches "${ref}"` : 'no runs yet');
  return id;
}

const ago = (iso) => {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const oneLine = (s, n) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const exitCodeFor = (status) => ({ succeeded: 0, cancelled: 130 })[status] ?? 1;

function printRun(meta, { events = 0 } = {}) {
  const result = readResult(meta.id);
  const bits = [meta.status];
  if (meta.durationSeconds != null) bits.push(`${meta.durationSeconds}s`);
  if (meta.numTurns != null) bits.push(`${meta.numTurns} turns`);
  if (meta.usage) bits.push(`${formatTokens(meta.usage.total_tokens)} tokens`);
  bits.push(`model ${meta.model ?? 'default'}`);
  console.log(`run ${meta.id}: ${bits.join(' · ')}`);
  if (meta.label) console.log(`label: ${meta.label}`);
  console.log(`cwd: ${meta.cwd}`);
  if (meta.conversationId) console.log(`conversation: ${meta.conversationId}  (continue with: claude-agy run --resume ${meta.conversationId} ...)`);
  if (meta.error) console.log(`error: ${typeof meta.error === 'string' ? meta.error : JSON.stringify(meta.error)}`);
  if (events > 0) {
    const lines = readEvents(meta.id).slice(-events);
    if (lines.length) console.log(`\n--- last ${lines.length} events ---\n${lines.map(summarizeEvent).join('\n')}`);
  }
  if (result?.response) console.log(`\n--- response ---\n${result.response.trim()}`);
  else if (!ACTIVE.has(meta.status)) console.log(`\n(no result event recorded; raw output: ${runPath(meta.id, 'events.ndjson')})`);
}

function readEvents(id) {
  let text = '';
  try {
    text = fs.readFileSync(runPath(id, 'events.ndjson'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

async function cmdRun(argv) {
  const { values: o, positionals } = args(argv, {
    model: { type: 'string', short: 'm' },
    plan: { type: 'boolean' },
    effort: { type: 'string' },
    cwd: { type: 'string' },
    'add-dir': { type: 'string', multiple: true },
    resume: { type: 'string' },
    agent: { type: 'string' },
    project: { type: 'string' },
    timeout: { type: 'string' },
    sandbox: { type: 'boolean' },
    yolo: { type: 'boolean' },
    label: { type: 'string' },
    background: { type: 'boolean', short: 'b' },
    'no-preamble': { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    source: { type: 'string' },
  });

  let prompt = positionals.join(' ').trim();
  if (prompt === '-') prompt = fs.readFileSync(0, 'utf8').trim();
  if (!prompt) fail('missing task. Usage: claude-agy run [options] <task...>', 2);

  const meta = createRun({
    id: newRunId(),
    status: 'starting',
    createdAt: new Date().toISOString(),
    source: o.source ?? (process.env.CLAUDECODE ? 'claude-code' : 'cli'),
    label: o.label ?? null,
    prompt,
    cwd: path.resolve(o.cwd ?? process.cwd()),
    model: o.model ?? process.env.CLAUDE_AGY_MODEL ?? null,
    mode: o.plan ? 'plan' : 'accept-edits',
    effort: o.effort ?? null,
    agent: o.agent ?? null,
    project: o.project ?? null,
    resume: o.resume ?? null,
    timeout: o.timeout ?? null,
    addDirs: (o['add-dir'] ?? []).map((d) => path.resolve(d)),
    sandbox: Boolean(o.sandbox),
    skipPermissions: Boolean(o.yolo) || process.env.CLAUDE_AGY_SKIP_PERMISSIONS === '1',
    preamble: !o['no-preamble'],
  });

  if (o.background) {
    const child = spawn(process.execPath, [SELF, '_supervise', meta.id], {
      cwd: meta.cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    updateMeta(meta.id, { pid: child.pid });
    if (o.json) console.log(JSON.stringify({ id: meta.id, status: 'starting', pid: child.pid }));
    else console.log(`started run ${meta.id} in the background (pid ${child.pid})\nfollow with: claude-agy wait ${meta.id}`);
    return;
  }

  const onEvent = o.verbose ? (e) => console.error(`· ${summarizeEvent(e)}`) : undefined;
  const final = await supervise(meta.id, { onEvent });
  if (o.json) console.log(JSON.stringify({ ...final, response: readResult(meta.id)?.response ?? null }, null, 2));
  else printRun(final);
  process.exitCode = exitCodeFor(final.status);
}

function cmdList(argv) {
  const { values: o } = args(argv, {
    all: { type: 'boolean', short: 'a' },
    status: { type: 'string' },
    limit: { type: 'string' },
  }, { positionals: false });
  let runs = listRuns();
  if (o.status) runs = runs.filter((r) => r.status === o.status);
  if (!o.all) runs = runs.slice(0, Number(o.limit ?? 20));
  if (o.json) return console.log(JSON.stringify(runs, null, 2));
  if (!runs.length) return console.log('no runs');
  const rows = runs.map((r) => [
    r.id, r.status, ago(r.createdAt), r.model ?? 'default', formatTokens(r.usage?.total_tokens), oneLine(r.label ?? r.prompt, 60),
  ]);
  const head = ['RUN', 'STATUS', 'CREATED', 'MODEL', 'TOKENS', 'TASK'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const row of [head, ...rows]) console.log(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join('  '));
}

function cmdShow(argv) {
  const { values: o, positionals } = args(argv, { events: { type: 'string' } });
  const meta = withEffectiveStatus(readMeta(requireRun(positionals[0])));
  if (o.json) {
    return console.log(JSON.stringify({ ...meta, result: readResult(meta.id), events: readEvents(meta.id).slice(-Number(o.events ?? 50)) }, null, 2));
  }
  printRun(meta, { events: Number(o.events ?? 15) });
}

async function cmdWait(argv) {
  const { values: o, positionals } = args(argv, { timeout: { type: 'string' }, events: { type: 'string' } });
  const id = requireRun(positionals[0]);
  const deadline = Date.now() + Number(o.timeout ?? 540) * 1000;
  let meta = withEffectiveStatus(readMeta(id));
  while (ACTIVE.has(meta.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    meta = withEffectiveStatus(readMeta(id));
  }
  if (o.json) console.log(JSON.stringify({ ...meta, response: readResult(id)?.response ?? null }, null, 2));
  else printRun(meta, { events: ACTIVE.has(meta.status) ? Number(o.events ?? 10) : 0 });
  if (ACTIVE.has(meta.status)) {
    if (!o.json) console.log(`\nstill ${meta.status}; wait again with: claude-agy wait ${id}`);
    process.exitCode = 124;
  } else {
    process.exitCode = exitCodeFor(meta.status);
  }
}

async function cmdStop(argv) {
  const { values: o, positionals } = args(argv, {});
  const id = requireRun(positionals[0]);
  let meta = readMeta(id);
  if (!ACTIVE.has(meta.status)) {
    return console.log(o.json ? JSON.stringify(meta) : `run ${id} is already ${meta.status}`);
  }
  if (isAlive(meta.pid) && meta.pid !== process.pid) {
    process.kill(meta.pid, 'SIGTERM'); // the supervisor cancels agy and records "cancelled"
    for (let i = 0; i < 40 && ACTIVE.has(readMeta(id).status); i++) await new Promise((r) => setTimeout(r, 250));
  }
  meta = readMeta(id);
  if (ACTIVE.has(meta.status)) {
    if (isAlive(meta.agyPid)) process.kill(meta.agyPid, 'SIGTERM');
    meta = updateMeta(id, { status: 'cancelled', endedAt: new Date().toISOString() });
  }
  console.log(o.json ? JSON.stringify(meta) : `run ${id} ${meta.status}`);
}

const until = (iso) => {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins <= 0) return 'now';
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
};

function cmdQuota(argv) {
  const { values: o } = args(argv, { credits: { type: 'boolean' } }, { positionals: false });
  let quota;
  let credits;
  try {
    quota = getQuota();
    if (o.credits) credits = getCredits();
  } catch (err) {
    fail(`could not read quota from agy: ${err.stderr || err.message}`);
  }
  if (o.json) return console.log(JSON.stringify({ quota, credits }, null, 2));
  for (const group of quota?.groups ?? []) {
    console.log(group.name);
    for (const b of group.buckets ?? []) {
      const pct = `${Math.round((b.remaining_fraction ?? 0) * 100)}%`.padStart(4);
      console.log(`  ${b.name.padEnd(28)} ${pct} left   resets in ${until(b.reset_time)} (${b.reset_time})`);
    }
  }
  if (credits) console.log(`AI credits remaining: ${credits.remaining_credits}`);
}

function cmdUsage(argv) {
  const { values: o } = args(argv, { since: { type: 'string' } }, { positionals: false });
  let runs = listRuns().filter((r) => r.usage);
  if (o.since) {
    const m = /^(\d+)([hd])$/.exec(o.since);
    if (!m) fail('--since expects e.g. 24h or 7d', 2);
    const cutoff = Date.now() - Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000);
    runs = runs.filter((r) => Date.parse(r.createdAt) >= cutoff);
  }
  const keys = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'];
  const byModel = {};
  for (const r of runs) {
    const row = (byModel[r.model ?? 'default'] ??= { runs: 0, ...Object.fromEntries(keys.map((k) => [k, 0])) });
    row.runs += 1;
    for (const k of keys) row[k] += r.usage[k] ?? 0;
  }
  if (o.json) return console.log(JSON.stringify(byModel, null, 2));
  if (!runs.length) return console.log('no completed runs with token usage');
  const head = ['MODEL', 'RUNS', 'INPUT', 'OUTPUT', 'THINKING', 'CACHE READ', 'TOTAL'];
  const rows = Object.entries(byModel).map(([model, r]) => [model, String(r.runs), ...keys.map((k) => formatTokens(r[k]))]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const row of [head, ...rows]) console.log(row.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  '));
}

function cmdModels(argv) {
  const { values: o } = args(argv, {}, { positionals: false });
  const models = getModels();
  if (o.json) return console.log(JSON.stringify(models, null, 2));
  for (const m of models) console.log(`${m.id}\t${m.name}`);
}

const COMMANDS = {
  run: cmdRun, list: cmdList, ls: cmdList, show: cmdShow, wait: cmdWait, stop: cmdStop,
  quota: cmdQuota, usage: cmdUsage, models: cmdModels,
  // Internal: entry point of a detached background run.
  _supervise: async ([id]) => {
    const final = await supervise(id);
    process.exitCode = exitCodeFor(final.status);
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(HELP);
} else if (!COMMANDS[command]) {
  fail(`unknown command "${command}"\n\n${HELP}`, 2);
} else {
  await COMMANDS[command](rest);
}

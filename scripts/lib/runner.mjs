import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { AGY_BIN, buildAgyArgs, eventKind } from './agy.mjs';
import { assessRun } from './outcome.mjs';
import { readMeta, runPath, updateMeta, writeJsonAtomic } from './store.mjs';

const clip = (s, n) => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const endStream = (stream) => new Promise((resolve) => stream.end(resolve));
// agy nests the outcome under `result` ({event: "result", result: {status, response, usage, ...}});
// result.json stores it flattened, as {event: "result", status, response, usage, ...}.
const flattenResult = (event) => (event.result && typeof event.result === 'object' ? { event: 'result', ...event.result } : event);
// What assessRun() needs from a tool step: the tool, its parameters and agy's error message, if any.
const toolStep = (step) => ({
  tool: step.tool_name ?? step.tool_info.name ?? 'tool',
  parameters: step.tool_info.parameters ?? {},
  message: step.tool_info.error?.message ?? '',
});

// Runs `agy` for an existing run (created by createRun) and records the outcome in meta.json.
// Resolves with the final meta. SIGINT/SIGTERM/SIGHUP cancel the agent and mark the run cancelled.
export async function supervise(id, { onEvent } = {}) {
  const meta = readMeta(id);
  if (!meta) throw new Error(`run ${id} not found`);

  const events = fs.createWriteStream(runPath(id, 'events.ndjson'), { flags: 'a' });
  const stderrLog = fs.createWriteStream(runPath(id, 'stderr.log'), { flags: 'a' });
  const started = Date.now();
  let stderrText = '';
  let result = null;
  // Tool steps in the order they started; a step's later updates (DONE, ERROR) replace its earlier ones.
  const toolSteps = new Map();
  let conversationId = meta.resume ?? null;
  let cancelled = false;

  const child = spawn(AGY_BIN, buildAgyArgs(meta), {
    cwd: meta.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_AGY_RUN_ID: id },
  });
  updateMeta(id, { status: 'running', pid: process.pid, agyPid: child.pid ?? null, startedAt: new Date().toISOString() });

  const cancel = () => {
    cancelled = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.on(sig, cancel);

  child.stderr.on('data', (chunk) => {
    stderrLog.write(chunk);
    if (stderrText.length < 1_000_000) stderrText += chunk;
  });

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    events.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (eventKind(event) === 'result') {
      result = flattenResult(event);
      writeJsonAtomic(runPath(id, 'result.json'), result);
    }
    const step = event.step_update ?? event;
    if (step.tool_info) toolSteps.set(`${step.conversation_id}:${step.step_index ?? toolSteps.size}`, toolStep(step));
    if (event.conversation_id && event.conversation_id !== conversationId) {
      conversationId = event.conversation_id;
      updateMeta(id, { conversationId });
    }
    onEvent?.(event);
  });

  const { code, signal, spawnError } = await new Promise((resolve) => {
    child.once('error', (err) => resolve({ code: null, signal: null, spawnError: err }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  for (const sig of signals) process.off(sig, cancel);
  await Promise.all([endStream(events), endStream(stderrLog)]);

  // agy reports SUCCESS even when a headless turn ends at a permission it cannot ask for; assessRun()
  // turns that, agy errors, timeouts and the agent's own report into a status and a list of blockers.
  const outcome = assessRun({ meta, result, toolSteps: [...toolSteps.values()], stderr: stderrText, code, spawnError, cancelled });
  return updateMeta(id, {
    status: outcome.status,
    exitCode: code,
    signal,
    endedAt: new Date().toISOString(),
    durationSeconds: result?.duration_seconds ?? Math.round((Date.now() - started) / 1000),
    numTurns: result?.num_turns ?? null,
    usage: result?.usage ?? null,
    conversationId: result?.conversation_id || conversationId,
    responsePreview: clip(outcome.report?.summary || result?.response, 300),
    deniedActions: result?.denied_actions ?? [],
    report: outcome.report,
    blockers: outcome.blockers,
    error: outcome.error,
  });
}

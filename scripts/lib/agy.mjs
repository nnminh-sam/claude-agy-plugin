// Thin wrapper around the Antigravity CLI (`agy`). Shell aliases do not apply to
// spawned processes, so permission flags are always explicit here.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const AGY_BIN = process.env.AGY_BIN || 'agy';

// The executor protocol: the preamble tells the agent how to work and how to report, and
// --json-schema makes agy enforce that report, which arrives as the result's `structured_output`.
// --no-preamble turns both off.
export const REPORT_SCHEMA = fileURLToPath(new URL('./executor-report.schema.json', import.meta.url));

export const PREAMBLE = [
  '[Delegated by Claude Code via claude-agy]',
  'You are an executor agent running headless: nobody can answer questions or approve actions while you work.',
  'Claude Code delegated this task and decides what happens next from your final report.',
  '',
  'How to work:',
  '- Do exactly what the task asks: read, search, write and edit code, and run the commands it needs. Nothing more.',
  '- Work inside the workspace and any directories the task names. Do not search or read anywhere else on the machine.',
  '- Use your file tools, not shell commands, to read, create, edit, list, search and inspect files, including to check your own changes.',
  '- Run shell commands only when the task needs them, such as its tests or build, and only after your edits: a command that needs approval is denied and ends your run at once.',
  '- Make small, reasonable assumptions and list them. Never guess at anything that changes the outcome.',
  '- If a file, credential or detail the task relies on is not in the workspace or the task, report it as needs_input instead of hunting for it.',
  '',
  'When something you cannot resolve within the task stops you, stop and report it as a blocker instead of working around it:',
  '- permission: an action you need was denied or needs approval',
  '- missing_tool: a command, program, package, service or tool you need is not available',
  '- needs_input: the task is ambiguous or contradictory, or lacks a file, credential or decision you need',
  '- out_of_scope: finishing requires changes the task rules out',
  '- environment: the network, sandbox, disk or a service is broken',
  '- task_failed: you tried, but cannot meet the acceptance criteria',
  'Never retry a denied action through another command, script or tool.',
  '',
  'Your final message is the JSON report the output schema describes: status (done, blocked or failed), summary, details',
  '(findings, answers or a plan the task asked for), changes, verification, assumptions, remaining and blockers.',
].join('\n');

// meta: the run's meta.json (see store.mjs). Returns argv for `agy`.
export function buildAgyArgs(meta) {
  const args = ['--print', meta.preamble === false ? meta.prompt : `${PREAMBLE}\n\n${meta.prompt}`];
  args.push('--output-format', 'stream-json');
  if (meta.model) args.push('--model', meta.model);
  if (meta.mode) args.push('--mode', meta.mode);
  if (meta.effort) args.push('--effort', meta.effort);
  if (meta.agent) args.push('--agent', meta.agent);
  if (meta.project) args.push('--project', meta.project);
  if (meta.resume) args.push('--conversation', meta.resume);
  if (meta.timeout) args.push('--print-timeout', meta.timeout);
  for (const dir of meta.addDirs ?? []) args.push('--add-dir', dir);
  if (meta.sandbox) args.push('--sandbox');
  if (meta.skipPermissions) args.push('--dangerously-skip-permissions');
  if (meta.preamble !== false) args.push('--json-schema', REPORT_SCHEMA);
  return args;
}

function agyJson(args, timeout = 60_000) {
  const out = execFileSync(AGY_BIN, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

// Read-only slash commands answered without starting an agent turn or spending quota.
export const getQuota = () => agyJson(['-p', '/usage', '--output-format', 'json']).command?.data;
export const getCredits = () => agyJson(['-p', '/credits', '--output-format', 'json']).command?.data;

// `agy models` prints "<id>\t<name>" rows (plus a progress line we skip).
export function getModels() {
  const out = execFileSync(AGY_BIN, ['models'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return out
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [id, name] = line.split('\t');
      return { id: id.trim(), name: (name ?? '').trim() };
    });
}

export const eventKind = (e) => e?.event ?? e?.type ?? 'unknown';

// Breadth-first lookup so summaries survive the step payload being nested differently.
export function findKey(obj, key, maxDepth = 4) {
  let level = [obj];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const node of level) {
      if (!node || typeof node !== 'object') continue;
      if (Object.hasOwn(node, key) && node[key] != null) return node[key];
      next.push(...Object.values(node));
    }
    level = next;
  }
  return undefined;
}

const clip = (s, n = 120) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

export function summarizeEvent(e) {
  const kind = eventKind(e);
  if (kind === 'result') return `result ${e.status ?? ''}`.trim();
  const parts = [kind];
  const stepType = findKey(e, 'step_type');
  if (stepType) parts.push(String(stepType));
  const tool = findKey(e, 'tool_info');
  if (tool) parts.push(tool.name ?? tool.canonical_name ?? tool.tool_name ?? 'tool');
  const sub = findKey(e, 'subagent_info');
  if (sub?.conversation_id) parts.push(`subagent ${sub.conversation_id}`);
  for (const key of ['text', 'delta_text', 'message', 'summary', 'title']) {
    const value = findKey(e, key);
    if (typeof value === 'string' && value.trim()) {
      parts.push(`— ${clip(value)}`);
      break;
    }
  }
  return parts.join(' ');
}

// `AGY_ERROR: {...}` is printed on stderr when a headless turn fails (exit code 3).
export function parseAgyError(stderr) {
  const line = stderr.split('\n').find((l) => l.startsWith('AGY_ERROR:'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('AGY_ERROR:'.length));
  } catch {
    return { message: line.slice('AGY_ERROR:'.length).trim() };
  }
}

export function formatTokens(n) {
  return n == null ? '-' : Number(n).toLocaleString('en-US');
}

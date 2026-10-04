// Turns the way an agy run ended into what Claude Code needs to decide the next step: the agent's
// executor report, the blockers that stopped the run (each with suggested next steps) and the run's
// status. Blockers come from the agent's own report (source "agent"), from agy's output (source
// "agy": denied actions, AGY_ERROR, print timeouts) and from claude-agy itself (source "claude-agy").
import { AGY_BIN, parseAgyError } from './agy.mjs';

// The kinds an agent can report (see executor-report.schema.json). claude-agy adds agy_error, timeout
// and no_report, and files anything it does not recognise under "other".
export const AGENT_BLOCKER_KINDS = ['permission', 'missing_tool', 'needs_input', 'out_of_scope', 'environment', 'task_failed'];
const STATUS_FOR_REPORT = { done: 'succeeded', blocked: 'blocked', failed: 'failed' };
const PRINT_TIMEOUT = /^.*print timeout after.*$/im;
const DENIAL = /denied/i;
// The tool behind each type of action agy can deny.
const ACTION_TOOLS = { command: 'run_command' };
// Tool parameters that name what a tool call acts on, most specific first.
const TARGET_PARAMETERS = ['CommandLine', 'Url', 'TargetFile', 'AbsolutePath', 'FilePath', 'DirectoryPath', 'SearchPath', 'Path'];
const AGY_SETTINGS = '~/.gemini/antigravity-cli/settings.json';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value : []);
const lastLines = (stderr) => stderr.trim().split('\n').slice(-5).join('\n');

function tryJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// The report agy checked against the schema, or one the agent wrote into its response as bare JSON
// or in a ```json fence. Missing fields are filled in; null when there is no usable report.
export function parseReport(result) {
  const raw = isObject(result?.structured_output) ? result.structured_output : parseResponse(result?.response);
  if (!isObject(raw) || !Object.hasOwn(STATUS_FOR_REPORT, raw.status)) return null;
  return {
    status: raw.status,
    summary: text(raw.summary),
    details: text(raw.details),
    changes: list(raw.changes)
      .map((change) => (typeof change === 'string' ? { path: text(change), change: '' } : { path: text(change?.path), change: text(change?.change) }))
      .filter((change) => change.path),
    verification: list(raw.verification)
      .map((check) => ({ command: text(check?.command), passed: check?.passed === true, output: text(check?.output) }))
      .filter((check) => check.command),
    assumptions: list(raw.assumptions).map(text).filter(Boolean),
    remaining: list(raw.remaining).map(text).filter(Boolean),
    blockers: list(raw.blockers).filter(isObject).map((blocker) => ({
      kind: AGENT_BLOCKER_KINDS.includes(blocker.kind) ? blocker.kind : 'other',
      detail: text(blocker.detail),
      target: text(blocker.target),
      needs: text(blocker.needs),
    })),
  };
}

function parseResponse(response) {
  const body = text(response);
  if (!body) return null;
  const fenced = [...body.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].map((match) => match[1]).reverse();
  return [body, ...fenced].map(tryJson).find(isObject) ?? null;
}

// What a finished run amounts to. `toolSteps` are the run's tool steps in the order they started, as
// {tool, parameters, message}, where `message` is agy's error, if any. Returns {status, report,
// blockers, error}, where `error` keeps its earlier meaning for older readers: the AGY_ERROR payload
// (or stderr) of a run agy failed, and otherwise a one-line description of the first blocker.
export function assessRun({ meta, result, toolSteps = [], stderr = '', code = 0, spawnError = null, cancelled = false }) {
  const executor = meta.preamble !== false;
  const report = executor ? parseReport(result) : null;
  if (cancelled) return { status: 'cancelled', report, blockers: [], error: null };
  if (spawnError) return startFailure(spawnError, report);

  const unsuccessful = Boolean(result?.status && !/SUCCESS/i.test(result.status));
  const crashed = code !== 0 || unsuccessful;
  const agyError = parseAgyError(stderr);
  const timeout = stderr.match(PRINT_TIMEOUT)?.[0].trim();
  const blockers = [];
  if (crashed) blockers.push(agyErrorBlocker(agyError, stderr, unsuccessful ? `agy reported ${result.status}` : `agy exited with code ${code}`));
  blockers.push(...permissionBlockers(result?.denied_actions, toolSteps));
  if (timeout) blockers.push({ kind: 'timeout', source: 'agy', detail: timeout, target: meta.timeout ?? '', needs: 'more time to finish the turn' });
  if (report) blockers.push(...agentBlockers(report));
  else if (executor && !blockers.length) {
    const detail = result ? 'the agent finished without the JSON report' : 'agy ended without a result';
    blockers.push({ kind: 'no_report', source: 'claude-agy', detail, target: '', needs: "the agent's report" });
  }

  let status;
  if (crashed || timeout) status = 'failed';
  else if (list(result?.denied_actions).length) status = 'blocked';
  else if (report) status = STATUS_FOR_REPORT[report.status];
  else status = executor ? 'failed' : 'succeeded';

  const described = blockers.map((blocker) => ({ ...blocker, next: blocker.next ?? nextSteps(blocker) }));
  let error = null;
  if (crashed) error = agyError ?? (lastLines(stderr) || described[0].detail);
  else if (status !== 'succeeded' && described.length) error = describeBlocker(described[0]);
  return { status, report, blockers: described, error };
}

export const describeBlocker = (blocker) => `${blocker.kind}: ${blocker.detail}${blocker.target ? ` [${blocker.target}]` : ''}`;

function startFailure(spawnError, report) {
  const missing = spawnError.code === 'ENOENT';
  const detail = missing ? `agy binary not found ("${AGY_BIN}"). Install the Antigravity CLI or set AGY_BIN.` : spawnError.message;
  const blocker = missing
    ? { kind: 'missing_tool', source: 'claude-agy', detail, target: AGY_BIN, needs: 'the Antigravity CLI', next: ['Install the Antigravity CLI (agy) and sign in, or set AGY_BIN to its path; then run the task again.'] }
    : { kind: 'agy_error', source: 'claude-agy', detail, target: AGY_BIN, needs: 'agy to start' };
  return { status: 'failed', report, blockers: [{ ...blocker, next: blocker.next ?? nextSteps(blocker) }], error: detail };
}

function agyErrorBlocker(agyError, stderr, fallback) {
  const message = text(agyError?.message) || text(agyError?.short_error);
  const detail = message ? `${message}${agyError.status ? ` [${agyError.status}]` : ''}` : lastLines(stderr) || fallback;
  const blocker = { kind: 'agy_error', source: 'agy', detail, target: '', needs: 'agy and the model to work again' };
  if (typeof agyError?.retryable === 'boolean') blocker.retryable = agyError.retryable;
  return blocker;
}

// agy names denied actions only by type, e.g. {action: "command"}. The tool step it failed with a
// denial says what was denied, such as the command line. agy does not always fail that step: it may
// mark it DONE with no output instead. A denial ends the turn at once, though, so the last tool step
// is the denied one when its tool matches the action.
function permissionBlockers(deniedActions, toolSteps) {
  const denied = list(deniedActions);
  if (!denied.length) return [];
  const steps = toolSteps.filter((step) => DENIAL.test(step.message));
  if (steps.length) return steps.map((step) => permissionBlocker(step.tool, targetOf(step.parameters)));
  const last = toolSteps.at(-1);
  return denied.map((action, index) => (index === denied.length - 1 && last && ACTION_TOOLS[action.action] === last.tool
    ? permissionBlocker(last.tool, targetOf(last.parameters))
    : permissionBlocker(action.display_name ?? action.action ?? 'a tool', '')));
}

function permissionBlocker(tool, target) {
  const command = tool === 'run_command' && target;
  const blocker = {
    kind: 'permission',
    source: 'agy',
    detail: `agy denied ${tool}: a headless run cannot ask for approval`,
    target,
    needs: command ? 'approval to run this command' : 'approval for this action',
    tool,
  };
  if (command && !/[\n()]/.test(target)) blocker.rule = `command(${target})`;
  return blocker;
}

const targetOf = (parameters) => text(TARGET_PARAMETERS.map((name) => parameters?.[name]).find((value) => text(value)));

function agentBlockers(report) {
  const blockers = report.blockers.map(({ kind, detail, target, needs }) => ({ kind, source: 'agent', detail, target, needs }));
  if (report.status !== 'done' && !blockers.length) {
    blockers.push({
      kind: report.status === 'failed' ? 'task_failed' : 'other',
      source: 'agent',
      detail: report.summary || `the agent reported "${report.status}" without naming a blocker`,
      target: '',
      needs: '',
    });
  }
  return blockers;
}

// What Claude Code can do about a blocker. resumeCommand() gives the command that resumes the run.
export function nextSteps(blocker) {
  switch (blocker.kind) {
    case 'permission':
      if (blocker.tool === 'run_command' && blocker.target) {
        return [
          "If the command is safe, run it yourself in the run's workspace, then resume with its output.",
          'Or, once the user approves, resume with --yolo --sandbox so the agent can run it.',
          ...(blocker.rule ? [`Or ask the user to allow it for good: add "${blocker.rule}" to permissions.allow in ${AGY_SETTINGS}, then resume.`] : []),
        ];
      }
      return ['Ask the user whether to allow it. If they approve, resume with --yolo --sandbox.'];
    case 'missing_tool':
      return [`Install or enable ${blocker.target || 'what is missing'} (ask the user first if that needs approval), or tell the agent what to use instead; then resume.`];
    case 'needs_input':
      return ['Answer from what you already know, or ask the user; then resume with the answer.'];
    case 'out_of_scope':
      return ['Decide whether to widen the scope (ask the user if it is their call); then resume with the decision, or do that part yourself.'];
    case 'environment':
      return ['Fix the environment, or report the problem to the user; then resume.'];
    case 'task_failed':
      return ['Review the report and the workspace diff; then resume with specific guidance, try a stronger model, or finish it yourself.'];
    case 'agy_error':
      if (/RESOURCE_EXHAUSTED|quota/i.test(blocker.detail)) return ['Check `claude-agy quota`, then run again with a model from a group that has quota left.'];
      return blocker.retryable
        ? ['agy marked the error as retryable: run again, or switch to another model.']
        : ['Read the error; run again with another model, or report it to the user.'];
    case 'timeout':
      return ['Resume to let the agent finish, or run again with a longer --timeout.'];
    case 'no_report':
      return ['Check the workspace (git status, git diff), then resume and ask the agent for its report.'];
    default:
      return ['Read the report and decide: resume with guidance, or report to the user.'];
  }
}

// A `claude-agy run` prefix that continues the run's agy conversation in the same workspace with the
// same settings. Append extra flags (such as --yolo --sandbox) and the message, or "-" to read it from
// stdin. null when the run never got a conversation.
export function resumeCommand(meta) {
  if (!meta?.conversationId) return null;
  const args = ['claude-agy', 'run', '--resume', meta.conversationId, '--cwd', meta.cwd];
  for (const [flag, value] of [['--model', meta.model], ['--effort', meta.effort], ['--agent', meta.agent], ['--project', meta.project], ['--timeout', meta.timeout]]) {
    if (value) args.push(flag, value);
  }
  for (const dir of meta.addDirs ?? []) args.push('--add-dir', dir);
  if (meta.mode === 'plan') args.push('--plan');
  if (meta.sandbox) args.push('--sandbox');
  if (meta.skipPermissions) args.push('--yolo');
  if (meta.preamble === false) args.push('--no-preamble');
  return args.map(shellQuote).join(' ');
}

const shellQuote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`);

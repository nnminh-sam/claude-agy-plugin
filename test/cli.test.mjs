import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessRun, nextSteps, parseReport, resumeCommand } from '../scripts/lib/outcome.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'scripts', 'claude-agy.mjs');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-agy.mjs');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agy-test-'));
  const argsFile = path.join(home, 'agy-args.json');
  const cli = (args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { ...process.env, CLAUDE_AGY_HOME: home, AGY_BIN: FAKE, FAKE_AGY_ARGS_FILE: argsFile, CLAUDECODE: '', CLAUDE_AGY_MODEL: '', ...env },
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  const agyArgs = () => JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  return { home, cli, agyArgs };
}

test('foreground run records events, result, token usage and the agent report', async () => {
  const { home, cli, agyArgs } = setup();
  const { code, stdout } = await cli(['run', '--json', '--label', 'demo', 'write a.txt']);
  assert.equal(code, 0);
  const run = JSON.parse(stdout);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.conversationId, 'conv-123');
  assert.equal(run.usage.total_tokens, 125);
  assert.equal(run.numTurns, 2);
  assert.equal(run.mode, 'accept-edits');
  assert.equal(run.report.status, 'done');
  assert.equal(run.report.summary, 'Done. Changed a.txt.');
  assert.deepEqual(run.report.changes, [{ path: 'a.txt', change: 'created' }]);
  assert.deepEqual(run.blockers, []);
  assert.equal(run.error, null);
  assert.equal(run.responsePreview, 'Done. Changed a.txt.');
  assert.match(run.resumeCommand, /^claude-agy run --resume conv-123 --cwd \S+ --model gemini-3\.1-pro-high$/);

  const events = fs.readFileSync(path.join(home, 'runs', run.id, 'events.ndjson'), 'utf8').trim().split('\n');
  assert.equal(events.length, 3);

  const args = agyArgs();
  assert.equal(args[0], '--print');
  assert.match(args[1], /Delegated by Claude Code[\s\S]*executor agent[\s\S]*write a\.txt$/);
  assert.deepEqual(args.slice(2, 8), ['--output-format', 'stream-json', '--model', 'gemini-3.1-pro-high', '--mode', 'accept-edits']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--json-schema') + 1], 'utf8'));
  assert.equal(schema.title, 'claude-agy executor report');
});

test('flags map onto agy arguments', async () => {
  const { cli, agyArgs } = setup();
  await cli(['run', '--plan', '--yolo', '--sandbox', '--no-preamble', '-m', 'gemini-x', '--resume', 'conv-9', '--timeout', '5m', 'task']);
  const args = agyArgs();
  assert.equal(args[1], 'task');
  for (const [flag, value] of [['--mode', 'plan'], ['--model', 'gemini-x'], ['--conversation', 'conv-9'], ['--print-timeout', '5m']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--sandbox'));
  assert.ok(!args.includes('--json-schema'));
});

test('task can be read from stdin', async () => {
  const { home, agyArgs } = setup();
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, [CLI, 'run', '--no-preamble', '-'], {
    input: 'multi\n"quoted" task\n',
    env: { ...process.env, CLAUDE_AGY_HOME: home, AGY_BIN: FAKE, FAKE_AGY_ARGS_FILE: path.join(home, 'agy-args.json') },
  });
  assert.equal(res.status, 0);
  assert.equal(agyArgs()[1], 'multi\n"quoted" task');
});

test('agy failure marks the run failed with the AGY_ERROR payload', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'fail' });
  assert.equal(code, 1);
  const run = JSON.parse(stdout);
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 3);
  assert.equal(run.error.message, 'model overloaded');
  assert.equal(run.blockers.length, 1);
  const [blocker] = run.blockers;
  assert.equal(blocker.kind, 'agy_error');
  assert.equal(blocker.source, 'agy');
  assert.equal(blocker.detail, 'model overloaded [UNAVAILABLE]');
  assert.equal(blocker.retryable, true);
  assert.match(blocker.next[0], /retryable/);
});

test('missing agy binary is reported clearly', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', 'task'], { AGY_BIN: '/nonexistent/agy' });
  assert.equal(code, 1);
  const run = JSON.parse(stdout);
  assert.match(run.error, /agy binary not found/);
  assert.deepEqual(run.blockers.map(({ kind, source, target }) => ({ kind, source, target })), [
    { kind: 'missing_tool', source: 'claude-agy', target: '/nonexistent/agy' },
  ]);
  assert.match(run.blockers[0].next[0], /Install the Antigravity CLI/);
  assert.equal(run.resumeCommand, null);
});

test('background run can be waited on, listed and summarized', async () => {
  const { cli } = setup();
  const started = await cli(['run', '--background', '--json', 'task']);
  const { id } = JSON.parse(started.stdout);
  const waited = await cli(['wait', id.slice(-6), '--timeout', '20', '--json']);
  assert.equal(waited.code, 0);
  assert.equal(JSON.parse(waited.stdout).status, 'succeeded');

  const list = JSON.parse((await cli(['list', '--json'])).stdout);
  assert.deepEqual(list.map((r) => r.id), [id]);
  const usage = JSON.parse((await cli(['usage', '--json'])).stdout);
  assert.equal(usage['gemini-3.1-pro-high'].total_tokens, 125);
  const shown = await cli(['show', 'last']);
  assert.match(shown.stdout, /--- report: done ---\nDone\. Changed a\.txt\.\nchanges:\n {2}- a\.txt: created\nverification:\n {2}- \[passed\] cat a\.txt — a\n/);
  assert.match(shown.stdout, /\nresume: claude-agy run --resume conv-123 --cwd \S+ --model gemini-3\.1-pro-high "<message>"\n$/);
});

test('stop cancels a running background agent', async () => {
  const { cli } = setup();
  const { id } = JSON.parse((await cli(['run', '--background', '--json', 'task'], { FAKE_AGY_MODE: 'slow' })).stdout);
  const pending = await cli(['wait', id, '--timeout', '1', '--json']);
  assert.equal(pending.code, 124);
  assert.equal(JSON.parse(pending.stdout).status, 'running');
  const stopped = await cli(['stop', id, '--json'], { FAKE_AGY_MODE: 'slow' });
  assert.equal(JSON.parse(stopped.stdout).status, 'cancelled');
});

test('quota parses the /usage payload', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['quota']);
  assert.equal(code, 0);
  assert.match(stdout, /Gemini Models\n {2}Five Hour Limit Remaining +50% left/);
});

test('without a profile, the built-in default model is saved and passed to agy', async () => {
  const { home, cli, agyArgs } = setup();
  const { stdout, stderr } = await cli(['run', '--json', 'task']);
  const run = JSON.parse(stdout);
  assert.equal(run.model, 'gemini-3.1-pro-high');
  assert.equal(run.modelSource, 'profile');
  assert.match(stderr, /no default model configured/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'profile.json'), 'utf8')), { defaultModel: 'gemini-3.1-pro-high' });
  assert.equal(agyArgs()[agyArgs().indexOf('--model') + 1], 'gemini-3.1-pro-high');
});

test('model precedence: --model, then $CLAUDE_AGY_MODEL, then profile.json', async () => {
  const { home, cli, agyArgs } = setup();
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ defaultModel: 'gemini-pro', other: 1 }));
  const modelArg = () => agyArgs()[agyArgs().indexOf('--model') + 1];
  assert.equal(JSON.parse((await cli(['run', '--json', 'task'])).stdout).modelSource, 'profile');
  assert.equal(modelArg(), 'gemini-pro');
  assert.equal(JSON.parse((await cli(['run', '--json', 'task'], { CLAUDE_AGY_MODEL: 'gemini-env' })).stdout).modelSource, 'env');
  assert.equal(modelArg(), 'gemini-env');
  await cli(['run', '-m', 'gemini-flag', 'task'], { CLAUDE_AGY_MODEL: 'gemini-env' });
  assert.equal(modelArg(), 'gemini-flag');
});

test('a malformed profile stops the run before agy starts', async () => {
  const { home, cli } = setup();
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ defaultModel: 42 }));
  const { code, stderr } = await cli(['run', 'task']);
  assert.equal(code, 1);
  assert.match(stderr, /"defaultModel" .* must be a non-empty string/);
  assert.ok(!fs.existsSync(path.join(home, 'runs')));
});

test('model command shows, validates and saves the default model', async () => {
  const { home, cli } = setup();
  const set = await cli(['model', 'gemini-fast']);
  assert.equal(set.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'profile.json'), 'utf8')).defaultModel, 'gemini-fast');
  assert.match((await cli(['model'])).stdout, /default model: gemini-fast \(from .*profile\.json\)/);
  assert.match((await cli(['models'])).stdout, /^\* gemini-fast\tGemini Fast\n {2}gemini-pro\tGemini Pro$/m);
  const unknown = await cli(['model', 'nope']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown model "nope"/);
});

test('a nested result event is read for status, usage and report', async () => {
  const { home, cli } = setup();
  const run = JSON.parse((await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'nested' })).stdout);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.usage.total_tokens, 12);
  assert.equal(run.numTurns, 3);
  assert.equal(run.report.summary, 'Nested done.');
  assert.equal(JSON.parse(run.response).summary, 'Nested done.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'runs', run.id, 'result.json'), 'utf8')).status, 'SUCCESS');
});

test('a denied command blocks the run, names the command and suggests next steps', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'denied' });
  assert.equal(code, 3);
  const run = JSON.parse(stdout);
  assert.equal(run.status, 'blocked');
  assert.equal(run.report, null);
  assert.deepEqual(run.deniedActions, [{ action: 'command', display_name: 'RunCommand' }]);
  assert.equal(run.blockers.length, 1);
  const { next, ...blocker } = run.blockers[0];
  assert.deepEqual(blocker, {
    kind: 'permission',
    source: 'agy',
    detail: 'agy denied run_command: a headless run cannot ask for approval',
    target: 'python3 -m unittest discover -s tests -t .',
    needs: 'approval to run this command',
    tool: 'run_command',
    rule: 'command(python3 -m unittest discover -s tests -t .)',
  });
  assert.equal(next.length, 3);
  assert.match(next[2], /add "command\(python3 -m unittest discover -s tests -t \.\)" to permissions\.allow/);
  assert.equal(run.error, 'permission: agy denied run_command: a headless run cannot ask for approval [python3 -m unittest discover -s tests -t .]');
  assert.match(run.resumeCommand, /^claude-agy run --resume conv-123 --cwd /);
});

test('a denied command is still named when agy marks its step DONE instead of failing it', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'denied-done' });
  assert.equal(code, 3);
  const [blocker] = JSON.parse(stdout).blockers;
  assert.equal(blocker.tool, 'run_command');
  assert.equal(blocker.target, 'python3 -m unittest discover -s tests -t .');
  assert.equal(blocker.rule, 'command(python3 -m unittest discover -s tests -t .)');
});

test('a blocker the agent reports blocks the run', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'blocked' });
  assert.equal(code, 3);
  const run = JSON.parse(stdout);
  assert.equal(run.status, 'blocked');
  assert.equal(run.report.status, 'blocked');
  assert.equal(run.report.summary, 'docs/spec.md is missing.');
  assert.deepEqual(run.blockers.map(({ next, ...blocker }) => blocker), [
    { kind: 'needs_input', source: 'agent', detail: 'docs/spec.md does not exist.', target: 'docs/spec.md', needs: 'the spec' },
  ]);
  assert.match(run.blockers[0].next[0], /ask the user/);
});

test('wait exits 3 for a blocked run, and the summary lists blockers and the resume command', async () => {
  const { cli } = setup();
  const { id } = JSON.parse((await cli(['run', '--background', '--json', 'task'], { FAKE_AGY_MODE: 'denied' })).stdout);
  const waited = await cli(['wait', id, '--timeout', '20']);
  assert.equal(waited.code, 3);
  assert.match(waited.stdout, /^run \S+: blocked/);
  assert.match(waited.stdout, /\(no response recorded; raw output: /);
  assert.match(waited.stdout, /--- blockers ---\n1\. permission \(from agy\): agy denied run_command: a headless run cannot ask for approval\n {3}target: python3 -m unittest discover -s tests -t \.\n {3}needs: {2}approval to run this command\n {3}next: {3}If the command is safe/);
  assert.match(waited.stdout, /\nresume: claude-agy run --resume conv-123 --cwd \S+ --model gemini-3\.1-pro-high "<message>"\n$/);
});

test('a run that ends without the report fails, but a report written into the response counts', async () => {
  const { cli } = setup();
  const missing = await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'no-report' });
  assert.equal(missing.code, 1);
  const run = JSON.parse(missing.stdout);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.blockers.map((b) => [b.kind, b.source]), [['no_report', 'claude-agy']]);
  assert.equal(run.response, 'All done!');

  const fenced = JSON.parse((await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'fenced' })).stdout);
  assert.equal(fenced.status, 'succeeded');
  assert.equal(fenced.report.summary, 'Fenced report.');

  const verbatim = JSON.parse((await cli(['run', '--json', '--no-preamble', 'task'], { FAKE_AGY_MODE: 'no-report' })).stdout);
  assert.equal(verbatim.status, 'succeeded');
  assert.equal(verbatim.report, null);
  assert.deepEqual(verbatim.blockers, []);
});

test('a print timeout fails the run with a timeout blocker', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', '--timeout', '1s', 'task'], { FAKE_AGY_MODE: 'timeout' });
  assert.equal(code, 1);
  const run = JSON.parse(stdout);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.blockers.map((b) => [b.kind, b.target]), [['timeout', '1s']]);
  assert.match(run.blockers[0].detail, /print timeout after 1s/);
  assert.match(run.resumeCommand, / --timeout 1s$/);
});

test('resumeCommand keeps the run settings and quotes what the shell would split', () => {
  const command = resumeCommand({
    conversationId: 'c-1', cwd: '/tmp/my ws', model: 'm', mode: 'plan', addDirs: ["/x/it's"], sandbox: true, skipPermissions: true, preamble: false,
  });
  assert.equal(command, "claude-agy run --resume c-1 --cwd '/tmp/my ws' --model m --add-dir '/x/it'\\''s' --plan --sandbox --yolo --no-preamble");
  assert.equal(resumeCommand({ cwd: '/tmp' }), null);
});

test('denied actions without a matching tool step still become permission blockers', () => {
  const { status, blockers } = assessRun({
    meta: {},
    result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'url', display_name: 'ReadUrl' }] },
    toolSteps: [{ tool: 'view_file', parameters: { AbsolutePath: '/w/a.txt' }, message: '' }],
  });
  assert.equal(status, 'blocked');
  assert.deepEqual(blockers.map(({ kind, tool, target }) => ({ kind, tool, target })), [{ kind: 'permission', tool: 'ReadUrl', target: '' }]);
  assert.match(blockers[0].next[0], /^Ask the user whether to allow it/);
});

test('unknown blocker kinds become "other", and quota errors point to claude-agy quota', () => {
  const report = parseReport({ structured_output: { status: 'blocked', summary: 'stuck', blockers: [{ kind: 'mystery', detail: 'x' }] } });
  assert.deepEqual(report.blockers, [{ kind: 'other', detail: 'x', target: '', needs: '' }]);
  assert.deepEqual(report.changes, []);
  assert.equal(parseReport({ structured_output: { status: 'finished' } }), null);
  assert.match(nextSteps({ kind: 'agy_error', detail: 'quota exceeded [RESOURCE_EXHAUSTED]' })[0], /claude-agy quota/);
});

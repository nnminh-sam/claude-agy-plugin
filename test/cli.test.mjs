import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

test('foreground run records events, result and token usage', async () => {
  const { home, cli, agyArgs } = setup();
  const { code, stdout } = await cli(['run', '--json', '--label', 'demo', 'write a.txt']);
  assert.equal(code, 0);
  const run = JSON.parse(stdout);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.conversationId, 'conv-123');
  assert.equal(run.usage.total_tokens, 125);
  assert.equal(run.numTurns, 2);
  assert.equal(run.response, 'Done. Changed a.txt.');
  assert.equal(run.mode, 'accept-edits');

  const events = fs.readFileSync(path.join(home, 'runs', run.id, 'events.ndjson'), 'utf8').trim().split('\n');
  assert.equal(events.length, 3);

  const args = agyArgs();
  assert.equal(args[0], '--print');
  assert.match(args[1], /Delegated by Claude Code[\s\S]*write a\.txt$/);
  assert.deepEqual(args.slice(2, 8), ['--output-format', 'stream-json', '--model', 'gemini-3.1-pro-high', '--mode', 'accept-edits']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
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
});

test('missing agy binary is reported clearly', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', 'task'], { AGY_BIN: '/nonexistent/agy' });
  assert.equal(code, 1);
  assert.match(JSON.parse(stdout).error, /agy binary not found/);
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
  assert.match(shown.stdout, /--- response ---\nDone\. Changed a\.txt\./);
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

test('a nested result event is read for status, usage and response', async () => {
  const { home, cli } = setup();
  const run = JSON.parse((await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'nested' })).stdout);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.usage.total_tokens, 12);
  assert.equal(run.numTurns, 3);
  assert.equal(run.response, 'Nested done.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'runs', run.id, 'result.json'), 'utf8')).status, 'SUCCESS');
});

test('a turn stopped by denied permissions with no response is a failure', async () => {
  const { cli } = setup();
  const { code, stdout } = await cli(['run', '--json', 'task'], { FAKE_AGY_MODE: 'denied' });
  assert.equal(code, 1);
  const run = JSON.parse(stdout);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.deniedActions, [{ action: 'command', display_name: 'RunCommand' }]);
  assert.match(run.error, /permission/);
});

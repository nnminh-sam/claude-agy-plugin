#!/usr/bin/env node
// Stand-in for the Antigravity CLI used by tests. Behaviour is selected with FAKE_AGY_MODE.
import fs from 'node:fs';

const mode = process.env.FAKE_AGY_MODE ?? 'success';
if (process.env.FAKE_AGY_ARGS_FILE) fs.writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
// With --json-schema, real agy returns the agent's report as `structured_output`, and as JSON text in `response`.
const executor = process.argv.includes('--json-schema');
const report = (fields) => ({
  status: 'done', summary: '', details: '', changes: [], verification: [], assumptions: [], remaining: [], blockers: [], ...fields,
});
const reported = (fields) => ({ response: JSON.stringify(report(fields)), structured_output: report(fields) });

if (process.argv[2] === '-p' && process.argv[3] === '/usage') {
  emit({
    conversation_id: '', status: 'SUCCESS', response: '', usage: {},
    command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.5, reset_time: '2099-01-01T00:00:00Z' },
    ] }] } },
  });
  process.exit(0);
}

if (process.argv[2] === 'models') {
  process.stdout.write('Fetching models...\ngemini-fast\tGemini Fast\ngemini-pro\tGemini Pro\n');
  process.exit(0);
}

emit({ event: 'init', conversation_id: 'conv-123', model: 'fake-model' });
emit({ event: 'step_update', step_type: 'TOOL_CALL', tool_info: { name: 'write_file', parameters: { path: 'a.txt' } } });

if (mode === 'slow') {
  setInterval(() => emit({ event: 'step_update', step_type: 'THINKING', text: 'still working' }), 200);
} else if (mode === 'fail') {
  process.stderr.write('some log line\nAGY_ERROR: {"status":"UNAVAILABLE","retryable":true,"message":"model overloaded"}\n');
  emit({ event: 'result', conversation_id: 'conv-123', status: 'ERROR', response: 'partial', usage: { total_tokens: 5 } });
  process.exit(3);
} else if (mode === 'nested') {
  // Real agy nests the outcome under `result`.
  emit({ event: 'result', result: {
    conversation_id: 'conv-123', status: 'SUCCESS', duration_seconds: 7, num_turns: 3,
    ...(executor ? reported({ summary: 'Nested done.' }) : { response: 'Nested done.' }),
    usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 12 },
  } });
} else if (mode === 'denied' || mode === 'denied-done') {
  // A headless turn ends at the first tool call that needs approval, and the result names the action.
  // agy usually fails that step with the denial, but sometimes marks it DONE with no output.
  process.stderr.write('jetski: no output produced — a tool required the "command" permission\n');
  const command = 'python3 -m unittest discover -s tests -t .';
  const step = { conversation_id: 'conv-123', step_index: 4, step_type: 'tool', tool_name: 'run_command' };
  const toolInfo = { name: 'run_command', parameters: { CommandLine: command } };
  const denial = `permission check failed for unsandboxed "${command}": user denied permission to run command:\n${command}`;
  emit({ event: 'step_update', step_update: { ...step, state: 'ACTIVE', tool_info: toolInfo } });
  emit({ event: 'step_update', step_update: mode === 'denied'
    ? { ...step, state: 'ERROR', tool_info: { ...toolInfo, error: { type: 'TOOL_ERROR', message: denial } } }
    : { ...step, state: 'DONE', tool_info: toolInfo } });
  emit({ event: 'result', result: {
    conversation_id: 'conv-123', status: 'SUCCESS', response: '', num_turns: 1, usage: { total_tokens: 9 },
    denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
  } });
} else if (mode === 'blocked') {
  emit({ event: 'result', result: {
    conversation_id: 'conv-123', status: 'SUCCESS', num_turns: 1, usage: { total_tokens: 30 },
    ...reported({
      status: 'blocked', summary: 'docs/spec.md is missing.',
      blockers: [{ kind: 'needs_input', detail: 'docs/spec.md does not exist.', target: 'docs/spec.md', needs: 'the spec' }],
    }),
  } });
} else if (mode === 'timeout') {
  process.stderr.write('[agy] print timeout after 1s with turn in progress; returning partial output\n');
  emit({ event: 'result', result: { conversation_id: 'conv-123', status: 'SUCCESS', response: 'Still editing', num_turns: 1, usage: { total_tokens: 7 } } });
} else if (mode === 'no-report') {
  emit({ event: 'result', result: { conversation_id: 'conv-123', status: 'SUCCESS', response: 'All done!', num_turns: 1, usage: { total_tokens: 5 } } });
} else if (mode === 'fenced') {
  const response = `Finished.\n\n\`\`\`json\n${JSON.stringify(report({ summary: 'Fenced report.' }), null, 2)}\n\`\`\`\n`;
  emit({ event: 'result', result: { conversation_id: 'conv-123', status: 'SUCCESS', response, num_turns: 1, usage: { total_tokens: 5 } } });
} else {
  const done = { summary: 'Done. Changed a.txt.', changes: [{ path: 'a.txt', change: 'created' }], verification: [{ command: 'cat a.txt', passed: true, output: 'a' }] };
  emit({
    event: 'result', conversation_id: 'conv-123', status: 'SUCCESS',
    ...(executor ? reported(done) : { response: 'Done. Changed a.txt.' }),
    duration_seconds: 4, num_turns: 2,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 50, total_tokens: 125 },
  });
}

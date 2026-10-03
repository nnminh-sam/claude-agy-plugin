#!/usr/bin/env node
// Stand-in for the Antigravity CLI used by tests. Behaviour is selected with FAKE_AGY_MODE.
import fs from 'node:fs';

const mode = process.env.FAKE_AGY_MODE ?? 'success';
if (process.env.FAKE_AGY_ARGS_FILE) fs.writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);

if (process.argv[2] === '-p' && process.argv[3] === '/usage') {
  emit({
    conversation_id: '', status: 'SUCCESS', response: '', usage: {},
    command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.5, reset_time: '2099-01-01T00:00:00Z' },
    ] }] } },
  });
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
} else {
  emit({
    event: 'result', conversation_id: 'conv-123', status: 'SUCCESS', response: 'Done. Changed a.txt.',
    duration_seconds: 4, num_turns: 2,
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 50, total_tokens: 125 },
  });
}

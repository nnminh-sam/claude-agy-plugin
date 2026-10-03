// Run store shared with the orchestrator server. Layout (see README "State contract"):
//   $CLAUDE_AGY_HOME/runs/<id>/meta.json      run metadata, rewritten atomically
//   $CLAUDE_AGY_HOME/runs/<id>/events.ndjson  raw `agy --output-format stream-json` lines
//   $CLAUDE_AGY_HOME/runs/<id>/stderr.log     agy stderr
//   $CLAUDE_AGY_HOME/runs/<id>/result.json    the terminal `result` event
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = process.env.CLAUDE_AGY_HOME || path.join(os.homedir(), '.claude-agy');
export const RUNS_DIR = path.join(HOME, 'runs');

export const ACTIVE = new Set(['starting', 'running']);

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export const runPath = (id, file = '') => path.join(RUNS_DIR, id, file);

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function createRun(meta) {
  fs.mkdirSync(runPath(meta.id), { recursive: true });
  writeJsonAtomic(runPath(meta.id, 'meta.json'), meta);
  return meta;
}

export const readMeta = (id) => readJson(runPath(id, 'meta.json'));
export const readResult = (id) => readJson(runPath(id, 'result.json'));

export function updateMeta(id, patch) {
  const meta = { ...readMeta(id), ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(runPath(id, 'meta.json'), meta);
  return meta;
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A run whose supervisor died without recording an outcome is reported as "lost".
export function withEffectiveStatus(meta) {
  if (meta && ACTIVE.has(meta.status) && meta.pid && !isAlive(meta.pid)) {
    return { ...meta, status: 'lost' };
  }
  return meta;
}

export function listRuns() {
  let ids;
  try {
    ids = fs.readdirSync(RUNS_DIR);
  } catch {
    return [];
  }
  return ids
    .map((id) => withEffectiveStatus(readMeta(id)))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Accepts a full id, a unique prefix, a unique suffix (the random part), or "last".
export function resolveRunId(ref) {
  const runs = listRuns();
  if (!ref || ref === 'last') return runs[0]?.id ?? null;
  const exact = runs.find((r) => r.id === ref);
  if (exact) return exact.id;
  const matches = runs.filter((r) => r.id.startsWith(ref) || r.id.endsWith(ref));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`run reference "${ref}" is ambiguous (${matches.length} matches)`);
  return null;
}

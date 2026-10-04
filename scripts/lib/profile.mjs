// User profile: $CLAUDE_AGY_HOME/profile.json, e.g. {"defaultModel": "gemini-3.1-pro-high"}.
// Every run passes an explicit --model, so agy never falls back to whatever model it used last.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, writeJsonAtomic } from './store.mjs';

export const PROFILE_PATH = path.join(HOME, 'profile.json');
export const BUILTIN_DEFAULT_MODEL = 'gemini-3.1-pro-high';

export function readProfile() {
  let text;
  try {
    text = fs.readFileSync(PROFILE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let profile;
  try {
    profile = JSON.parse(text);
  } catch (err) {
    throw new Error(`${PROFILE_PATH} is not valid JSON: ${err.message}`);
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`${PROFILE_PATH} must hold a JSON object`);
  }
  if (profile.defaultModel != null && (typeof profile.defaultModel !== 'string' || !profile.defaultModel.trim())) {
    throw new Error(`"defaultModel" in ${PROFILE_PATH} must be a non-empty string`);
  }
  return profile;
}

// Merges `patch` into the profile, keeping any other keys.
export function writeProfile(patch) {
  fs.mkdirSync(HOME, { recursive: true });
  const profile = { ...(readProfile() ?? {}), ...patch };
  writeJsonAtomic(PROFILE_PATH, profile);
  return profile;
}

// Precedence: --model, then $CLAUDE_AGY_MODEL, then the profile's defaultModel. A profile without a
// defaultModel gets BUILTIN_DEFAULT_MODEL written into it (`created: true`). Throws on a malformed profile.
export function resolveModel(flag) {
  if (flag) return { model: flag, source: 'flag' };
  if (process.env.CLAUDE_AGY_MODEL) return { model: process.env.CLAUDE_AGY_MODEL, source: 'env' };
  const configured = readProfile()?.defaultModel?.trim();
  if (configured) return { model: configured, source: 'profile' };
  writeProfile({ defaultModel: BUILTIN_DEFAULT_MODEL });
  return { model: BUILTIN_DEFAULT_MODEL, source: 'profile', created: true };
}

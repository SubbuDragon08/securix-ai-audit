/**
 * Minimal `.env` loader.
 *
 * Node 20.6+ has `--env-file`, but that only helps a process you launch
 * directly — the app's client id is inlined at *build* time by esbuild, so the
 * value has to be readable from inside the build script itself.
 *
 * Real environment variables always win, so CI can override a developer's local
 * `.env` without anyone editing a file. Deliberately tiny: no dependency, no
 * interpolation, no `export` keyword handling — this file holds two client ids,
 * not a configuration language.
 */

import { existsSync, readFileSync } from 'node:fs';

/**
 * @param {string} file Path to a `.env` file. Missing files are not an error.
 * @returns {Record<string,string>} Values that were newly applied to process.env.
 */
export function loadEnv(file) {
  const applied = {};
  if (!existsSync(file)) return applied;

  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip one matching pair of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (key === '' || process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied[key] = value;
  }

  return applied;
}

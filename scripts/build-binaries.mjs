#!/usr/bin/env node
/**
 * Cross-compile standalone binaries with `bun build --compile`.
 *
 * Bun embeds its own runtime, so the output needs no Node installed on the
 * admin's machine — which is the whole point for a lead-magnet tool handed to
 * someone who will not `npm install` anything.
 *
 * Usage:
 *   node scripts/build-binaries.mjs            # every target
 *   node scripts/build-binaries.mjs darwin-arm64 windows-x64
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'dist-bin');

/** Bun target triples -> output filename. */
const TARGETS = {
  'darwin-arm64': { bun: 'bun-darwin-arm64', out: `ai-audit-lens-${version}-macos-arm64` },
  'darwin-x64': { bun: 'bun-darwin-x64', out: `ai-audit-lens-${version}-macos-x64` },
  'windows-x64': { bun: 'bun-windows-x64', out: `ai-audit-lens-${version}-windows-x64.exe` },
  'linux-x64': { bun: 'bun-linux-x64', out: `ai-audit-lens-${version}-linux-x64` },
  'linux-arm64': { bun: 'bun-linux-arm64', out: `ai-audit-lens-${version}-linux-arm64` },
};

const requested = process.argv.slice(2);
const selected = requested.length > 0 ? requested : Object.keys(TARGETS);

const unknown = selected.filter((t) => !(t in TARGETS));
if (unknown.length > 0) {
  console.error(`Unknown target(s): ${unknown.join(', ')}`);
  console.error(`Known targets: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(2);
}

if (spawnSync('bun', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('bun is required. Install it: curl -fsSL https://bun.sh/install | bash');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const key of selected) {
  const target = TARGETS[key];
  process.stdout.write(`building ${key} … `);
  const result = spawnSync(
    'bun',
    [
      'build',
      'src/index.ts',
      '--compile',
      '--minify',
      // Strip the sourcemap-heavy dev output; these ship to end users.
      '--sourcemap=none',
      `--target=${target.bun}`,
      '--outfile',
      join(outDir, target.out),
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (result.status === 0) {
    console.log(`ok -> dist-bin/${target.out}`);
  } else {
    failures++;
    console.log('FAILED');
    process.stderr.write(result.stderr?.toString() ?? '');
  }
}

process.exit(failures > 0 ? 1 : 0);

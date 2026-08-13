#!/usr/bin/env node
/**
 * Build the Linux artifacts, picking targets the host can actually produce.
 *
 * Why this script exists: `.deb` and `.rpm` are assembled by `fpm`, which shells
 * out to GNU `ar`. macOS ships BSD `ar`, which fails with
 * `ar failed (exit code 72)` partway through — after AppImage has already
 * succeeded, so the run looks half-broken and confusing.
 *
 * AppImage has no such dependency and is the universal Linux format anyway, so
 * on a non-Linux host we build that and say plainly how to get the others.
 * On Linux we build everything.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const onLinux = process.platform === 'linux';

const targets = onLinux ? ['AppImage', 'deb', 'rpm'] : ['AppImage'];

if (!onLinux) {
  console.log(
    `\n  Host is ${process.platform}, so building AppImage only.\n` +
      '  AppImage runs on every mainstream distro and needs no package manager.\n\n' +
      '  For .deb and .rpm, build on Linux or in a container:\n' +
      '    docker run --rm -v "$PWD":/project -w /project \\\n' +
      '      electronuserland/builder:wine \\\n' +
      '      /bin/bash -c "npm ci && npm run dist:linux"\n',
  );
}

// Naming targets on the command line replaces the arch list from
// electron-builder.yml with the host arch alone, so both arches are requested
// explicitly — otherwise an Apple Silicon build silently ships arm64 only.
const result = spawnSync(
  'npx',
  ['electron-builder', '--linux', ...targets, '--x64', '--arm64', '--publish', 'never'],
  { cwd: root, stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 1);

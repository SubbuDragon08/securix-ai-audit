#!/usr/bin/env node
/**
 * Build the Linux artifacts, picking targets the host can actually produce.
 *
 * Background: `.deb` and `.rpm` are assembled by `fpm`, which shells out to GNU
 * `ar` and (for rpm) `rpmbuild`. macOS ships BSD `ar`, which fails mid-build
 * with `ar failed (exit code 72)` — after AppImage has already succeeded, so the
 * run looks half-broken.
 *
 * Rather than give up off-Linux, this probes for the GNU tools and enables the
 * targets they unlock:
 *
 *   brew install binutils rpm
 *
 * Homebrew keeps binutils keg-only (Apple's CLT owns those names), so its bin
 * directory is prepended to PATH **for the child process only** — no shell
 * profile is modified, and the build behaves the same for anyone with the
 * packages installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const onLinux = process.platform === 'linux';

/** Homebrew keg-only binutils locations, Apple Silicon then Intel. */
const BINUTILS_DIRS = [
  '/opt/homebrew/opt/binutils/bin',
  '/usr/local/opt/binutils/bin',
];

const env = { ...process.env };

/** Does `ar` on the current PATH understand GNU syntax? */
function hasGnuAr(searchEnv) {
  const probe = spawnSync('ar', ['--version'], { env: searchEnv, encoding: 'utf8' });
  return probe.status === 0 && /GNU ar/.test(probe.stdout ?? '');
}

function hasCommand(name) {
  return spawnSync('command', ['-v', name], { shell: true, env, stdio: 'ignore' }).status === 0;
}

/**
 * Can this rpmbuild target Linux at all?
 *
 * Homebrew's rpm ships **only `*-darwin` platform definitions**. `rpmbuild
 * --target x86_64-unknown-linux` then fails with the unhelpful
 * `error: No compatible architectures found for build`, which fpm swallows into
 * a bare `exit code 1`. Presence of the binary is therefore not enough — probe
 * for a Linux platform file before offering the target.
 */
function rpmCanTargetLinux() {
  if (!hasCommand('rpmbuild')) return false;
  const probe = spawnSync('rpm', ['--eval', '%{_usrlibrpm}'], { env, encoding: 'utf8' });
  const libDir = (probe.stdout ?? '').trim();
  if (!libDir || libDir.startsWith('%')) return false;
  return ['x86_64-linux', 'aarch64-linux'].some((p) => existsSync(join(libDir, 'platform', p)));
}

// Prepend Homebrew's binutils if the default `ar` is not GNU.
if (!onLinux && !hasGnuAr(env)) {
  const dir = BINUTILS_DIRS.find((d) => existsSync(join(d, 'ar')));
  if (dir) env.PATH = `${dir}:${env.PATH}`;
}

// Probe on every host, including Linux: a CI runner is a Linux box that
// usually has GNU ar but *not* rpmbuild, and assuming otherwise turns a
// successful AppImage+deb build into a failed job.
const gnuAr = hasGnuAr(env);
const rpmbuild = rpmCanTargetLinux();

const targets = ['AppImage'];
if (gnuAr) targets.push('deb');
if (gnuAr && rpmbuild) targets.push('rpm');

console.log(`\n  Host: ${process.platform}`);
console.log(`  GNU ar:   ${gnuAr ? 'yes' : 'no  (deb/rpm unavailable)'}`);
console.log(`  rpmbuild: ${rpmbuild ? 'yes' : 'no  (cannot target Linux from here)'}`);
console.log(`  Targets:  ${targets.join(', ')}\n`);

if (!onLinux && !gnuAr) {
  console.log('  Install GNU ar to enable .deb:  brew install binutils\n');
}
if (!onLinux && !rpmbuild) {
  console.log(
    '  .rpm cannot be cross-built from this host: Homebrew\'s rpm ships only\n' +
      '  *-darwin platform definitions, so rpmbuild cannot target Linux. Build\n' +
      '  .rpm on a Linux machine, or in the official container:\n\n' +
      '    docker run --rm -v "$PWD":/project -w /project \\\n' +
      '      electronuserland/builder:wine \\\n' +
      '      /bin/bash -c "npm ci && npm run dist:linux"\n\n' +
      '  AppImage already covers Fedora/RHEL/openSUSE users in the meantime.\n',
  );
}

// Naming targets on the command line replaces the arch list from
// electron-builder.yml with the host arch alone, so both arches are requested
// explicitly — otherwise an Apple Silicon build silently ships arm64 only.
// rpm is x64-only in the config; electron-builder ignores the arch flags it
// does not apply to a given target.
const result = spawnSync(
  'npx',
  ['electron-builder', '--linux', ...targets, '--x64', '--arm64', '--publish', 'never'],
  { cwd: root, stdio: 'inherit', env },
);

process.exit(result.status ?? 1);

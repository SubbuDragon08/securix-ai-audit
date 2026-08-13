#!/usr/bin/env node
/**
 * Launch the app in development.
 *
 * Exists for one reason: **VS Code's integrated terminal exports
 * `ELECTRON_RUN_AS_NODE=1`** (it uses Electron to host extensions). Inherited by
 * a child Electron process, that flag makes it boot as plain Node, so
 * `require('electron')` returns the *path to the binary* instead of the API and
 * the app dies with a baffling
 *
 *     TypeError: Cannot read properties of undefined (reading 'whenReady')
 *
 * Stripping the variable here means `npm run app` behaves identically inside
 * VS Code, iTerm, and CI. The same applies to a few sibling variables Electron
 * treats as mode switches.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// The `electron` package exports the absolute path to its binary when required
// from Node — which is precisely the behaviour we are defending against below,
// and exactly what we want here.
const electronBinary = require('electron');

const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) {
  if (env[key]) {
    console.log(`  (unset ${key}=${env[key]} — inherited from this terminal)`);
    delete env[key];
  }
}

const child = spawn(electronBinary, [join(root, 'dist-electron', 'main.cjs'), ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
});

child.on('close', (code) => process.exit(code ?? 0));

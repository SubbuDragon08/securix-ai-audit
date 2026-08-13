#!/usr/bin/env node
/**
 * Bundle the Electron app.
 *
 * esbuild rather than plain tsc because the main process imports the ESM core
 * in `src/`, while a sandboxed preload must be CommonJS. Bundling each entry
 * separately sidesteps the whole ESM/CJS interop question and produces two
 * self-contained files that electron-builder can package as-is.
 *
 * `SECURIX_ENTRA_CLIENT_ID` is inlined at build time via `--define`, so the
 * shipped binary carries the vendor's app id without reading the environment on
 * the user's machine.
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './load-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-electron');

// `.env` is read here rather than by the launcher because the client id is
// inlined into the bundle below — by the time the app runs, it is a constant.
loadEnv(join(root, '.env'));

const clientId = process.env.SECURIX_ENTRA_CLIENT_ID?.trim() ?? '';
if (!clientId) {
  console.warn(
    '\n  ! SECURIX_ENTRA_CLIENT_ID is not set (checked the environment and .env).\n' +
      '    The app builds and runs, and "Preview with sample data" works fully —\n' +
      '    but Microsoft sign-in is disabled and the UI shows a setup notice.\n' +
      '    See DISTRIBUTION.md § 1 to register the app and get an id.\n',
  );
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  // Electron 33 ships Node 20; matching it avoids downlevel helpers.
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  legalComments: 'none',
  logLevel: 'info',
  define: {
    // Baked in so the binary does not depend on the end user's environment.
    'process.env.SECURIX_ENTRA_CLIENT_ID': JSON.stringify(clientId),
  },
};

await build({
  ...shared,
  entryPoints: [join(root, 'electron/main.ts')],
  outfile: join(outDir, 'main.cjs'),
});

await build({
  ...shared,
  entryPoints: [join(root, 'electron/preload.ts')],
  outfile: join(outDir, 'preload.cjs'),
});

// The renderer is plain HTML/CSS/JS — copied verbatim, never bundled, so what
// ships is exactly what is in the repo and is trivially auditable.
cpSync(join(root, 'ui'), join(outDir, 'ui'), { recursive: true });

console.log(`\n  Built -> dist-electron/  (entra client id: ${clientId || 'NOT SET'})`);
